// @ts-ignore
// @ts-ignore

export const NS = 'vibeLearning'

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
  | 'artifact.runs'
  | 'artifact.run.result'
  | 'artifact.run.feedback'
  | 'artifact.run.empty'
  | 'artifact.previewClose'
  | 'present.title'
  | 'present.running'
  | 'present.outcome.submitted'
  | 'present.outcome.timeout'
  | 'present.outcome.interrupted'
  | 'present.outcome.error'
  | 'present.openExternal'
  | 'present.refresh'
  | 'present.collapse'
  | 'present.expand'
  | 'present.url'
  | 'present.preparing'
  | 'present.unavailable'
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
  | 'state.idle'
  | 'state.error'
  | 'card.outline.notLearning'

// @ts-ignore。傻逼IDEA抽风
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    vibeLearning: VibeLearningKey
  }
}

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
  'artifact.runs': '{n} 次作答',
  'artifact.run.result': '有结果',
  'artifact.run.feedback': '已批改',
  'artifact.run.empty': '无作答记录',
  'artifact.previewClose': '关闭预览',
  'present.title': '课程工件',
  'present.running': '运行中',
  'present.outcome.submitted': '已提交',
  'present.outcome.timeout': '超时',
  'present.outcome.interrupted': '中断',
  'present.outcome.error': '失败',
  'present.openExternal': '外部打开',
  'present.refresh': '刷新',
  'present.collapse': '收起',
  'present.expand': '展开',
  'present.url': 'URL',
  'present.preparing': '准备中…',
  'present.unavailable': '无法加载呈现',
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
  'state.idle': '待命中',
  'state.error': '加载失败',
  'card.outline.notLearning': '本会话未进入氛围学习',
}

// 英文词典
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
  'artifact.runs': '{n} attempts',
  'artifact.run.result': 'Result',
  'artifact.run.feedback': 'Feedback',
  'artifact.run.empty': 'No attempts',
  'artifact.previewClose': 'Close preview',
  'present.title': 'Artifact',
  'present.running': 'Running',
  'present.outcome.submitted': 'Submitted',
  'present.outcome.timeout': 'Timed out',
  'present.outcome.interrupted': 'Interrupted',
  'present.outcome.error': 'Failed',
  'present.openExternal': 'Open',
  'present.refresh': 'Refresh',
  'present.collapse': 'Collapse',
  'present.expand': 'Expand',
  'present.url': 'URL',
  'present.preparing': 'Preparing…',
  'present.unavailable': 'Presentation unavailable',
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
  'state.idle': 'Idle',
  'state.error': 'Load failed',
  'card.outline.notLearning': 'Not Learning',
}
