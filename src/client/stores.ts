/**
 * DVL browser-half stores. Shared viewing state lives here (active sub-tab,
 * expanded outline, preview target, and the fetched learning state) so it
 * survives remounts and is shared across the learning view and the two
 * floating cards. The fetch itself lives in the apply closure; this store only
 * holds the plain JSON DTO the inject callbacks write and the components read.
 * @module dvl/client/stores
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { ArtifactCategory, LearningStateDto } from './types.ts'

/** Shared viewing-state record. */
export type DvlViewState = {
  /** The learning view's active sub-tab. */
  tab: 'outlines' | 'reviews' | 'quizzes'
  /** Outline id expanded in the outlines tab (single-selection accordion). */
  expandedOutlineId: string | null
  /** Preview target currently shown inline; null = no preview panel. */
  preview: { category: ArtifactCategory; hash: string } | null
  /** The latest fetched learning state; null until the first response lands. */
  learningState: LearningStateDto | null
}

/** The actions binding for {@link DvlViewState}. */
export type DvlViewActions = {
  setTab: (draft: DvlViewState, tab: DvlViewState['tab']) => void
  setExpandedOutlineId: (draft: DvlViewState, id: string | null) => void
  setPreview: (draft: DvlViewState, preview: DvlViewState['preview']) => void
  setLearningState: (draft: DvlViewState, state: LearningStateDto) => void
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
      learningState: null,
    }),
    actions: {
      setTab: (d, tab) => { d.tab = tab },
      setExpandedOutlineId: (d, id) => { d.expandedOutlineId = id },
      setPreview: (d, preview) => { d.preview = preview },
      setLearningState: (d, state) => { d.learningState = state },
    },
  })
}
