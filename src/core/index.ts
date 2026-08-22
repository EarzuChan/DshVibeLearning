// DVL 服务装配：会话 bootstrap、领域 facade、数据变更发布与 URL 投影

import {homedir} from 'node:os'
import {join} from 'node:path'
import {Service, type Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'
import type {Agent, PreStepDecision} from '@deepseek-ai/dsh-agent'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {installLearnCommand} from '../command/index.ts'
import type {ArtifactHash, ArtifactKind} from '../shared/artifacts.ts'
import {ARTIFACT_CATEGORY_BY_KIND} from '../shared/artifacts.ts'
import {CORDIS_CONTEXT_LEARNING, CORDIS_EFFECT_AGENT_TOOLS, CORDIS_SECTION_SNAPSHOT, DVL_SERVER_ROUTE_PREFIX} from '../shared/constants.ts'
import type {ArtifactSummary, Outline, OutlineNode, OutlinePhase, ReviewPlan, ReviewRating, RunOutcome, TemporaryReviewPlanRoundManifest} from '../shared/model.ts'
import type {SessionDvlLearningState} from '../shared/projection.ts'
import {installCourseAuthoringSkill} from '../skill/index.ts'
import {installLearningRoutes} from '../the-so-called-backend/index.ts'
import {installLearningTools} from '../tool/index.ts'
import {recordWorkspaceHashIdByGeneratingItFromItsCwd} from '../the-so-called-backend/workspace-hash-id-related.ts'
import {ArtifactStore} from './artifact.ts'
import {DataChangeBus} from './data-change-bus.ts'
import {isValidArtifactHash, LearningFiles} from './files.ts'
import {generateWorkspaceHashIdOf, isSafeSegment} from '../util/identifiers.ts'
import {recordLearningEnteredToSession, recordLearningOutlineChangeToSession} from './learning-event.ts'
import {NotesStore} from './notes.ts'
import {findOutlineLesson, outlineArtifactHashes, OutlineStore, type OutlineInput} from './outline.ts'
import {InBandPresentationRegistry} from './presentation.ts'
import {dvlLearningProjection} from './projection.ts'
import {BOOT_LINE, FULL_GUIDE, renderSnapshot} from './prompt.ts'
import {ReviewPlanStore, type PreparedReviewPlan, type ReviewPlanCreationInput} from './review-plan.ts'
import {RunStore} from './run.ts'
import type {ArtifactRef, ArtifactRunDescriptor, LearningSnapshot, PresentOutcome, RunRef} from './types.ts'
import {presentOutcomeOf} from './types.ts'

declare module '@deepseek-ai/cordis' {
    interface Context {
        learning: LearningService
    }
}

// TIPS：插件总配置
export interface Config {
    readonly dataDir?: string
    readonly presentTimeoutMs?: number
}

interface AgentPreparation {
    readonly confirmedTurn: number
    readonly snapshot: LearningSnapshot
}

// ---实用小造---

function noticeMessage(text: string) {
    return createUserMessage({content: [{type: 'text', text}], source: {kind: 'plugin', plugin: 'learning'}})
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

// TIPS：核心服务
export class LearningService extends Service {
    static Config: z<Config> = z.object({dataDir: z.string().default(join(homedir(), '.dsh-vibe-learning')), presentTimeoutMs: z.number().default(3_600_000)})

    readonly notes: NotesStore
    readonly dataChanges = new DataChangeBus()
    readonly runs = new RunStore()
    readonly inBandPresentations = new InBandPresentationRegistry()

    private readonly learningToolsEnabledAgents = new WeakSet<Agent>() // 已被安工具的会话
    private readonly preparations = new WeakMap<Agent, AgentPreparation>() // 准备即为【PreTurn+快照】


    // 外围能力仍各自实现，LearningService 只统一拥有其安装与卸载生命周期
    private installEssentialCapabilities(ctx: Context): void {
        // THINKING：若进入后，要不要对该会话隐藏本命令？
        ctx.inject(['commands'], (scope: Context) => installLearnCommand(scope, this))

        ctx.inject(['skills'], (scope: Context) => installCourseAuthoringSkill(scope))

        ctx.inject(['agents', 'webServer'], (scope: Context) => installLearningRoutes(scope, this))
    }

    // 普通ctor
    constructor(ctx: Context, public config: Config) {
        super(ctx, 'learning')

        this.notes = new NotesStore(config.dataDir ?? join(homedir(), '.dsh-vibe-learning'), () => this.dataChanges.publish('notes'))

        this.installEssentialCapabilities(ctx)

        ctx.inject(['systemPrompt'], (scope: Context) => {
            scope.systemPrompt.context({name: CORDIS_CONTEXT_LEARNING, order: 130, text: context => {
                const agent = context.agent
                return agent === undefined ? '' : this.getCurrentSessionDvlLearningState(agent).entered ? FULL_GUIDE : BOOT_LINE
            }})
        })

        ctx.inject(['sessionProjections'], (scope: Context) => { scope.sessionProjections.register(dvlLearningProjection) })

        ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
            const state = await this.prepareAgent(payload.agent, payload.turn, payload.signal)
            const decision = await next()
            if (decision.kind === 'reject' || payload.signal.aborted || !state.entered) return decision

            // 下为PreStep的注入

            const snapshot = this.preparations.get(payload.agent)?.snapshot
            if (snapshot === undefined) return decision

            const text = renderSnapshot(snapshot)

            return {kind: 'enter', messages: [...decision.messages, createUserMessage({content: [{type: 'text', text}], source: {kind: 'plugin', plugin: 'learning', form: 'snapshot', sections: [{name: CORDIS_SECTION_SNAPSHOT, text}]}})]}
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
        return this.ctx.get('sessionProjections')?.snapshot(agent.session).values.dvlLearning ?? {entered: false, activeOutlineId: null}
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

        agent.steer(noticeMessage(bootMsg))
        return true
    }

    async changeCurrentSessionOutline(agent: Agent, outlineId: string | null): Promise<void> {
        if (outlineId !== null) {
            if (!isSafeSegment(outlineId)) throw new Error(`不安全的纲目 ID：${outlineId}`)
            const cwd = this.getCurrentSessionCwd(agent)
            if (cwd === null) throw new Error('切换纲目需要会话有工作区目录')
            if (await this.outlinesFor(cwd).read(outlineId) === null) throw new Error(`纲目不存在：${outlineId}`)
        }
        recordLearningOutlineChangeToSession(agent.session, outlineId)
    }

    notify(agent: Agent, text: string): void {
        agent.steer(noticeMessage(text))
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

    async saveOutline(cwd: string, outline: Outline): Promise<void> {
        for (const hash of outlineArtifactHashes(outline)) if (!await this.artifactsFor(cwd).exists('lesson', hash)) throw new Error(`大纲引用的课程工件不存在：${hash}`)

        await this.outlinesFor(cwd).write(outline)

        this.publishLearning(cwd)
    }

    async updateOutlineArtifactBinding(cwd: string, outlineId: string, lessonId: string, artifactHash: string | null): Promise<Outline> {
        if (artifactHash !== null && !await this.artifactsFor(cwd).exists('lesson', artifactHash)) throw new Error(`课程工件不存在：${artifactHash}`)

        const outline = await this.outlinesFor(cwd).updateArtifactBinding(outlineId, lessonId, artifactHash)

        this.publishLearning(cwd)

        return outline
    }

    // 若无活跃Run->删：本身、连带的RP、只挂本的课程工件、只挂本RP的复习工件
    async deleteOutline(cwd: string, id: string): Promise<void> {
        const target = await this.outlinesFor(cwd).read(id)
        if (target === null) throw new Error(`纲目不存在：${id}`)

        // 收集连带情况

        const remainingOutlines = (await this.listOutlines(cwd)).filter(outline => outline.id !== id)
        const retainedLessons = new Set(remainingOutlines.flatMap(outline => outlineArtifactHashes(outline)))

        const removedPlans = (await this.reviewPlansFor(cwd).list()).filter(plan => plan.outlineId === id)
        const retainedPlans = (await this.reviewPlansFor(cwd).list()).filter(plan => plan.outlineId !== id)

        const retainedReviews = new Set(retainedPlans.flatMap(plan => plan.rounds.flatMap(round => round.artifactHash === undefined ? [] : [round.artifactHash])))
        const temporaryReviews = new Set((await this.reviewPlansFor(cwd).temporaryManifest()).rounds.flatMap(round => round.artifactHash === undefined ? [] : [round.artifactHash]))

        // 盘算删除

        const lessonDeletions = outlineArtifactHashes(target).filter(hash => !retainedLessons.has(hash))
        const reviewDeletions = removedPlans.flatMap(plan => plan.rounds.flatMap(round => round.artifactHash === undefined ? [] : [round.artifactHash])).filter(hash => !retainedReviews.has(hash) && !temporaryReviews.has(hash))

        for (const hash of lessonDeletions) await this.confirmArtifactHasNoActiveRun(cwd, 'lesson', hash)
        for (const hash of reviewDeletions) await this.confirmArtifactHasNoActiveRun(cwd, 'review', hash)

        // 真正删除

        await this.outlinesFor(cwd).delete(id)
        for (const plan of removedPlans) await this.reviewPlansFor(cwd).delete(plan.id)
        for (const hash of lessonDeletions) await this.artifactsFor(cwd).delete('lesson', hash)
        for (const hash of reviewDeletions) await this.artifactsFor(cwd).delete('review', hash)

        this.publishLearning(cwd)
    }

    async deleteArtifact(cwd: string, kind: ArtifactKind, hash: string): Promise<void> {
        // 校验

        if (!await this.artifactsFor(cwd).exists(kind, hash)) throw new Error(`工件不存在：${kind}/${hash}`)

        if (kind === 'lesson') {
            const referenced = (await this.listOutlines(cwd)).some(outline => outlineArtifactHashes(outline).includes(hash))
            if (referenced) throw new Error('仍被大纲课程引用的工件不能删除')
        }

        if (kind === 'review') {
            const planned = (await this.reviewPlansFor(cwd).list()).some(plan => plan.rounds.some(round => round.artifactHash === hash))
            if (planned) throw new Error('仍被复习计划引用的工件不能删除')
        }

        await this.confirmArtifactHasNoActiveRun(cwd, kind, hash)

        // 删除

        if (kind === 'review') await this.reviewPlansFor(cwd).removeTemporaryRoundsForArtifact(hash)
        await this.artifactsFor(cwd).delete(kind, hash)

        this.publishLearning(cwd)
    }

    async updateOutlineWorkflow(cwd: string, id: string, phase: OutlinePhase, currentLessonId: string | null): Promise<Outline> {
        const outline = await this.outlinesFor(cwd).transition(id, phase, currentLessonId)

        this.publishLearning(cwd)

        return outline
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

        const hashes = [...new Set(plan.rounds.flatMap(round => round.artifactHash === undefined ? [] : [round.artifactHash]))]
        const otherReferences = new Set((await this.reviewPlansFor(cwd).list()).filter(other => other.id !== id).flatMap(other => other.rounds.flatMap(round => round.artifactHash === undefined ? [] : [round.artifactHash])))
        const temporary = new Set((await this.reviewPlansFor(cwd).temporaryManifest()).rounds.flatMap(round => round.artifactHash === undefined ? [] : [round.artifactHash]))
        const deletions = hashes.filter(hash => !otherReferences.has(hash) && !temporary.has(hash))

        if (!preserveArtifacts) for (const hash of deletions) await this.confirmArtifactHasNoActiveRun(cwd, 'review', hash)
        if (preserveArtifacts) for (const round of plan.rounds) if (round.artifactHash !== undefined && !otherReferences.has(round.artifactHash) && !temporary.has(round.artifactHash)) await this.reviewPlansFor(cwd).preserveArtifactAsTemporary(plan.outlineId, plan.lessonId, round.artifactHash)

        // 真正删除

        await this.reviewPlansFor(cwd).delete(id)
        if (!preserveArtifacts) for (const hash of deletions) await this.artifactsFor(cwd).delete('review', hash)

        this.publishLearning(cwd)
    }

    // ---复习计划的回合---

    async claimReviewPlanRound(cwd: string, planId: string, force: boolean): Promise<{plan: ReviewPlan; round: ReviewPlan['rounds'][number]}> {
        const claimed = await this.reviewPlansFor(cwd).claim(planId, force)

        this.publishLearning(cwd)

        return claimed
    }

    async updateReviewPlanRoundArtifactBinding(cwd: string, planId: string, roundId: string, artifactHash: ArtifactHash): Promise<ReviewPlan> {
        await this.confirmReviewArtifact(cwd, artifactHash)

        const plan = await this.reviewPlansFor(cwd).updateRoundArtifactBinding(planId, roundId, artifactHash)

        this.publishLearning(cwd)

        return plan
    }

    async updateTemporaryReviewPlanRoundArtifactBinding(cwd: string, roundId: string, artifactHash: ArtifactHash): Promise<TemporaryReviewPlanRoundManifest> {
        await this.confirmReviewArtifact(cwd, artifactHash)

        const manifest = await this.reviewPlansFor(cwd).updateTemporaryRoundArtifactBinding(roundId, artifactHash)

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
        if (temporary === undefined || temporary.artifactHash === undefined) throw new Error('临时复习期次不存在或尚未绑定工件')

        await this.confirmCompletedReviewedArtifact(cwd, temporary.artifactHash)

        const adopted = await this.reviewPlansFor(cwd).adoptTemporaryRound(temporaryRoundId, planId)

        this.publishLearning(cwd)

        return adopted.plan
    }

    // 事务：把RP的活跃Round给完成掉（会校验Round工件已批注）
    async completeReviewPlan(cwd: string, planId: string, rating: ReviewRating): Promise<ReviewPlan> {
        const plan = await this.reviewPlansFor(cwd).read(planId)
        if (plan === null) throw new Error(`复习计划不存在：${planId}`)

        const active = plan.rounds.filter(round => round.state === 'active')
        if (active.length !== 1 || active[0]?.artifactHash === undefined) throw new Error('复习计划的活跃期次尚未绑定复习工件')

        await this.confirmCompletedReviewedArtifact(cwd, active[0].artifactHash)
        const updated = await this.reviewPlansFor(cwd).complete(planId, rating)

        this.publishLearning(cwd)

        return updated
    }

    // 确定存在复习工件
    private async confirmReviewArtifact(cwd: string, artifactHash: ArtifactHash): Promise<void> {
        if (!isValidArtifactHash(artifactHash)) throw new Error(`复习工件哈希无效：${artifactHash}`)
        if (!await this.artifactsFor(cwd).exists('review', artifactHash)) throw new Error(`复习工件不存在：${artifactHash}`)
    }

    // 确定复习工件已完成（完成批改了）
    private async confirmCompletedReviewedArtifact(cwd: string, artifactHash: ArtifactHash): Promise<void> {
        await this.confirmReviewArtifact(cwd, artifactHash)
        const runs = await this.runs.list('review', artifactHash, cwd)

        for (const run of runs) if (run.state === 'completed' && run.hasFeedback) return

        throw new Error(`复习工件尚无已完成且已批改的 Run：${artifactHash}`)
    }

    // ---和RUN有关系---

    // 无则开，有则续
    async obtainDirectRun(cwd: string, kind: ArtifactKind, hash: string): Promise<RunRef> {
        const run = await this.runs.obtain({cwd, kind, hash})

        this.publishLearning(cwd)

        return run
    }

    // 把Outcome写啊一个个
    async finishRun(ref: RunRef, outcome: RunOutcome): Promise<{outcome: RunOutcome; alreadyFinished: boolean}> {
        const finished = await this.runs.finish(ref, outcome)

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

            this.publishLearning(cwd)

            try {
                const waited = await this.runs.wait(run, {signal, timeoutMs: this.config.presentTimeoutMs ?? 3_600_000})

                if (waited === 'timed-out') return {outcome: {outcome: 'timed-out', runId: run.runId}, descriptor}

                if (waited === 'interrupted') return {outcome: {outcome: 'interrupted', runId: run.runId}, descriptor}

                return {outcome: presentOutcomeOf(run.runId, waited), descriptor}
            } finally {
                this.inBandPresentations.release(callId)

                reserved = false

                this.publishLearning(cwd)
            }
        } catch (error: unknown) {
            if (reserved) this.inBandPresentations.release(callId)

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
        return {version: 2, workspaceId: generateWorkspaceHashIdOf(run.cwd), kind: run.kind, hash: run.hash, title: await this.artifactsFor(run.cwd).title(run.kind, run.hash), runId: run.runId, url: this.getRunUrl(run.cwd, run.kind, run.hash, run.runId)}
    }

    // ---工件这一块---

    async listArtifacts(cwd: string, kind: ArtifactKind): Promise<ArtifactSummary[]> {
        const artifacts = await this.artifactsFor(cwd).list(kind, (artifactKind, hash) => this.runs.list(artifactKind, hash, cwd))

        return artifacts.map(artifact => ({...artifact, runs: artifact.runs.map(run => {
            const lease = this.inBandPresentations.forRun({cwd, kind, hash: artifact.hash, runId: run.runId})
            return lease === null ? run : {...run, inBandSessionId: lease.sessionId}
        })}))
    }

    private async confirmArtifactHasNoActiveRun(cwd: string, kind: ArtifactKind, hash: string): Promise<void> {
        const active = (await this.runs.list(kind, hash, cwd)).some(run => run.state === 'active')

        if (active) throw new Error('工件仍有进行中的 Run，不能删除')
    }

    getArtifactUrl(cwd: string, kind: ArtifactKind, hash: string): string {
        recordWorkspaceHashIdByGeneratingItFromItsCwd(cwd)
        return `${this.getOriginBase()}${DVL_SERVER_ROUTE_PREFIX}/${generateWorkspaceHashIdOf(cwd)}/${ARTIFACT_CATEGORY_BY_KIND[kind]}/${hash}/index.html`
    }

    getRunUrl(cwd: string, kind: ArtifactKind, hash: string, runId: string): string {
        recordWorkspaceHashIdByGeneratingItFromItsCwd(cwd)
        return `${this.getOriginBase()}${DVL_SERVER_ROUTE_PREFIX}/${generateWorkspaceHashIdOf(cwd)}/${ARTIFACT_CATEGORY_BY_KIND[kind]}/${hash}/runs/${runId}/index.html`
    }

    // ---剩余金典会话内容---

    // 拍摄快照，用于Step钩子注入最新
    async snapshotLearningWorkspaceState(cwd: string, activeOutlineId: string | null): Promise<LearningSnapshot> {
        recordWorkspaceHashIdByGeneratingItFromItsCwd(cwd)
        const exists = await this.filesFor(cwd).currentIsLearningWorkspace()
        if (!exists) return {workspaceId: generateWorkspaceHashIdOf(cwd), learningDirExists: false, activeOutlineId, outlines: [], currentLesson: null, dueReviews: [], problem: '学习工作区目录不存在'}

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

            const dueReviews = plans.flatMap(plan => {
                const active = plan.rounds.find(round => round.state === 'active')
                const dueAt = String(plan.card.due)
                return active === undefined && Date.parse(dueAt) <= Date.now() ? [{planId: plan.id, lessonId: plan.lessonId, lessonTitle: titles.get(plan.lessonId) ?? plan.lessonId, dueAt}] : []
            }).sort((left, right) => left.dueAt.localeCompare(right.dueAt))

            const currentLesson = active !== null && lesson?.kind === 'lesson' && (active.workflow.phase === 'learning' || active.workflow.phase === 'qa') ? {id: lesson.id, title: lesson.title, phase: active.workflow.phase} : null
            return {workspaceId: generateWorkspaceHashIdOf(cwd), learningDirExists: true, activeOutlineId, outlines: outlines.map(outline => ({id: outline.id, title: outline.title, phase: outline.workflow.phase})), currentLesson, dueReviews}
        } catch (error: unknown) {
            return {workspaceId: generateWorkspaceHashIdOf(cwd), learningDirExists: true, activeOutlineId, outlines: [], currentLesson: null, dueReviews: [], problem: errorText(error)}
        }
    }

    // 一般来说PreTurn
    private async prepareAgent(agent: Agent, turn: number, signal: AbortSignal): Promise<SessionDvlLearningState> {
        // 检查

        const state = this.getCurrentSessionDvlLearningState(agent)

        const existing = this.preparations.get(agent)
        if (existing?.confirmedTurn === turn && existing.snapshot.activeOutlineId === state.activeOutlineId) return state
        if (!state.entered || signal.aborted) return state

        // 下为每Turn一次

        if (!this.learningToolsEnabledAgents.has(agent)) {
            agent.ctx.effect(() => installLearningTools(this.ctx, this, agent), CORDIS_EFFECT_AGENT_TOOLS)
            this.learningToolsEnabledAgents.add(agent)
        }

        const cwd = this.getCurrentSessionCwd(agent)
        const snapshot = cwd === null ? {workspaceId: '', learningDirExists: false, activeOutlineId: state.activeOutlineId, outlines: [], currentLesson: null, dueReviews: [], problem: '学习会话没有工作区目录'} satisfies LearningSnapshot : await this.snapshotLearningWorkspaceState(cwd, state.activeOutlineId)
        this.preparations.set(agent, {confirmedTurn: turn, snapshot})

        return state
    }

    private getOriginBase(): string {
        const webServer = this.ctx.get('webServer')
        if (webServer === undefined) throw new Error('DSH webServer 未就绪，无法构造工件 URL')

        // noinspection HttpUrlsUsage
        return `http://${webServer.host}:${webServer.port}`
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
