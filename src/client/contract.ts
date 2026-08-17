/**
 * DVL browser-half slot contracts: the injected business face for the
 * `conversation.view` learning entry and the two floating cards. The face
 * carries only plain data and callbacks (the fetch/notes logic lives in the
 * apply closure; components never touch ctx or subscribe to business data —
 * Fetched state is read through the store seat).
 * @module dvl/client/contract
 */

import type { PropsRuntime, PropsStore, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge, so the
// 'conversation.view' / 'conversation.session.header.utilities' keys type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ArtifactCategory, InbandPresentResult,
} from './types.ts'
import type { createDvlViewStore } from './stores.ts'

/** The copy namespace this plugin owns (see locales.ts). */
type NS = 'vibeLearning'

/** Folder mutation verbs carried on the inject face. */
export interface NotesActions {
  /** Create a folder, then refresh the learning state. */
  addFolder: (name: string) => Promise<void>
  renameFolder: (folderId: string, name: string) => Promise<void>
  deleteFolder: (folderId: string) => Promise<void>
  addNote: (input: {
    folderId: string
    title: string
    markdown: string
    tags: string[]
    access: 'private' | 'readable' | 'readwrite'
  }) => Promise<void>
  updateNote: (noteId: string, input: {
    folderId?: string
    title?: string
    markdown?: string
    tags?: string[]
    access?: 'private' | 'readable' | 'readwrite'
  }) => Promise<void>
  deleteNote: (noteId: string) => Promise<void>
}

/** The API client face injected into the learning view entry. */
export interface LearningApi {
  /** Re-fetch the learning state into the shared store; throws on failure. */
  refresh: () => Promise<void>
  /** Run an in-band present request; returns the server's settlement. */
  inbandPresent: (category: ArtifactCategory, hash: string, sessionId: string) => Promise<InbandPresentResult>
  /** Open one artifact URL in a new tab (external browser semantics). */
  openArtifact: (category: ArtifactCategory, hash: string) => void
  /** Resolve an artifact's absolute URL (iframes and links alike). */
  artifactUrl: (category: ArtifactCategory, hash: string) => string
}

/** Shared store handle type (type-only alias for components). */
export type DvlViewStore = ReturnType<typeof createDvlViewStore>

/** Injectable face for the learning view: API + notes verbs. */
export interface LearningViewInject {
  readonly api: LearningApi
  readonly notes: NotesActions
}

/** Full learning-view component props: runtime + store + injected face + locale. */
export type LearningViewProps =
  PropsRuntime<'conversation.view'>
  & PropsStore<DvlViewStore>
  & InjectFace<LearningViewInject>
  & PropsLocale<NS>

/** Injectable face for the outline floating card (self-sufficient: store + locale only). */
export interface OutlineCardInject {}

/** Full outline-card props: runtime (header utilities) + store + locale. */
export type OutlineCardProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsStore<DvlViewStore>
  & PropsLocale<NS>

/** Injectable face for the notes floating card. */
export interface NotesCardInject {
  readonly notes: NotesActions
}

/** Full notes-card props: runtime (header utilities) + store + inject + locale. */
export type NotesCardProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsStore<DvlViewStore>
  & InjectFace<{ readonly card: NotesCardInject }>
  & PropsLocale<NS>
