/**
 * DVL core service (`ctx.learning`): workspace file domain, global notes,
 * FSRS bookkeeping, the one-way session event, prompt injection (P0/P1/P2),
 * and the in-band present registry the artifact server resolves.
 * @module dvl/learning
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { CATEGORY_DIRS, LearningFiles } from './files.ts'
import { gradeFor, newCard, nextCard, stateLabel } from './fsrs.ts'
import type { Card } from 'ts-fsrs'
import { NotesStore } from './notes.ts'
import { BOOT_LINE, FULL_GUIDE, renderSnapshot } from './prompt.ts'
import { isSafeSegment, workspaceIdOf } from '../shared/hash.ts'
import type {
  ArtifactKind, CardFile, LearningSnapshot, Outline, OutlineNode, PresentOutcome,
  RatingThresholds, ResultEnvelope, ReviewRecord,
} from '../shared/types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    learning: LearningService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One-way valve: this session entered learning mode. Appended once by the
     * `/learn` command and never removed; resumes replay it to re-boot the
     * DVL surface (tools, full prompt, UI).
     */
    'learning/entered': {
      at: string
    }
  }
}

/** Plugin config. All optional — defaults keep the plugin drop-in usable. */
export interface Config {
  /** Artifact server port on 127.0.0.1. */
  readonly port?: number
  /** Global DVL data dir (notes). Defaults to `~/.dsh-vibe-learning`. */
  readonly dataDir?: string
  /** Score → FSRS grade boundaries. */
  readonly ratingThresholds?: RatingThresholds
  /** How long an in-band present waits for a submission. */
  readonly presentTimeoutMs?: number
}

interface PendingPresent {
  outcome?: PresentOutcome
  readonly waiters: Array<(outcome: PresentOutcome) => void>
}

interface NormalizedOutlineInput {
  readonly title: string
  readonly nodes: OutlineNode[]
}

/** Content block pair used for every plugin-injected user message. */
function noticeMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'learning' },
  })
}

/**
 * The DVL service. One instance per host process; per-session tool mounting
 * lives in tool-learning, commands in command-learning, the artifact server
 * in learning-web.
 */
export class LearningService extends Service {
  static Config: z<Config> = z.object({
    port: z.number().default(4182),
    dataDir: z.string().default(join(homedir(), '.dsh-vibe-learning')),
    ratingThresholds: z.object({
      again: z.number().default(0.4),
      hard: z.number().default(0.7),
      good: z.number().default(0.9),
    }).default({ again: 0.4, hard: 0.7, good: 0.9 }),
    presentTimeoutMs: z.number().default(3_600_000),
  })

  /** Global note store over the plugin data dir. */
  readonly notes: NotesStore
  private readonly pending = new Map<string, PendingPresent>()
  private readonly workspaces = new Map<string, string>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'learning')
    this.notes = new NotesStore(config.dataDir ?? join(homedir(), '.dsh-vibe-learning'))

    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'dvl:learning',
        order: 130,
        text: (context) => {
          const agent = context.agent
          if (agent === undefined) return ''
          return this.hasEntered(agent.session.events) ? FULL_GUIDE : BOOT_LINE
        },
      })
    })

    ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || payload.signal.aborted) return decision
      const agent = payload.agent
      if (!this.hasEntered(agent.session.events)) return decision
      const cwd = this.sessionCwd(agent)
      if (cwd === null) return decision
      let snapshot: LearningSnapshot
      try {
        snapshot = await this.snapshot(cwd)
      } catch (error: unknown) {
        this.ctx.logger.warn(`dvl: snapshot failed for ${agent.id}: ${String(error)}`)
        return decision
      }
      const text = renderSnapshot(snapshot)
      return {
        kind: 'enter',
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: 'learning', form: 'snapshot', sections: [{ name: 'dvl:snapshot', text }] },
          }),
        ],
      }
    }, { prepend: true })
  }

  protected async [Service.init](): Promise<void> {
    await this.notes.load()
    this.indexRegistryWorkspaces()
  }

  // ── session / workspace helpers ──────────────────────────────────────────

  /** The one-way valve fold: entered when any `learning/entered` event exists. */
  hasEntered(events: readonly SessionEvent[]): boolean {
    return events.some(event => event.type === 'learning/entered')
  }

  /** A session's workspace cwd, when its header carries one. */
  sessionCwd(agent: Agent): string | null {
    return agent.session.header.cwd ?? null
  }

  /** Append the one-way marker (idempotent) and wake the model with a notice. */
  enter(agent: Agent, notice: string): boolean {
    if (this.hasEntered(agent.session.events)) return false
    agent.session.append('learning/entered', { at: new Date().toISOString() })
    agent.inject(noticeMessage(notice))
    return true
  }

  /** Wake the model with a plugin notice (mode already on). */
  notify(agent: Agent, text: string): void {
    agent.inject(noticeMessage(text))
  }

  filesFor(cwd: string): LearningFiles {
    return new LearningFiles(cwd)
  }

  registerWorkspace(cwd: string): void {
    this.workspaces.set(workspaceIdOf(cwd), cwd)
  }

  resolveWorkspace(workspaceId: string): string | null {
    return this.workspaces.get(workspaceId) ?? null
  }

  private indexRegistryWorkspaces(): void {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return
    for (const workspace of registry.list()) this.registerWorkspace(workspace.path)
  }

  artifactUrl(cwd: string, kind: ArtifactKind, hash: string): string {
    return `http://127.0.0.1:${this.config.port ?? 4182}/learning/${workspaceIdOf(cwd)}/${CATEGORY_DIRS[kind]}/${hash}/index.html`
  }

  // ── outlines ─────────────────────────────────────────────────────────────

  async readOutline(cwd: string, outlineId: string): Promise<Outline | null> {
    return this.filesFor(cwd).readOutline(outlineId)
  }

  async listOutlines(cwd: string): Promise<Outline[]> {
    return this.filesFor(cwd).listOutlines()
  }

  async activate(cwd: string, outlineId: string): Promise<void> {
    const outline = await this.readOutline(cwd, outlineId)
    if (outline === null) throw new Error(`unknown outline '${outlineId}'`)
    const files = this.filesFor(cwd)
    await files.ensureRoot()
    await files.writeActive(outlineId)
    this.registerWorkspace(cwd)
  }

  /**
   * Normalize a model-authored outline tree into a durable `Outline`:
   * fills missing node ids and lesson ids (preserving existing ones) and
   * carries lesson state/artifactHash over from the current file.
   */
  normalizeOutline(cwd: string, input: NormalizedOutlineInput, existingId?: string): Promise<Outline> {
    const title = input.title.trim()
    if (title.length === 0) throw new Error('outline title must be non-blank')
    const now = new Date().toISOString()
    return (async (): Promise<Outline> => {
      const previous = existingId === undefined ? null : await this.readOutline(cwd, existingId)
      const previousById = new Map((previous?.nodes ?? []).map(node => [node.id, node]))
      const nodes: OutlineNode[] = input.nodes.map((node, index) => {
        const id = node.id === undefined || node.id.length === 0
          ? randomUUID()
          : node.id
        const prev = previousById.get(id)
        const carried = {
          ...(node.state !== undefined ? { state: node.state } : {}),
          ...(node.artifactHash !== undefined ? { artifactHash: node.artifactHash } : {}),
        }
        const restored = {
          ...(prev?.state !== undefined ? { state: prev.state } : {}),
          ...(prev?.artifactHash !== undefined ? { artifactHash: prev.artifactHash } : {}),
        }
        const base: OutlineNode = {
          id,
          kind: node.kind === 'lesson' ? 'lesson' : 'group',
          title: node.title.trim() || `节点 ${index + 1}`,
          order: typeof node.order === 'number' && Number.isFinite(node.order) ? node.order : index,
          parentId: node.parentId ?? null,
          ...(node.description !== undefined && node.description.length > 0 ? { description: node.description } : {}),
        }
        if (base.kind === 'lesson') {
          return {
            ...base,
            lessonId: node.lessonId ?? prev?.lessonId ?? randomUUID(),
            ...carried.state !== undefined || prev?.state !== undefined
              ? { state: { ...restored, ...carried }.state ?? 'not-started' as const }
              : { state: 'not-started' as const },
            ...(carried.artifactHash !== undefined || prev?.artifactHash !== undefined
              ? { artifactHash: { ...restored, ...carried }.artifactHash }
              : {}),
          }
        }
        return base
      })
      const outline: Outline = {
        id: existingId ?? randomUUID(),
        title,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        nodes,
      }
      return outline
    })()
  }

  async saveOutline(cwd: string, outline: Outline): Promise<void> {
    const files = this.filesFor(cwd)
    await files.writeOutline(outline)
    await this.cleanupOrphans(cwd, outline)
    this.registerWorkspace(cwd)
  }

  /**
   * After an outline update: drop artifacts/cards that lost their referent.
   * Lessons keep only referenced hashes; cards keep only live lesson ids;
   * review artifacts keep only hashes present in a card history; quiz
   * artifacts keep only live lesson targets.
   */
  async cleanupOrphans(cwd: string, outline: Outline): Promise<void> {
    const files = this.filesFor(cwd)
    const lessonIds = new Set(outline.nodes.filter(node => node.kind === 'lesson').map(node => node.lessonId as string))
    const referencedHashes = new Set(
      outline.nodes
        .filter(node => node.kind === 'lesson' && node.artifactHash !== undefined)
        .map(node => node.artifactHash as string),
    )
    for (const { hash } of await files.listArtifacts('lesson')) {
      if (!referencedHashes.has(hash)) await files.deleteArtifact('lesson', hash)
    }
    const cards = await files.listCards()
    const referencedReviewHashes = new Set<string>()
    for (const card of cards) {
      if (!lessonIds.has(card.lessonId)) {
        await files.deleteCard(card.lessonId)
        continue
      }
      for (const record of card.history) {
        if (record.reviewHash !== undefined) referencedReviewHashes.add(record.reviewHash)
      }
    }
    for (const { hash } of await files.listArtifacts('review')) {
      if (!referencedReviewHashes.has(hash)) await files.deleteArtifact('review', hash)
    }
    for (const { hash, meta } of await files.listArtifacts('quiz')) {
      if (!lessonIds.has(meta.targetId)) await files.deleteArtifact('quiz', hash)
    }
  }

  /** Set one lesson node's progression state inside its outline file. */
  async setLessonState(cwd: string, lessonId: string, state: OutlineNode['state']): Promise<void> {
    const files = this.filesFor(cwd)
    for (const outline of await files.listOutlines()) {
      const node = outline.nodes.find(item => item.lessonId === lessonId)
      if (node === undefined) continue
      const updated: Outline = {
        ...outline,
        updatedAt: new Date().toISOString(),
        nodes: outline.nodes.map(item => item.lessonId === lessonId
          ? { ...item, state } as OutlineNode
          : item),
      }
      await files.writeOutline(updated)
      return
    }
  }

  // ── review cards ─────────────────────────────────────────────────────────

  async ensureCard(cwd: string, lessonId: string): Promise<CardFile> {
    const files = this.filesFor(cwd)
    const existing = await files.readCard(lessonId)
    if (existing !== null) return existing
    const card: CardFile = { lessonId, card: newCard() as unknown as Record<string, unknown>, history: [] }
    await files.writeCard(card)
    return card
  }

  // ── artifact present / result ────────────────────────────────────────────

  private presentKey(cwd: string, kind: ArtifactKind, hash: string): string {
    return `${cwd}\u0000${kind}\u0000${hash}`
  }

  /**
   * Register an in-band present and wait for the submission (or abort/timeout).
   * The durable write path (`submit`) settles the same registry, so a result
   * landing after a timeout still reaches disk and `get_result`.
   */
  present(cwd: string, kind: ArtifactKind, hash: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<PresentOutcome> {
    const key = this.presentKey(cwd, kind, hash)
    const existing = this.pending.get(key)
    if (existing !== undefined) {
      if (existing.outcome !== undefined) return Promise.resolve(existing.outcome)
      return new Promise(resolve => existing.waiters.push(resolve))
    }
    const entry: PendingPresent = { waiters: [] }
    this.pending.set(key, entry)
    const settle = (outcome: PresentOutcome): void => {
      if (entry.outcome !== undefined) return
      entry.outcome = outcome
      for (const waiter of entry.waiters.splice(0)) waiter(outcome)
      if (this.pending.get(key) === entry && entry.outcome !== undefined) this.pending.delete(key)
    }
    const timeoutMs = opts.timeoutMs ?? this.config.presentTimeoutMs ?? 3_600_000
    const timer = setTimeout(() => settle({ kind: 'no-result', reason: 'timeout' }), timeoutMs)
    timer.unref?.()
    const onAbort = (): void => settle({ kind: 'no-result', reason: 'interrupted' })
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    return new Promise(resolve => {
      entry.waiters.push((outcome) => {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        resolve(outcome)
      })
    })
  }

  /**
   * The durable-first submission path (artifact server → this): write the
   * result file, advance lesson/card bookkeeping, then settle any pending
   * in-band present.
   */
  async submit(cwd: string, kind: ArtifactKind, hash: string, envelope: { targetId: string; submittedAt?: string; score?: number; payload?: unknown }): Promise<void> {
    const files = this.filesFor(cwd)
    const result: ResultEnvelope = {
      kind,
      targetId: envelope.targetId,
      submittedAt: envelope.submittedAt ?? new Date().toISOString(),
      ...(typeof envelope.score === 'number' && Number.isFinite(envelope.score) ? { score: envelope.score } : {}),
      ...(envelope.payload !== undefined ? { payload: envelope.payload } : {}),
    }
    await files.writeResult(kind, hash, result)
    this.registerWorkspace(cwd)

    if (kind === 'lesson') {
      await this.setLessonState(cwd, result.targetId, 'qa')
    } else if (kind === 'review') {
      const cardFile = await this.ensureCard(cwd, result.targetId)
      const thresholds = this.config.ratingThresholds ?? { again: 0.4, hard: 0.7, good: 0.9 }
      if (typeof result.score === 'number') {
        const before = cardFile.card as unknown as Card
        const after = nextCard(before, result.score, Date.now(), thresholds)
        const record: ReviewRecord = {
          at: result.submittedAt,
          rating: gradeFor(result.score, thresholds) as unknown as number,
          score: result.score,
          reviewHash: hash,
        }
        await files.writeCard({
          lessonId: cardFile.lessonId,
          card: after as unknown as Record<string, unknown>,
          history: [...cardFile.history, record],
        })
      }
    }

    const pending = this.pending.get(this.presentKey(cwd, kind, hash))
    if (pending !== undefined) {
      const outcome: PresentOutcome = { kind: 'result', result }
      if (pending.outcome !== undefined) return
      pending.outcome = outcome
      for (const waiter of pending.waiters.splice(0)) waiter(outcome)
      this.pending.delete(this.presentKey(cwd, kind, hash))
    }
  }

  async getResult(cwd: string, kind: ArtifactKind, hash: string): Promise<ResultEnvelope | null> {
    return this.filesFor(cwd).readResult(kind, hash)
  }

  // ── snapshot ─────────────────────────────────────────────────────────────

  /** Read-only learning state over one workspace (P2 + GUI API). */
  async snapshot(cwd: string): Promise<LearningSnapshot> {
    const files = this.filesFor(cwd)
    this.registerWorkspace(cwd)
    const exists = await files.exists()
    const outlines = await files.listOutlines()
    const activeOutlineId = await files.readActive()
    const activeOutline = outlines.find(outline => outline.id === activeOutlineId) ?? null
    const lessonTitle = new Map<string, string>()
    for (const outline of outlines) {
      for (const node of outline.nodes) {
        if (node.kind === 'lesson' && node.lessonId !== undefined) {
          lessonTitle.set(node.lessonId, node.title)
        }
      }
    }
    const currentLessons = (activeOutline?.nodes ?? [])
      .filter(node => node.kind === 'lesson'
        && (node.state === 'learning' || node.state === 'qa')
        && node.lessonId !== undefined)
      .map(node => ({ id: node.lessonId as string, title: node.title, state: node.state as 'learning' | 'qa' }))
    const now = Date.now()
    const dueCards = (await files.listCards())
      .map((cardFile) => {
        const card = cardFile.card as unknown as Card
        const due = typeof card.due === 'string' ? Date.parse(card.due) : card.due instanceof Date ? card.due.getTime() : 0
        return {
          lessonId: cardFile.lessonId,
          lessonTitle: lessonTitle.get(cardFile.lessonId) ?? cardFile.lessonId,
          due: new Date(due).toISOString(),
          state: stateLabel(card),
          overdue: due <= now,
        }
      })
      .filter(item => item.overdue)
      .sort((left, right) => left.due.localeCompare(right.due))
    return {
      workspaceId: workspaceIdOf(cwd),
      learningDirExists: exists,
      activeOutlineId,
      outlines: outlines.map(outline => ({ id: outline.id, title: outline.title, active: outline.id === activeOutlineId })),
      currentLessons,
      dueCards,
    }
  }

  // ── artifacts for tools ──────────────────────────────────────────────────

  /**
   * Register a model-authored artifact: validate the path convention, ensure
   * the HTML exists, and write its meta. Side effects: lesson state → learning
   * (lesson kind) and card creation (review kind).
   */
  async registerArtifact(cwd: string, kind: ArtifactKind, targetId: string, path: string, title?: string): Promise<string> {
    if (!isSafeSegment(targetId)) throw new Error(`unsafe target id '${targetId}'`)
    const files = this.filesFor(cwd)
    const hash = files.validateArtifactPath(kind, path)
    if ((await files.readArtifactHtml(kind, hash)) === null) {
      throw new Error(`no artifact html at '${path}'`)
    }
    await files.ensureRoot()
    await files.writeMeta(kind, hash, {
      kind,
      targetId,
      title: title?.trim() || hash,
      createdAt: new Date().toISOString(),
    })
    this.registerWorkspace(cwd)
    if (kind === 'lesson') await this.setLessonState(cwd, targetId, 'learning')
    if (kind === 'review') await this.ensureCard(cwd, targetId)
    return hash
  }
}

export default LearningService
