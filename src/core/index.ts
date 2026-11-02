// DVL 服务装配：会话 bootstrap、领域 facade、数据变更发布与 URL 投影

import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Service, type Context} from '@deepseek-ai/cordis'
import type {ProjectionHandle} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tools'
import {SessionId as brandSessionId} from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {boundContextSummary, createUserMessage, type ContextFormed} from '@deepseek-ai/dsh-llm'
import {installLearnCommand} from '../command/index.ts'
import type {ArtifactId, ArtifactKind} from '../shared/artifacts.ts'
import {ARTIFACT_CATEGORY_BY_KIND} from '../shared/artifacts.ts'
import {CORDIS_CONTEXT_LEARNING, CORDIS_SECTION_SNAPSHOT, DVL_SERVER_ROUTE_PREFIX} from '../shared/constants.ts'
import type {ArtifactSummary, Outline, OutlineNode, OutlinePhase, ReviewPlan, ReviewRating, RunOutcome, TemporaryReviewPlanRoundManifest} from '../shared/model.ts'
import type {SessionDvlLearningState} from '../shared/projection.ts'
import {installCourseAuthoringSkill} from '../skill/index.ts'
import {installLearningRoutes} from '../the-so-called-backend/index.ts'
import {installLearningTools} from '../tool/index.ts'
import {recordWorkspaceHashIdByGeneratingItFromItsCwd} from '../the-so-called-backend/workspace-hash-id-related.ts'
import {ArtifactStore} from './artifact.ts'
import {DataChangeBus} from './data-change-bus.ts'
import {isValidArtifactId, LearningFiles} from './files.ts'
import {generateWorkspaceHashIdOf, isSafeSegment} from '../util/identifiers.ts'
import {recordLearningDelegateToSession, recordLearningEnteredToSession, recordLearningOutlineChangeToSession} from './learning-event.ts'
import {NotesStore} from './notes.ts'
import {findOutlineLesson, outlineArtifactIds, OutlineStore, type OutlineInput, type OutlineWriter} from './outline.ts'
import {InBandPresentationRegistry} from './presentation.ts'
import {InteractionService} from './interaction.ts'
import {dvlLearningProjection} from './projection.ts'
import type {PanelOutlineMode, PanelSessionContext} from './panel-intent.ts'
import {AUTHOR_GUIDE, BOOT_LINE, FULL_GUIDE, renderSnapshot} from './prompt.ts'
import {ReviewPlanStore, type PreparedReviewPlan, type ReviewPlanCreationInput} from './review-plan.ts'
import {RunStore} from './run.ts'
import type {ArtifactRef, ArtifactRunDescriptor, LearningSnapshot, PresentOutcome, RunRef, StaleOutlineNotice} from './types.ts'
import {presentOutcomeOf} from './types.ts'

declare module '@deepseek-ai/cordis' {
    interface Context {
        learning: LearningService
    }
}

// DVL 注入会话的消息来源，按 DSH 约定由生产方自行声明
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'dsh-vibe-learning': {kind: 'dsh-vibe-learning'} & ContextFormed
    }
}

// TIPS：插件总配置
export interface Config {
    readonly dataDir?: string
    readonly presentTimeoutMs?: number
    readonly delegationToolNames?: string[]
}

// 会话在 DVL 中的角色：根学习会话、学习会话派出的创作子代理、与学习无关
export type LearningAudience = 'root' | 'author' | 'none'

// 官方会派出子代理的工具名，DVL 子代理不得再调用它们（只允许一级子代理）
const LIVE_AGENT_WAIT_MS = 5_000
const DEFAULT_DELEGATION_TOOL_NAMES = ['subagent', 'subagent_fork', 'subagent_oar', 'ralph', 'spawn_teammate']

const EMPTY_STATE: SessionDvlLearningState = {entered: false, activeOutlineId: null, delegatedFrom: null}

// ---实用小造---

function noticeMessage(summary: string, text: string) {
    return createUserMessage({content: [{type: 'text', text}], source: {kind: 'dsh-vibe-learning', form: 'notice', summary: boundContextSummary(summary)}})
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

// TIPS：核心服务
export class LearningService extends Service {
    static Config: z<Config> = z.object({dataDir: z.string().default(join(homedir(), '.dsh-vibe-learning')), presentTimeoutMs: z.number().default(3_600_000), delegationToolNames: z.array(z.string()).default(DEFAULT_DELEGATION_TOOL_NAMES)})

    readonly notes: NotesStore
    readonly dataChanges = new DataChangeBus()
    readonly runs = new RunStore()
    readonly inBandPresentations = new InBandPresentationRegistry()
    readonly interactions = new InteractionService()

    private projection: ProjectionHandle<SessionDvlLearningState> | undefined
    private readonly previewSecret = randomBytes(32) // 每个进程一份，用于签发只读预览凭证
    private readonly seenOutlineRevisions = new Map<string, number>() // 会话最近看到的大纲修订号，仅在本进程内有效

    // 外围能力仍各自实现，LearningService 只统一拥有其安装与卸载生命周期
    private installEssentialCapabilities(ctx: Context): void {
        // THINKING：若进入后，要不要对该会话隐藏本命令？
        ctx.inject(['commands'], (scope: Context) => installLearnCommand(scope, this))

        ctx.inject(['skills'], (scope: Context) => installCourseAuthoringSkill(scope))

        ctx.inject(['agents', 'webServer'], (scope: Context) => installLearningRoutes(scope, this))

        // 工具全局注册一次，由 when 条件决定只对学习会话及其创作子代理声明
        ctx.inject(['tools'], (scope: Context) => installLearningTools(scope, this))

        // 只允许一级子代理：DVL 子代理调用派出子代理的工具时一律拒绝
        ctx.inject(['tools'], (scope: Context) => {
            scope.on('tools/pre-execute', async (exec, next) => {
                const names = this.config.delegationToolNames ?? DEFAULT_DELEGATION_TOOL_NAMES
                if (exec.agent !== undefined && names.includes(exec.name) && this.audienceOf(exec.agent) === 'author') return {kind: 'deny', reason: '你是氛围学习派出的创作子代理，只负责完成交给你的工件创作，不能再派出下级子代理'}
                return next()
            })
        })
    }

    // 普通ctor
    constructor(ctx: Context, public config: Config) {
        super(ctx, 'learning')

        this.notes = new NotesStore(config.dataDir ?? join(homedir(), '.dsh-vibe-learning'), () => this.dataChanges.publish('notes'))

        this.installEssentialCapabilities(ctx)

        // 系统提示词按会话角色分三档；与学习无关的子代理不注入任何内容
        ctx.inject(['systemPrompt'], (scope: Context) => {
            scope.systemPrompt.context({name: CORDIS_CONTEXT_LEARNING, order: 130, text: context => {
                const agent = context.agent
                if (agent === undefined) return ''

                const audience = this.audienceOf(agent)
                if (audience === 'root') return FULL_GUIDE
                if (audience === 'author') return AUTHOR_GUIDE
                return agent.session.header.origin === 'subagent' ? '' : BOOT_LINE
            }})
        })

        ctx.inject(['sessionProjections'], async (scope: Context) => {
            this.projection = await scope.sessionProjections.register(dvlLearningProjection)
        })

        // 创作子代理首次开步前，把归属写进它自己的日志，使其冷恢复时不必依赖父会话仍然在线
        ctx.on('agent/pre-step', async ({agent}, next) => {
            if (agent.session.header.origin !== 'subagent' || this.getCurrentSessionDvlLearningState(agent).delegatedFrom !== null) return next()

            const root = this.learningRootOf(agent)
            if (root !== null) {
                recordLearningDelegateToSession(agent.session, String(root.id))
                ctx.logger.info(`创作子代理 ${String(agent.id)} 已归属学习会话 ${String(root.id)}`)
            }
            return next()
        })

        // 每轮把学习快照注入根学习会话
        ctx.on('system-prompt/assemble', async (assembly, context, next) => {
            const result = await next()
            const agent = context.agent

            // 无agent或非根学习会话或放弃，则early ret
            if (agent === undefined || this.audienceOf(agent) !== 'root' || context.signal?.aborted === true) return result

            const state = this.getCurrentSessionDvlLearningState(agent)
            const cwd = this.getCurrentSessionCwd(agent)

            const snapshot = cwd === null ? {workspaceId: '', learningDirExists: false, activeOutlineId: state.activeOutlineId, outlines: [], currentLesson: null, dueReviews: [], problem: '学习会话没有工作区目录'} satisfies LearningSnapshot : await this.snapshotLearningWorkspaceState(cwd, state.activeOutlineId)
            const stale = cwd === null || state.activeOutlineId === null ? undefined : await this.staleOutlineOf(agent, cwd, state.activeOutlineId)
            const text = renderSnapshot(stale === undefined ? snapshot : {...snapshot, staleOutline: stale})

            return {...result, contexts: [...result.contexts, {name: CORDIS_SECTION_SNAPSHOT, text}]}
        }, {prepend: true})
    }

    // ctor之后的async init
    protected async [Service.init]() {
        await this.notes.load()
    }

    // ---取领域能力---

    filesFor(cwd: string): LearningFiles {
        return new LearningFiles(cwd)
    }

    outlinesFor(cwd: string): OutlineStore {
        return new OutlineStore(this.filesFor(cwd))
    }

    reviewPlansFor(cwd: string): ReviewPlanStore {
        return new ReviewPlanStore(this.filesFor(cwd))
    }

    artifactsFor(cwd: string): ArtifactStore {
        return new ArtifactStore(this.filesFor(cwd))
    }

    // ---实用会话状态取得---

    getCurrentSessionDvlLearningState(agent: Agent): SessionDvlLearningState {
        return this.projection?.stateOf(agent.session) ?? EMPTY_STATE
    }

    // 判定会话角色。子代理（含 fork 出来、继承了进入记录的）一律不算根学习会话
    audienceOf(agent: Agent): LearningAudience {
        const state = this.getCurrentSessionDvlLearningState(agent)

        if (agent.session.header.origin !== 'subagent') return state.entered ? 'root' : 'none'
        return state.delegatedFrom !== null || this.learningRootOf(agent) !== null ? 'author' : 'none'
    }

    // 子代理的直接父会话若是在线的根学习会话，则返回它
    private learningRootOf(agent: Agent): Agent | null {
        const parentId = agent.session.header.parentSession
        const parent = parentId === undefined ? undefined : this.ctx.get('agents')?.get(parentId)
        if (parent === undefined || parent.session.header.origin === 'subagent') return null

        return this.getCurrentSessionDvlLearningState(parent).entered ? parent : null
    }

    getCurrentSessionCwd(agent: Agent): string | null {
        return agent.session.header.cwd ?? null
    }

    // ---实用会话方法---

    async enterVibeLearning(agent: Agent, bootMsg: string): Promise<boolean> {
        if (this.getCurrentSessionDvlLearningState(agent).entered) return false

        const cwd = this.getCurrentSessionCwd(agent)
        if (cwd === null) throw new Error('进入氛围学习需要会话有工作区目录')
        await this.filesFor(cwd).createLearningWorkspace()
        this.publishWorkspace(cwd)

        recordLearningEnteredToSession(agent.session)
        this.ctx.logger.info(`会话 ${String(agent.id)} 进入氛围学习`)

        agent.steer(noticeMessage('已进入氛围学习', bootMsg))
        return true
    }

    // 学习面板发起的意图投递：目标会话须在线；新建的会话会继承发起方会话的模型并先进入学习
    // outline 为意图所属的大纲：按 mode 决定是否先为目标会话激活它，再据投递后的会话情况生成指令
    async deliverPanelIntent(sessionId: string, sourceSessionId: string, summary: string, outline: {readonly id: string; readonly mode: PanelOutlineMode} | null, build: (session: PanelSessionContext) => string | Promise<string>): Promise<void> {
        const agents = this.ctx.get('agents')
        if (sessionId.length === 0) throw new Error('必须指定目标会话')

        // 刚新建或刚由前端打开的会话可能还在恢复中，稍等它上线
        let agent = agents?.get(brandSessionId(sessionId))
        for (let waited = 0; agent === undefined && waited < LIVE_AGENT_WAIT_MS; waited += 100) {
            await new Promise(resolve => setTimeout(resolve, 100))
            agent = agents?.get(brandSessionId(sessionId))
        }
        if (agent === undefined) throw new Error(`目标会话不在线：${sessionId}`)

        const source = sourceSessionId.length === 0 || sourceSessionId === sessionId ? undefined : agents?.get(brandSessionId(sourceSessionId))
        const inherited = source?.model.current()
        if (inherited !== undefined && agent.model.current() === undefined) agent.model.select(inherited)

        const active = this.getCurrentSessionDvlLearningState(agent).activeOutlineId
        const activate = outline !== null && active !== outline.id && (active === null ? outline.mode !== 'keep' : outline.mode === 'switch')
        if (activate) await this.changeCurrentSessionOutline(agent, outline.id)

        const instruction = await build({activeOutlineId: activate ? outline.id : active, activated: activate})

        if (this.getCurrentSessionDvlLearningState(agent).entered) this.notify(agent, summary, instruction)
        else await this.enterVibeLearning(agent, instruction)

        this.ctx.logger.info(`学习面板向会话 ${sessionId} 投递意图：${summary}`)
    }

    async changeCurrentSessionOutline(agent: Agent, outlineId: string | null): Promise<void> {
        if (outlineId !== null) {
            if (!isSafeSegment(outlineId)) throw new Error(`不安全的纲目 ID：${outlineId}`)
            const cwd = this.getCurrentSessionCwd(agent)
            if (cwd === null) throw new Error('切换纲目需要会话有工作区目录')
            if (await this.outlinesFor(cwd).read(outlineId) === null) throw new Error(`纲目不存在：${outlineId}`)
        }
        recordLearningOutlineChangeToSession(agent.session, outlineId)
        this.ctx.logger.info(`会话 ${String(agent.id)} 的激活纲目切换为 ${outlineId ?? '无'}`)
    }

    notify(agent: Agent, summary: string, text: string): void {
        agent.steer(noticeMessage(summary, text))
    }

    // ---这几个和Outline等有关，但又涉及工作区操刀。部分加了“总联动”所以目前放在本core而不是都下沉入领域类---

    async readOutline(cwd: string, id: string): Promise<Outline | null> {
        return this.outlinesFor(cwd).read(id)
    }

    async listOutlines(cwd: string): Promise<Outline[]> {
        return this.outlinesFor(cwd).list()
    }

    async normalizeOutline(cwd: string, input: OutlineInput, outlineId: string | null): Promise<Outline> {
        return this.outlinesFor(cwd).normalize(input, outlineId)
    }

    // ---大纲修订：会话看到过哪一版，写入时据此发现其他会话的改动---

    private seenKey(agent: Agent, cwd: string, outlineId: string): string {
        return `${String(agent.id)}\u0000${cwd}\u0000${outlineId}`
    }

    markOutlineSeen(agent: Agent, cwd: string, outline: Outline): void {
        this.seenOutlineRevisions.set(this.seenKey(agent, cwd, outline.id), outline.revision)
    }

    seenOutlineRevision(agent: Agent, cwd: string, outlineId: string): number | undefined {
        return this.seenOutlineRevisions.get(this.seenKey(agent, cwd, outlineId))
    }

    // 会话写入时校验它看到的修订号；面板写入不校验
    private writerOf(agent: Agent | null, cwd: string, outlineId: string): OutlineWriter {
        if (agent === null) return {sessionId: null}

        const expectedRevision = this.seenOutlineRevision(agent, cwd, outlineId)
        return {sessionId: String(agent.id), ...(expectedRevision === undefined ? {} : {expectedRevision})}
    }

    // 激活大纲是否在本会话上次查看后被别处改动；首次见到时只记下，不算过时。过时状态保留到本会话 get_outline 或自己写入为止
    private async staleOutlineOf(agent: Agent, cwd: string, outlineId: string): Promise<StaleOutlineNotice | undefined> {
        const outline = await this.outlinesFor(cwd).read(outlineId).catch(() => null)
        if (outline === null) return undefined

        const seen = this.seenOutlineRevision(agent, cwd, outlineId)
        if (seen === undefined || outline.lastWriterSessionId === String(agent.id)) {
            this.markOutlineSeen(agent, cwd, outline)
            return undefined
        }

        return outline.revision > seen ? {writerSessionId: outline.lastWriterSessionId, seenRevision: seen, revision: outline.revision} : undefined
    }

    private afterOutlineWrite(agent: Agent | null, cwd: string, outline: Outline): Outline {
        if (agent !== null) this.markOutlineSeen(agent, cwd, outline)
        this.publishLearning(cwd)
        return outline
    }

    async saveOutline(cwd: string, outline: Outline, writer: Agent | null): Promise<Outline> {
        for (const artifactId of outlineArtifactIds(outline)) if (!await this.artifactsFor(cwd).exists('lesson', artifactId)) throw new Error(`大纲引用的课程工件不存在：${artifactId}`)

        return this.afterOutlineWrite(writer, cwd, await this.outlinesFor(cwd).write(outline, this.writerOf(writer, cwd, outline.id)))
    }

    async updateOutlineArtifactBinding(cwd: string, outlineId: string, lessonId: string, artifactId: string | null, writer: Agent | null): Promise<Outline> {
        if (artifactId !== null && !await this.artifactsFor(cwd).exists('lesson', artifactId)) throw new Error(`课程工件不存在：${artifactId}`)

        return this.afterOutlineWrite(writer, cwd, await this.outlinesFor(cwd).updateArtifactBinding(outlineId, lessonId, artifactId, this.writerOf(writer, cwd, outlineId)))
    }

    // 若无活跃Run->删：本身、连带的RP、只挂本的课程工件、只挂本RP的复习工件
    async deleteOutline(cwd: string, id: string): Promise<void> {
        const target = await this.outlinesFor(cwd).read(id)
        if (target === null) throw new Error(`纲目不存在：${id}`)

        // 收集连带情况

        const remainingOutlines = (await this.listOutlines(cwd)).filter(outline => outline.id !== id)
        const retainedLessons = new Set(remainingOutlines.flatMap(outline => outlineArtifactIds(outline)))

        const removedPlans = (await this.reviewPlansFor(cwd).list()).filter(plan => plan.outlineId === id)
        const retainedPlans = (await this.reviewPlansFor(cwd).list()).filter(plan => plan.outlineId !== id)

        const retainedReviews = new Set(retainedPlans.flatMap(plan => plan.rounds.flatMap(round => round.artifactId === undefined ? [] : [round.artifactId])))
        const temporaryReviews = new Set((await this.reviewPlansFor(cwd).temporaryManifest()).rounds.flatMap(round => round.artifactId === undefined ? [] : [round.artifactId]))

        // 盘算删除

        const lessonDeletions = outlineArtifactIds(target).filter(artifactId => !retainedLessons.has(artifactId))
        const reviewDeletions = removedPlans.flatMap(plan => plan.rounds.flatMap(round => round.artifactId === undefined ? [] : [round.artifactId])).filter(artifactId => !retainedReviews.has(artifactId) && !temporaryReviews.has(artifactId))

        for (const artifactId of lessonDeletions) await this.confirmArtifactHasNoActiveRun(cwd, 'lesson', artifactId)
        for (const artifactId of reviewDeletions) await this.confirmArtifactHasNoActiveRun(cwd, 'review', artifactId)

        // 真正删除

        await this.outlinesFor(cwd).delete(id)
        for (const plan of removedPlans) await this.reviewPlansFor(cwd).delete(plan.id)
        for (const artifactId of lessonDeletions) await this.artifactsFor(cwd).delete('lesson', artifactId)
        for (const artifactId of reviewDeletions) await this.artifactsFor(cwd).delete('review', artifactId)

        this.publishLearning(cwd)
    }

    async deleteArtifact(cwd: string, kind: ArtifactKind, artifactId: string): Promise<void> {
        // 校验

        if (!await this.artifactsFor(cwd).exists(kind, artifactId)) throw new Error(`工件不存在：${kind}/${artifactId}`)

        if (kind === 'lesson') {
            const referenced = (await this.listOutlines(cwd)).some(outline => outlineArtifactIds(outline).includes(artifactId))
            if (referenced) throw new Error('仍被大纲课程引用的工件不能删除')
        }

        if (kind === 'review') {
            const planned = (await this.reviewPlansFor(cwd).list()).some(plan => plan.rounds.some(round => round.artifactId === artifactId))
            if (planned) throw new Error('仍被复习计划引用的工件不能删除')
        }

        await this.confirmArtifactHasNoActiveRun(cwd, kind, artifactId)

        // 删除

        if (kind === 'review') await this.reviewPlansFor(cwd).removeTemporaryRoundsForArtifact(artifactId)
        await this.artifactsFor(cwd).delete(kind, artifactId)

        this.publishLearning(cwd)
    }

    async updateOutlineWorkflow(cwd: string, id: string, phase: OutlinePhase, currentLessonId: string | null, writer: Agent | null): Promise<Outline> {
        return this.afterOutlineWrite(writer, cwd, await this.outlinesFor(cwd).transition(id, phase, currentLessonId, this.writerOf(writer, cwd, id)))
    }

    // ---复习计划---

    async createReviewPlan(cwd: string, input: ReviewPlanCreationInput): Promise<PreparedReviewPlan> {
        return this.reviewPlansFor(cwd).create(input)
    }

    async saveReviewPlan(cwd: string, prepared: PreparedReviewPlan): Promise<ReviewPlan> {
        await this.reviewPlansFor(cwd).write(prepared.plan)

        this.publishLearning(cwd)

        return prepared.plan
    }

    // 删：本身、非保留工件则仅删自身工件
    async deleteReviewPlan(cwd: string, id: string, preserveArtifacts: boolean): Promise<void> {
        const plan = await this.reviewPlansFor(cwd).read(id)
        if (plan === null) throw new Error(`复习计划不存在：${id}`)

        // 收集和盘算

        const artifactIds = [...new Set(plan.rounds.flatMap(round => round.artifactId === undefined ? [] : [round.artifactId]))]
        const otherReferences = new Set((await this.reviewPlansFor(cwd).list()).filter(other => other.id !== id).flatMap(other => other.rounds.flatMap(round => round.artifactId === undefined ? [] : [round.artifactId])))
        const temporary = new Set((await this.reviewPlansFor(cwd).temporaryManifest()).rounds.flatMap(round => round.artifactId === undefined ? [] : [round.artifactId]))
        const deletions = artifactIds.filter(artifactId => !otherReferences.has(artifactId) && !temporary.has(artifactId))

        if (!preserveArtifacts) for (const artifactId of deletions) await this.confirmArtifactHasNoActiveRun(cwd, 'review', artifactId)
        if (preserveArtifacts) for (const round of plan.rounds) if (round.artifactId !== undefined && !otherReferences.has(round.artifactId) && !temporary.has(round.artifactId)) await this.reviewPlansFor(cwd).preserveArtifactAsTemporary(plan.outlineId, plan.lessonId, round.artifactId)

        // 真正删除

        await this.reviewPlansFor(cwd).delete(id)
        if (!preserveArtifacts) for (const artifactId of deletions) await this.artifactsFor(cwd).delete('review', artifactId)

        this.publishLearning(cwd)
    }

    // ---复习计划的回合---

    async claimReviewPlanRound(cwd: string, planId: string, force: boolean): Promise<{plan: ReviewPlan; round: ReviewPlan['rounds'][number]}> {
        const claimed = await this.reviewPlansFor(cwd).claim(planId, force)

        this.publishLearning(cwd)

        return claimed
    }

    async updateReviewPlanRoundArtifactBinding(cwd: string, planId: string, roundId: string, artifactId: ArtifactId): Promise<ReviewPlan> {
        await this.confirmReviewArtifact(cwd, artifactId)

        const plan = await this.reviewPlansFor(cwd).updateRoundArtifactBinding(planId, roundId, artifactId)

        this.publishLearning(cwd)

        return plan
    }

    async updateTemporaryReviewPlanRoundArtifactBinding(cwd: string, roundId: string, artifactId: ArtifactId): Promise<TemporaryReviewPlanRoundManifest> {
        await this.confirmReviewArtifact(cwd, artifactId)

        const manifest = await this.reviewPlansFor(cwd).updateTemporaryRoundArtifactBinding(roundId, artifactId)

        this.publishLearning(cwd)

        return manifest
    }

    async claimTemporaryReviewPlanRound(cwd: string, outlineId: string, lessonId: string): Promise<{manifest: TemporaryReviewPlanRoundManifest; round: TemporaryReviewPlanRoundManifest['rounds'][number]}> {
        const outline = await this.outlinesFor(cwd).read(outlineId)
        if (outline === null || !outline.workflow.completedLessonIds.includes(lessonId)) throw new Error('只有已经学完的课程才能开始临时复习')

        const round = await this.reviewPlansFor(cwd).claimTemporary(outlineId, lessonId)

        this.publishLearning(cwd)

        return round
    }

    // 事务：把完成的临时RPR转到正式RP中（会校验Round工件已批注）
    async adoptTemporaryReviewPlanRound(cwd: string, temporaryRoundId: string, planId: string): Promise<ReviewPlan> {
        const manifest = await this.reviewPlansFor(cwd).temporaryManifest()
        const temporary = manifest.rounds.find(round => round.id === temporaryRoundId)
        if (temporary === undefined || temporary.artifactId === undefined) throw new Error('临时复习期次不存在或尚未绑定工件')

        await this.confirmCompletedReviewedArtifact(cwd, temporary.artifactId)

        const adopted = await this.reviewPlansFor(cwd).adoptTemporaryRound(temporaryRoundId, planId)

        this.publishLearning(cwd)

        return adopted.plan
    }

    // 事务：把RP的活跃Round给完成掉（会校验Round工件已批注）
    async completeReviewPlan(cwd: string, planId: string, rating: ReviewRating): Promise<ReviewPlan> {
        const plan = await this.reviewPlansFor(cwd).read(planId)
        if (plan === null) throw new Error(`复习计划不存在：${planId}`)

        const active = plan.rounds.filter(round => round.state === 'active')
        if (active.length !== 1 || active[0]?.artifactId === undefined) throw new Error('复习计划的活跃期次尚未绑定复习工件')

        await this.confirmCompletedReviewedArtifact(cwd, active[0].artifactId)
        const updated = await this.reviewPlansFor(cwd).complete(planId, rating)

        this.publishLearning(cwd)

        return updated
    }

    // 确定存在复习工件
    private async confirmReviewArtifact(cwd: string, artifactId: ArtifactId): Promise<void> {
        if (!isValidArtifactId(artifactId)) throw new Error(`复习工件哈希无效：${artifactId}`)
        if (!await this.artifactsFor(cwd).exists('review', artifactId)) throw new Error(`复习工件不存在：${artifactId}`)
    }

    // 确定复习工件已完成（完成批改了）
    private async confirmCompletedReviewedArtifact(cwd: string, artifactId: ArtifactId): Promise<void> {
        await this.confirmReviewArtifact(cwd, artifactId)
        const runs = await this.runs.list('review', artifactId, cwd)

        for (const run of runs) if (run.state === 'completed' && run.hasFeedback) return

        throw new Error(`复习工件尚无已完成且已批改的 Run：${artifactId}`)
    }

    // ---和RUN有关系---

    // 无则开，有则续
    async obtainDirectRun(cwd: string, kind: ArtifactKind, artifactId: string): Promise<RunRef> {
        const run = await this.runs.obtain({cwd, kind, artifactId})

        this.publishLearning(cwd)

        return run
    }

    // 把Outcome写啊一个个
    async finishRun(ref: RunRef, outcome: RunOutcome): Promise<{outcome: RunOutcome; alreadyFinished: boolean}> {
        const finished = await this.runs.finish(ref, outcome)
        if (!finished.alreadyFinished) this.ctx.logger.info(`Run ${ref.runId}（${ref.kind}/${ref.artifactId}）终结为 ${finished.outcome.state}`)

        this.publishLearning(ref.cwd)

        return finished
    }

    async saveFeedback(ref: RunRef, payload: unknown): Promise<void> {
        await this.runs.saveFeedback(ref, payload)
        this.publishLearning(ref.cwd)
    }

    // 一个金方法：Present（现在只限InBand。会独占“InBand权”）。Direct不算Present也不独占。PresentOutcome不是RunOutcome。Present绑Call生命周期
    async presentArtifact(agent: Agent, kind: ArtifactKind, path: string, callId: string, signal: AbortSignal, runId?: string): Promise<{outcome: PresentOutcome; descriptor?: ArtifactRunDescriptor}> {
        const cwd = this.getCurrentSessionCwd(agent)
        if (cwd === null) return {outcome: {outcome: 'error', detail: '当前会话没有工作区目录'}}

        let reserved = false
        try {
            const target = this.filesFor(cwd).validateArtifactPath(kind, path)
            const artifact: ArtifactRef = {cwd, ...target}

            this.inBandPresentations.reserve(callId, String(agent.id))
            reserved = true

            const run = await this.runs.obtain(artifact, {namespace: 'dsh-tool-call', value: callId}, runId)
            const descriptor = await this.describeRun(run)
            this.inBandPresentations.attach(callId, run)

            this.ctx.logger.info(`会话 ${String(agent.id)} 开始呈现 ${kind}/${run.artifactId}，Run ${run.runId}`)
            this.publishLearning(cwd)

            try {
                const waited = await this.runs.wait(run, {signal, timeoutMs: this.config.presentTimeoutMs ?? 3_600_000})

                if (waited === 'timed-out') return {outcome: {outcome: 'timed-out', runId: run.runId}, descriptor}

                if (waited === 'interrupted') return {outcome: {outcome: 'interrupted', runId: run.runId}, descriptor}

                return {outcome: presentOutcomeOf(run.runId, waited), descriptor}
            } finally {
                this.ctx.logger.info(`会话 ${String(agent.id)} 结束呈现 Run ${run.runId}`)
                this.inBandPresentations.release(callId)

                reserved = false

                this.publishLearning(cwd)
            }
        } catch (error: unknown) {
            if (reserved) this.inBandPresentations.release(callId)

            this.ctx.logger.warn(`会话 ${String(agent.id)} 呈现工件失败：${errorText(error)}`)
            return {outcome: {outcome: 'error', detail: errorText(error)}}
        }
    }

    // 当前进行中的
    async livePresent(cwd: string, callId: string): Promise<ArtifactRunDescriptor | null> {
        const lease = this.inBandPresentations.forCall(callId)
        if (lease === null || lease.run.cwd !== cwd) return null

        return this.describeRun(lease.run)
    }

    async describeRun(run: RunRef): Promise<ArtifactRunDescriptor> {
        return {version: 2, workspaceId: generateWorkspaceHashIdOf(run.cwd), kind: run.kind, artifactId: run.artifactId, title: await this.artifactsFor(run.cwd).title(run.kind, run.artifactId), runId: run.runId, url: this.getRunUrl(run.cwd, run.kind, run.artifactId, run.runId)}
    }

    // ---工件这一块---

    async listArtifacts(cwd: string, kind: ArtifactKind): Promise<ArtifactSummary[]> {
        const artifacts = await this.artifactsFor(cwd).list(kind, (artifactKind, artifactId) => this.runs.list(artifactKind, artifactId, cwd))

        return artifacts.map(artifact => ({...artifact, previewUrl: this.getArtifactUrl(cwd, kind, artifact.artifactId), runs: artifact.runs.map(run => {
            const lease = this.inBandPresentations.forRun({cwd, kind, artifactId: artifact.artifactId, runId: run.runId})
            return lease === null ? run : {...run, inBandSessionId: lease.sessionId}
        })}))
    }

    private async confirmArtifactHasNoActiveRun(cwd: string, kind: ArtifactKind, artifactId: string): Promise<void> {
        const active = (await this.runs.list(kind, artifactId, cwd)).some(run => run.state === 'active')

        if (active) throw new Error('工件仍有进行中的 Run，不能删除')
    }

    // 分配一个新工件身份，供模型随后用官方 write/edit 工具写入
    async allocateArtifact(cwd: string, kind: ArtifactKind): Promise<{artifactId: ArtifactId; path: string}> {
        await this.filesFor(cwd).createLearningWorkspace()
        return this.artifactsFor(cwd).allocate(kind)
    }

    // ---URL：一律为同源相对路径，由前端按当前页面 origin 解析---

    // 只读预览 URL 带本进程签发的凭证，工件页面不依赖 Dsh 的 cookie 鉴权
    getArtifactUrl(cwd: string, kind: ArtifactKind, artifactId: string): string {
        recordWorkspaceHashIdByGeneratingItFromItsCwd(cwd)
        const workspaceId = generateWorkspaceHashIdOf(cwd)
        return `${DVL_SERVER_ROUTE_PREFIX}/${workspaceId}/${ARTIFACT_CATEGORY_BY_KIND[kind]}/${artifactId}/index.html?k=${this.previewKeyOf(workspaceId, kind, artifactId)}`
    }

    // Run 页面以不可猜的 runId 本身作为凭证
    getRunUrl(cwd: string, kind: ArtifactKind, artifactId: string, runId: string): string {
        recordWorkspaceHashIdByGeneratingItFromItsCwd(cwd)
        return `${DVL_SERVER_ROUTE_PREFIX}/${generateWorkspaceHashIdOf(cwd)}/${ARTIFACT_CATEGORY_BY_KIND[kind]}/${artifactId}/runs/${runId}/index.html`
    }

    previewKeyOf(workspaceId: string, kind: ArtifactKind, artifactId: string): string {
        return createHmac('sha256', this.previewSecret).update(`${workspaceId}/${kind}/${artifactId}`).digest('hex').slice(0, 32)
    }

    verifyPreviewKey(workspaceId: string, kind: ArtifactKind, artifactId: string, key: string): boolean {
        const expected = Buffer.from(this.previewKeyOf(workspaceId, kind, artifactId))
        const actual = Buffer.from(key)
        return actual.length === expected.length && timingSafeEqual(actual, expected)
    }

    // ---剩余金典会话内容---

    // 拍摄快照，用于Turn钩子注入最新
    async snapshotLearningWorkspaceState(cwd: string, activeOutlineId: string | null): Promise<LearningSnapshot> {
        recordWorkspaceHashIdByGeneratingItFromItsCwd(cwd)

        const exists = await this.filesFor(cwd).currentIsLearningWorkspace()
        if (!exists) return {workspaceId: generateWorkspaceHashIdOf(cwd), learningDirExists: false, activeOutlineId, outlines: [], currentLesson: null, dueReviews: [], problem: '学习工作区目录不存在'} // 两回啊两回门禁

        try {
            const outlines = await this.listOutlines(cwd)

            const active = outlines.find(outline => outline.id === activeOutlineId) ?? null
            if (activeOutlineId !== null && active === null) throw new Error(`当前会话激活的纲目不存在：${activeOutlineId}`)

            const lesson = active?.workflow.currentLessonId === null || active?.workflow.currentLessonId === undefined ? null : findOutlineLesson(active, active.workflow.currentLessonId)
            const plans = await this.reviewPlansFor(cwd).list()

            const titles = new Map<string, string>()
            for (const outline of outlines) {
                const pending = [...outline.tree]
                while (pending.length > 0) {
                    const node = pending.pop() as OutlineNode
                    if (node.kind === 'group') pending.push(...node.children)
                    else titles.set(node.id, node.title)
                }
            }

            const planById = new Map(plans.map(plan => [plan.id, plan]))

            const dueReviews = plans.flatMap(plan => {
                const active = plan.rounds.find(round => round.state === 'active')
                const dueAt = String(plan.card.due)
                return active === undefined && Date.parse(dueAt) <= Date.now() ? [{planId: plan.id, lessonId: plan.lessonId, lessonTitle: titles.get(plan.lessonId) ?? plan.lessonId, dueAt}] : []
            }).sort((left, right) => left.dueAt.localeCompare(right.dueAt))

            const currentLesson = active !== null && lesson?.kind === 'lesson' && (active.workflow.phase === 'learning' || active.workflow.phase === 'qa') ? {id: lesson.id, title: lesson.title, phase: active.workflow.phase} : null

            const visibleDueReviews = activeOutlineId === null ? dueReviews : dueReviews.filter(review => planById.get(review.planId)?.outlineId === activeOutlineId)

            const dueReviewCountByOutline = new Map<string, number>()
            for (const review of dueReviews) {
                const outlineId = planById.get(review.planId)?.outlineId
                if (outlineId !== undefined) dueReviewCountByOutline.set(outlineId, (dueReviewCountByOutline.get(outlineId) ?? 0) + 1)
            }

            const snapshotOutlines = outlines.map(outline => ({id: outline.id, title: outline.title, phase: outline.workflow.phase, dueReviewCount: dueReviewCountByOutline.get(outline.id) ?? 0}))

            return {workspaceId: generateWorkspaceHashIdOf(cwd), learningDirExists: true, activeOutlineId, outlines: snapshotOutlines, currentLesson, dueReviews: visibleDueReviews}
        } catch (error: unknown) {
            return {workspaceId: generateWorkspaceHashIdOf(cwd), learningDirExists: true, activeOutlineId, outlines: [], currentLesson: null, dueReviews: [], problem: errorText(error)}
        }
    }

    // ---通知前端---

    private publishWorkspace(cwd: string): void {
        this.dataChanges.publish('workspace', generateWorkspaceHashIdOf(cwd))
    }

    private publishLearning(cwd: string): void {
        this.dataChanges.publish('learning', generateWorkspaceHashIdOf(cwd))
    }
}

export default LearningService
