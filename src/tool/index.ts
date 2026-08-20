import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {ContentBlock} from '@deepseek-ai/dsh-llm'
import {defineTool} from '@deepseek-ai/dsh-tools'
import type {GenericCallView} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {LearningService} from '../core/index.ts'
import {LEARNING_ARTIFACT_PATH} from '../core/files.ts'
import type {JsonValue} from '@deepseek-ai/dsh-session'
import type {ArtifactKind} from '../shared/artifacts.ts'
import type {PresentArtifactDescriptor} from '../shared/api.ts'
import type {OutlineNode, ReviewRating} from '../shared/model.ts'

// 工具返回值类型。必须与各工具的 output schema 完全一致

export type PresentValue = {readonly kind: 'result', readonly hash: string, readonly run_id: string, readonly url: string, readonly result: JsonValue, readonly presentation: JsonValue} | {readonly kind: 'no-result', readonly reason: 'interrupted' | 'timeout' | 'error', readonly detail?: string, readonly hash: string, readonly run_id?: string, readonly url?: string, readonly presentation?: JsonValue}
export type GetResultValue = {readonly kind: 'none'} | {readonly kind: 'result', readonly run_id: string, readonly hash: string, readonly result: JsonValue}
export type SaveFeedbackValue = {readonly outcome: 'saved', readonly run_id: string, readonly hash: string, readonly saved_at: string} | {readonly outcome: 'error', readonly detail: string}
export type UpdateReviewPlanValue = {readonly outcome: 'confirmed', readonly lesson_id: string, readonly source_run_id: string, readonly rating: ReviewRating, readonly due: string, readonly history_count: number} | {readonly outcome: 'cancelled', readonly detail?: string} | {readonly outcome: 'error', readonly detail: string}
export type GetOutlineValue = {readonly kind: 'none'} | {readonly kind: 'outline', readonly outline: Record<string, JsonValue>}
export type UpdateOutlineValue = {readonly outcome: 'confirmed', readonly outline: Record<string, JsonValue>} | {readonly outcome: 'cancelled', readonly detail?: string} | {readonly outcome: 'error', readonly detail: string}
export type ActivateValue = {readonly outcome: 'activated', readonly outline_id: string} | {readonly outcome: 'error', readonly detail: string}
export interface FilterNotesValue { readonly ids: string[] }
export type GetNoteValue = {readonly kind: 'none'} | {readonly kind: 'note', readonly id: string, readonly title: string, readonly markdown: string, readonly tags: string[], readonly access: string}
export type UpdateNoteValue = {readonly outcome: 'confirmed', readonly id: string} | {readonly outcome: 'cancelled', readonly detail?: string} | {readonly outcome: 'error', readonly detail: string}
interface ConfirmAnswer { readonly confirmed: boolean, readonly custom?: string }

// 在工具内部确认一次待执行的写入
async function confirmWrite(ctx: Context, agent: Agent, title: string, detail: string, signal?: AbortSignal): Promise<ConfirmAnswer> {
    try {
        const answer = await ctx.userQuestions.ask({questions: [{id: 'confirm', header: '确认写入', question: title, detail, options: [{label: '确认', description: '允许本次写入'}, {label: '取消', description: '放弃本次写入'}]}], agent, ...(signal !== undefined ? {signal} : {})})
        const chosen = answer.answers[0]
        const confirmed = chosen?.selected.includes('确认') ?? false
        return {confirmed, ...(chosen?.custom !== undefined ? {custom: chosen.custom} : {})}
    } catch {
        return {confirmed: false, custom: 'confirmation unavailable'}
    }
}

function genericCard(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView { return {card: 'generic', title, kind, ...(rawInput === undefined ? {} : {rawInput})} }
function textBlocks(value: unknown): ContentBlock[] { return [{type: 'text', text: JSON.stringify(value)}] }


const KIND_SCHEMA = {type: 'string', required: true, enum: ['lesson', 'review', 'quiz']} as const
const HASH_SCHEMA = {type: 'string', required: true} as const
const FREE_OBJECT = {type: 'object', required: true, additionalProperties: true} as const
const FREE_JSON = {type: 'json'} as const // 不受约束且无损的 JSON，可为基本类型、数组、对象或 null
const RATING_SCHEMA = {type: 'string', required: true, enum: ['again', 'hard', 'good', 'easy']} as const

// 在一个精确的 Agent 作用域里注册十个 DVL 工具
export function installLearningTools(rootCtx: Context, toolCtx: Context, agent: Agent): () => void {
    const learning: LearningService = rootCtx.learning
    const disposers: Array<() => void> = []

    // ── present_artifact 工具 ──
    disposers.push(toolCtx.tools.register(defineTool({
        name: 'present_artifact',
        description: `Present one authored artifact (lesson/review/quiz WebApp) to the user and wait for their submission. The artifact HTML must already exist at the conventional path <workspace>/${LEARNING_ARTIFACT_PATH}. This creates (or, on retry of the same call, resumes) a run and returns its canonical URL + run id. The call suspends until the user submits (returns the result envelope with the raw payload), or aborts/times out (returns no-result: afterwards call get_result with run_id, or ask the user whether they finished). For kind=lesson this starts the course (state becomes 学习中). No review card or FSRS state is ever created or advanced here.`,
        parameters: {
            kind: {...KIND_SCHEMA, description: 'Artifact kind.'},
            target_id: {type: 'string', required: true, description: 'Lesson id this artifact belongs to.'},
            path: {type: 'string', required: true, description: 'Absolute path of the authored artifact HTML.'},
            title: {type: 'string', description: 'Optional display title (defaults to the artifact hash).'}
        },
        output: {
            schema: {
                oneOf: [
                    {type: 'object', additionalProperties: false, properties: {kind: {type: 'string', required: true, const: 'result'}, hash: {type: 'string', required: true}, run_id: {type: 'string', required: true}, url: {type: 'string', required: true}, result: FREE_JSON, presentation: FREE_JSON}},
                    {type: 'object', additionalProperties: false, properties: {kind: {type: 'string', required: true, const: 'no-result'}, reason: {type: 'string', required: true, enum: ['interrupted', 'timeout', 'error']}, detail: {type: 'string'}, hash: {type: 'string', required: true}, run_id: {type: 'string'}, url: {type: 'string'}, presentation: FREE_JSON}}
                ]
            },
            render: (_args, value) => textBlocks(value),
            presentationMeta: (_args, value) => value.presentation ?? null
        },
        async execute(args: {kind: ArtifactKind, target_id: string, path: string, title?: string}, exec): Promise<PresentValue> {
            requireOwner(exec, agent)
            const cwd = requireCwd(agent)
            let descriptor: PresentArtifactDescriptor

            try {
                descriptor = await learning.createOrResumeRun(cwd, args.kind, args.target_id, args.path, exec.callId, args.title)
            } catch (error: unknown) {
                return {kind: 'no-result', reason: 'error', detail: error instanceof Error ? error.message : String(error), hash: ''}
            }

            try {
                const outcome = await learning.present(cwd, args.kind, descriptor.hash, descriptor.runId, {signal: exec.signal})
                if (outcome.kind === 'result') return {kind: 'result', hash: descriptor.hash, run_id: descriptor.runId, url: descriptor.url, result: outcome.result as unknown as JsonValue, presentation: descriptor as unknown as JsonValue}
                return {kind: 'no-result', reason: outcome.reason, ...(outcome.detail !== undefined ? {detail: outcome.detail} : {}), hash: descriptor.hash, run_id: descriptor.runId, url: descriptor.url, presentation: descriptor as unknown as JsonValue}
            } finally {
                learning.forgetDescriptor(exec.callId)
            }
        },
        presentCall: args => genericCard(`Present ${String(args.kind)} artifact`, 'other', args.title)
    })))

    // ── get_result 工具 ──
    disposers.push(toolCtx.tools.register(defineTool({
        name: 'get_result',
        description: 'Read the durable result envelope of one artifact run (lesson/review/quiz). Pass run_id to read exactly that run; omit it to read the latest submitted run of the artifact. Use after a present_artifact returned no-result: the user may have submitted after the tool settled. Returns none when nothing was submitted yet.',
        parameters: {
            kind: {...KIND_SCHEMA, description: 'Artifact kind.'},
            hash: {...HASH_SCHEMA, description: 'Artifact content hash (directory name under the category).'},
            run_id: {type: 'string', description: 'Optional run id; omitted = latest submitted run.'}
        },
        output: {
            schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {kind: {type: 'string', required: true, const: 'none'}}}, {type: 'object', additionalProperties: false, properties: {kind: {type: 'string', required: true, const: 'result'}, run_id: {type: 'string', required: true}, hash: {type: 'string', required: true}, result: FREE_JSON}}]},
            render: (_args, value) => textBlocks(value)
        },
        async execute(args: {kind: ArtifactKind, hash: string, run_id?: string}, exec): Promise<GetResultValue> {
            requireOwner(exec, agent)
            const cwd = requireCwd(agent)
            const found = await learning.getResult(cwd, args.kind, args.hash, args.run_id)
            return found === null ? {kind: 'none'} : {kind: 'result', run_id: found.runId, hash: args.hash, result: found.result as unknown as JsonValue}
        },
        presentCall: () => genericCard('Read artifact result', 'read')
    })))

    // ── save_feedback 工具 ──
    disposers.push(toolCtx.tools.register(defineTool({
        name: 'save_feedback',
        description: 'Save your grading report for one finished run. The report is an arbitrary JSON value (object/array/primitive/null) — DVL stores it verbatim and never validates its schema. DVL resolves the run, verifies it belongs to the artifact and already has a result, and owns the file path. You do not construct any feedback.json path. The return value is saved (with run id + saved time) / error.',
        parameters: {
            kind: {...KIND_SCHEMA, description: 'Artifact kind of the run.'},
            hash: {...HASH_SCHEMA, description: 'Artifact content hash (directory name under the category).'},
            run_id: {type: 'string', required: true, description: 'The run whose result you graded.'},
            feedback: {...FREE_JSON, required: true, description: 'Your grading report, any JSON value (not parsed by DVL).'}
        },
        output: {
            schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'saved'}, run_id: {type: 'string', required: true}, hash: {type: 'string', required: true}, saved_at: {type: 'string', required: true}}}, {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'error'}, detail: {type: 'string', required: true}}}]},
            render: (_args, value) => textBlocks(value)
        },
        async execute(args: {kind: ArtifactKind, hash: string, run_id: string, feedback: JsonValue}, exec): Promise<SaveFeedbackValue> {
            requireOwner(exec, agent)
            const cwd = requireCwd(agent)

            try {
                const feedback = await learning.saveFeedback(cwd, args.kind, args.hash, args.run_id, args.feedback)
                return {outcome: 'saved', run_id: feedback.runId, hash: feedback.artifactHash, saved_at: feedback.savedAt}
            } catch (error: unknown) {
                return {outcome: 'error', detail: error instanceof Error ? error.message : String(error)}
            }
        },
        presentCall: args => genericCard('Save grading report', 'other', args.run_id)
    })))

    // ── update_review_plan 工具 ──
    disposers.push(toolCtx.tools.register(defineTool({
        name: 'update_review_plan',
        description: 'Create or update the FSRS review plan of one lesson from your full grading judgement of a finished run. This is the ONLY path that creates or advances a review card. rating is your explicit FSRS rating (again/hard/good/easy) — never derived from an automatic score. DVL verifies source_kind/source_hash/source_run_id point at a real run that has a result and belongs to lesson_id. source_run_id makes the write idempotent: the same run can never advance the card twice. The tool asks the user to confirm inside the tool before writing; the return value is confirmed / cancelled / error.',
        parameters: {
            lesson_id: {type: 'string', required: true, description: 'Lesson id the review belongs to.'},
            source_kind: {...KIND_SCHEMA, description: 'Artifact kind of the source run.'},
            source_hash: {...HASH_SCHEMA, description: 'Artifact content hash of the source run.'},
            source_run_id: {type: 'string', required: true, description: 'The run whose result this rating came from (idempotency key).'},
            rating: {...RATING_SCHEMA, description: 'Your explicit FSRS rating from the full grading.'},
            reason: {type: 'string', description: 'Optional short rationale for the rating.'}
        },
        output: {
            schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'confirmed'}, lesson_id: {type: 'string', required: true}, source_run_id: {type: 'string', required: true}, rating: RATING_SCHEMA, due: {type: 'string', required: true}, history_count: {type: 'integer', required: true}}}, {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'cancelled'}, detail: {type: 'string'}}}, {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'error'}, detail: {type: 'string', required: true}}}]},
            render: (_args, value) => textBlocks(value)
        },
        async execute(args: {lesson_id: string, source_kind: ArtifactKind, source_hash: string, source_run_id: string, rating: ReviewRating, reason?: string}, exec): Promise<UpdateReviewPlanValue> {
            requireOwner(exec, agent)
            const cwd = requireCwd(agent)
            let proposal

            try {
                proposal = await learning.computeReviewPlan(cwd, args.lesson_id, args.rating, args.source_kind, args.source_hash, args.source_run_id, args.reason)
            } catch (error: unknown) {
                return {outcome: 'error', detail: error instanceof Error ? error.message : String(error)}
            }

            if (proposal.alreadyApplied) return {outcome: 'error', detail: `source run '${args.source_run_id}' already applied to review plan`}

            const answer = await confirmWrite(rootCtx, agent, `更新复习计划「${args.lesson_id}」？`, JSON.stringify({rating: proposal.rating, reason: proposal.reason, nextDue: proposal.due, sourceRunId: proposal.sourceRunId}, null, 2), exec.signal)
            if (!answer.confirmed) return {outcome: 'cancelled', ...(answer.custom !== undefined ? {detail: answer.custom} : {})}

            try {
                const cardFile = await learning.commitReviewPlan(cwd, args.lesson_id, args.rating, args.source_kind, args.source_hash, args.source_run_id, args.reason)
                return {outcome: 'confirmed', lesson_id: args.lesson_id, source_run_id: args.source_run_id, rating: args.rating, due: proposal.due, history_count: cardFile.history.length}
            } catch (error: unknown) {
                return {outcome: 'error', detail: error instanceof Error ? error.message : String(error)}
            }
        },
        presentCall: args => genericCard('Update review plan', 'other', args.lesson_id)
    })))

    // ── get_outline 工具 ──
    disposers.push(toolCtx.tools.register(defineTool({
        name: 'get_outline',
        description: 'Read one outline (syllabus) of the current workspace: title, node tree, and per-lesson states. The active outline id comes from the per-turn DVL snapshot.',
        parameters: {outline_id: {type: 'string', required: true, description: 'Outline id.'}},
        output: {
            schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {kind: {type: 'string', required: true, const: 'none'}}}, {type: 'object', additionalProperties: false, properties: {kind: {type: 'string', required: true, const: 'outline'}, outline: FREE_OBJECT}}]},
            render: (_args, value) => textBlocks(value)
        },
        async execute(args: {outline_id: string}, exec): Promise<GetOutlineValue> {
            requireOwner(exec, agent)
            const cwd = requireCwd(agent)
            const outline = await learning.readOutline(cwd, args.outline_id)
            return outline === null ? {kind: 'none'} : {kind: 'outline', outline: outline as unknown as Record<string, JsonValue>}
        },
        presentCall: () => genericCard('Read outline', 'read')
    })))

    // ── update_outline 工具 ──。FIXME：这玩意儿有问题。如果工件存在问题，虽然用户 confirmed，但它这个依然有问题，所以可能会导致之后出现问题
    disposers.push(toolCtx.tools.register(defineTool({
        name: 'update_outline',
        description: 'Create or replace an outline (syllabus) of the current workspace. Omit outline_id to create a new one. The tool itself asks the user to confirm the write before it lands; the return value is confirmed (with the saved outline) / cancelled / error. Lesson node states advance through this same tool: set state to done when Q&A closes. Preserve node ids, lesson ids, artifactHash and state of unchanged lessons — the plugin reuses artifacts by content hash and clears orphans automatically.',
        parameters: {
            outline_id: {type: 'string', description: 'Outline id to replace; omitted creates a new outline.'},
            title: {type: 'string', required: true, description: 'Outline title.'},
            nodes: {type: 'array', required: true, description: 'Full node tree. Each node: id (stable, keep existing), kind (group|lesson), title, order, parentId (root children use null or omit; empty string also treated as root), and for lessons: lessonId, state (not-started|learning|qa|done), artifactHash, description.', items: {type: 'object', additionalProperties: true, properties: {id: {type: 'string'}, kind: {type: 'string', enum: ['group', 'lesson']}, title: {type: 'string'}, order: {type: 'number'}, parentId: {type: 'string', description: 'Omit (or empty string) for root children.'}, lessonId: {type: 'string'}, state: {type: 'string', enum: ['not-started', 'learning', 'qa', 'done']}, artifactHash: {type: 'string'}, description: {type: 'string'}}}}
        },
        output: {
            schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'confirmed'}, outline: FREE_OBJECT}}, {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'cancelled'}, detail: {type: 'string'}}}, {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'error'}, detail: {type: 'string', required: true}}}]},
            render: (_args, value) => textBlocks(value)
        },
        async execute(args: {outline_id?: string, title: string, nodes: unknown[]}, exec): Promise<UpdateOutlineValue> {
            requireOwner(exec, agent)
            const cwd = requireCwd(agent)
            let outline

            try {
                outline = await learning.normalizeOutline(cwd, {title: args.title, nodes: args.nodes as unknown as OutlineNode[]}, args.outline_id)
            } catch (error: unknown) {
                return {outcome: 'error', detail: error instanceof Error ? error.message : String(error)}
            }

            const answer = await confirmWrite(rootCtx, agent, args.outline_id === undefined ? `新建纲目「${args.title}」？` : `更新纲目「${args.title}」？`, JSON.stringify(outline.nodes.map(node => `${node.kind}:${node.title}`), null, 2), exec.signal)
            if (!answer.confirmed) return {outcome: 'cancelled', ...(answer.custom !== undefined ? {detail: answer.custom} : {})}

            try {
                await learning.saveOutline(cwd, outline)
                return {outcome: 'confirmed', outline: outline as unknown as Record<string, JsonValue>}
            } catch (error: unknown) {
                return {outcome: 'error', detail: error instanceof Error ? error.message : String(error)}
            }
        },
        presentCall: args => genericCard(args.outline_id === undefined ? 'Create outline' : 'Update outline', 'other', args.title)
    })))

    // ── activate_outline 工具 ──
    disposers.push(toolCtx.tools.register(defineTool({
        name: 'activate_outline',
        description: 'Switch this session-active outline. Call it only after the user clearly chooses or switches an outline and you have confirmed it exists.',
        parameters: {outline_id: {type: 'string', required: true, description: 'Outline id to activate.'}},
        output: {
            schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'activated'}, outline_id: {type: 'string', required: true}}}, {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'error'}, detail: {type: 'string', required: true}}}]},
            render: (_args, value) => textBlocks(value)
        },
        async execute(args: {outline_id: string}, exec): Promise<ActivateValue> {
            requireOwner(exec, agent)

            try {
                await learning.changeCurrentSessionOutline(agent, args.outline_id)
                return {outcome: 'activated', outline_id: args.outline_id}
            } catch (error: unknown) {
                return {outcome: 'error', detail: error instanceof Error ? error.message : String(error)}
            }
        },
        presentCall: args => genericCard('Activate outline', 'other', args.outline_id)
    })))

    // ── filter_notes 工具 ──
    disposers.push(toolCtx.tools.register(defineTool({
        name: 'filter_notes',
        description: "Find readable notes of the current workspace by tags (AND semantics). Tags use prefixes: `outline:<id>` or `lesson:<id>`. The current workspace is always implied; private notes and other workspaces are never returned. The user's notebook/folder organization is invisible to you — filter only by tags.",
        parameters: {tags: {type: 'array', required: true, description: 'Required tags (empty = every readable note of this workspace).', items: {type: 'string'}}},
        output: {
            schema: {type: 'object', additionalProperties: false, properties: {ids: {type: 'array', required: true, items: {type: 'string'}}}},
            render: (_args, value) => textBlocks(value)
        },
        async execute(args: {tags: string[]}, exec): Promise<FilterNotesValue> {
            requireOwner(exec, agent)
            requireCwd(agent)
            const ids = learning.notes.filterForModel(args.tags)
            return {ids}
        },
        presentCall: () => genericCard('Filter notes', 'read')
    })))

    // ── get_note 工具 ──
    disposers.push(toolCtx.tools.register(defineTool({
        name: 'get_note',
        description: 'Read one readable note of the current workspace (markdown body). Private notes or notes of other workspaces return none.',
        parameters: {note_id: {type: 'string', required: true, description: 'Note id from filter_notes.'}},
        output: {
            schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {kind: {type: 'string', required: true, const: 'none'}}}, {type: 'object', additionalProperties: false, properties: {kind: {type: 'string', required: true, const: 'note'}, id: {type: 'string', required: true}, title: {type: 'string', required: true}, markdown: {type: 'string', required: true}, tags: {type: 'array', required: true, items: {type: 'string'}}, access: {type: 'string', required: true}}}]},
            render: (_args, value) => textBlocks(value)
        },
        async execute(args: {note_id: string}, exec): Promise<GetNoteValue> {
            requireOwner(exec, agent)
            requireCwd(agent)
            const note = learning.notes.modelReadable(args.note_id)
            if (note === undefined) return {kind: 'none'}
            return {kind: 'note', id: note.id, title: note.title, markdown: note.markdown, tags: [...note.tags], access: note.access}
        },
        presentCall: args => genericCard('Read note', 'read', args.note_id)
    })))

    // ── update_note 工具 ──
    disposers.push(toolCtx.tools.register(defineTool({
        name: 'update_note',
        description: 'Update the markdown body of one readwrite note of the current workspace. You cannot create or delete notes (the user owns them in the GUI), and you cannot touch private or read-only notes. The tool asks the user to confirm before writing; the return value is confirmed / cancelled / error.',
        parameters: {
            note_id: {type: 'string', required: true, description: 'Note id from filter_notes.'},
            markdown: {type: 'string', required: true, description: 'Replacement markdown body.'}
        },
        output: {
            schema: {oneOf: [{type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'confirmed'}, id: {type: 'string', required: true}}}, {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'cancelled'}, detail: {type: 'string'}}}, {type: 'object', additionalProperties: false, properties: {outcome: {type: 'string', required: true, const: 'error'}, detail: {type: 'string', required: true}}}]},
            render: (_args, value) => textBlocks(value)
        },
        async execute(args: {note_id: string, markdown: string}, exec): Promise<UpdateNoteValue> {
            requireOwner(exec, agent)
            requireCwd(agent)

            const note = learning.notes.modelReadable(args.note_id)
            if (note === undefined) return {outcome: 'error', detail: 'note is private, foreign, or unknown'}
            if (note.access !== 'readwrite') return {outcome: 'error', detail: 'note is read-only for the model'}

            const answer = await confirmWrite(rootCtx, agent, `更新笔记「${note.title}」？`, args.markdown.slice(0, 500), exec.signal)
            if (!answer.confirmed) return {outcome: 'cancelled', ...(answer.custom !== undefined ? {detail: answer.custom} : {})}

            try {
                learning.notes.updateNote(args.note_id, {markdown: args.markdown})
                return {outcome: 'confirmed', id: args.note_id}
            } catch (error: unknown) {
                return {outcome: 'error', detail: error instanceof Error ? error.message : String(error)}
            }
        },
        presentCall: args => genericCard('Update note', 'other', args.note_id)
    })))

    return () => { for (const dispose of disposers.reverse()) dispose() }
}

// ---

// 获取调用方 Agent 的工作区 cwd，不存在时直接报错。这个可没判断说这是不是一个学习工作区，它只约束**要有工作区**
function requireCwd(agent: Agent): string {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) throw new Error('欲挂工具，CWD须具')

    return cwd
}

// 严格校验 Agent，已挂载的工具只为进入氛围学习的 Agent 服务
function requireOwner(exec: {agent?: Agent}, agent: Agent): void { if (exec.agent !== agent) throw new Error('汝欲用器，须处学习') }