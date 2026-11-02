// 学习面板发起“在会话中呈现”时给模型的情境：工件归属、目标会话与大纲的关系、本次该走哪种流程

import type {ArtifactKind} from '../shared/artifacts.ts'
import type {ArtifactRunSummary, Outline, ReviewPlan, ReviewPlanRound, TemporaryReviewPlanRound, TemporaryReviewPlanRoundManifest} from '../shared/model.ts'
import {findOutlineLesson, outlineLessons} from './outline.ts'

// 目标会话激活大纲的处理：auto 仅在没有激活大纲时激活；switch 切换为工件所属大纲；keep 保持不变
export type PanelOutlineMode = 'auto' | 'switch' | 'keep'

export type ArtifactOwner =
    | {readonly role: 'lesson'; readonly outline: Outline; readonly lessonId: string}
    | {readonly role: 'review-round'; readonly plan: ReviewPlan; readonly round: ReviewPlanRound; readonly outline: Outline | null}
    | {readonly role: 'temporary-review'; readonly round: TemporaryReviewPlanRound; readonly outline: Outline | null}
    | {readonly role: 'quiz'}
    | {readonly role: 'unowned'}

// 投递后目标会话的大纲情况
export interface PanelSessionContext {
    readonly activeOutlineId: string | null
    readonly activated: boolean // 是否为本次投递切换或设置了激活大纲
}

export function resolveArtifactOwner(kind: ArtifactKind, artifactId: string, outlines: readonly Outline[], plans: readonly ReviewPlan[], temporary: TemporaryReviewPlanRoundManifest): ArtifactOwner {
    const outlineById = (id: string): Outline | null => outlines.find(outline => outline.id === id) ?? null

    if (kind === 'quiz') return {role: 'quiz'}

    if (kind === 'lesson') {
        for (const outline of outlines) for (const [lessonId, bound] of Object.entries(outline.artifactBindings)) if (bound === artifactId) return {role: 'lesson', outline, lessonId}
        return {role: 'unowned'}
    }

    for (const plan of plans) for (const round of plan.rounds) if (round.artifactId === artifactId) return {role: 'review-round', plan, round, outline: outlineById(plan.outlineId)}
    for (const round of temporary.rounds) if (round.artifactId === artifactId) return {role: 'temporary-review', round, outline: outlineById(round.outlineId)}

    return {role: 'unowned'}
}

export function ownerOutlineIdOf(owner: ArtifactOwner): string | null {
    if (owner.role === 'lesson') return owner.outline.id
    if (owner.role === 'review-round') return owner.plan.outlineId
    if (owner.role === 'temporary-review') return owner.round.outlineId
    return null
}

// “第 n 课「标题」”
function lessonLabel(outline: Outline | null, lessonId: string): string {
    if (outline === null) return `课程 ${lessonId}`

    const lessons = outlineLessons(outline)
    const index = lessons.findIndex(lesson => lesson.id === lessonId)
    const title = findOutlineLesson(outline, lessonId)?.title ?? lessonId
    return index < 0 ? `「${title}」（lesson_id: ${lessonId}）` : `第 ${index + 1} 课「${title}」（lesson_id: ${lessonId}）`
}

function workflowLabel(outline: Outline): string {
    const workflow = outline.workflow
    if (workflow.currentLessonId === null) return workflow.phase
    return `${workflow.phase}，当前在${lessonLabel(outline, workflow.currentLessonId)}`
}

function outlineLabel(outline: Outline | null, outlineId: string): string {
    return outline === null ? `大纲 ${outlineId}（已不存在）` : `大纲「${outline.title}」（outline_id: ${outline.id}；进度：${workflowLabel(outline)}）`
}

export function describeOwner(owner: ArtifactOwner): string {
    switch (owner.role) {
        case 'lesson':
            return `归属：${outlineLabel(owner.outline, owner.outline.id)}的${lessonLabel(owner.outline, owner.lessonId)}。`

        case 'review-round':
            return `归属：复习计划 ${owner.plan.id} 的期次 ${owner.round.id}（${owner.round.state === 'active' ? '进行中' : '已完成'}），复习对象是${outlineLabel(owner.outline, owner.plan.outlineId)}的${lessonLabel(owner.outline, owner.plan.lessonId)}。`

        case 'temporary-review':
            return `归属：临时复习期次 ${owner.round.id}，复习对象是${outlineLabel(owner.outline, owner.round.outlineId)}的${lessonLabel(owner.outline, owner.round.lessonId)}。`

        case 'quiz':
            return '归属：小测，不属于任何大纲或复习计划。'

        case 'unowned':
            return '归属：游离工件，未绑定任何大纲课程或复习期次。'
    }
}

export function describeSession(ownerOutlineId: string | null, ownerOutlineTitle: string | null, session: PanelSessionContext): string {
    if (session.activeOutlineId === null) return '本会话目前没有激活大纲。'
    if (ownerOutlineId === null) return `本会话的激活大纲为 ${session.activeOutlineId}，与本工件无关。`
    if (session.activeOutlineId !== ownerOutlineId) return `本会话激活的是另一个大纲（${session.activeOutlineId}），用户选择不切换，因此本次只是回看。`

    return session.activated ? `已为本次呈现把本会话的激活大纲设为「${ownerOutlineTitle ?? ownerOutlineId}」。` : `本会话的激活大纲就是「${ownerOutlineTitle ?? ownerOutlineId}」。`
}

function describeRuns(runs: readonly ArtifactRunSummary[]): string {
    if (runs.length === 0) return '该工件此前没有作答记录。'

    const completed = runs.filter(run => run.state === 'completed').length
    const graded = runs.filter(run => run.hasFeedback).length
    return `该工件此前有 ${runs.length} 次作答（${completed} 次完成，${graded} 次已批改）；需要时可用 get_run_outcome 查看某次作答。`
}

// 本次该走的流程
function describeFlow(owner: ArtifactOwner, session: PanelSessionContext): string {
    const ownerOutlineId = ownerOutlineIdOf(owner)
    const inContext = ownerOutlineId === null || session.activeOutlineId === ownerOutlineId
    const lookBack = '这是历史或非当前的工件，本次只是回看：收到 completed 后按需批改并 save_feedback，不得改变大纲 Workflow 或复习计划。'

    if (owner.role === 'lesson' && inContext && owner.outline.workflow.phase === 'learning' && owner.outline.workflow.currentLessonId === owner.lessonId) return '这是该大纲当前正在学习的课程，走正常课程流程：收到 completed 后批改并 save_feedback，再调用 update_outline_workflow 进入 qa 开始答疑。'
    if (owner.role === 'review-round' && owner.round.state === 'active') return `这是复习计划 ${owner.plan.id} 当前进行中的期次：收到 completed 后批改并 save_feedback，再调用 update_review_plan(plan_id='${owner.plan.id}', rating) 结算本期。`
    if (owner.role === 'temporary-review') return '这是临时复习：收到 completed 后批改并 save_feedback；是否纳入正式复习计划按临时复习规则询问用户。'
    if (owner.role === 'quiz') return '小测没有状态机：收到 completed 后批改并 save_feedback 即可，不改变大纲或复习计划。'

    return lookBack
}

export interface PresentInstructionInput {
    readonly kind: ArtifactKind
    readonly title: string
    readonly path: string
    readonly runId?: string
    readonly owner: ArtifactOwner
    readonly runs: readonly ArtifactRunSummary[]
    readonly session: PanelSessionContext
}

export function renderPresentInstruction(input: PresentInstructionInput): string {
    const ownerOutlineId = ownerOutlineIdOf(input.owner)
    const ownerOutline = input.owner.role === 'lesson' || input.owner.role === 'review-round' || input.owner.role === 'temporary-review' ? input.owner.outline : null
    const call = `present_artifact(kind='${input.kind}', path='${input.path}'${input.runId === undefined ? '' : `, run_id='${input.runId}'`})`

    return [
        `用户从学习面板要求在本会话中呈现 ${input.kind} 工件「${input.title}」。`,
        describeOwner(input.owner),
        describeSession(ownerOutlineId, ownerOutline?.title ?? null, input.session),
        describeRuns(input.runs),
        `请调用 ${call}。${describeFlow(input.owner, input.session)}`,
    ].join('\n')
}

export function renderDueReviewInstruction(plan: ReviewPlan, outline: Outline | null, session: PanelSessionContext): string {
    return [
        `用户从学习面板确认开始复习计划 ${plan.id} 的到期复习，复习对象是${outlineLabel(outline, plan.outlineId)}的${lessonLabel(outline, plan.lessonId)}。`,
        describeSession(plan.outlineId, outline?.title ?? null, session).replace('因此本次只是回看', '复习计划本身不依赖会话的激活大纲，照常进行'),
        `请调用 claim_review_plan_round 取得 active round，再生成全新的 Review Artifact，调用 update_review_plan_round_artifact_binding 绑定本期，再 present、批改、save_feedback，最后调用 update_review_plan 结算计划。`,
    ].join('\n')
}
