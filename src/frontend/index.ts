// DVL 浏览器端：负责生命周期控制、学习/笔记数据源，以及三个 UI contribution

import type {ClientContext, SessionId} from '@deepseek-ai/dsh-client-runtime/client'
import {createSnapshotStore, type SnapshotStore} from '@deepseek-ai/dsh-client-runtime/client'
import '@deepseek-ai/dsh-client-locale/client' // 仅用于合并 ctx.locale 的 Context 类型
import '@deepseek-ai/dsh-client-ui-conversation/client' // 仅用于合并 conversation.view、header utilities 等 SlotMap 类型
import type {BoundActions} from '@deepseek-ai/dsh-client-ui-slots'
import {artifactUrl, buildNotesActions, fetchNotes, fetchState, inbandPresent, resolveDescriptor} from './api.ts'
import type {LearningApi, LearningViewInject, NotesActions, NotesCardInject, PresentToolViewInject} from './contract.ts'
// @ts-ignore：傻逼IDEA
import {LearningView} from './LearningView.tsx'
import {en, NS, zh} from './locales.ts'
// @ts-ignore：傻逼IDEA
import {NotesCard} from './NotesCard.tsx'
// @ts-ignore：傻逼IDEA
import {OutlineCard} from './OutlineCard.tsx'
// @ts-ignore：傻逼IDEA
import {PresentArtifactToolView} from './PresentArtifactToolView.tsx'
import {createDvlViewStore, idleLearningDomain, idleNotesDomain} from './stores.ts'
import type {ArtifactCategory} from '../shared/artifacts.ts'
import type {LearningDomain, NotesDomain} from './state.ts'

// 必需服务，目标 slot 由 ui-conversation 声明，因此 apply 会通过 slots.inject 等待它们
export const inject = ['slots', 'sessions', 'workspaces', 'locale']

// 会话快照中实际使用的字段子集
interface SessionRow {
  readonly cwd?: string
}

// sessions list 快照中实际使用的字段子集
interface SessionListSnapshot {
  readonly current?: SessionId
  readonly byId?: Record<string, SessionRow>
}

// 学习域 hooks 数据源快照
type LearningSourceState = {readonly learning: LearningDomain}

// 笔记域 hooks 数据源快照
type NotesSourceState = {readonly notes: NotesDomain}

// 注册学习视图与两张常驻面板，并维护对应的数据生命周期
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, {zh, en}), 'dvl: dictionaries')
  const t = ctx.locale.bind(NS)
  const store = createDvlViewStore()

  // 数据源：引擎快照 store 经 hooks 通道提供给组件
  const learningSource: SnapshotStore<LearningSourceState> = createSnapshotStore({learning: idleLearningDomain()})
  const notesSource: SnapshotStore<NotesSourceState> = createSnapshotStore({notes: idleNotesDomain()})
  const workspaceSource: SnapshotStore<{isLearningWorkspace: boolean}> = createSnapshotStore({isLearningWorkspace: false})

  // 解析会话所属工作区 cwd，优先使用会话头，缺失时回退到工作区列表
  const resolveCwd = (sessionId: SessionId): string | null => {
    const sessions = ctx.sessions.list.getSnapshot()
    const row = (sessions.byId as Record<string, SessionRow | undefined>)[sessionId]
    if (row?.cwd !== undefined && row.cwd !== '') return row.cwd

    const workspaces = ctx.workspaces.list.getSnapshot()
    const workspace = workspaces.items.find(item => item.sessionIds.includes(sessionId))
    return workspace?.path ?? null
  }

  // 刷新全局笔记并合并并发请求，失败时将错误写入笔记域
  let notesInFlight: Promise<void> | null = null
  const refreshNotes = (): Promise<void> => {
    if (notesInFlight !== null) return notesInFlight

    const run = (async (): Promise<void> => {
      const previous = notesSource.getSnapshot().notes
      notesSource.set({notes: {...previous, phase: 'loading'}})

      try {
        const notes = await fetchNotes()
        notesSource.set({notes: {phase: 'ready', notes, error: null}})
      } catch (error: unknown) {
        notesSource.set({notes: {...previous, phase: 'error', error: error instanceof Error ? error.message : String(error)}})
      } finally {
        notesInFlight = null
      }
    })()

    notesInFlight = run
    return run
  }

  // 按 cwd 加载学习域，generation 用于丢弃旧 cwd 的迟到响应
  let learningGeneration = 0
  const loadLearning = async (cwd: string): Promise<void> => {
    const generation = ++learningGeneration
    const previous = learningSource.getSnapshot().learning
    learningSource.set({learning: {...previous, phase: 'loading'}})

    try {
      const state = await fetchState(cwd)
      if (generation !== learningGeneration) return

      learningSource.set({learning: {phase: 'ready', state, isLearningWorkspace: state.learningDirExists, error: null}})
      workspaceSource.set({isLearningWorkspace: state.learningDirExists})
    } catch (error: unknown) {
      if (generation !== learningGeneration) return

      const message = error instanceof Error ? error.message : String(error)
      const unknownWorkspace = message.includes('404') && message.includes('未知的工作区')

      if (unknownWorkspace) {
        learningSource.set({learning: {phase: 'idle', state: null, isLearningWorkspace: false, error: null}})
        workspaceSource.set({isLearningWorkspace: false})
        return
      }

      learningSource.set({learning: {...previous, phase: 'error', error: message}})
      workspaceSource.set({isLearningWorkspace: false})
    }
  }

  // 生命周期控制器：订阅 sessions list，并在 cwd 变化时重新加载学习域
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
        learningSource.set({learning: {phase: 'idle', state: null, isLearningWorkspace: false, error: null}})
        workspaceSource.set({isLearningWorkspace: false})
      } else void loadLearning(cwd)
    }

    const unsubscribe = ctx.sessions.list.subscribe(evaluate)
    evaluate()
    void refreshNotes()
    return () => unsubscribe()
  }, 'dvl: lifecycle controller')

  // 构造单个会话使用的学习 API，包括刷新、展示和工件 URL
  const makeApi = (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createDvlViewStore>>): LearningApi => {
    let workspaceId: string | null = null

    const refresh = async (): Promise<void> => {
      const cwd = resolveCwd(sessionId)
      if (cwd === null) throw new Error('DVL：当前会话没有工作区 cwd')

      const state = await fetchState(cwd)
      workspaceId = state.workspaceId
      learningSource.set({learning: {phase: 'ready', state, isLearningWorkspace: state.learningDirExists, error: null}})
    }

    const ensureWorkspaceId = async (): Promise<string | null> => {
      if (workspaceId !== null) return workspaceId

      const cwd = resolveCwd(sessionId)
      if (cwd === null) return null

      const current = learningSource.getSnapshot().learning.state
      if (current?.cwd === cwd) {
        workspaceId = current.workspaceId
        return workspaceId
      }

      await refresh()
      return workspaceId
    }

    const knownWorkspaceId = (): string => {
      if (workspaceId !== null) return workspaceId
      const cwd = resolveCwd(sessionId)
      const state = learningSource.getSnapshot().learning.state
      return cwd !== null && state?.cwd === cwd ? state.workspaceId : ''
    }

    const urlFor = (category: ArtifactCategory, hash: string): string => artifactUrl(knownWorkspaceId(), category, hash)

    return {
      refresh,
      inbandPresent: async (category, hash, targetSessionId) => {
        const ws = await ensureWorkspaceId()
        if (ws === null) throw new Error('DVL：当前会话没有工作区 cwd')
        return inbandPresent(ws, category, hash, targetSessionId)
      },
      openArtifact: (category, hash) => { window.open(urlFor(category, hash), '_blank', 'noopener') },
      artifactUrl: urlFor,
    }
  }

  const makeNotes = (): NotesActions => buildNotesActions(refreshNotes)

  // 学习 tab：订阅 workspaceSource，并根据当前工作区动态注册或注销
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
          inject: (sessionId, actions): LearningViewInject => ({api: makeApi(sessionId, actions), notes: makeNotes(), hooks: {learning: learningSource}}),
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

  // 两张面板常驻注册，具体显隐由组件根据 projection 与域状态决定
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'vibe-learning-outline-card',
    order: 30,
    locale: NS,
    store,
    inject: (): {hooks: {learning: SnapshotStore<LearningSourceState>}} => ({hooks: {learning: learningSource}}),
  }, OutlineCard))

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'vibe-learning-notes-card',
    order: 40,
    locale: NS,
    store,
    inject: (): {card: NotesCardInject, hooks: {notes: SnapshotStore<NotesSourceState>}} => ({card: {notes: makeNotes()}, hooks: {notes: notesSource}}),
  }, NotesCard))

  // present_artifact 工具视图：运行时展开规范 run URL，结束后折叠为记录行
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'present_artifact',
    locale: NS,
    store,
    inject: (): PresentToolViewInject => ({resolveDescriptor: (cwd, callId) => resolveDescriptor(cwd, callId)}),
  }, PresentArtifactToolView))
}
