// DVL 浏览器端 slot 契约：定义学习入口与两张浮动卡片注入的业务接口，组件只通过 store 与回调访问业务数据

import type {PropsRuntime, PropsStore, InjectFace, PropsLocale, HostObservable} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client' // 仅用于引入 ui-conversation 的 SlotMap 类型合并
import type {ToolCallViewProps} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {ArtifactCategory} from '../shared/artifacts.ts'
import type {ArtifactRunDescriptor, InbandPresentResult} from '../shared/api.ts'
import type {NoteAccess} from '../shared/model.ts'
import type {createDvlViewStore} from './stores.ts'
import type {LearningDomain, NotesDomain} from './state.ts'

// 插件拥有的文案 namespace，对应 locales.ts
type NS = 'vibeLearning'

// 笔记相关写操作
export interface NotesActions {
  addFolder: (name: string) => Promise<void> // 新建文件夹并刷新状态
  renameFolder: (folderId: string, name: string) => Promise<void>
  deleteFolder: (folderId: string) => Promise<void>
  addNote: (input: {folderId: string, title: string, markdown: string, tags: string[], access: NoteAccess}) => Promise<void>
  updateNote: (noteId: string, input: {folderId?: string, title?: string, markdown?: string, tags?: string[], access?: NoteAccess}) => Promise<void>
  deleteNote: (noteId: string) => Promise<void>
}

// 注入学习视图的 API
export interface LearningApi {
  refresh: () => Promise<void> // 重新获取学习状态并写入共享 store，失败时抛错
  createDirectRun: (category: ArtifactCategory, hash: string) => Promise<ArtifactRunDescriptor>
  abortRun: (category: ArtifactCategory, hash: string, runId: string) => Promise<void>
  inbandPresentExisting: (category: ArtifactCategory, hash: string, sessionId: string, runId?: string) => Promise<InbandPresentResult>
  startDueReview: (planId: string, sessionId: string) => Promise<InbandPresentResult>
  deleteOutline: (id: string) => Promise<void>
  deleteReviewPlan: (id: string, preserveArtifacts: boolean) => Promise<void>
  deleteArtifact: (category: ArtifactCategory, hash: string) => Promise<void>
  openRun: (category: ArtifactCategory, hash: string, runId: string) => void
  artifactUrl: (category: ArtifactCategory, hash: string) => string // 获取禁用提交的工件只读预览 URL
}

// 组件使用的共享 store 类型
export type DvlViewStore = ReturnType<typeof createDvlViewStore>

// 学习域数据源 snapshot
export interface LearningSourceSnapshot {
  readonly learning: LearningDomain
}

// 笔记域数据源 snapshot
export interface NotesSourceSnapshot {
  readonly notes: NotesDomain
}

// 学习视图注入接口：API、笔记操作与学习域数据源
export interface LearningViewInject {
  readonly api: LearningApi
  readonly notes: NotesActions
  readonly hooks: {readonly learning: HostObservable<LearningSourceSnapshot>} // hooks 通道必须使用内联字面量以满足 InjectFace 模式匹配
}

// 学习视图完整 props
export type LearningViewProps = PropsRuntime<'conversation.view'> & PropsStore<DvlViewStore> & InjectFace<LearningViewInject> & PropsLocale<NS>

// 纲目浮动卡片注入接口，学习域数据通过 hooks 提供
export interface OutlineCardInject {}

// 纲目浮动卡片完整 props
export type OutlineCardProps = PropsRuntime<'conversation.session.header.utilities'> & PropsStore<DvlViewStore> & InjectFace<{readonly hooks: {readonly learning: HostObservable<LearningSourceSnapshot>}}> & PropsLocale<NS>

// 笔记浮动卡片注入接口
export interface NotesCardInject {
  readonly notes: NotesActions
}

// 笔记浮动卡片完整 props
export type NotesCardProps = PropsRuntime<'conversation.session.header.utilities'> & PropsStore<DvlViewStore> & InjectFace<{readonly card: NotesCardInject, readonly hooks: {readonly notes: HostObservable<NotesSourceSnapshot>}}> & PropsLocale<NS>

// keyed present_artifact 工具视图注入接口
export interface PresentToolViewInject {
  readonly resolveDescriptor: (cwd: string, callId: string) => Promise<ArtifactRunDescriptor | null> // 根据 cwd + callId 获取运行中展示的规范描述符
  readonly abortRun: (descriptor: ArtifactRunDescriptor) => Promise<void>
}

// present_artifact 工具视图完整 props
export type PresentToolViewProps = ToolCallViewProps & PropsStore<DvlViewStore> & InjectFace<PresentToolViewInject> & PropsLocale<NS>
