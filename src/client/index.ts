/**
 * DVL browser half：生命周期控制器 + 三个 UI contribution。
 * 控制器自建引擎快照 store（不占框架 store seat），订阅 sessions list
 * 跟踪 active session/cwd——学习域按 cwd 加载，笔记域全局加载一次；
 * 数据源经 inject face 的 hooks 通道绑成 useLearning/useNotes 传给组件。
 * 学习 tab 按当前工作区是否为学习工作区动态注册/注销
 * @module dvl/client
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.locale Context merge (register/bind).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' / header-utilities SlotMap rows + dvlLearning 键
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import { artifactUrl, buildNotesActions, fetchNotes, fetchState, inbandPresent, resolveDescriptor } from './api.ts'
import type { LearningApi, LearningViewInject, NotesActions, NotesCardInject, PresentToolViewInject } from './contract.ts'
import { LearningView } from './LearningView.tsx'
import { en, NS, zh } from './locales.ts'
import { NotesCard } from './NotesCard.tsx'
import { OutlineCard } from './OutlineCard.tsx'
import { PresentArtifactToolView } from './PresentArtifactToolView.tsx'
import { createDvlViewStore, idleLearningDomain, idleNotesDomain } from './stores.ts'
import type { LearningDomain, NotesDomain } from './types.ts'
import { workspaceIdOf, type ArtifactCategory } from './types.ts'

/** Required services; target slots are declared by ui-conversation, so apply waits on them via `slots.inject`. */
export const inject = ['slots', 'sessions', 'workspaces', 'locale']

/** 会话快照里我们关心的字段（结构子集，避免依赖完整类型） */
interface SessionRow { readonly cwd?: string }

/** sessions list 快照的结构子集 */
interface SessionListSnapshot { readonly current?: SessionId; readonly byId?: Record<string, SessionRow> }

/** 学习域数据源形态（hooks 通道的 snapshot） */
type LearningSourceState = { readonly learning: LearningDomain }

/** 笔记域数据源形态 */
type NotesSourceState = { readonly notes: NotesDomain }

/**
 * Compose the learning view tab and the two floating cards
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dvl: dictionaries')
  const t = ctx.locale.bind(NS)
  const store = createDvlViewStore()

  // ── 数据源：引擎快照 store（subscribe/getSnapshot → hooks 通道） ────
  const learningSource: SnapshotStore<LearningSourceState> = createSnapshotStore({ learning: idleLearningDomain() })
  const notesSource: SnapshotStore<NotesSourceState> = createSnapshotStore({ notes: idleNotesDomain() })
  const workspaceSource: SnapshotStore<{ isLearningWorkspace: boolean }> = createSnapshotStore({ isLearningWorkspace: false })

  /** Resolve the session's workspace cwd (session header first, workspace fallback). */
  const resolveCwd = (sessionId: SessionId): string | null => {
    const sessions = ctx.sessions.list.getSnapshot()
    const row = (sessions.byId as Record<string, SessionRow | undefined>)[sessionId]
    if (row?.cwd !== undefined && row.cwd !== '') return row.cwd
    const workspaces = ctx.workspaces.list.getSnapshot()
    const workspace = workspaces.items.find(item => item.sessionIds.includes(sessionId))
    return workspace?.path ?? null
  }

  /** 全局笔记：合并并发，失败写入笔记域 error */
  let notesInFlight: Promise<void> | null = null
  const refreshNotes = (): Promise<void> => {
    if (notesInFlight !== null) return notesInFlight

    const run = (async (): Promise<void> => {
      const previous = notesSource.getSnapshot().notes
      notesSource.set({ notes: { ...previous, phase: 'loading' } })
      try {
        const notes = await fetchNotes()
        notesSource.set({ notes: { phase: 'ready', notes, error: null } })
      } catch (error: unknown) {
        notesSource.set({ notes: { ...previous, phase: 'error', error: error instanceof Error ? error.message : String(error) } })
      } finally {
        notesInFlight = null
      }
    })()
    notesInFlight = run
    return run
  }

  /** 学习域：按 cwd 加载；generation 递增使旧 cwd 的迟到响应失效 */
  let learningGeneration = 0
  const loadLearning = async (cwd: string): Promise<void> => {
    const generation = ++learningGeneration
    const previous = learningSource.getSnapshot().learning
    learningSource.set({ learning: { ...previous, phase: 'loading' } })
    try {
      const state = await fetchState(cwd)
      if (generation !== learningGeneration) return
      learningSource.set({ learning: { phase: 'ready', state, isLearningWorkspace: state.learningDirExists, error: null } })
      workspaceSource.set({ isLearningWorkspace: state.learningDirExists })
    } catch (error: unknown) {
      if (generation !== learningGeneration) return
      const message = error instanceof Error ? error.message : String(error)
      const unknownWorkspace = message.includes('404') && message.includes('unknown workspace')
      if (unknownWorkspace) {
        learningSource.set({ learning: { phase: 'idle', state: null, isLearningWorkspace: false, error: null } })
        workspaceSource.set({ isLearningWorkspace: false })
        return
      }
      learningSource.set({ learning: { ...previous, phase: 'error', error: message } })
      workspaceSource.set({ isLearningWorkspace: false })
    }
  }

  // ── 生命周期控制器：订阅 sessions list，cwd 变化触发学习域加载 ──────
  ctx.effect(() => {
    let lastCwd: string | null | undefined = undefined
    const evaluate = (): void => {
      const snapshot = ctx.sessions.list.getSnapshot() as SessionListSnapshot
      const current = snapshot.current
      const row = current !== undefined ? snapshot.byId?.[current] : undefined
      const cwd = row?.cwd !== undefined && row.cwd !== '' ? row.cwd : null
      if (cwd === lastCwd) return
      lastCwd = cwd
      if (cwd === null) {
        learningSource.set({ learning: { phase: 'idle', state: null, isLearningWorkspace: false, error: null } })
        workspaceSource.set({ isLearningWorkspace: false })
      } else void loadLearning(cwd)
    }

    const unsubscribe = ctx.sessions.list.subscribe(evaluate)
    evaluate()
    void refreshNotes()
    return () => { unsubscribe() }
  }, 'dvl: lifecycle controller')

  /** Build the per-session learning API face (fetch + present + artifact URLs). */
  const makeApi = (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createDvlViewStore>>): LearningApi => {
    let workspaceId: string | null = null
    const refresh = async (): Promise<void> => {
      const cwd = resolveCwd(sessionId)
      if (cwd === null) throw new Error('dvl: session has no workspace cwd')
      const state = await fetchState(cwd)
      workspaceId = state.workspaceId
      learningSource.set({ learning: { phase: 'ready', state, isLearningWorkspace: state.learningDirExists, error: null } })
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
      artifactUrl(workspaceId ?? '', category, hash)
    return {
      refresh,
      inbandPresent: async (category, hash, targetSessionId) => {
        const ws = await ensureWorkspaceId()
        if (ws === null) throw new Error('dvl: session has no workspace cwd')
        return inbandPresent(ws, category, hash, targetSessionId)
      },
      openArtifact: (category, hash) => { window.open(urlFor(category, hash), '_blank', 'noopener') },
      artifactUrl: urlFor,
    }
  }

  const makeNotes = (): NotesActions => buildNotesActions(refreshNotes)

  // ── 学习 tab：订阅 workspaceSource，动态注册/注销 ───────────────────
  ctx.effect(() => {
    let disposeView: (() => void) | null = null
    const evaluate = (): void => {
      const isLearning = workspaceSource.getSnapshot().isLearningWorkspace
      if (isLearning && disposeView === null) {
        disposeView = ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'vibe-learning',
          order: 20,
          locale: NS,
          label: () => t('view.label'),
          store,
          inject: (sessionId, actions): LearningViewInject => ({
            api: makeApi(sessionId, actions),
            notes: makeNotes(),
            hooks: { learning: learningSource },
          }),
        }, LearningView))
      } else if (!isLearning && disposeView !== null) {
        disposeView()
        disposeView = null
      }
    }
    const unsubscribe = workspaceSource.subscribe(evaluate)
    evaluate()
    return () => {
      unsubscribe()
      disposeView?.()
    }
  }, 'dvl: learning view tab')

  // ── 两张面板：常驻注册，组件按 projection/域状态显隐 ────────────────
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'vibe-learning-outline-card',
    order: 30,
    locale: NS,
    store,
    inject: (): { hooks: { learning: SnapshotStore<LearningSourceState> } } => ({ hooks: { learning: learningSource } }),
  }, OutlineCard))

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'vibe-learning-notes-card',
    order: 40,
    locale: NS,
    store,
    inject: (): { card: NotesCardInject; hooks: { notes: SnapshotStore<NotesSourceState> } } =>
      ({ card: { notes: makeNotes() }, hooks: { notes: notesSource } }),
  }, NotesCard))

  // The keyed present_artifact toolview: running = expanded iframe (canonical
  // run URL from the server descriptor), settled = collapsed record line.
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'present_artifact',
    locale: NS,
    store,
    inject: (): PresentToolViewInject => ({
      resolveDescriptor: (cwd, callId) => resolveDescriptor(cwd, callId),
    }),
  }, PresentArtifactToolView))
}
