// 会话头部工具区的浮动笔记卡片，可展开管理全局笔记文件夹与笔记，所有写操作后都会重新拉取状态

import {useState} from 'react'
import clsx from 'clsx'
import {Button, IconChevronDownOutline14, Modal} from '@deepseek-ai/dsh-client-ui-primitives'
import type {NotesCardProps} from './contract.ts'
import type {Note, NoteAccess} from '../shared/model.ts'
import css from './NotesCard.module.css'

// 笔记权限选项顺序，private 放最后
const ACCESS_TIERS: readonly {value: NoteAccess; key: 'notes.access.readwrite' | 'notes.access.readable' | 'notes.access.private'}[] = [{value: 'readwrite', key: 'notes.access.readwrite'}, {value: 'readable', key: 'notes.access.readable'}, {value: 'private', key: 'notes.access.private'}]

// 编辑器草稿，noteId 为 null 时表示新建笔记
interface EditorDraft {
  noteId: string | null
  folderId: string
  title: string
  markdown: string
  tags: string
  access: NoteAccess
}

// 渲染可折叠的笔记卡片
export function NotesCard({useNotes, card, t}: NotesCardProps) {
  const notesDomain = useNotes(s => s.notes)
  const notes = notesDomain.notes
  const [expanded, setExpanded] = useState(false)
  const [editor, setEditor] = useState<EditorDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  const folders = notes?.folders ?? []
  const notesByFolder = (folderId: string): readonly Note[] => (notes?.notes ?? []).filter(note => note.folderId === folderId)

  const openNew = (): void => {
    if (folders.length === 0) return
    setError(false)
    setEditor({noteId: null, folderId: folders[0].id, title: '', markdown: '', tags: '', access: 'readwrite'})
  }

  const openEdit = (note: Note): void => {
    setError(false)
    setEditor({noteId: note.id, folderId: note.folderId, title: note.title, markdown: note.markdown, tags: note.tags.join(', '), access: note.access})
  }

  const addFolder = (): void => {
    const name = window.prompt(t('notes.folderName'), '')
    if (name === null || name.trim() === '') return
    void card.notes.addFolder(name.trim()).catch(() => {})
  }

  const renameFolder = (folderId: string, current: string): void => {
    const name = window.prompt(t('notes.folderName'), current)
    if (name === null || name.trim() === '' || name.trim() === current) return
    void card.notes.renameFolder(folderId, name.trim()).catch(() => {})
  }

  const deleteFolder = (folderId: string): void => {
    if (!window.confirm(t('card.notes.delete'))) return
    void card.notes.deleteFolder(folderId).catch(() => {})
  }

  const deleteNote = (noteId: string): void => {
    if (!window.confirm(t('notes.deleteNote.title'))) return
    void card.notes.deleteNote(noteId).catch(() => {})
  }

  const save = async (): Promise<void> => {
    if (editor === null) return

    setBusy(true)
    setError(false)

    try {
      const tags = editor.tags.split(',').map(part => part.trim()).filter(part => part !== '')

      if (editor.noteId === null) await card.notes.addNote({folderId: editor.folderId, title: editor.title, markdown: editor.markdown, tags, access: editor.access})
      else await card.notes.updateNote(editor.noteId, {folderId: editor.folderId, title: editor.title, markdown: editor.markdown, tags, access: editor.access})

      setEditor(null)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
      <div className={css.card}>
        <button type="button" className={css.header} aria-expanded={expanded} onClick={() => { setExpanded(v => !v) }}>
          <span className={css.title}>{t('card.notes.title')}</span>
          <IconChevronDownOutline14 className={clsx(css.chevron, expanded && css.chevronOpen)} />
        </button>

        {expanded && (
            <div className={css.body}>
              {notesDomain.phase === 'error' ? <div className={css.empty}>{t('state.error')}</div> : notes === null ? <div className={css.empty}>{t('state.loading')}</div> : (
                  <>
                    <div className={css.toolbar}>
                      <Button size="sm" variant="outline" onClick={addFolder}>{t('card.notes.addFolder')}</Button>
                      <Button size="sm" variant="primary" disabled={folders.length === 0} onClick={openNew}>{t('card.notes.addNote')}</Button>
                    </div>

                    {folders.length === 0 ? <div className={css.empty}>{t('card.notes.empty')}</div> : folders.map(folder => (
                        <div key={folder.id} className={css.folder}>
                          <div className={css.folderHeader}>
                            <span className={css.folderName}>{folder.name}</span>
                            <button type="button" className={css.miniButton} onClick={() => { renameFolder(folder.id, folder.name) }}>{t('card.notes.rename')}</button>
                            <button type="button" className={css.miniButton} onClick={() => { deleteFolder(folder.id) }}>{t('card.notes.delete')}</button>
                          </div>

                          {notesByFolder(folder.id).map(note => (
                              <div key={note.id} className={css.note}>
                                <span className={css.noteTitle}>{note.title}</span>
                                <button type="button" className={css.miniButton} onClick={() => { openEdit(note) }}>{t('notes.editor.title.edit')}</button>
                                <button type="button" className={css.miniButton} onClick={() => { deleteNote(note.id) }}>{t('card.notes.delete')}</button>
                              </div>
                          ))}
                        </div>
                    ))}
                  </>
              )}
            </div>
        )}

        <Modal open={editor !== null} onClose={() => { setEditor(null) }} closeLabel={t('notes.cancel')} title={editor?.noteId === null ? t('notes.editor.title.new') : t('notes.editor.title.edit')} footer={<><Button variant="outline" disabled={busy} onClick={() => { setEditor(null) }}>{t('notes.cancel')}</Button><Button variant="primary" disabled={busy} onClick={() => { void save() }}>{t('notes.save')}</Button></>}>
          {editor !== null && (
              <div className={css.editor}>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('notes.folderName')}</span>
                  <select className={css.input} value={editor.folderId} onChange={event => { setEditor({...editor, folderId: event.target.value}) }}>
                    {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                  </select>
                </label>

                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('notes.note.title')}</span>
                  <input className={css.input} value={editor.title} placeholder={t('notes.note.title.placeholder')} onChange={event => { setEditor({...editor, title: event.target.value}) }} />
                </label>

                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('notes.note.markdown')}</span>
                  <textarea className={clsx(css.input, css.textarea)} value={editor.markdown} onChange={event => { setEditor({...editor, markdown: event.target.value}) }} />
                </label>

                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('notes.note.tags')}</span>
                  <input className={css.input} value={editor.tags} placeholder={t('notes.note.tags.placeholder')} onChange={event => { setEditor({...editor, tags: event.target.value}) }} />
                </label>

                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('notes.note.access')}</span>
                  <select className={css.input} value={editor.access} onChange={event => { setEditor({...editor, access: event.target.value as NoteAccess}) }}>
                    {ACCESS_TIERS.map(tier => <option key={tier.value} value={tier.value}>{t(tier.key)}</option>)}
                  </select>
                </label>

                {error && <div className={css.error}>{t('notes.error')}</div>}
              </div>
          )}
        </Modal>
      </div>
  )
}
