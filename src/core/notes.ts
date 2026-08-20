// 设计说明：笔记分为用户面与模型面
// 用户面：全局笔记不从属于单个工作区、纲目或课程，而是按册存储；一篇笔记可同时拥有多个工作区、纲目和课程 tag；访问等级分为 private（用户 rw）、readable（用户 rw、模型 r）、readwrite（用户和模型均 rw）
// 模型面：不按册向模型列出笔记，模型通过 tag 筛选笔记，private 笔记永不进入结果

import {randomUUID} from 'node:crypto'
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import type {Note, NoteAccess, NoteFolder, NotesDb} from '../shared/model.ts'

function isEnoent(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

// 使用插件数据目录中的单个 notes.json 持久化笔记，并串行执行所有落盘操作
export class NotesStore {
    private db: NotesDb = {folders: [], notes: []}
    private tail = Promise.resolve()

    constructor(private readonly dataDir: string, private readonly onChanged: () => void = () => {}) {
    }

    private get file(): string {
        return join(this.dataDir, 'notes.json')
    }

    async load() {
        try {
            const raw = await readFile(this.file, 'utf8')
            const parsed = JSON.parse(raw) as NotesDb
            this.db = {folders: [...parsed.folders], notes: [...parsed.notes]}
        } catch (error: unknown) {
            if (!isEnoent(error)) throw error
            this.db = {folders: [], notes: []}
        }
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.tail.then(operation)
        this.tail = result.then(() => {}, () => {})
        return result
    }

    private save() {
        const json = `${JSON.stringify(this.db, null, 2)}\n`

        return this.enqueue(async () => {
            await mkdir(dirname(this.file), {recursive: true})
            const tmp = join(this.dataDir, `.notes.${randomUUID()}.tmp`)
            await writeFile(tmp, json, 'utf8')
            await rename(tmp, this.file)
        })
    }

    snapshot(): NotesDb {
        return {folders: [...this.db.folders], notes: [...this.db.notes]}
    }

    // ---文件夹---

    async addFolder(name: string): Promise<NoteFolder> {
        const trimmed = name.trim()
        if (trimmed.length === 0) throw new Error('文件夹名称不能为空')

        const folder: NoteFolder = {id: randomUUID(), name: trimmed, createdAt: new Date().toISOString()}
        this.db = {folders: [...this.db.folders, folder], notes: this.db.notes}
        await this.save()
        this.onChanged()

        return folder
    }

    async renameFolder(folderId: string, name: string): Promise<void> {
        const trimmed = name.trim()
        if (trimmed.length === 0) throw new Error('文件夹名称不能为空')

        const folder = this.db.folders.find(item => item.id === folderId)
        if (folder === undefined) throw new Error(`找不到文件夹 ${folderId}`)

        this.db = {folders: this.db.folders.map(item => item.id === folderId ? {...item, name: trimmed} : item), notes: this.db.notes}
        await this.save()
        this.onChanged()
    }

    async deleteFolder(folderId: string): Promise<void> {
        this.db = {folders: this.db.folders.filter(item => item.id !== folderId), notes: this.db.notes.filter(item => item.folderId !== folderId)}
        await this.save()
        this.onChanged()
    }

    // ---笔记---

    async addNote(input: { folderId: string; title: string; markdown: string; tags: string[]; access: NoteAccess }): Promise<Note> {
        if (this.db.folders.every(item => item.id !== input.folderId)) throw new Error(`找不到文件夹「${input.folderId}」`)

        const now = new Date().toISOString()
        const note: Note = {id: randomUUID(), folderId: input.folderId, title: input.title.trim() || '未命名笔记', markdown: input.markdown, tags: [...new Set(input.tags)], access: input.access, createdAt: now, updatedAt: now}
        this.db = {folders: this.db.folders, notes: [...this.db.notes, note]}
        await this.save()
        this.onChanged()

        return note
    }

    async updateNote(noteId: string, patch: { title?: string; markdown?: string; tags?: string[]; access?: NoteAccess; folderId?: string }): Promise<Note> {
        const note = this.db.notes.find(item => item.id === noteId)
        if (note === undefined) throw new Error(`找不到笔记 ${noteId}`)
        if (patch.folderId !== undefined && this.db.folders.every(item => item.id !== patch.folderId)) throw new Error(`找不到文件夹「${patch.folderId}」`)

        const updated: Note = {...note, ...patch.title !== undefined ? {title: patch.title.trim() || note.title} : {}, ...patch.markdown !== undefined ? {markdown: patch.markdown} : {}, ...patch.tags !== undefined ? {tags: [...new Set(patch.tags)]} : {}, ...patch.access !== undefined ? {access: patch.access} : {}, ...patch.folderId !== undefined ? {folderId: patch.folderId} : {}, updatedAt: new Date().toISOString()}
        this.db = {folders: this.db.folders, notes: this.db.notes.map(item => item.id === noteId ? updated : item)}
        await this.save()
        this.onChanged()

        return updated
    }

    async deleteNote(noteId: string): Promise<void> {
        this.db = {folders: this.db.folders, notes: this.db.notes.filter(item => item.id !== noteId)}
        await this.save()
        this.onChanged()
    }

    getNote(noteId: string): Note | undefined {
        return this.db.notes.find(item => item.id === noteId)
    }

    // 模型面按 tag 筛选笔记，并排除 private 笔记
    // THINKING：如果笔记没有tag，还能被筛选到吗？我觉得最好可能是：如果没有 tag 就直接收集，如果有 tag 再去筛选有没有目标 tag。
    filterForModel(tags: readonly string[]): string[] {
        return this.db.notes.filter(note => note.access !== 'private').filter(note => tags.every(tag => note.tags.includes(tag))).map(note => note.id)
    }

    // 获取模型可读笔记，private 笔记按不存在处理
    modelReadable(noteId: string): Note | undefined {
        const note = this.getNote(noteId)
        if (note === undefined || note.access === 'private') return undefined
        return note
    }
}
