// DVL 浏览器端：负责生命周期控制、学习/笔记数据源，以及三个 UI contribution

import type {ClientContext, SessionId} from '@deepseek-ai/dsh-client-runtime/client'
import {createSnapshotStore, type SnapshotStore} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client' // 仅用于合并 ctx.locale 的 Context 类型
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client' // 仅用于合并 conversation.view、header utilities 等 SlotMap 类型
import {abortRun, artifactUrl, buildNotesActions, createDirectRun, deleteLearningEntity, fetchLearningData, fetchLearningWorkspace, fetchNotes, inbandPresentExisting, openDataChangeStream, resolveDescriptor, runUrl, startDueReview} from './api.ts'
import type {LearningApi, LearningViewInject, NotesActions, NotesCardInject, PresentToolViewInject} from './contract.ts'
import {LearningView} from './LearningView.tsx'
import {en, NS, zh} from './locales.ts'
import {NotesCard} from './NotesCard.tsx'
import {OutlineCard} from './OutlineCard.tsx'
import {InBandPresentArtifactView} from './InBandPresentArtifactView.tsx'
import {createDvlViewStore, idleLearningDomain, idleNotesDomain, idleWorkspaceDomain} from './stores.ts'
import type {ArtifactCategory} from '../shared/artifacts.ts'
import type {DataChangeDto} from '../shared/api.ts'
import {CORDIS_EFFECT_DATA_CHANGE_SUBSCRIBER, CORDIS_EFFECT_DICTIONARIES, CORDIS_EFFECT_LEARNING_DATA_CONTROLLER, CORDIS_EFFECT_LEARNING_VIEW_TAB, CORDIS_EFFECT_LIFECYCLE_CONTROLLER, CORDIS_SLOT_CONVERSATION_VIEW, CORDIS_SLOT_SESSION_HEADER_UTILITIES, CORDIS_SLOT_TOOL_CALL_TOOLVIEW, LEARNING_NOTES_CARD_ID, LEARNING_OUTLINE_CARD_ID, LEARNING_VIEW_ID} from '../shared/constants.ts'
import type {LearningSourceState, NotesSourceState, WorkspaceSourceState} from './state.ts'

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

// 注册学习视图与两张常驻面板，并维护对应的数据生命周期。前端的 Cordis
export function apply(ctx: ClientContext): void {
    ctx.effect(() => ctx.locale.register(NS, {zh, en}), CORDIS_EFFECT_DICTIONARIES)

    const t = ctx.locale.bind(NS)
    const store = createDvlViewStore()

    // 数据源：引擎快照 store 经 hooks 通道提供给组件
    const learningSource: SnapshotStore<LearningSourceState> = createSnapshotStore({learning: idleLearningDomain()})
    const notesSource: SnapshotStore<NotesSourceState> = createSnapshotStore({notes: idleNotesDomain()})
    const workspaceSource: SnapshotStore<WorkspaceSourceState> = createSnapshotStore({workspace: idleWorkspaceDomain()})

    // 解析会话所属工作区 cwd，优先使用会话头，缺失时回退到工作区列表。FUCK：和getCurrentSessionCwdOrNull有作用重叠
    const getCwdOrNullBySessionId = (sessionId: SessionId): string | null => {
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

    // 按 cwd 探测工作区能力，generation 用于丢弃旧 cwd 的迟到响应
    let workspaceGeneration = 0
    const loadLearningWorkspace = async (cwd: string): Promise<void> => {
        const generation = ++workspaceGeneration

        try {
            const workspace = await fetchLearningWorkspace(cwd)
            if (generation !== workspaceGeneration) return
            workspaceSource.set({workspace: {cwd, workspaceId: workspace.workspaceId, isLearningWorkspace: workspace.isLearningWorkspace}})
        } catch (error: unknown) {
            if (generation !== workspaceGeneration) return
            workspaceSource.set({workspace: {cwd, workspaceId: null, isLearningWorkspace: false}})
        }
    }

    // 按 cwd 加载学习域，generation 用于丢弃旧 cwd 的迟到响应
    let learningGeneration = 0
    const loadLearningData = async (cwd: string): Promise<void> => {
        const generation = ++learningGeneration

        const previous = learningSource.getSnapshot().learning
        learningSource.set({learning: {...previous, phase: 'loading'}})

        try {
            const data = await fetchLearningData(cwd)
            if (generation !== learningGeneration) return

            learningSource.set({learning: {phase: 'ready', data, error: null}})
        } catch (error: unknown) {
            if (generation !== learningGeneration) return

            const message = error instanceof Error ? error.message : String(error)
            const unknownWorkspace = message.includes('404') && message.includes('未知的工作区')

            if (unknownWorkspace) {
                learningSource.set({learning: {phase: 'idle', data: null, error: null}})
                return
            }

            learningSource.set({learning: {...previous, phase: 'error', error: message}})
        }
    }

    // TIPS：生命周期控制器：订阅 sessions list，cwd 变化时重载
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
                workspaceSource.set({workspace: idleWorkspaceDomain()})
            } else void loadLearningWorkspace(cwd)
        }

        void refreshNotes()

        const disposer = ctx.sessions.list.subscribe(evaluate)
        evaluate()

        return disposer
    }, CORDIS_EFFECT_LIFECYCLE_CONTROLLER)

    // 构造单个会话使用的学习 API，包括刷新、展示和工件 URL
    const makeApi = (sessionId: SessionId): LearningApi => {
        const refresh = async (): Promise<void> => {
            const cwd = getCwdOrNullBySessionId(sessionId)
            if (cwd === null) throw new Error('DVL（前端）：当前会话没有工作区 cwd')

            await loadLearningData(cwd)
        }

        const ensureWorkspaceId = async (): Promise<string | null> => {
            const cwd = getCwdOrNullBySessionId(sessionId)
            if (cwd === null) return null

            const workspace = workspaceSource.getSnapshot().workspace
            if (workspace.cwd === cwd && workspace.workspaceId !== null) return workspace.workspaceId

            await loadLearningWorkspace(cwd)
            const next = workspaceSource.getSnapshot().workspace
            return next.cwd === cwd ? next.workspaceId : null
        }

        const knownWorkspaceId = (): string => {
            const cwd = getCwdOrNullBySessionId(sessionId)
            const workspace = workspaceSource.getSnapshot().workspace
            return cwd !== null && workspace.cwd === cwd ? workspace.workspaceId ?? '' : ''
        }

        const urlFor = (category: ArtifactCategory, hash: string): string => artifactUrl(knownWorkspaceId(), category, hash)

        return {
            refresh,
            createDirectRun: async (category, hash) => {
                const ws = await ensureWorkspaceId()
                if (ws === null) throw new Error('DVL：当前会话没有工作区 cwd')
                return createDirectRun(ws, category, hash)
            },
            abortRun: async (category, hash, runId) => {
                const ws = await ensureWorkspaceId()
                if (ws === null) throw new Error('DVL：当前会话没有工作区 cwd')
                await abortRun(ws, category, hash, runId)
            },
            inbandPresentExisting: async (category, hash, targetSessionId, runId) => {
                const ws = await ensureWorkspaceId()
                if (ws === null) throw new Error('DVL：当前会话没有工作区 cwd')
                return inbandPresentExisting(ws, category, hash, targetSessionId, runId)
            },
            startDueReview: async (planId, targetSessionId) => {
                const ws = await ensureWorkspaceId()
                if (ws === null) throw new Error('DVL：当前会话没有工作区 cwd')
                return startDueReview(ws, planId, targetSessionId)
            },
            deleteOutline: async id => {
                const ws = await ensureWorkspaceId()
                if (ws === null) throw new Error('DVL：当前会话没有工作区 cwd')
                await deleteLearningEntity(ws, {target: 'outline', id})
            },
            deleteReviewPlan: async (id, preserveArtifacts) => {
                const ws = await ensureWorkspaceId()
                if (ws === null) throw new Error('DVL：当前会话没有工作区 cwd')
                await deleteLearningEntity(ws, {target: 'review-plan', id, preserveArtifacts})
            },
            deleteArtifact: async (category, hash) => {
                const ws = await ensureWorkspaceId()
                if (ws === null) throw new Error('DVL：当前会话没有工作区 cwd')
                await deleteLearningEntity(ws, {target: 'artifact', category, hash})
            },
            openRun: (category, hash, runId) => { window.open(runUrl(knownWorkspaceId(), category, hash, runId), '_blank', 'noopener') },
            artifactUrl: urlFor,
        }
    }

    const makeNotes = (): NotesActions => buildNotesActions()

    // TIPS：当前选中会话的 cwd；无工作区时返回 null
    const getCurrentSessionCwdOrNull = (): string | null => {
        const snapshot = ctx.sessions.list.getSnapshot() as SessionListSnapshot
        const current = snapshot.current
        const row = current !== undefined ? snapshot.byId?.[current] : undefined
        return row?.cwd !== undefined && row.cwd !== '' ? row.cwd : null
    }

    // 订阅后端数据失效信号，只触发重新拉取，不在前端推导第二套业务状态
    ctx.effect(() => {
        const onChange = (change: DataChangeDto): void => {
            if (change.channel === 'notes') { void refreshNotes(); return }
            if (change.channel === 'reset') {
                const cwd = getCurrentSessionCwdOrNull()
                if (cwd !== null) void loadLearningWorkspace(cwd)
                void refreshNotes()
                return
            }
            const workspace = workspaceSource.getSnapshot().workspace
            if (change.workspaceId !== workspace.workspaceId) return

            const cwd = getCurrentSessionCwdOrNull()
            if (cwd === null) return
            if (change.channel === 'workspace') void loadLearningWorkspace(cwd)
            else if (workspace.isLearningWorkspace) void loadLearningData(cwd)
        }

        const source = openDataChangeStream(onChange)
        return () => source.close()
    }, CORDIS_EFFECT_DATA_CHANGE_SUBSCRIBER)

    // 学习数据控制器：只看工作区域能力；能力变化时加载或重置学习内容
    ctx.effect(() => {
        let lastIdentity: string | null = null

        const evaluate = (): void => {
            const workspace = workspaceSource.getSnapshot().workspace
            const identity = `${workspace.cwd ?? ''}|${workspace.workspaceId ?? ''}|${workspace.isLearningWorkspace}`
            if (identity === lastIdentity) return

            lastIdentity = identity
            if (workspace.cwd === null || !workspace.isLearningWorkspace) {
                learningSource.set({learning: idleLearningDomain()})
                return
            }

            void loadLearningData(workspace.cwd)
        }

        const disposer = workspaceSource.subscribe(evaluate)
        evaluate()
        return disposer
    }, CORDIS_EFFECT_LEARNING_DATA_CONTROLLER)

    // TIPS：学习 tab：【订阅 workspaceSource】，并根据当前工作区动态注册或注销
    ctx.effect(() => {
        let viewDisposer: (() => void) | null = null

        const evaluate = (): void => {
            // 是学习工作区就挂，反之消
            const isLearningWorkspace = workspaceSource.getSnapshot().workspace.isLearningWorkspace

            if (isLearningWorkspace && viewDisposer === null) {
                // 注册UI槽位
                viewDisposer = ctx.slots.inject(CORDIS_SLOT_CONVERSATION_VIEW, () => ctx.slots.register({
                    name: CORDIS_SLOT_CONVERSATION_VIEW, id: LEARNING_VIEW_ID, order: 20, locale: NS, label: () => t('view.label'), store,
                    inject: (sessionId, _): LearningViewInject => ({api: makeApi(sessionId), notes: makeNotes(), hooks: {learning: learningSource}}),
                }, LearningView))
            } else if (!isLearningWorkspace && viewDisposer !== null) {
                viewDisposer()
                viewDisposer = null
            }
        }

        const unsubscribe = workspaceSource.subscribe(evaluate)
        evaluate()

        return () => {
            unsubscribe()
            viewDisposer?.()
        }
    }, CORDIS_EFFECT_LEARNING_VIEW_TAB)

    // TIPS：两张面板【常驻注册】，具体显隐由组件根据 projection 与域状态决定
    // TODO：改到更好的挂载点

    ctx.slots.inject(CORDIS_SLOT_SESSION_HEADER_UTILITIES, () => ctx.slots.register({
        name: CORDIS_SLOT_SESSION_HEADER_UTILITIES, id: LEARNING_OUTLINE_CARD_ID, order: 30, locale: NS, store,
        inject: (): { hooks: { learning: SnapshotStore<LearningSourceState> } } => ({hooks: {learning: learningSource}}),
    }, OutlineCard))

    ctx.slots.inject(CORDIS_SLOT_SESSION_HEADER_UTILITIES, () => ctx.slots.register({
        name: CORDIS_SLOT_SESSION_HEADER_UTILITIES, id: LEARNING_NOTES_CARD_ID, order: 40, locale: NS, store,
        inject: (): { card: NotesCardInject, hooks: { notes: SnapshotStore<NotesSourceState> } } => ({card: {notes: makeNotes()}, hooks: {notes: notesSource}}),
    }, NotesCard))

    // TIPS：挂载 IN-BAND工件展现 视图
    ctx.slots.inject(CORDIS_SLOT_TOOL_CALL_TOOLVIEW, () => ctx.slots.register({
        name: CORDIS_SLOT_TOOL_CALL_TOOLVIEW, key: 'present_artifact', locale: NS, store,
        inject: (): PresentToolViewInject => ({resolveDescriptor: (cwd, callId) => resolveDescriptor(cwd, callId), abortRun: async descriptor => abortRun(descriptor.workspaceId, descriptor.kind === 'lesson' ? 'lessons' : descriptor.kind === 'review' ? 'reviews' : 'quizzes', descriptor.hash, descriptor.runId)}),
    }, InBandPresentArtifactView))
}
