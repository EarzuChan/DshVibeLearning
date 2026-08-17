/**
 * DVL browser-half slot contracts: the injected business face for the
 * `conversation.view` learning entry and the two floating cards. The face
 * carries only plain data and callbacks (the fetch/notes logic lives in the
 * apply closure; components never touch ctx or subscribe to business data —
 * Fetched state is read through the store seat).
 * @module dvl/client/contract
 */

import type { PropsRuntime, PropsStore, InjectFace, PropsLocale, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge, so the
// 'conversation.view' / 'conversation.session.header.utilities' keys type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the keyed 'tool.call.toolview' slot + owner props.
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {
  ArtifactCategory, InbandPresentResult, LearningDomain, NotesDomain, PresentArtifactDescriptorDto,
} from './types.ts'
import type { createDvlViewStore } from './stores.ts'
import {NoteAccess} from "../shared/types.ts"

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
    access: NoteAccess
  }) => Promise<void>
  updateNote: (noteId: string, input: {
    folderId?: string
    title?: string
    markdown?: string
    tags?: string[]
    access?: NoteAccess
  }) => Promise<void>
  deleteNote: (noteId: string) => Promise<void>
}

/** The API client face injected into the learning view entry. */
export interface LearningApi {
  /** Re-fetch the learning state into the shared store; throws on failure. */
  refresh: () => Promise<void>
  /** Run an in-band present request; returns the server's settlement. */
  inbandPresent: (category: ArtifactCategory, hash: string, sessionId: string) => Promise<InbandPresentResult>
  /** Open one artifact read-only preview URL in a new tab. */
  openArtifact: (category: ArtifactCategory, hash: string) => void
  /** Resolve an artifact's read-only preview URL (submission disabled). */
  artifactUrl: (category: ArtifactCategory, hash: string) => string
}

/** Shared store handle type (type-only alias for components). */
export type DvlViewStore = ReturnType<typeof createDvlViewStore>

/** 学习域数据源的 snapshot 形态 */
export interface LearningSourceSnapshot { readonly learning: LearningDomain }

/** 笔记域数据源的 snapshot 形态 */
export interface NotesSourceSnapshot { readonly notes: NotesDomain }

/** Injectable face for the learning view: API + notes verbs + learning 数据源. */
export interface LearningViewInject {
  readonly api: LearningApi
  readonly notes: NotesActions
  // hooks 通道必须是内联字面量（InjectFace 的模式匹配要求）
  readonly hooks: { readonly learning: HostObservable<LearningSourceSnapshot> }
}

/** Full learning-view component props: runtime + store + injected face + locale. */
export type LearningViewProps =
  PropsRuntime<'conversation.view'>
  & PropsStore<DvlViewStore>
  & InjectFace<LearningViewInject>
  & PropsLocale<NS>

/** Injectable face for the outline floating card（learning 数据源走 hooks） */
export interface OutlineCardInject {}

/** Full outline-card props: runtime (header utilities) + store + inject + locale. */
export type OutlineCardProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsStore<DvlViewStore>
  & InjectFace<{ readonly hooks: { readonly learning: HostObservable<LearningSourceSnapshot> } }>
  & PropsLocale<NS>

/** Injectable face for the notes floating card. */
export interface NotesCardInject {
  readonly notes: NotesActions
}

/** Full notes-card props: runtime (header utilities) + store + inject + locale. */
export type NotesCardProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsStore<DvlViewStore>
  & InjectFace<{ readonly card: NotesCardInject; readonly hooks: { readonly notes: HostObservable<NotesSourceSnapshot> } }>
  & PropsLocale<NS>

/** Injectable face for the keyed `present_artifact` toolview. */
export interface PresentToolViewInject {
  /** Resolve a running present's canonical descriptor by `cwd + callId`. */
  resolveDescriptor: (cwd: string, callId: string) => Promise<PresentArtifactDescriptorDto | null>
}

/** Full `present_artifact` toolview props: runtime + store + inject + locale. */
export type PresentToolViewProps =
  ToolCallViewProps
  & PropsStore<DvlViewStore>
  & InjectFace<PresentToolViewInject>
  & PropsLocale<NS>
