/**
 * Model-facing DVL tools, mounted per learning session under the agent's own
 * scope (`agent.ctx`), so non-learning sessions never see them. Mutating
 * tools confirm inside the tool (userQuestions) instead of asking the model
 * to pre-ask.
 * @module dvl/tool-learning
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-user-questions'
import type { LearningService } from '../learning/index.ts'
import { workspaceIdOf } from '../shared/hash.ts'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ArtifactKind, OutlineNode, PresentOutcome } from '../shared/types.ts'

// ── typed result unions (must match each tool's output schema exactly) ─────

export type PresentValue =
  | { readonly kind: 'result'; readonly url: string; readonly hash: string; readonly result: Record<string, JsonValue> }
  | { readonly kind: 'no-result'; readonly reason: 'interrupted' | 'timeout' | 'error'; readonly detail?: string; readonly hash: string }

export type GetResultValue =
  | { readonly kind: 'none' }
  | { readonly kind: 'result'; readonly result: Record<string, JsonValue> }

export type GetOutlineValue =
  | { readonly kind: 'none' }
  | { readonly kind: 'outline'; readonly outline: Record<string, JsonValue> }

export type UpdateOutlineValue =
  | { readonly outcome: 'confirmed'; readonly outline: Record<string, JsonValue> }
  | { readonly outcome: 'cancelled'; readonly detail?: string }
  | { readonly outcome: 'error'; readonly detail: string }

export type ActivateValue =
  | { readonly outcome: 'activated'; readonly outline_id: string }
  | { readonly outcome: 'error'; readonly detail: string }

export interface FilterNotesValue { readonly ids: string[] }

export type GetNoteValue =
  | { readonly kind: 'none' }
  | {
    readonly kind: 'note'
    readonly id: string
    readonly title: string
    readonly markdown: string
    readonly tags: string[]
    readonly access: string
  }

export type UpdateNoteValue =
  | { readonly outcome: 'confirmed'; readonly id: string }
  | { readonly outcome: 'cancelled'; readonly detail?: string }
  | { readonly outcome: 'error'; readonly detail: string }

interface ConfirmAnswer {
  readonly confirmed: boolean
  readonly custom?: string
}

/** Ask the user to confirm one pending write, inside the tool. */
async function confirmWrite(
  ctx: Context,
  agent: Agent,
  title: string,
  detail: string,
  signal?: AbortSignal,
): Promise<ConfirmAnswer> {
  try {
    const answer = await ctx.userQuestions.ask({
      questions: [{
        id: 'confirm',
        header: '确认写入',
        question: title,
        detail,
        options: [
          { label: '确认', description: '允许本次写入' },
          { label: '取消', description: '放弃本次写入' },
        ],
      }],
      agent,
      ...(signal !== undefined ? { signal } : {}),
    })
    const chosen = answer.answers[0]
    const confirmed = chosen?.selected.includes('确认') ?? false
    return { confirmed, ...(chosen?.custom !== undefined ? { custom: chosen.custom } : {}) }
  } catch {
    return { confirmed: false, custom: 'confirmation unavailable' }
  }
}

function genericCard(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...(rawInput === undefined ? {} : { rawInput }) }
}

function textBlocks(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Exact live-agent guard: a mounted tool only serves its own agent. */
function requireOwner(exec: { agent?: Agent }, agent: Agent): void {
  if (exec.agent !== agent) throw new Error('dvl tool called for a foreign agent')
}

/** The calling agent's workspace cwd, or a thrown error. */
function requireCwd(agent: Agent): string {
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new Error('dvl tools require a session workspace (no cwd on this session)')
  return cwd
}

const KIND_SCHEMA = { type: 'string', required: true, enum: ['lesson', 'review', 'quiz'] } as const
const HASH_SCHEMA = { type: 'string', required: true } as const
const FREE_OBJECT = { type: 'object', required: true, additionalProperties: true } as const

/**
 * Register the eight DVL tools in one exact agent scope.
 * @param rootCtx - global service context (learning service, user questions).
 * @param toolCtx - exact agent-scoped context receiving the definitions.
 * @param agent - exact live owner whose session the tools read/write.
 * @returns aggregate disposer for every registration.
 */
export function registerLearningTools(rootCtx: Context, toolCtx: Context, agent: Agent): () => void {
  const learning: LearningService = rootCtx.learning
  const disposers: Array<() => void> = []

  // ── present_artifact ─────────────────────────────────────────────────────
  disposers.push(toolCtx.tools.register(defineTool({
    name: 'present_artifact',
    description: 'Present one authored artifact (lesson/review/quiz WebApp) to the user and wait for their submission. '
      + 'The artifact HTML must already exist at the conventional path `<workspace>/.dsh/learning/<lessons|reviews|quizzes>/<hash>/index.html`. '
      + 'The call suspends until the user submits (returns the result), or aborts/times out (returns no-result: afterwards call get_result, or ask the user whether they finished). '
      + 'For kind=lesson this starts the course (state becomes 学习中); for kind=review the lesson must have a review card (created automatically when missing).',
    parameters: {
      kind: { ...KIND_SCHEMA, description: 'Artifact kind.' },
      target_id: { type: 'string', required: true, description: 'Lesson id this artifact belongs to.' },
      path: { type: 'string', required: true, description: 'Absolute path of the authored artifact HTML.' },
      title: { type: 'string', description: 'Optional display title (defaults to the artifact hash).' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object', additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'result' },
              url: { type: 'string', required: true },
              hash: { type: 'string', required: true },
              result: FREE_OBJECT,
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'no-result' },
              reason: { type: 'string', required: true, enum: ['interrupted', 'timeout', 'error'] },
              detail: { type: 'string' },
              hash: { type: 'string', required: true },
            },
          },
        ],
      },
      render: (_args, value) => textBlocks(value),
    },
    async execute(args: { kind: ArtifactKind; target_id: string; path: string; title?: string }, exec): Promise<PresentValue> {
      requireOwner(exec, agent)
      const cwd = requireCwd(agent)
      try {
        const hash = await learning.registerArtifact(cwd, args.kind, args.target_id, args.path, args.title)
        const outcome: PresentOutcome = await learning.present(cwd, args.kind, hash, { signal: exec.signal })
        if (outcome.kind === 'result') {
          return { kind: 'result', url: learning.artifactUrl(cwd, args.kind, hash), hash, result: outcome.result as unknown as Record<string, JsonValue> }
        }
        return { kind: 'no-result', reason: outcome.reason, ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}), hash }
      } catch (error: unknown) {
        return { kind: 'no-result', reason: 'error', detail: error instanceof Error ? error.message : String(error), hash: '' }
      }
    },
    presentCall: args => genericCard(`Present ${String(args.kind)} artifact`, 'other', args.title),
  })))

  // ── get_result ───────────────────────────────────────────────────────────
  disposers.push(toolCtx.tools.register(defineTool({
    name: 'get_result',
    description: 'Read the durable result file of one artifact (lesson/review/quiz). '
      + 'Use after a present_artifact returned no-result: the user may have submitted after the tool settled. Returns none when nothing was submitted yet.',
    parameters: {
      kind: { ...KIND_SCHEMA, description: 'Artifact kind.' },
      hash: { ...HASH_SCHEMA, description: 'Artifact content hash (directory name under the category).' },
    },
    output: {
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'none' } } },
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'result' }, result: FREE_OBJECT } },
        ],
      },
      render: (_args, value) => textBlocks(value),
    },
    async execute(args: { kind: ArtifactKind; hash: string }, exec): Promise<GetResultValue> {
      requireOwner(exec, agent)
      const cwd = requireCwd(agent)
      const result = await learning.getResult(cwd, args.kind, args.hash)
      return result === null ? { kind: 'none' } : { kind: 'result', result: result as unknown as Record<string, JsonValue> }
    },
    presentCall: () => genericCard('Read artifact result', 'read'),
  })))

  // ── get_outline ──────────────────────────────────────────────────────────
  disposers.push(toolCtx.tools.register(defineTool({
    name: 'get_outline',
    description: 'Read one outline (syllabus) of the current workspace: title, node tree, and per-lesson states. '
      + 'The active outline id comes from the per-turn DVL snapshot.',
    parameters: {
      outline_id: { type: 'string', required: true, description: 'Outline id.' },
    },
    output: {
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'none' } } },
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'outline' }, outline: FREE_OBJECT } },
        ],
      },
      render: (_args, value) => textBlocks(value),
    },
    async execute(args: { outline_id: string }, exec): Promise<GetOutlineValue> {
      requireOwner(exec, agent)
      const cwd = requireCwd(agent)
      const outline = await learning.readOutline(cwd, args.outline_id)
      return outline === null ? { kind: 'none' } : { kind: 'outline', outline: outline as unknown as Record<string, JsonValue> }
    },
    presentCall: () => genericCard('Read outline', 'read'),
  })))

  // ── update_outline ───────────────────────────────────────────────────────
  disposers.push(toolCtx.tools.register(defineTool({
    name: 'update_outline',
    description: 'Create or replace an outline (syllabus) of the current workspace. '
      + 'Omit outline_id to create a new one. The tool itself asks the user to confirm the write before it lands; '
      + 'the return value is confirmed (with the saved outline) / cancelled / error. '
      + 'Lesson node states advance through this same tool: set state to done when Q&A closes. '
      + 'Preserve node ids, lesson ids, artifactHash and state of unchanged lessons — the plugin reuses artifacts by content hash and clears orphans automatically.',
    parameters: {
      outline_id: { type: 'string', description: 'Outline id to replace; omitted creates a new outline.' },
      title: { type: 'string', required: true, description: 'Outline title.' },
      nodes: {
        type: 'array', required: true,
        description: 'Full node tree. Each node: id (stable, keep existing), kind (group|lesson), title, order, parentId (null for root children), and for lessons: lessonId, state (not-started|learning|qa|done), artifactHash, description.',
        items: {
          type: 'object', additionalProperties: true,
          properties: {
            id: { type: 'string' },
            kind: { type: 'string', enum: ['group', 'lesson'] },
            title: { type: 'string' },
            order: { type: 'number' },
            parentId: { type: 'string' },
            lessonId: { type: 'string' },
            state: { type: 'string', enum: ['not-started', 'learning', 'qa', 'done'] },
            artifactHash: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    },
    output: {
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: { outcome: { type: 'string', required: true, const: 'confirmed' }, outline: FREE_OBJECT } },
          { type: 'object', additionalProperties: false, properties: { outcome: { type: 'string', required: true, const: 'cancelled' }, detail: { type: 'string' } } },
          { type: 'object', additionalProperties: false, properties: { outcome: { type: 'string', required: true, const: 'error' }, detail: { type: 'string', required: true } } },
        ],
      },
      render: (_args, value) => textBlocks(value),
    },
    async execute(args: { outline_id?: string; title: string; nodes: unknown[] }, exec): Promise<UpdateOutlineValue> {
      requireOwner(exec, agent)
      const cwd = requireCwd(agent)
      let outline
      try {
        outline = await learning.normalizeOutline(cwd, { title: args.title, nodes: args.nodes as unknown as OutlineNode[] }, args.outline_id)
      } catch (error: unknown) {
        return { outcome: 'error', detail: error instanceof Error ? error.message : String(error) }
      }
      const answer = await confirmWrite(rootCtx, agent,
        args.outline_id === undefined ? `新建纲目「${args.title}」？` : `更新纲目「${args.title}」？`,
        JSON.stringify(outline.nodes.map(node => `${node.kind}:${node.title}`), null, 2),
        exec.signal)
      if (!answer.confirmed) return { outcome: 'cancelled', ...(answer.custom !== undefined ? { detail: answer.custom } : {}) }
      try {
        await learning.saveOutline(cwd, outline)
        return { outcome: 'confirmed', outline: outline as unknown as Record<string, JsonValue> }
      } catch (error: unknown) {
        return { outcome: 'error', detail: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall: args => genericCard(args.outline_id === undefined ? 'Create outline' : 'Update outline', 'other', args.title),
  })))

  // ── activate_outline ─────────────────────────────────────────────────────
  disposers.push(toolCtx.tools.register(defineTool({
    name: 'activate_outline',
    description: 'Switch the workspace-active outline pointer. Only called when the user explicitly requested it via the /learn <outline-id> command flow.',
    parameters: {
      outline_id: { type: 'string', required: true, description: 'Outline id to activate.' },
    },
    output: {
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: { outcome: { type: 'string', required: true, const: 'activated' }, outline_id: { type: 'string', required: true } } },
          { type: 'object', additionalProperties: false, properties: { outcome: { type: 'string', required: true, const: 'error' }, detail: { type: 'string', required: true } } },
        ],
      },
      render: (_args, value) => textBlocks(value),
    },
    async execute(args: { outline_id: string }, exec): Promise<ActivateValue> {
      requireOwner(exec, agent)
      const cwd = requireCwd(agent)
      try {
        await learning.activate(cwd, args.outline_id)
        return { outcome: 'activated', outline_id: args.outline_id }
      } catch (error: unknown) {
        return { outcome: 'error', detail: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall: args => genericCard('Activate outline', 'other', args.outline_id),
  })))

  // ── filter_notes ─────────────────────────────────────────────────────────
  disposers.push(toolCtx.tools.register(defineTool({
    name: 'filter_notes',
    description: 'Find readable notes of the current workspace by tags (AND semantics). '
      + 'Tags use prefixes: `outline:<id>` or `lesson:<id>`. The current workspace is always implied; private notes and other workspaces are never returned. '
      + "The user's notebook/folder organization is invisible to you — filter only by tags.",
    parameters: {
      tags: {
        type: 'array', required: true,
        description: 'Required tags (empty = every readable note of this workspace).',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ids: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => textBlocks(value),
    },
    async execute(args: { tags: string[] }, exec): Promise<FilterNotesValue> {
      requireOwner(exec, agent)
      const cwd = requireCwd(agent)
      const ids = learning.notes.filterForModel(`workspace:${workspaceIdOf(cwd)}`, args.tags)
      return { ids }
    },
    presentCall: () => genericCard('Filter notes', 'read'),
  })))

  // ── get_note ─────────────────────────────────────────────────────────────
  disposers.push(toolCtx.tools.register(defineTool({
    name: 'get_note',
    description: 'Read one readable note of the current workspace (markdown body). Private notes or notes of other workspaces return none.',
    parameters: {
      note_id: { type: 'string', required: true, description: 'Note id from filter_notes.' },
    },
    output: {
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'none' } } },
          {
            type: 'object', additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'note' },
              id: { type: 'string', required: true },
              title: { type: 'string', required: true },
              markdown: { type: 'string', required: true },
              tags: { type: 'array', required: true, items: { type: 'string' } },
              access: { type: 'string', required: true },
            },
          },
        ],
      },
      render: (_args, value) => textBlocks(value),
    },
    async execute(args: { note_id: string }, exec): Promise<GetNoteValue> {
      requireOwner(exec, agent)
      const cwd = requireCwd(agent)
      const note = learning.notes.modelReadable(args.note_id, `workspace:${workspaceIdOf(cwd)}`)
      if (note === undefined) return { kind: 'none' }
      return { kind: 'note', id: note.id, title: note.title, markdown: note.markdown, tags: [...note.tags], access: note.access }
    },
    presentCall: args => genericCard('Read note', 'read', args.note_id),
  })))

  // ── update_note ──────────────────────────────────────────────────────────
  disposers.push(toolCtx.tools.register(defineTool({
    name: 'update_note',
    description: 'Update the markdown body of one readwrite note of the current workspace. '
      + 'You cannot create or delete notes (the user owns them in the GUI), and you cannot touch private or read-only notes. '
      + 'The tool asks the user to confirm before writing; the return value is confirmed / cancelled / error.',
    parameters: {
      note_id: { type: 'string', required: true, description: 'Note id from filter_notes.' },
      markdown: { type: 'string', required: true, description: 'Replacement markdown body.' },
    },
    output: {
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: { outcome: { type: 'string', required: true, const: 'confirmed' }, id: { type: 'string', required: true } } },
          { type: 'object', additionalProperties: false, properties: { outcome: { type: 'string', required: true, const: 'cancelled' }, detail: { type: 'string' } } },
          { type: 'object', additionalProperties: false, properties: { outcome: { type: 'string', required: true, const: 'error' }, detail: { type: 'string', required: true } } },
        ],
      },
      render: (_args, value) => textBlocks(value),
    },
    async execute(args: { note_id: string; markdown: string }, exec): Promise<UpdateNoteValue> {
      requireOwner(exec, agent)
      const cwd = requireCwd(agent)
      const note = learning.notes.modelReadable(args.note_id, `workspace:${workspaceIdOf(cwd)}`)
      if (note === undefined) return { outcome: 'error', detail: 'note is private, foreign, or unknown' }
      if (note.access !== 'readwrite') return { outcome: 'error', detail: 'note is read-only for the model' }
      const answer = await confirmWrite(rootCtx, agent, `更新笔记「${note.title}」？`, args.markdown.slice(0, 500), exec.signal)
      if (!answer.confirmed) return { outcome: 'cancelled', ...(answer.custom !== undefined ? { detail: answer.custom } : {}) }
      try {
        learning.notes.updateNote(args.note_id, { markdown: args.markdown })
        return { outcome: 'confirmed', id: args.note_id }
      } catch (error: unknown) {
        return { outcome: 'error', detail: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall: args => genericCard('Update note', 'other', args.note_id),
  })))

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/** Boot one learning session's tools exactly once per live agent. */
function boot(ctx: Context, agent: Agent, booted: WeakSet<Agent>): void {
  if (booted.has(agent)) return
  if (!ctx.learning.hasEntered(agent.session.events)) return
  booted.add(agent)
  agent.ctx.effect(() => registerLearningTools(ctx, agent.ctx, agent), 'dvl.tools()')
}

/** Mount the per-session boot: fresh roots on agent/created, live entry on the event. */
export function installToolBoot(ctx: Context): void {
  const booted = new WeakSet<Agent>()
  const bootRoot = (agent: Agent): void => {
    if (!ctx.agents.roots().includes(agent)) return
    boot(ctx, agent, booted)
  }
  ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => bootRoot(agent))
    const stopEvent = ctx.on('session/event', (session, event) => {
      if (event.type !== 'learning/entered') return
      const agent = ctx.agents.get(session.id)
      if (agent !== undefined) bootRoot(agent)
    })
    return () => {
      stopCreated()
      stopEvent()
    }
  }, 'dvl.boot()')
}
