/**
 * DVL browser half: one `conversation.view` tab (the learning view) plus two
 * floating session-header cards (current outline + notes). All three share
 * one store handle (one instance per session) built in `apply`; the inject
 * factories close over `ctx` to resolve the session's workspace cwd and reach
 * the local artifact server over `fetch`.
 * @module dvl/client
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.locale Context merge (register/bind).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' / header-utilities SlotMap rows.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import {
  artifactUrl, buildNotesActions, DEFAULT_PORT, fetchState, inbandPresent, originOf,
} from './api.ts'
import type { DvlViewStore, LearningApi, LearningViewInject, NotesActions, NotesCardInject } from './contract.ts'
import { LearningView } from './LearningView.tsx'
import { en, NS, zh } from './locales.ts'
import { NotesCard } from './NotesCard.tsx'
import { OutlineCard } from './OutlineCard.tsx'
import { createDvlViewStore } from './stores.ts'
import { workspaceIdOf, type ArtifactCategory } from './types.ts'

/** Required services; target slots are declared by ui-conversation, so apply waits on them via `slots.inject`. */
export const inject = ['slots', 'sessions', 'workspaces', 'locale']

/**
 * Compose the learning view tab and the two floating cards. Each contribution
 * rides `slots.inject` so it installs once the owner declares the slot and
 * leaves with the caller's fiber.
 * @param ctx - client root context.
 * @param config - optional client-half config; `port` must match the host artifact-server port.
 */
export function apply(ctx: ClientContext, config?: { port?: number }): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dvl: dictionaries')
  const t = ctx.locale.bind(NS)
  const origin = originOf(config?.port ?? DEFAULT_PORT)
  const store = createDvlViewStore()

  /** Resolve the session's workspace cwd (session header first, workspace fallback). */
  const resolveCwd = (sessionId: SessionId): string | null => {
    const sessions = ctx.sessions.list.getSnapshot()
    const cwd = sessions.byId[sessionId]?.cwd
    if (cwd !== undefined && cwd !== '') return cwd
    const workspaces = ctx.workspaces.list.getSnapshot()
    const workspace = workspaces.items.find(item => item.sessionIds.includes(sessionId))
    return workspace?.path ?? null
  }

  /** Build the per-session learning API face (fetch + present + artifact URLs). */
  const makeApi = (sessionId: SessionId, actions: BoundActions<DvlViewStore>): LearningApi => {
    let workspaceId: string | null = null
    const refresh = async (): Promise<void> => {
      const cwd = resolveCwd(sessionId)
      if (cwd === null) throw new Error('dvl: session has no workspace cwd')
      const state = await fetchState(origin, cwd)
      workspaceId = state.workspaceId
      actions.setLearningState(state)
    }
    const ensureWorkspaceId = async (): Promise<string | null> => {
      if (workspaceId !== null) return workspaceId
      const cwd = resolveCwd(sessionId)
      if (cwd === null) return null
      const id = await workspaceIdOf(cwd)
      workspaceId = id
      return id
    }
    const urlFor = (category: ArtifactCategory, hash: string): string =>
      artifactUrl(origin, workspaceId ?? '', category, hash)
    return {
      refresh,
      inbandPresent: async (category, hash, targetSessionId) => {
        const ws = await ensureWorkspaceId()
        if (ws === null) throw new Error('dvl: session has no workspace cwd')
        return inbandPresent(origin, ws, category, hash, targetSessionId)
      },
      openArtifact: (category, hash) => { window.open(urlFor(category, hash), '_blank', 'noopener') },
      artifactUrl: urlFor,
    }
  }

  const makeNotes = (api: LearningApi): NotesActions => buildNotesActions(origin, api.refresh)

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'vibe-learning',
    order: 20,
    locale: NS,
    label: () => t('view.label'),
    store,
    inject: (sessionId, actions): LearningViewInject => {
      const api = makeApi(sessionId, actions)
      return { api, notes: makeNotes(api) }
    },
  }, LearningView))

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'vibe-learning-outline-card',
    order: 30,
    locale: NS,
    store,
  }, OutlineCard))

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'vibe-learning-notes-card',
    order: 40,
    locale: NS,
    store,
    inject: (sessionId, actions): { card: NotesCardInject } => {
      const api = makeApi(sessionId, actions)
      return { card: { notes: makeNotes(api) } }
    },
  }, NotesCard))
}
