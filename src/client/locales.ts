/**
 * `vibeLearning` namespace dictionaries: the learning view's tab labels,
 * toolbar, card chrome, and note-panel copy. Chinese product copy, English
 * code comments; both locales derive from the single key union.
 * @module dvl/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'vibeLearning'

/** The dictionary key set (single source of truth for both locales). */
export type VibeLearningKey =
  | 'view.label'
  | 'tab.outlines'
  | 'tab.reviews'
  | 'tab.quizzes'
  | 'toolbar.refresh'
  | 'toolbar.refreshing'
  | 'outlines.empty'
  | 'outlines.active'
  | 'outlines.nodes'
  | 'lesson.state.notStarted'
  | 'lesson.state.learning'
  | 'lesson.state.qa'
  | 'lesson.state.done'
  | 'reviews.cards'
  | 'reviews.artifacts'
  | 'reviews.emptyCards'
  | 'reviews.emptyArtifacts'
  | 'reviews.due'
  | 'reviews.historyCount'
  | 'artifact.open'
  | 'artifact.preview'
  | 'artifact.inband'
  | 'artifact.inband.current'
  | 'artifact.inband.new'
  | 'artifact.inband.dialog.title'
  | 'artifact.hasResult'
  | 'artifact.hasFeedback'
  | 'artifact.previewClose'
  | 'card.outline.title'
  | 'card.outline.empty'
  | 'card.notes.title'
  | 'card.notes.empty'
  | 'card.notes.addFolder'
  | 'card.notes.addNote'
  | 'card.notes.rename'
  | 'card.notes.delete'
  | 'notes.folderName'
  | 'notes.folderName.placeholder'
  | 'notes.note.title'
  | 'notes.note.title.placeholder'
  | 'notes.note.markdown'
  | 'notes.note.tags'
  | 'notes.note.tags.placeholder'
  | 'notes.note.access'
  | 'notes.access.private'
  | 'notes.access.readable'
  | 'notes.access.readwrite'
  | 'notes.editor.title.new'
  | 'notes.editor.title.edit'
  | 'notes.deleteNote.title'
  | 'notes.cancel'
  | 'notes.save'
  | 'notes.error'
  | 'state.unavailable'
  | 'state.loading'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The DVL learning view and floating-card copy. */
    vibeLearning: VibeLearningKey
  }
}

/** Simplified Chinese dictionary. */
export const zh: Record<VibeLearningKey, string> = {
  'view.label': '学习',
  'tab.outlines': '纲目们',
  'tab.reviews': '复习们',
  'tab.quizzes': '小测们',
  'toolbar.refresh': '刷新',
  'toolbar.refreshing': '刷新中…',
  'outlines.empty': '暂无纲目',
  'outlines.active': '激活',
  'outlines.nodes': '{n} 个节点',
  'lesson.state.notStarted': '未开始',
  'lesson.state.learning': '学习中',
  'lesson.state.qa': '答疑中',
  'lesson.state.done': '完成',
  'reviews.cards': '卡牌',
  'reviews.artifacts': '复习工件',
  'reviews.emptyCards': '暂无到期卡牌',
  'reviews.emptyArtifacts': '暂无复习工件',
  'reviews.due': '到期 {due}',
  'reviews.historyCount': '{n} 次复习',
  'artifact.open': '打开',
  'artifact.preview': '预览',
  'artifact.inband': 'in-band',
  'artifact.inband.current': '当前会话',
  'artifact.inband.new': '新开会话',
  'artifact.inband.dialog.title': 'in-band 呈现',
  'artifact.hasResult': '有结果',
  'artifact.hasFeedback': '有反馈',
  'artifact.previewClose': '关闭预览',
  'card.outline.title': '当前纲目',
  'card.outline.empty': '当前无激活纲目',
  'card.notes.title': '笔记',
  'card.notes.empty': '暂无笔记',
  'card.notes.addFolder': '新建笔记夹',
  'card.notes.addNote': '新建笔记',
  'card.notes.rename': '重命名',
  'card.notes.delete': '删除',
  'notes.folderName': '笔记夹名称',
  'notes.folderName.placeholder': '输入名称',
  'notes.note.title': '标题',
  'notes.note.title.placeholder': '笔记标题',
  'notes.note.markdown': '正文（Markdown）',
  'notes.note.tags': '标签（逗号分隔）',
  'notes.note.tags.placeholder': '标签，逗号分隔',
  'notes.note.access': '权限',
  'notes.access.private': '私密',
  'notes.access.readable': '只读',
  'notes.access.readwrite': '可读写',
  'notes.editor.title.new': '新建笔记',
  'notes.editor.title.edit': '编辑笔记',
  'notes.deleteNote.title': '删除笔记',
  'notes.cancel': '取消',
  'notes.save': '保存',
  'notes.error': '操作失败',
  'state.unavailable': '学习状态不可用',
  'state.loading': '加载中…',
}

/** English dictionary. */
export const en: Record<VibeLearningKey, string> = {
  'view.label': 'Learn',
  'tab.outlines': 'Outlines',
  'tab.reviews': 'Reviews',
  'tab.quizzes': 'Quizzes',
  'toolbar.refresh': 'Refresh',
  'toolbar.refreshing': 'Refreshing…',
  'outlines.empty': 'No outlines yet',
  'outlines.active': 'Active',
  'outlines.nodes': '{n} nodes',
  'lesson.state.notStarted': 'Not started',
  'lesson.state.learning': 'Learning',
  'lesson.state.qa': 'Q&A',
  'lesson.state.done': 'Done',
  'reviews.cards': 'Cards',
  'reviews.artifacts': 'Review artifacts',
  'reviews.emptyCards': 'No cards due',
  'reviews.emptyArtifacts': 'No review artifacts',
  'reviews.due': 'Due {due}',
  'reviews.historyCount': '{n} reviews',
  'artifact.open': 'Open',
  'artifact.preview': 'Preview',
  'artifact.inband': 'in-band',
  'artifact.inband.current': 'Current session',
  'artifact.inband.new': 'New session',
  'artifact.inband.dialog.title': 'In-band present',
  'artifact.hasResult': 'Result',
  'artifact.hasFeedback': 'Feedback',
  'artifact.previewClose': 'Close preview',
  'card.outline.title': 'Current outline',
  'card.outline.empty': 'No active outline',
  'card.notes.title': 'Notes',
  'card.notes.empty': 'No notes yet',
  'card.notes.addFolder': 'Add folder',
  'card.notes.addNote': 'Add note',
  'card.notes.rename': 'Rename',
  'card.notes.delete': 'Delete',
  'notes.folderName': 'Folder name',
  'notes.folderName.placeholder': 'Enter a name',
  'notes.note.title': 'Title',
  'notes.note.title.placeholder': 'Note title',
  'notes.note.markdown': 'Body (Markdown)',
  'notes.note.tags': 'Tags (comma-separated)',
  'notes.note.tags.placeholder': 'tag1, tag2',
  'notes.note.access': 'Access',
  'notes.access.private': 'Private',
  'notes.access.readable': 'Readable',
  'notes.access.readwrite': 'Read-write',
  'notes.editor.title.new': 'New note',
  'notes.editor.title.edit': 'Edit note',
  'notes.deleteNote.title': 'Delete note',
  'notes.cancel': 'Cancel',
  'notes.save': 'Save',
  'notes.error': 'Operation failed',
  'state.unavailable': 'Learning state unavailable',
  'state.loading': 'Loading…',
}
