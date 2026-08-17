/**
 * # 设计说明：笔记的两个面：
 *
 * ## 笔记用户面
 *
 * **全局笔记**（而不是一篇笔记只属于某个工作区、纲目、课程），按**册**存储。笔记可以有tag[]，tag可以是工作区、可以是大纲、可以是课程，**都可以多个**（同时有多个不同工作区、大纲、课程的tag）；笔记有查看等级：private（用户rw）、readable（用户rw、模型r）、readwrite（用户、模型都rw）
 *
 * ## 笔记模型（agent）面
 *
 * **不按册**向模型列出笔记。模型通过工具，传入tag来筛选笔记，且private笔记不进结果
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Note, NoteAccess, NoteFolder, NotesDb } from '../shared/types.ts'

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/**
 * One JSON file (`notes.json`) under the plugin data dir, read at startup and
 * written through a serialized operation chain so concurrent mutations never
 * interleave check-then-write pairs.
 */
export class NotesStore {
  private db: NotesDb = { folders: [], notes: [] }
  private tail = Promise.resolve()

  constructor(private readonly dataDir: string) {}

  private get file(): string {
    return join(this.dataDir, 'notes.json')
  }

  // TODO？：笔记异步落盘，写入或先于http返回

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as NotesDb
      this.db = { folders: [...parsed.folders], notes: [...parsed.notes] }
    } catch (error: unknown) {
      if (!isEnoent(error)) throw error
      this.db = { folders: [], notes: [] }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }

  private save(): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = join(this.dataDir, `.notes.${randomUUID()}.tmp`)
      await writeFile(tmp, `${JSON.stringify(this.db, null, 2)}\n`, 'utf8')
      await rename(tmp, this.file)
    })
  }

  snapshot(): NotesDb {
    return { folders: [...this.db.folders], notes: [...this.db.notes] }
  }

  // ── folders ──────────────────────────────────────────────────────────────

  addFolder(name: string): NoteFolder {
    const trimmed = name.trim()
    if (trimmed.length === 0) throw new Error('folder name must be non-blank')
    const folder: NoteFolder = { id: randomUUID(), name: trimmed, createdAt: new Date().toISOString() }
    this.db = { folders: [...this.db.folders, folder], notes: this.db.notes }
    void this.save()
    return folder
  }

  renameFolder(folderId: string, name: string): void {
    const trimmed = name.trim()
    if (trimmed.length === 0) throw new Error('folder name must be non-blank')

    const folder = this.db.folders.find(item => item.id === folderId)
    if (folder === undefined) throw new Error(`unknown folder '${folderId}'`)

    this.db = {
      folders: this.db.folders.map(item => item.id === folderId ? { ...item, name: trimmed } : item),
      notes: this.db.notes,
    }
    void this.save()
  }

  deleteFolder(folderId: string): void {
    this.db = {
      folders: this.db.folders.filter(item => item.id !== folderId),
      notes: this.db.notes.filter(item => item.folderId !== folderId),
    }
    void this.save()
  }

  // ── notes ────────────────────────────────────────────────────────────────

  addNote(input: { folderId: string; title: string; markdown: string; tags: string[]; access: NoteAccess }): Note {
    if (this.db.folders.every(item => item.id !== input.folderId)) throw new Error(`unknown folder '${input.folderId}'`)

    const now = new Date().toISOString()
    const note: Note = {
      id: randomUUID(),
      folderId: input.folderId,
      title: input.title.trim() || '未命名笔记',
      markdown: input.markdown,
      tags: [...new Set(input.tags)],
      access: input.access,
      createdAt: now,
      updatedAt: now,
    }
    this.db = { folders: this.db.folders, notes: [...this.db.notes, note] }
    void this.save()

    return note
  }

  updateNote(noteId: string, patch: { title?: string; markdown?: string; tags?: string[]; access?: NoteAccess; folderId?: string }): Note {
    const note = this.db.notes.find(item => item.id === noteId)
    if (note === undefined) throw new Error(`unknown note '${noteId}'`)
    if (patch.folderId !== undefined && this.db.folders.every(item => item.id !== patch.folderId)) throw new Error(`unknown folder '${patch.folderId}'`)

    const updated: Note = {
      ...note,
      ...patch.title !== undefined ? { title: patch.title.trim() || note.title } : {},
      ...patch.markdown !== undefined ? { markdown: patch.markdown } : {},
      ...patch.tags !== undefined ? { tags: [...new Set(patch.tags)] } : {},
      ...patch.access !== undefined ? { access: patch.access } : {},
      ...patch.folderId !== undefined ? { folderId: patch.folderId } : {},
      updatedAt: new Date().toISOString(),
    }
    this.db = { folders: this.db.folders, notes: this.db.notes.map(item => item.id === noteId ? updated : item) }
    void this.save()

    return updated
  }

  deleteNote(noteId: string): void {
    this.db = { folders: this.db.folders, notes: this.db.notes.filter(item => item.id !== noteId) }
    void this.save()
  }

  getNote(noteId: string): Note | undefined {
    return this.db.notes.find(item => item.id === noteId)
  }

  /**
   * 笔记的模型面：按tag来筛选
   * 且：会去掉 Private 笔记
   * @param workspaceTag - `workspace:<id>` implicit scope.
   * @param tags - requested `outline:<id>` / `lesson:<id>` tags.
   * @returns matching note ids.
   */
  filterForModel(tags: readonly string[]): string[] {
    return this.db.notes
      .filter(note => note.access !== 'private')
      .filter(note => tags.every(tag => note.tags.includes(tag)))
      .map(note => note.id)
  }

  modelReadable(noteId: string): Note | undefined {
    const note = this.getNote(noteId)
    if (note === undefined || note.access === 'private') return undefined

    return note
  }
}
