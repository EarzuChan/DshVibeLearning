// DVL 核心学习服务：管理工作区文件、全局笔记、FSRS、会话入口、prompt 注入、运行生命周期、展示描述符与复习计划

import {homedir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Service, type Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'
import type {Agent, PreStepDecision} from '@deepseek-ai/dsh-agent'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {LearningFiles} from './files.ts'
import {newCard, nextCard, stateLabel} from './fsrs.ts'
import type {Card} from 'ts-fsrs'
import {NotesStore} from './notes.ts'
import {dvlLearningProjection} from './projection.ts'
import {BOOT_LINE, FULL_GUIDE, renderSnapshot} from './prompt.ts'
import {installLearningTools} from '../tool/index.ts'
import {recordWorkspaceHashIdByGeneratingItFromItsCwd} from '../the-so-called-backend/workspace-hash-id-related.ts'
import {isSafeSegment, generateWorkspaceHashIdOf} from './identifiers.ts'
import {recordLearningEnteredToSession, recordLearningOutlineChangeToSession} from './learning-event.ts'
import {ARTIFACT_CATEGORY_BY_KIND, type ArtifactKind} from '../shared/artifacts.ts'
import type {PresentArtifactDescriptor} from '../shared/api.ts'
import type {Outline, OutlineNode, ReviewRating, ReviewRecord} from '../shared/model.ts'
import {LEARNING_ROUTE_PREFIX} from '../shared/routes.ts'
import type {ArtifactRun, CardFile, FeedbackEnvelope, LearningSnapshot, PresentOutcome, ResultEnvelope, ReviewPlanProposal} from './types.ts'
import type {SessionDvlLearningState} from '../shared/projection.ts'

declare module '@deepseek-ai/cordis' {
    interface Context {
        learning: LearningService
    }
}

// 插件配置均为可选项，默认值保证插件可直接使用
export interface Config {
    readonly dataDir?: string // 全局 DVL 数据目录，用于笔记，默认为 ~/.dsh-vibe-learning
    readonly presentTimeoutMs?: number // IN-BAND展示等待提交的最长时间
}

interface PendingPresent {
    outcome?: PresentOutcome
    readonly waiters: Array<(outcome: PresentOutcome) => void>
}

// 展示运行期间按 DSH 工具 callId 登记的描述符
interface DescriptorEntry {
    readonly cwd: string
    readonly descriptor: PresentArtifactDescriptor
}

// 每个实时 Agent 的学习准备状态，turn gate 保证同一轮只确认与挂载一次，激活纲目变化时只重建快照
interface AgentPreparation {
    confirmedTurn: number,
    snapshot: LearningSnapshot
}

const learningToolsEnabledAgents = new WeakSet<Agent>()

interface NormalizedOutlineInput {
    readonly title: string
    readonly nodes: OutlineNode[]
}

// 构造插件注入的用户消息
function noticeMessage(text: string) {
    return createUserMessage({content: [{type: 'text', text}], source: {kind: 'plugin', plugin: 'learning'}})
}

// DVL 学习服务，每个宿主进程一个实例，会话工具、命令与工件服务分别由其他模块挂载
export class LearningService extends Service {
    static Config: z<Config> = z.object({dataDir: z.string().default(join(homedir(), '.dsh-vibe-learning')), presentTimeoutMs: z.number().default(3_600_000)})

    readonly notes: NotesStore // 插件全局数据目录上的笔记存储
    private readonly pending = new Map<string, PendingPresent>()
    private readonly descriptors = new Map<string, DescriptorEntry>()
    private readonly preparations = new WeakMap<Agent, AgentPreparation>()

    constructor(ctx: Context, public config: Config) {
        super(ctx, 'learning') // “占领”一个Ctx上的命名空间

        // 笔记
        this.notes = new NotesStore(config.dataDir ?? join(homedir(), '.dsh-vibe-learning'))

        // 系统Prompt
        ctx.inject(['systemPrompt'], (scope: Context) => {
            scope.systemPrompt.context({
                name: 'dvl:learning', order: 130, text: context => {
                    const agent = context.agent
                    if (agent === undefined) return ''
                    return this.getCurrentSessionDvlLearningState(agent).entered ? FULL_GUIDE : BOOT_LINE
                }
            })
        })

        // 氛围学习数据的投影。TODO、CHECK：最好也和【getCurrentSessionLearningState】统一命名
        ctx.inject(['sessionProjections'], (scope: Context) => {
            scope.sessionProjections.register(dvlLearningProjection)
        })

        // 每Step的昨天注入
        ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
            const learningState = await this.runPreStepHookAndGetLearningState(payload.agent, payload.turn, payload.signal)

            const decision = await next()
            if (decision.kind === 'reject' || payload.signal.aborted || !learningState.entered) return decision

            const snapshot = this.preparations.get(payload.agent)?.snapshot
            if (snapshot?.activeOutlineId !== learningState.activeOutlineId) throw new Error('快照的活跃大纲竟于状态的不同！出岔子了，不再注入快照')

            // FIXME：这玩意的注入太频繁，应该搞成变了才注入
            const text = renderSnapshot(snapshot)
            return {kind: 'enter', messages: [...decision.messages, createUserMessage({content: [{type: 'text', text}], source: {kind: 'plugin', plugin: 'learning', form: 'snapshot', sections: [{name: 'dvl:snapshot', text}]}})],} // CHECK
        }, {prepend: true})
    }

    // CHECK：这是什么鬼
    protected async [Service.init]() {
        await this.notes.load()
    }

    // ---

    // 从官方 session projection 取会话学习状态
    getCurrentSessionDvlLearningState(agent: Agent): SessionDvlLearningState {
        const projections = this.ctx.get('sessionProjections')

        const defaultOne = {entered: false, activeOutlineId: null}

        if (projections === undefined) return defaultOne // 无则快速返假
        return projections.snapshot(agent.session).values.dvlLearning ?? defaultOne
    }

    // 模型请求前的唯一准备入口：turn gate 内确认工作区、注册学习工具；失败时阻断该步骤
    private async runPreStepHookAndGetLearningState(agent: Agent, turn: number, signal: AbortSignal): Promise<SessionDvlLearningState> {
        const preparation = this.preparations.get(agent)
        const state = this.getCurrentSessionDvlLearningState(agent)
        const confirmedThisTurn = preparation?.confirmedTurn === turn

        if (confirmedThisTurn && preparation?.snapshot.activeOutlineId === state.activeOutlineId) return state // 已准备过**且纲目未变**，early ret

        // ---下面是Pre**Turn**（而非Step）之作为---

        const cwd = this.getCurrentSessionCwd(agent)
        if (cwd === null) {
            if (!state.entered) return state
            throw new Error('学习会话竟无工作区目录，无法继续')
        }

        const files = this.filesFor(cwd)
        if (state.entered && !confirmedThisTurn) await files.requireCurrentLearningWorkspaceAndAllOutlinesReallyAvailable(state.activeOutlineId) // 检测工作区
        else if (state.entered && confirmedThisTurn && state.activeOutlineId !== null) await files.requireCurrentLearningWorkspaceAndSpecificOutlineReallyAvailable(state.activeOutlineId) // 同轮只确认新激活纲目，不重复扫工作区

        if (!state.entered || signal.aborted) return state

        // 未装载工具则确保装载一手。仅在此挂载，别无分号
        if (!learningToolsEnabledAgents.has(agent)) {
            agent.ctx.effect(() => installLearningTools(this.ctx, agent.ctx, agent), 'dvl.tools()')
            learningToolsEnabledAgents.add(agent)
        }

        this.preparations.set(agent, {confirmedTurn: turn, snapshot: await this.snapshot(cwd, state.activeOutlineId)})
        return state
    }

    // 获取会话头中的工作区 cwd，不存在时返回 null
    getCurrentSessionCwd(agent: Agent): string | null {
        return agent.session.header.cwd ?? null
    }

    // TIPS：重要！氛围学习启动点：先确保学习工作区存在，再登记工作区、追加单向事件并唤醒模型
    async enterVibeLearning(agent: Agent, bootMsg: string): Promise<boolean> { // 返回初次与否
        if (this.getCurrentSessionDvlLearningState(agent).entered) return false

        // THINKING：通过bootMsg注入引导Msg太生草了，不是体系化Prompt

        // 如果是首次，会有副作用：

        const cwd = this.getCurrentSessionCwd(agent)
        if (cwd === null) throw new Error('进入氛围学习需要会话有工作区目录')

        await this.filesFor(cwd).createLearningWorkspace() // TIPS：创建工作区目录！

        recordLearningEnteredToSession(agent.session) // 对本会话注入进入氛围学习
        agent.steer(noticeMessage(bootMsg)) // 告诉Agent，目前进入氛围学习

        return true
    }

    // 切换当前会话的激活纲目；null 表示明确确立为没有激活纲目
    async changeCurrentSessionOutline(agent: Agent, outlineId: string | null): Promise<void> {
        if (outlineId !== null) {
           if(!isSafeSegment(outlineId)) throw new Error(`不安全的纲目 ID：${outlineId}`)

            const cwd = this.getCurrentSessionCwd(agent)
            if (cwd === null) throw new Error('切换纲目需要会话有工作区目录')

            if (await this.readOutline(cwd, outlineId) === null) throw new Error(`未知纲目 ${outlineId}，不可切换至！`)
        }

        recordLearningOutlineChangeToSession(agent.session, outlineId)
    }

    // 用插件消息唤醒已进入氛围学习的模型
    notify(agent: Agent, text: string) {
        agent.steer(noticeMessage(text))
    }

    filesFor(cwd: string): LearningFiles {
        return new LearningFiles(cwd)
    }


    // 运行时从 DSH webServer 取我们的基底，服务未就绪时抛错
    private getOriginBase(): string {
        const webServer = this.ctx.get('webServer')
        if (webServer === undefined) throw new Error('DSH webServer 未就绪，无法构造工件 URL')

        // noinspection HttpUrlsUsage，THINKING：如果用户要公网呢？要localhost呢
        return `http://${webServer.host}:${webServer.port}`
    }

    // CHECK：这俩URL的构造，和`the-so-called-backend`是否有重复

    // 构造只读预览 URL，不带 runId 且禁止提交
    getArtifactUrl(cwd: string, kind: ArtifactKind, hash: string): string {
        recordWorkspaceHashIdByGeneratingItFromItsCwd(cwd)
        return `${this.getOriginBase()}${LEARNING_ROUTE_PREFIX}/${generateWorkspaceHashIdOf(cwd)}/${ARTIFACT_CATEGORY_BY_KIND[kind]}/${hash}/index.html`
    }

    // 构造启用提交的规范运行 URL，包含不可猜测的 runId
    getRunUrl(cwd: string, kind: ArtifactKind, hash: string, runId: string): string {
        recordWorkspaceHashIdByGeneratingItFromItsCwd(cwd)
        return `${this.getOriginBase()}${LEARNING_ROUTE_PREFIX}/${generateWorkspaceHashIdOf(cwd)}/${ARTIFACT_CATEGORY_BY_KIND[kind]}/${hash}/runs/${runId}/index.html`
    }

    // ---

    async readOutline(cwd: string, outlineId: string): Promise<Outline | null> {
        return this.filesFor(cwd).readOutline(outlineId)
    }

    async listOutlines(cwd: string): Promise<Outline[]> {
        return this.filesFor(cwd).listOutlines()
    }

    // 将模型生成的纲目树归一为持久化 Outline，补齐稳定 ID，并继承已有课程状态与工件哈希
    normalizeOutline(cwd: string, input: NormalizedOutlineInput, existingId?: string): Promise<Outline> {
        const title = input.title.trim()
        if (title.length === 0) throw new Error('纲目标题不能为空')
        const now = new Date().toISOString()

        return (async (): Promise<Outline> => {
            const previous = existingId === undefined ? null : await this.readOutline(cwd, existingId)
            const previousById = new Map((previous?.nodes ?? []).map(node => [node.id, node]))
            const nodes: OutlineNode[] = input.nodes.map((node, index) => {
                const id = node.id === undefined || node.id.length === 0 ? randomUUID() : node.id
                const prev = previousById.get(id)
                const carried = {...(node.state !== undefined ? {state: node.state} : {}), ...(node.artifactHash !== undefined ? {artifactHash: node.artifactHash} : {})}
                const restored = {...(prev?.state !== undefined ? {state: prev.state} : {}), ...(prev?.artifactHash !== undefined ? {artifactHash: prev.artifactHash} : {})}
                const base: OutlineNode = {
                    id,
                    kind: node.kind === 'lesson' ? 'lesson' : 'group',
                    title: node.title.trim() || `节点 ${index + 1}`,
                    order: typeof node.order === 'number' && Number.isFinite(node.order) ? node.order : index,
                    // 空串视为根：工具 schema 的 string parentId 无法传 null，因此在这里统一归一
                    parentId: node.parentId === undefined || node.parentId === '' ? null : node.parentId,
                    ...(node.description !== undefined && node.description.length > 0 ? {description: node.description} : {}),
                }

                if (base.kind === 'lesson') return {...base, lessonId: node.lessonId ?? prev?.lessonId ?? randomUUID(), ...(carried.state !== undefined || prev?.state !== undefined ? {state: {...restored, ...carried}.state ?? 'not-started' as const} : {state: 'not-started' as const}), ...(carried.artifactHash !== undefined || prev?.artifactHash !== undefined ? {artifactHash: {...restored, ...carried}.artifactHash} : {})}
                return base
            })
            return {id: existingId ?? randomUUID(), title, createdAt: previous?.createdAt ?? now, updatedAt: now, nodes}
        })()
    }

    async saveOutline(cwd: string, outline: Outline): Promise<void> {
        const files = this.filesFor(cwd)
        await files.writeOutline(outline)
        await this.cleanupOrphans(cwd, outline)
    }

    // 清理纲目更新后失去引用的工件与卡片，只保留仍被课程引用或仍属于有效课程的内容
    async cleanupOrphans(cwd: string, outline: Outline): Promise<void> {
        const files = this.filesFor(cwd)
        const lessonIds = new Set(outline.nodes.filter(node => node.kind === 'lesson').map(node => node.lessonId as string))
        const referencedHashes = new Set(outline.nodes.filter(node => node.kind === 'lesson' && node.artifactHash !== undefined).map(node => node.artifactHash as string))

        for (const {hash} of await files.listArtifacts('lesson')) if (!referencedHashes.has(hash)) await files.deleteArtifact('lesson', hash)
        for (const {hash, meta} of await files.listArtifacts('review')) if (!lessonIds.has(meta.targetId)) await files.deleteArtifact('review', hash)
        for (const {hash, meta} of await files.listArtifacts('quiz')) if (!lessonIds.has(meta.targetId)) await files.deleteArtifact('quiz', hash)
        for (const card of await files.listCards()) if (!lessonIds.has(card.lessonId)) await files.deleteCard(card.lessonId)
    }

    // 设置课程节点在纲目文件中的推进状态
    async setLessonState(cwd: string, lessonId: string, state: OutlineNode['state']): Promise<void> {
        const files = this.filesFor(cwd)
        for (const outline of await files.listOutlines()) {
            const node = outline.nodes.find(item => item.lessonId === lessonId)
            if (node === undefined) continue
            const updated: Outline = {...outline, updatedAt: new Date().toISOString(), nodes: outline.nodes.map(item => item.lessonId === lessonId ? {...item, state} as OutlineNode : item)}
            await files.writeOutline(updated)
            return
        }
    }

    // ---
    // CHECK：下面回头再读

    // 登记已创作工件并创建或恢复展示运行，同一 callId 重试时复用运行，返回服务端持有的规范描述符
    async createOrResumeRun(cwd: string, kind: ArtifactKind, targetId: string, path: string, callId: string, title?: string): Promise<PresentArtifactDescriptor> {
        if (!isSafeSegment(targetId)) throw new Error(`不安全的目标 ID ${targetId}`)
        if (callId.length === 0) throw new Error('present 需要非空工具调用 ID')

        const files = this.filesFor(cwd)
        const hash = files.validateArtifactPath(kind, path)
        if ((await files.readArtifactHtml(kind, hash)) === null) throw new Error(`路径 ${path} 下不存在工件 HTML`)

        const existingMeta = await files.readMeta(kind, hash)
        const metaTitle = existingMeta?.title ?? title?.trim() ?? hash
        if (existingMeta === null) await files.writeMeta(kind, hash, {kind, targetId, title: metaTitle, createdAt: new Date().toISOString()})
        if (kind === 'lesson') await this.setLessonState(cwd, targetId, 'learning')

        let run = await files.findRunByCallId(kind, hash, callId)
        if (run === null) {
            run = {runId: randomUUID(), artifactHash: hash, kind, targetId, callId, createdAt: new Date().toISOString()} satisfies ArtifactRun
            await files.writeRun(kind, hash, run)
        }

        const descriptor: PresentArtifactDescriptor = {version: 1, callId, workspaceId: generateWorkspaceHashIdOf(cwd), kind, category: ARTIFACT_CATEGORY_BY_KIND[kind], hash, targetId: run.targetId, title: metaTitle, runId: run.runId, url: this.getRunUrl(cwd, kind, hash, run.runId)}
        this.descriptors.set(callId, {cwd, descriptor})
        return descriptor
    }

    // 按 cwd + callId 获取正在运行的展示描述符
    resolveDescriptor(cwd: string, callId: string): PresentArtifactDescriptor | null {
        const entry = this.descriptors.get(callId)
        if (entry === undefined || entry.cwd !== cwd) return null
        return entry.descriptor
    }

    // 工具结束后移除展示描述符，重放场景改用持久化元数据
    forgetDescriptor(callId: string): void {
        this.descriptors.delete(callId)
    }

    // 登记IN-BAND展示并等待提交、取消或超时，持久化提交与等待注册表通过同一入口收敛
    async present(cwd: string, kind: ArtifactKind, hash: string, runId: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<PresentOutcome> {
        const files = this.filesFor(cwd)
        const run = await files.readRun(kind, hash, runId)
        if (run === null || run.kind !== kind || run.artifactHash !== hash) return {kind: 'no-result', reason: 'error', detail: `在 ${ARTIFACT_CATEGORY_BY_KIND[kind]}/${hash} 下找不到运行 ${runId}`}

        const key = runId
        const existing = this.pending.get(key)
        if (existing !== undefined) {
            if (existing.outcome !== undefined) return existing.outcome
            return new Promise(resolve => existing.waiters.push(resolve))
        }

        const entry: PendingPresent = {waiters: []}
        this.pending.set(key, entry)
        const settle = (outcome: PresentOutcome): void => {
            if (entry.outcome !== undefined) return
            entry.outcome = outcome
            for (const waiter of entry.waiters.splice(0)) waiter(outcome)
            if (this.pending.get(key) === entry && entry.outcome !== undefined) this.pending.delete(key)
        }

        // 注册等待者后再对齐持久化结果，使提交早于注册或发生在注册期间两种竞态都能正确收敛
        const existingResult = await files.readResult(kind, hash, runId)
        if (existingResult !== null) {
            settle({kind: 'result', result: existingResult})
            return {kind: 'result', result: existingResult}
        }

        const timeoutMs = opts.timeoutMs ?? this.config.presentTimeoutMs ?? 3600_000 // TIPS：默认一个小时
        const timer = setTimeout(() => settle({kind: 'no-result', reason: 'timeout'}), timeoutMs)
        timer.unref?.()
        const onAbort = (): void => settle({kind: 'no-result', reason: 'interrupted'})
        opts.signal?.addEventListener('abort', onAbort, {once: true})
        return new Promise(resolve => {
            entry.waiters.push(outcome => {
                clearTimeout(timer)
                opts.signal?.removeEventListener('abort', onAbort)
                resolve(outcome)
            })
        })
    }

    private settlePending(runId: string, outcome: PresentOutcome): void {
        const pending = this.pending.get(runId)
        if (pending === undefined || pending.outcome !== undefined) return
        pending.outcome = outcome
        for (const waiter of pending.waiters.splice(0)) waiter(outcome)
        this.pending.delete(runId)
    }

    // 读取并校验工件运行，供需要抛错的写入路径复用
    private async requireRun(cwd: string, kind: ArtifactKind, hash: string, runId: string): Promise<{ files: LearningFiles; run: ArtifactRun }> {
        const files = this.filesFor(cwd)
        const run = await files.readRun(kind, hash, runId)
        if (run === null) throw new Error(`在 ${ARTIFACT_CATEGORY_BY_KIND[kind]}/${hash} 下找不到运行 ${runId}`)
        if (run.kind !== kind || run.artifactHash !== hash) throw new Error(`运行 ${runId} 不属于 ${ARTIFACT_CATEGORY_BY_KIND[kind]}/${hash}`)
        return {files, run}
    }

    // 持久化优先的不透明提交路径：原子写入一次结果，lesson 推进到 qa，再结算等待中的IN-BAND展示
    async submit(cwd: string, kind: ArtifactKind, hash: string, runId: string, payload: unknown): Promise<{ result: ResultEnvelope; alreadySubmitted: boolean }> {
        const {files, run} = await this.requireRun(cwd, kind, hash, runId)
        const result: ResultEnvelope = {kind, targetId: run.targetId, artifactHash: hash, runId, submittedAt: new Date().toISOString(), payload}
        const wrote = await files.writeResultOnce(kind, hash, runId, result)
        if (kind === 'lesson' && wrote) await this.setLessonState(cwd, run.targetId, 'qa')
        const durable = wrote ? result : (await files.readResult(kind, hash, runId)) ?? result
        this.settlePending(runId, {kind: 'result', result: durable})
        return {result: durable, alreadySubmitted: !wrote}
    }

    // 读取指定运行的结果，未给 runId 时读取工件最近一次已提交运行
    async getResult(cwd: string, kind: ArtifactKind, hash: string, runId?: string): Promise<{ runId: string; result: ResultEnvelope } | null> {
        const files = this.filesFor(cwd)
        if (runId !== undefined) {
            const result = await files.readResult(kind, hash, runId)
            return result === null ? null : {runId, result}
        }

        const latest = await files.latestSubmittedRun(kind, hash)
        if (latest === null) return null
        const result = await files.readResult(kind, hash, latest.runId)
        return result === null ? null : {runId: latest.runId, result}
    }

    // 保存模型对单次运行的不透明判阅报告，校验运行归属与结果存在性后原样写入
    async saveFeedback(cwd: string, kind: ArtifactKind, hash: string, runId: string, payload: unknown): Promise<FeedbackEnvelope> {
        const {files, run} = await this.requireRun(cwd, kind, hash, runId)
        if ((await files.readResult(kind, hash, runId)) === null) throw new Error(`运行 ${runId} 尚无结果——只能在提交后批改`)

        const feedback: FeedbackEnvelope = {kind, targetId: run.targetId, artifactHash: hash, runId, savedAt: new Date().toISOString(), payload}
        await files.writeFeedback(kind, hash, runId, feedback)
        return feedback
    }

    // ---------

    // 校验复习计划来源运行存在、已有结果且确实属于指定课程
    private async resolveSourceRun(cwd: string, kind: ArtifactKind, hash: string, runId: string, lessonId: string): Promise<ArtifactRun> {
        const files = this.filesFor(cwd)
        const run = await files.readRun(kind, hash, runId)
        if (run === null) throw new Error(`在 ${ARTIFACT_CATEGORY_BY_KIND[kind]}/${hash} 下找不到来源运行 ${runId}`)
        if (run.kind !== kind || run.artifactHash !== hash) throw new Error(`运行 ${runId} 不属于 ${ARTIFACT_CATEGORY_BY_KIND[kind]}/${hash}`)
        if (run.targetId !== lessonId) throw new Error(`运行 ${runId} 属于课程 ${run.targetId}，而非 ${lessonId}`)
        if ((await files.readResult(kind, hash, runId)) === null) throw new Error(`运行 ${runId} 尚无结果——只能对已完成批改的运行进行评级`)
        return run
    }

    // 在用户确认前计算 update_review_plan 的只读候选，只校验并推演下一张卡片，不做持久化写入
    async computeReviewPlan(cwd: string, lessonId: string, rating: ReviewRating, sourceKind: ArtifactKind, sourceHash: string, sourceRunId: string, reason?: string): Promise<ReviewPlanProposal> {
        if (!isSafeSegment(lessonId)) throw new Error(`不安全的课程 ID ${lessonId}`)
        await this.resolveSourceRun(cwd, sourceKind, sourceHash, sourceRunId, lessonId)

        const files = this.filesFor(cwd)
        const current = await files.readCard(lessonId)
        const card = current === null ? newCard() : current.card as unknown as Card
        const alreadyApplied = (current?.history ?? []).some(record => record.sourceRunId === sourceRunId)
        const next = nextCard(card, rating, Date.now())
        return {lessonId, rating, sourceRunId, ...(reason !== undefined && reason.length > 0 ? {reason} : {}), current, nextCard: next as unknown as Record<string, unknown>, due: next.due instanceof Date ? next.due.toISOString() : String(next.due), alreadyApplied}
    }

    // 提交一次复习计划更新：重新校验来源、检查幂等键、应用评级并原子写入卡片及历史
    async commitReviewPlan(cwd: string, lessonId: string, rating: ReviewRating, sourceKind: ArtifactKind, sourceHash: string, sourceRunId: string, reason?: string): Promise<CardFile> {
        if (!isSafeSegment(lessonId)) throw new Error(`不安全的课程 ID ${lessonId}`)
        await this.resolveSourceRun(cwd, sourceKind, sourceHash, sourceRunId, lessonId)

        const files = this.filesFor(cwd)
        const current = await files.readCard(lessonId)
        const history = current?.history ?? []
        if (history.some(record => record.sourceRunId === sourceRunId)) throw new Error(`来源运行 ${sourceRunId} 已应用到复习计划`)

        const card = current === null ? newCard() : current.card as unknown as Card
        const next = nextCard(card, rating, Date.now())
        const record: ReviewRecord = {at: new Date().toISOString(), rating, sourceRunId, ...(reason !== undefined && reason.length > 0 ? {reason} : {})}
        const cardFile: CardFile = {lessonId, card: next as unknown as Record<string, unknown>, history: [...history, record]}
        await files.writeCard(cardFile)
        return cardFile
    }

    // ---------

    // 读取一个工作区的只读学习状态；会话激活纲目由调用方传入，不属于工作区事实
    async snapshot(cwd: string, activeOutlineId: string | null): Promise<LearningSnapshot> {
        const files = this.filesFor(cwd)
        recordWorkspaceHashIdByGeneratingItFromItsCwd(cwd)
        const exists = await files.currentIsLearningWorkspace()
        const outlines = await files.listOutlines()
        const activeOutline = outlines.find(outline => outline.id === activeOutlineId) ?? null
        const lessonTitle = new Map<string, string>()
        for (const outline of outlines) for (const node of outline.nodes) if (node.kind === 'lesson' && node.lessonId !== undefined) lessonTitle.set(node.lessonId, node.title)

        const currentLessons = (activeOutline?.nodes ?? []).filter(node => node.kind === 'lesson' && (node.state === 'learning' || node.state === 'qa') && node.lessonId !== undefined).map(node => ({id: node.lessonId as string, title: node.title, state: node.state as 'learning' | 'qa'}))
        const now = Date.now()
        const dueCards = (await files.listCards()).map(cardFile => {
            const card = cardFile.card as unknown as Card
            const due = typeof card.due === 'string' ? Date.parse(card.due) : card.due instanceof Date ? card.due.getTime() : 0
            return {lessonId: cardFile.lessonId, lessonTitle: lessonTitle.get(cardFile.lessonId) ?? cardFile.lessonId, due: new Date(due).toISOString(), state: stateLabel(card), overdue: due <= now}
        }).filter(item => item.overdue).sort((left, right) => left.due.localeCompare(right.due))

        return {workspaceId: generateWorkspaceHashIdOf(cwd), learningDirExists: exists, activeOutlineId, outlines: outlines.map(outline => ({id: outline.id, title: outline.title})), currentLessons, dueCards}
    }
}

export default LearningService
