// DVL 浏览器端 store：框架 store 仅保存 UI 观看状态，学习与笔记数据域由 apply 闭包中的引擎快照 store 管理，并通过 useLearning/useNotes 供组件订阅

import {defineStore, type EngineStoreHandle} from '@deepseek-ai/dsh-client-runtime/client'
import type {ArtifactCategory} from '../shared/artifacts.ts'
import type {LearningDomain, NotesDomain, WorkspaceDomain} from './state.ts'

export type {LearningDomain, NotesDomain, WorkspaceDomain} from './state.ts'

// DVL 共享观看状态
export type DvlViewState = {
  tab: 'outlines' | 'reviews' | 'quizzes' // 学习视图当前子 tab
  preview: {category: ArtifactCategory; hash: string} | null // 当前内联预览目标，null 表示不显示预览
}

// DVL 共享观看状态操作
export type DvlViewActions = {
  setTab: (draft: DvlViewState, tab: DvlViewState['tab']) => void
  setPreview: (draft: DvlViewState, preview: DvlViewState['preview']) => void
}

// 创建共享 DVL 观看状态 store，每个 apply 闭包持有自己的实例而不使用模块级单例
export function createDvlViewStore(): EngineStoreHandle<DvlViewState, DvlViewActions> {
  return defineStore({
    init: (): DvlViewState => ({tab: 'outlines', preview: null}),
    actions: {
      setTab: (d, tab) => { d.tab = tab },
      setPreview: (d, preview) => { d.preview = preview },
    },
  })
}

// ---

// 生成学习域初始值
export function idleWorkspaceDomain(): WorkspaceDomain { return {cwd: null, workspaceId: null, isLearningWorkspace: false} }

// 生成学习域初始值
export function idleLearningDomain(): LearningDomain { return {phase: 'idle', data: null, error: null} }

// 生成笔记域初始值
export function idleNotesDomain(): NotesDomain { return {phase: 'idle', notes: null, error: null} }

// 再导出与 DTO 放在同一文件中的数据域类型
export type {LearningDataDto, NotesDto} from '../shared/api.ts'
