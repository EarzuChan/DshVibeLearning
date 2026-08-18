// DVL 浏览器端 store：框架 store 仅保存 UI 观看状态，学习与笔记数据域由 apply 闭包中的引擎快照 store 管理，并通过 useLearning/useNotes 供组件订阅

import {defineStore, type EngineStoreHandle} from '@deepseek-ai/dsh-client-runtime/client'
import type {ArtifactCategory} from '../shared/artifacts.ts'
import type {LearningDomain, NotesDomain} from './state.ts'

export type {LearningDomain, NotesDomain} from './state.ts'

// 当前正在运行的 present，通过 DSH 工具 callId 观测
export interface PresentRunEntry {
  readonly category: ArtifactCategory
  readonly hash: string
  readonly runId: string
}

// DVL 共享观看状态
export type DvlViewState = {
  tab: 'outlines' | 'reviews' | 'quizzes' // 学习视图当前子 tab
  expandedOutlineId: string | null // 纲目 tab 当前展开的纲目 ID，单选
  preview: {category: ArtifactCategory; hash: string} | null // 当前内联预览目标，null 表示不显示预览
  presentRuns: Record<string, PresentRunEntry> // 按 DSH 工具 callId 索引的活跃 present，不持久化
}

// DVL 共享观看状态操作
export type DvlViewActions = {
  setTab: (draft: DvlViewState, tab: DvlViewState['tab']) => void
  setExpandedOutlineId: (draft: DvlViewState, id: string | null) => void
  setPreview: (draft: DvlViewState, preview: DvlViewState['preview']) => void
  observePresentRun: (draft: DvlViewState, callId: string, entry: PresentRunEntry) => void
  forgetPresentRun: (draft: DvlViewState, callId: string) => void
}

// 创建共享 DVL 观看状态 store，每个 apply 闭包持有自己的实例而不使用模块级单例
export function createDvlViewStore(): EngineStoreHandle<DvlViewState, DvlViewActions> {
  return defineStore({
    init: (): DvlViewState => ({tab: 'outlines', expandedOutlineId: null, preview: null, presentRuns: {}}),
    actions: {
      setTab: (d, tab) => { d.tab = tab },
      setExpandedOutlineId: (d, id) => { d.expandedOutlineId = id },
      setPreview: (d, preview) => { d.preview = preview },
      observePresentRun: (d, callId, entry) => { d.presentRuns[callId] = entry },
      forgetPresentRun: (d, callId) => { delete d.presentRuns[callId] },
    },
  })
}

// ---

// 生成学习域初始值
export function idleLearningDomain(): LearningDomain { return {phase: 'idle', state: null, isLearningWorkspace: false, error: null} }

// 生成笔记域初始值
export function idleNotesDomain(): NotesDomain { return {phase: 'idle', notes: null, error: null} }

// 再导出与 DTO 放在同一文件中的数据域类型
export type {LearningStateDto, NotesDto} from '../shared/api.ts'
