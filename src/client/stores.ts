/**
 * DVL browser-half stores. 框架 store seat 只留 UI 观看状态（子 tab、
 * 预览目标、活跃 present）——学习/笔记数据域在 apply 闭包的引擎快照
 * store 里，经 inject hooks 通道（useLearning/useNotes）供组件订阅
 * @module dvl/client/stores
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { ArtifactCategory, LearningDomain, LearningStateDto, NotesDomain, NotesDto } from './types.ts'

export type { LearningDomain, NotesDomain } from './types.ts'

/** One active (running) present, observed by its DSH tool callId. */
export interface PresentRunEntry {
  readonly category: ArtifactCategory
  readonly hash: string
  readonly runId: string
}

/** Shared viewing-state record. */
export type DvlViewState = {
  /** The learning view's active sub-tab. */
  tab: 'outlines' | 'reviews' | 'quizzes'
  /** Outline id expanded in the outlines tab (single-selection accordion). */
  expandedOutlineId: string | null
  /** Preview target currently shown inline; null = no preview panel. */
  preview: { category: ArtifactCategory; hash: string } | null
  /** Live present runs keyed by DSH tool callId (never persisted). */
  presentRuns: Record<string, PresentRunEntry>
}

/** The actions binding for {@link DvlViewState}. */
export type DvlViewActions = {
  setTab: (draft: DvlViewState, tab: DvlViewState['tab']) => void
  setExpandedOutlineId: (draft: DvlViewState, id: string | null) => void
  setPreview: (draft: DvlViewState, preview: DvlViewState['preview']) => void
  observePresentRun: (draft: DvlViewState, callId: string, entry: PresentRunEntry) => void
  forgetPresentRun: (draft: DvlViewState, callId: string) => void
}

/**
 * Create the shared DVL viewing-store handle (factory only; the apply closure
 * passes one handle to every registration, never a module-level singleton).
 * @returns the store handle.
 */
export function createDvlViewStore(): EngineStoreHandle<DvlViewState, DvlViewActions> {
  return defineStore({
    init: (): DvlViewState => ({
      tab: 'outlines',
      expandedOutlineId: null,
      preview: null,
      presentRuns: {},
    }),
    actions: {
      setTab: (d, tab) => { d.tab = tab },
      setExpandedOutlineId: (d, id) => { d.expandedOutlineId = id },
      setPreview: (d, preview) => { d.preview = preview },
      observePresentRun: (d, callId, entry) => { d.presentRuns[callId] = entry },
      forgetPresentRun: (d, callId) => { delete d.presentRuns[callId] },
    },
  })
}

/** 学习域写入面（apply 闭包的引擎快照 store 初始化用） */
export function idleLearningDomain(): LearningDomain {
  return { phase: 'idle', state: null, isLearningWorkspace: false, error: null }
}

/** 笔记域初始值 */
export function idleNotesDomain(): NotesDomain {
  return { phase: 'idle', notes: null, error: null }
}

/** 类型再导出：数据域定义放在 types.ts（与 DTO 同处） */
export type { LearningStateDto, NotesDto } from './types.ts'
