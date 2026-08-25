import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {ContentBlock} from '@deepseek-ai/dsh-llm'
import type {JsonValue} from '@deepseek-ai/dsh-session'
import {defineTool, type GenericCallView} from '@deepseek-ai/dsh-tools'
import type {LearningService} from '../core/index.ts'
import {LEARNING_ARTIFACT_PATH_PATTERN} from '../core/files.ts'
import type {ArtifactKind} from '../shared/artifacts.ts'
import type {OutlineNode, OutlinePhase, ReviewRating} from '../shared/model.ts'

interface ConfirmAnswer { readonly confirmed: boolean; readonly custom?: string }

async function confirmWrite(learning: LearningService, agent: Agent, title: string, detail: unknown, signal?: AbortSignal): Promise<ConfirmAnswer> {
    try {
        const content = typeof detail === 'string' ? {kind: 'markdown' as const, text: detail} : {kind: 'json' as const, value: detail as JsonValue}

        const optionId = await learning.interactions.ask({agent, title, content, options: [{id: 'confirm', label: '确认', description: '允许本次写入'}, {id: 'cancel', label: '取消', description: '放弃本次写入'}], signal})

        return {confirmed: optionId === 'confirm'}
    } catch {
        return {confirmed: false, custom: `系统提问用户 ${title} 时出错`}
    }
}

function genericCard(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
    return {card: 'generic', title, kind, ...(rawInput === undefined ? {} : {rawInput})}
}

function textBlocks(value: unknown): ContentBlock[] {
    return [{type: 'text', text: JSON.stringify(value)}]
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

const KIND_SCHEMA = {type: 'string', required: true, enum: ['lesson', 'review', 'quiz']} as const
const HASH_SCHEMA = {type: 'string', required: true} as const
const FREE_OBJECT = {type: 'object', required: true, additionalProperties: true} as const
const FREE_JSON = {type: 'json'} as const
const RATING_SCHEMA = {type: 'string', required: true, enum: ['again', 'hard', 'good', 'easy']} as const
const ERROR_OUTCOME = {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'error'}, detail: {type: 'string', required: true}}} as const
const OUTLINE_TREE_EXAMPLES: JsonValue = [[{kind: 'group', title: '基础篇', children: [{kind: 'lesson', title: '第一课'}]}, {kind: 'lesson', title: '总结'}]]
const OUTLINE_TREE_SCHEMA = {type: 'json', required: true, description: '嵌套 OutlineNode 数组。分组节点：{id?: string, kind: "group", title: string, description?: string, children: OutlineNode[]}；课程节点：{id?: string, kind: "lesson", title: string, description?: string}。更新已有大纲时先读取原大纲，并保留每个既有节点的原 id；只有新节点可以省略 id，由系统生成。tree 只描述标题、说明和拓扑，不得传入 artifactHash、artifactBindings、artifact_bindings、workflow、state、parentId 或 order。工件绑定必须使用 update_outline_artifact_binding。', examples: OUTLINE_TREE_EXAMPLES} as const

export function installLearningTools(ctx: Context, learning: LearningService, agent: Agent): () => void {
    const disposers: Array<() => void> = []

    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'present_artifact',
        description: `在会话内呈现一个已存在的学习工件并等待本次 Run 终局。工件须位于 <workspace>/${LEARNING_ARTIFACT_PATH_PATTERN}。本工具只创建或复用 Run、取得 In-band 占用并等待；绝不改变大纲 Workflow 或复习计划。等待超时或调用中断不会终结 Run。`,
        parameters: {kind: {...KIND_SCHEMA, description: '工件类型'}, path: {type: 'string', required: true, description: '工件 index.html 的绝对路径'}, run_id: {type: 'string', description: '仅在接管一个既有 Active Run 时提供'}},
        output: {
            schema: {oneOf: [
                {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'completed'}, run_id: {type: 'string', required: true}, payload: FREE_JSON, presentation: FREE_JSON}},
                {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'aborted'}, run_id: {type: 'string', required: true}, reason: {type: 'string'}, presentation: FREE_JSON}},
                {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, enum: ['timed-out', 'interrupted']}, run_id: {type: 'string', required: true}, presentation: FREE_JSON}},
                ERROR_OUTCOME
            ]},
            render: (_args, value) => textBlocks(value),
            presentationMeta: (_args, value) => 'presentation' in value ? value.presentation ?? null : null
        },
        async execute(args: {kind: ArtifactKind; path: string; run_id?: string}, exec) {
            requireOwner(exec, agent)

            const presented = await learning.presentArtifact(agent, args.kind, args.path, exec.callId, exec.signal, args.run_id)

            if (presented.outcome.outcome === 'error') return presented.outcome
            const presentation = presented.descriptor as unknown as JsonValue
            if (presented.outcome.outcome === 'completed') return {outcome: 'completed' as const, run_id: presented.outcome.runId, payload: presented.outcome.payload as JsonValue, presentation}
            if (presented.outcome.outcome === 'aborted') return {outcome: 'aborted' as const, run_id: presented.outcome.runId, ...(presented.outcome.reason === undefined ? {} : {reason: presented.outcome.reason}), presentation}

            return {outcome: presented.outcome.outcome, run_id: presented.outcome.runId, presentation}
        },
        presentCall: args => genericCard(`呈现 ${String(args.kind)} 工件`, 'other', args.path)
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'get_run_outcome',
        description: '读取指定 Run 的持久终局。没有 outcome.json 时返回 active；不会创建或终结 Run。',
        parameters: {kind: KIND_SCHEMA, hash: HASH_SCHEMA, run_id: {type: 'string', required: true, description: 'Run ID'}},
        output: {
            schema: {oneOf: [
                {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'active'}, run_id: {type: 'string', required: true}}},
                {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'completed'}, run_id: {type: 'string', required: true}, payload: FREE_JSON}},
                {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'aborted'}, run_id: {type: 'string', required: true}, reason: {type: 'string'}}},
                ERROR_OUTCOME
            ]},
            render: (_args, value) => textBlocks(value)
        },
        async execute(args: {kind: ArtifactKind; hash: string; run_id: string}, exec) {
            requireOwner(exec, agent)
            const cwd = requireCwd(agent)
            try {
                const ref = {cwd, kind: args.kind, hash: args.hash, runId: args.run_id}
                if (!await learning.runs.exists(ref)) return {outcome: 'error' as const, detail: `Run 不存在：${args.run_id}`}
                const outcome = await learning.runs.outcome(ref)
                if (outcome === null) return {outcome: 'active' as const, run_id: args.run_id}
                return outcome.state === 'completed' ? {outcome: 'completed' as const, run_id: args.run_id, payload: outcome.payload as JsonValue} : {outcome: 'aborted' as const, run_id: args.run_id, ...(outcome.reason === undefined ? {} : {reason: outcome.reason})}
            } catch (error: unknown) {
                return {outcome: 'error' as const, detail: errorText(error)}
            }
        },
        presentCall: args => genericCard('读取 Run 终局', 'read', args.run_id)
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'save_feedback',
        description: '为一个已 completed 的 Run 保存不透明批改载荷。不要复述完整题干，使用题号或简短引用定位。',
        parameters: {kind: KIND_SCHEMA, hash: HASH_SCHEMA, run_id: {type: 'string', required: true}, feedback: {...FREE_JSON, required: true, description: '任意 JSON 批改载荷'}},
        output: {schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'succeeded'}, run_id: {type: 'string', required: true}}}, ERROR_OUTCOME]}, render: (_args, value) => textBlocks(value)},
        async execute(args: {kind: ArtifactKind; hash: string; run_id: string; feedback: JsonValue}, exec) {
            requireOwner(exec, agent)
            const cwd = requireCwd(agent)
            try {
                await learning.saveFeedback({cwd, kind: args.kind, hash: args.hash, runId: args.run_id}, args.feedback)
                return {outcome: 'succeeded' as const, run_id: args.run_id}
            } catch (error: unknown) {
                return {outcome: 'error' as const, detail: errorText(error)}
            }
        },
        presentCall: args => genericCard('保存批改', 'other', args.run_id)
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'get_outline',
        description: '读取一个大纲的完整树、其 Workflow 状态、其工件绑定情况。',
        parameters: {outline_id: {type: 'string', required: true}},
        output: {schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'found'}, outline: FREE_OBJECT}}, {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'not-found'}}}, ERROR_OUTCOME]}, render: (_args, value) => textBlocks(value)},
        async execute(args: {outline_id: string}, exec) {
            requireOwner(exec, agent)
            try {
                const outline = await learning.readOutline(requireCwd(agent), args.outline_id)
                return outline === null ? {outcome: 'not-found' as const} : {outcome: 'found' as const, outline: outline as unknown as Record<string, JsonValue>}
            } catch (error: unknown) {
                return {outcome: 'error' as const, detail: errorText(error)}
            }
        },
        presentCall: args => genericCard('读取大纲', 'read', args.outline_id)
    })))

    // TIPS：工具，更新大纲
    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'update_outline',
        description: '创建或更新树形大纲的标题、说明和拓扑，不设置工件绑定，也不改变根级 Workflow。outline_id，如是更新原有大纲则必须传入其，而新建大纲时也须显式传入 null。更新前先调用 get_outline，并保留既有节点 ID。是否确定更新，工具会自行询问用户确认，无需模型额外预先询问。',
        parameters: {outline_id: {required: true, description: '必须明确选择操作：传 null 表示新建大纲；传入原有大纲 ID 表示更新该大纲。更新时不得省略、伪造或改写 ID；传入不存在的 ID 会返回错误。', oneOf: [{type: 'string'}, {type: 'null'}]}, title: {type: 'string', required: true}, tree: OUTLINE_TREE_SCHEMA},
        output: {schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'confirmed'}, outline: FREE_OBJECT}}, {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'cancelled'}, detail: {type: 'string'}}}, ERROR_OUTCOME]}, render: (_args, value) => textBlocks(value)},
        async execute(args: {outline_id: string | null; title: string; tree: JsonValue}, exec) {
            requireOwner(exec, agent)
            const cwd = requireCwd(agent)
            try {
                if (!Array.isArray(args.tree)) return {outcome: 'error' as const, detail: 'tree 必须是数组'}

                const outline = await learning.normalizeOutline(cwd, {title: args.title, tree: args.tree as unknown as OutlineNode[]}, args.outline_id)

                const answer = await confirmWrite(learning, agent, args.outline_id === null ? `新建大纲「${args.title}」？` : `更新大纲「${args.title}」？`, outline.tree, exec.signal)
                if (!answer.confirmed) return {outcome: 'cancelled' as const, ...(answer.custom === undefined ? {} : {detail: answer.custom})}

                await learning.saveOutline(cwd, outline)
                return {outcome: 'confirmed' as const, outline: outline as unknown as Record<string, JsonValue>}
            } catch (error: unknown) {
                return {outcome: 'error' as const, detail: errorText(error)}
            }
        },
        presentCall: args => genericCard(args.outline_id === null ? '创建大纲' : '更新大纲', 'other', args.title)
    })))

    // THINKING：我感觉这个绑定工件可以不用问用户
    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'update_outline_artifact_binding',
        description: '设置或解除大纲课程节点的 Lesson Artifact 绑定。outline_id 和 lesson_id 必须传入原有 ID；artifact_hash 传工件哈希表示绑定，传 null 表示解除绑定。本工具不改变 tree 或 Workflow，会自行询问用户确认。',
        parameters: {outline_id: {type: 'string', required: true, description: '目标大纲的原有 ID'}, lesson_id: {type: 'string', required: true, description: '目标课程节点的原有 ID，必须指向 kind 为 lesson 的节点'}, artifact_hash: {required: true, description: '传入已存在的 Lesson Artifact 哈希进行绑定；传 null 解除该课程的绑定。', oneOf: [{type: 'string'}, {type: 'null'}]}},
        output: {schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'confirmed'}, outline: FREE_OBJECT}}, {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'cancelled'}, detail: {type: 'string'}}}, ERROR_OUTCOME]}, render: (_args, value) => textBlocks(value)},
        async execute(args: {outline_id: string; lesson_id: string; artifact_hash: string | null}, exec) {
            requireOwner(exec, agent)
            const cwd = requireCwd(agent)
            try {
                const outline = await learning.readOutline(cwd, args.outline_id)
                if (outline === null) return {outcome: 'error' as const, detail: `大纲不存在：${args.outline_id}`}
                const answer = await confirmWrite(learning, agent, args.artifact_hash === null ? `解除课程「${args.lesson_id}」的工件绑定？` : `为课程「${args.lesson_id}」绑定工件？`, {outlineId: args.outline_id, lessonId: args.lesson_id, artifactHash: args.artifact_hash}, exec.signal)
                if (!answer.confirmed) return {outcome: 'cancelled' as const, ...(answer.custom === undefined ? {} : {detail: answer.custom})}
                const updated = await learning.updateOutlineArtifactBinding(cwd, args.outline_id, args.lesson_id, args.artifact_hash)
                return {outcome: 'confirmed' as const, outline: updated as unknown as Record<string, JsonValue>}
            } catch (error: unknown) {
                return {outcome: 'error' as const, detail: errorText(error)}
            }
        },
        presentCall: args => genericCard(args.artifact_hash === null ? '解除课程工件绑定' : '绑定课程工件', 'other', args.lesson_id)
    })))

    // TIPS：工具，大纲工作流（状态机）状态更新
    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'update_outline_workflow',
        description: '显式迁移大纲根级 Workflow。开始课程、进入 QA、结束 QA 或完成大纲都必须由模型调用；本工具与 Present/Run 无隐式联系。结束 QA 时会询问用户确认。',
        parameters: {outline_id: {type: 'string', required: true}, phase: {type: 'string', required: true, enum: ['not-started', 'learning', 'qa', 'completed']}, current_lesson_id: {type: 'string', description: '进入 learning 时的课程节点 ID'}},
        output: {schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'succeeded'}, outline: FREE_OBJECT}}, {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'confirmed'}, outline: FREE_OBJECT}}, {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'cancelled'}, detail: {type: 'string'}}}, ERROR_OUTCOME]}, render: (_args, value) => textBlocks(value)},
        async execute(args: {outline_id: string; phase: OutlinePhase; current_lesson_id?: string}, exec) {
            requireOwner(exec, agent)
            const cwd = requireCwd(agent)
            try {
                const before = await learning.readOutline(cwd, args.outline_id)
                if (before === null) return {outcome: 'error' as const, detail: `大纲不存在：${args.outline_id}`}
                const requiresConfirmation = before.workflow.phase === 'qa' && (args.phase === 'learning' || args.phase === 'completed')
                if (requiresConfirmation) {
                    const answer = await confirmWrite(learning, agent, args.phase === 'completed' ? `结束「${before.title}」？` : `结束本课并进入下一课「${args.current_lesson_id ?? ''}」？`, {from: before.workflow, to: {phase: args.phase, currentLessonId: args.current_lesson_id ?? null}}, exec.signal)
                    if (!answer.confirmed) return {outcome: 'cancelled' as const, ...(answer.custom === undefined ? {} : {detail: answer.custom})}
                }
                const outline = await learning.updateOutlineWorkflow(cwd, args.outline_id, args.phase, args.current_lesson_id ?? null)
                return {outcome: requiresConfirmation ? 'confirmed' as const : 'succeeded' as const, outline: outline as unknown as Record<string, JsonValue>}
            } catch (error: unknown) {
                return {outcome: 'error' as const, detail: errorText(error)}
            }
        },
        presentCall: args => genericCard('更新大纲 Workflow', 'other', args.outline_id)
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'activate_outline',
        description: '切换当前会话激活的大纲，只写 session projection。',
        parameters: {outline_id: {type: 'string', required: true}},
        output: {schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'succeeded'}, outline_id: {type: 'string', required: true}}}, ERROR_OUTCOME]}, render: (_args, value) => textBlocks(value)},
        async execute(args: {outline_id: string}, exec) {
            requireOwner(exec, agent)
            try {
                await learning.changeCurrentSessionOutline(agent, args.outline_id)
                return {outcome: 'succeeded' as const, outline_id: args.outline_id}
            } catch (error: unknown) {
                return {outcome: 'error' as const, detail: errorText(error)}
            }
        },
        presentCall: args => genericCard('激活大纲', 'other', args.outline_id)
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'get_review_plan',
        description: '读取一个课程的复习计划、当前 FSRS 状态和全部正式复习期次。',
        parameters: {plan_id: {type: 'string', required: true}},
        output: {schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'found'}, plan: FREE_OBJECT}}, {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'not-found'}}}, ERROR_OUTCOME]}, render: (_args, value) => textBlocks(value)},
        async execute(args: {plan_id: string}, exec) {
            requireOwner(exec, agent)
            try {
                const plan = await learning.reviewPlansFor(requireCwd(agent)).read(args.plan_id)
                return plan === null ? {outcome: 'not-found' as const} : {outcome: 'found' as const, plan: plan as unknown as Record<string, JsonValue>}
            } catch (error: unknown) {
                return {outcome: 'error' as const, detail: errorText(error)}
            }
        },
        presentCall: args => genericCard('读取复习计划', 'read', args.plan_id)
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'update_review_plan',
        description: '创建或结算复习计划。plan_id 显式传 null 时，根据 rating 创建没有初始复习期次的新计划；传已有计划 ID 时，必须存在唯一已绑定且已完成批改的 active round，工具会结算它并由 Core 计算新的 FSRS 状态。',
        parameters: {plan_id: {required: true, oneOf: [{type: 'string'}, {type: 'null'}]}, outline_id: {type: 'string', description: '创建计划时必填'}, lesson_id: {type: 'string', description: '创建计划时必填'}, rating: RATING_SCHEMA},
        output: {schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'confirmed'}, plan_id: {type: 'string', required: true}, due_at: {type: 'string', required: true}, mode: {type: 'string', required: true, enum: ['create', 'complete']}}}, {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'cancelled'}, detail: {type: 'string'}}}, ERROR_OUTCOME]}, render: (_args, value) => textBlocks(value)},
        async execute(args: {plan_id: string | null; outline_id?: string; lesson_id?: string; rating: ReviewRating}, exec) {
            requireOwner(exec, agent)
            const cwd = requireCwd(agent)
            try {
                const creating = args.plan_id === null
                if (creating && (args.outline_id === undefined || args.lesson_id === undefined)) return {outcome: 'error' as const, detail: '创建复习计划必须提供 outline_id 和 lesson_id'}
                const answer = await confirmWrite(learning, agent, creating ? `为课程「${args.lesson_id ?? ''}」创建复习计划？` : `结算复习计划「${args.plan_id}」的当前期次？`, {rating: args.rating}, exec.signal)
                if (!answer.confirmed) return {outcome: 'cancelled' as const, ...(answer.custom === undefined ? {} : {detail: answer.custom})}
                if (creating) {
                    const prepared = await learning.createReviewPlan(cwd, {outlineId: args.outline_id as string, lessonId: args.lesson_id as string, rating: args.rating})
                    await learning.saveReviewPlan(cwd, prepared)
                    return {outcome: 'confirmed' as const, plan_id: prepared.plan.id, due_at: prepared.dueAt, mode: 'create' as const}
                }
                const plan = await learning.completeReviewPlan(cwd, args.plan_id as string, args.rating)
                return {outcome: 'confirmed' as const, plan_id: plan.id, due_at: String(plan.card.due), mode: 'complete' as const}
            } catch (error: unknown) {
                return {outcome: 'error' as const, detail: errorText(error)}
            }
        },
        presentCall: args => genericCard(args.plan_id === null ? '创建复习计划' : '结算复习计划', 'other', args.plan_id ?? args.lesson_id)
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'claim_review_plan_round',
        description: '取得一个正式复习计划的唯一 active round。计划到期时可直接取得，未到期必须显式传 force=true；已有 active round 时直接返回它。',
        parameters: {plan_id: {type: 'string', required: true}, force: {type: 'boolean'}},
        output: {schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'succeeded'}, plan_id: {type: 'string', required: true}, round_id: {type: 'string', required: true}, state: {type: 'string', required: true, const: 'active'}, started_at: {type: 'string', required: true}}}, ERROR_OUTCOME]}, render: (_args, value) => textBlocks(value)},
        async execute(args: {plan_id: string; force?: boolean}, exec) {
            requireOwner(exec, agent)
            try {
                const claimed = await learning.claimReviewPlanRound(requireCwd(agent), args.plan_id, args.force === true)
                return {outcome: 'succeeded' as const, plan_id: args.plan_id, round_id: claimed.round.id, state: 'active' as const, started_at: claimed.round.startedAt}
            } catch (error: unknown) {
                return {outcome: 'error' as const, detail: errorText(error)}
            }
        },
        presentCall: args => genericCard('取得正式复习期次', 'other', args.plan_id)
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'claim_temporary_review_plan_round',
        description: '为已经学完的课程创建一个由 man.json 托管的临时复习期次。man.json 可以同时托管多个临时期次。',
        parameters: {outline_id: {type: 'string', required: true}, lesson_id: {type: 'string', required: true}},
        output: {schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'succeeded'}, temporary_round_id: {type: 'string', required: true}, started_at: {type: 'string', required: true}}}, ERROR_OUTCOME]}, render: (_args, value) => textBlocks(value)},
        async execute(args: {outline_id: string; lesson_id: string}, exec) {
            requireOwner(exec, agent)
            try {
                const claimed = await learning.claimTemporaryReviewPlanRound(requireCwd(agent), args.outline_id, args.lesson_id)
                return {outcome: 'succeeded' as const, temporary_round_id: claimed.round.id, started_at: claimed.round.startedAt}
            } catch (error: unknown) {
                return {outcome: 'error' as const, detail: errorText(error)}
            }
        },
        presentCall: args => genericCard('取得临时复习期次', 'other', args.lesson_id)
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'update_review_plan_round_artifact_binding',
        description: '更新正式复习计划指定期次的 Review Artifact 绑定。期次必须 active，工件必须是 Review Artifact。',
        parameters: {review_plan_id: {type: 'string', required: true}, round_id: {type: 'string', required: true}, artifact_hash: HASH_SCHEMA},
        output: {schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'succeeded'}, review_plan_id: {type: 'string', required: true}, round_id: {type: 'string', required: true}}}, ERROR_OUTCOME]}, render: (_args, value) => textBlocks(value)},
        async execute(args: {review_plan_id: string; round_id: string; artifact_hash: string}, exec) {
            requireOwner(exec, agent)
            try {
                await learning.updateReviewPlanRoundArtifactBinding(requireCwd(agent), args.review_plan_id, args.round_id, args.artifact_hash)
                return {outcome: 'succeeded' as const, review_plan_id: args.review_plan_id, round_id: args.round_id}
            } catch (error: unknown) {
                return {outcome: 'error' as const, detail: errorText(error)}
            }
        },
        presentCall: args => genericCard('更新正式复习期次工件绑定', 'other', args.round_id)
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'update_temporary_review_plan_round_artifact_binding',
        description: '更新 man.json 中指定临时复习期次的 Review Artifact 绑定。',
        parameters: {temporary_round_id: {type: 'string', required: true}, artifact_hash: HASH_SCHEMA},
        output: {schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'succeeded'}, temporary_round_id: {type: 'string', required: true}}}, ERROR_OUTCOME]}, render: (_args, value) => textBlocks(value)},
        async execute(args: {temporary_round_id: string; artifact_hash: string}, exec) {
            requireOwner(exec, agent)
            try {
                await learning.updateTemporaryReviewPlanRoundArtifactBinding(requireCwd(agent), args.temporary_round_id, args.artifact_hash)
                return {outcome: 'succeeded' as const, temporary_round_id: args.temporary_round_id}
            } catch (error: unknown) {
                return {outcome: 'error' as const, detail: errorText(error)}
            }
        },
        presentCall: args => genericCard('更新临时复习期次工件绑定', 'other', args.temporary_round_id)
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'adopt_temporary_review_plan_round',
        description: '将 man.json 中已经绑定 Review Artifact、且已有 completed Run 与 feedback 的临时复习期次纳入匹配的正式复习计划。',
        parameters: {temporary_round_id: {type: 'string', required: true}, review_plan_id: {type: 'string', required: true}},
        output: {schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'succeeded'}, temporary_round_id: {type: 'string', required: true}, review_plan_id: {type: 'string', required: true}}}, ERROR_OUTCOME]}, render: (_args, value) => textBlocks(value)},
        async execute(args: {temporary_round_id: string; review_plan_id: string}, exec) {
            requireOwner(exec, agent)
            try {
                await learning.adoptTemporaryReviewPlanRound(requireCwd(agent), args.temporary_round_id, args.review_plan_id)
                return {outcome: 'succeeded' as const, temporary_round_id: args.temporary_round_id, review_plan_id: args.review_plan_id}
            } catch (error: unknown) {
                return {outcome: 'error' as const, detail: errorText(error)}
            }
        },
        presentCall: args => genericCard('纳入临时复习期次', 'other', args.temporary_round_id)
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'filter_notes',
        description: '按标签筛选模型可读的笔记。当前工作区由会话隐含。',
        parameters: {tags: {type: 'array', required: true, items: {type: 'string'}}},
        output: {schema: {type: 'object', additionalProperties: false, properties: {ids: {type: 'array', required: true, items: {type: 'string'}}}}, render: (_args, value) => textBlocks(value)},
        async execute(args: {tags: string[]}, exec) {
            requireOwner(exec, agent)
            requireCwd(agent)
            return {ids: learning.notes.filterForModel(args.tags)}
        },
        presentCall: () => genericCard('筛选笔记', 'read')
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'get_note',
        description: '读取一条模型可读笔记。',
        parameters: {note_id: {type: 'string', required: true}},
        output: {schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'not-found'}}}, {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'found'}, note: FREE_OBJECT}}]}, render: (_args, value) => textBlocks(value)},
        async execute(args: {note_id: string}, exec) {
            requireOwner(exec, agent)
            requireCwd(agent)
            const note = learning.notes.modelReadable(args.note_id)
            return note === undefined ? {outcome: 'not-found' as const} : {outcome: 'found' as const, note: note as unknown as Record<string, JsonValue>}
        },
        presentCall: args => genericCard('读取笔记', 'read', args.note_id)
    })))

    disposers.push(agent.ctx.tools.register(defineTool({
        name: 'update_note',
        description: '更新一条允许模型写入的笔记，工具会自行询问用户确认。',
        parameters: {note_id: {type: 'string', required: true}, markdown: {type: 'string', required: true}},
        output: {schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'confirmed'}, note_id: {type: 'string', required: true}}}, {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'cancelled'}, detail: {type: 'string'}}}, ERROR_OUTCOME]}, render: (_args, value) => textBlocks(value)},
        async execute(args: {note_id: string; markdown: string}, exec) {
            requireOwner(exec, agent)
            requireCwd(agent)
            const note = learning.notes.modelReadable(args.note_id)
            if (note === undefined) return {outcome: 'error' as const, detail: '笔记不存在或模型不可读'}
            if (note.access !== 'readwrite') return {outcome: 'error' as const, detail: '该笔记不允许模型写入'}
            const answer = await confirmWrite(learning, agent, `更新笔记「${note.title}」？`, args.markdown.slice(0, 500), exec.signal)
            if (!answer.confirmed) return {outcome: 'cancelled' as const, ...(answer.custom === undefined ? {} : {detail: answer.custom})}
            try {
                await learning.notes.updateNote(args.note_id, {markdown: args.markdown})
                return {outcome: 'confirmed' as const, note_id: args.note_id}
            } catch (error: unknown) {
                return {outcome: 'error' as const, detail: errorText(error)}
            }
        },
        presentCall: args => genericCard('更新笔记', 'other', args.note_id)
    })))

    return () => { for (const dispose of disposers.reverse()) dispose() }
}

function requireCwd(agent: Agent): string {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) throw new Error('当前学习会话没有工作区目录')
    return cwd
}

function requireOwner(exec: {agent?: Agent}, agent: Agent): void {
    if (exec.agent !== agent) throw new Error('工具调用不属于当前学习会话')
}
