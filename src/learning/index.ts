/**
 * DVL core service (`ctx.learning`): workspace file domain, global notes,
 * FSRS bookkeeping, the one-way session event, prompt injection (P0/P1/P2),
 * the run lifecycle, the canonical presentation descriptor registry, and the
 * review-plan proposal/commit path.
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
import { newCard, nextCard, stateLabel } from './fsrs.ts'
import type { Card } from 'ts-fsrs'
import { NotesStore } from './notes.ts'
import { dvlLearningProjection } from './projection.ts'
import { BOOT_LINE, FULL_GUIDE, renderSnapshot } from './prompt.ts'
import { isSafeSegment, workspaceIdOf } from '../shared/hash.ts'
import { LEARNING_ROUTE_PREFIX } from '../shared/routes.ts'
import type {
  ArtifactKind, ArtifactRun, CardFile, FeedbackEnvelope, LearningSnapshot, Outline,
  OutlineNode, PresentArtifactDescriptor, PresentOutcome, ResultEnvelope,
  ReviewPlanProposal, ReviewRating, ReviewRecord,
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
  /** Global DVL data dir (notes). Defaults to `~/.dsh-vibe-learning`. */
  readonly dataDir?: string
  /** How long an in-band present waits for a submission. */
  readonly presentTimeoutMs?: number
}

interface PendingPresent {
  outcome?: PresentOutcome
  readonly waiters: Array<(outcome: PresentOutcome) => void>
}

/** A descriptor registered while a present runs, keyed by DSH tool callId. */
interface DescriptorEntry {
  readonly cwd: string
  readonly descriptor: PresentArtifactDescriptor
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
    dataDir: z.string().default(join(homedir(), '.dsh-vibe-learning')),
    presentTimeoutMs: z.number().default(3_600_000),
  })

  /** Global note store over the plugin data dir. */
  readonly notes: NotesStore
  private readonly pending = new Map<string, PendingPresent>()
  private readonly descriptors = new Map<string, DescriptorEntry>()
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

    // 注册学习模式投影：客户端 useProjection('dvlLearning') 的唯一事实源
    ctx.inject(['sessionProjections'], (scope: Context) => {
      scope.sessionProjections.register(dvlLearningProjection)
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

  /**
   * 进入学习模式：先确保学习工作区存在（mkdir 幂等），再追加单向事件——
   * 事件一旦存在，工作区必然已是学习工作区
   */
  async enter(agent: Agent, notice: string): Promise<boolean> {
    if (this.hasEntered(agent.session.events)) return false

    const cwd = this.sessionCwd(agent)
    if (cwd === null) throw new Error('dvl: 进入学习模式需要会话工作区目录（/learn）')

    await this.filesFor(cwd).ensureRoot()
    this.registerWorkspace(cwd)
    agent.session.append('learning/entered', { at: new Date().toISOString() })
    agent.steer(noticeMessage(notice))
    return true
  }

  /**
   * 统一幂等 reconcile：重放与实时事件都走这里收敛到同一状态——
   * 已进入则确保工作区存在并登记；返回是否需要挂载学习工具
   */
  async reconcile(agent: Agent): Promise<boolean> {
    if (!this.hasEntered(agent.session.events)) return false

    const cwd = this.sessionCwd(agent)
    if (cwd === null) return true

    await this.filesFor(cwd).ensureRoot()
    this.registerWorkspace(cwd)
    return true
  }

  /** Wake the model with a plugin notice (mode already on). */
  notify(agent: Agent, text: string): void {
    agent.steer(noticeMessage(text))
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

  /** 同源 base：运行时从 DSH webServer 取实际监听端口（服务未就绪时抛错） */
  private originBase(): string {
    const webServer = this.ctx.get('webServer')
    if (webServer === undefined) throw new Error('dvl: DSH webServer 未就绪，无法构造工件 URL')
    return `http://127.0.0.1:${webServer.port}`
  }

  /** Read-only preview URL (no run id; submission is disabled). */
  artifactUrl(cwd: string, kind: ArtifactKind, hash: string): string {
    return `${this.originBase()}${LEARNING_ROUTE_PREFIX}/${workspaceIdOf(cwd)}/${CATEGORY_DIRS[kind]}/${hash}/index.html`
  }

  /** Canonical active-run URL (unguessable run id; submission enabled). */
  runUrl(cwd: string, kind: ArtifactKind, hash: string, runId: string): string {
    return `${this.originBase()}${LEARNING_ROUTE_PREFIX}/${workspaceIdOf(cwd)}/${CATEGORY_DIRS[kind]}/${hash}/runs/${runId}/index.html`
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
          // 空串视为根：工具 schema 的 string parentId 无法传 null，统一在此归一
          parentId: node.parentId === undefined || node.parentId === '' ? null : node.parentId,
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
   * Lessons keep only referenced hashes; reviews and quizzes keep only live
   * lesson targets; cards keep only live lesson ids.
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
    for (const { hash, meta } of await files.listArtifacts('review')) {
      if (!lessonIds.has(meta.targetId)) await files.deleteArtifact('review', hash)
    }
    for (const { hash, meta } of await files.listArtifacts('quiz')) {
      if (!lessonIds.has(meta.targetId)) await files.deleteArtifact('quiz', hash)
    }
    for (const card of await files.listCards()) {
      if (!lessonIds.has(card.lessonId)) await files.deleteCard(card.lessonId)
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

  // ── run lifecycle ────────────────────────────────────────────────────────

  /**
   * Register an authored artifact (validate path, write immutable meta, mark a
   * lesson `learning`) and create — or, on retry of the same DSH `callId`,
   * resume — the run it presents. Returns the canonical server-owned descriptor.
   */
  async createOrResumeRun(
    cwd: string,
    kind: ArtifactKind,
    targetId: string,
    path: string,
    callId: string,
    title?: string,
  ): Promise<PresentArtifactDescriptor> {
    if (!isSafeSegment(targetId)) throw new Error(`unsafe target id '${targetId}'`)
    if (callId.length === 0) throw new Error('present requires a non-empty tool call id')
    const files = this.filesFor(cwd)
    const hash = files.validateArtifactPath(kind, path)
    if ((await files.readArtifactHtml(kind, hash)) === null) {
      throw new Error(`no artifact html at '${path}'`)
    }
    await files.ensureRoot()
    const existingMeta = await files.readMeta(kind, hash)
    const metaTitle = existingMeta?.title ?? title?.trim() ?? hash
    if (existingMeta === null) {
      await files.writeMeta(kind, hash, { kind, targetId, title: metaTitle, createdAt: new Date().toISOString() })
    }
    this.registerWorkspace(cwd)
    if (kind === 'lesson') await this.setLessonState(cwd, targetId, 'learning')

    let run = await files.findRunByCallId(kind, hash, callId)
    if (run === null) {
      run = {
        runId: randomUUID(),
        artifactHash: hash,
        kind,
        targetId,
        callId,
        createdAt: new Date().toISOString(),
      } satisfies ArtifactRun
      await files.writeRun(kind, hash, run)
    }

    const descriptor: PresentArtifactDescriptor = {
      version: 1,
      callId,
      workspaceId: workspaceIdOf(cwd),
      kind,
      category: CATEGORY_DIRS[kind],
      hash,
      targetId: run.targetId,
      title: metaTitle,
      runId: run.runId,
      url: this.runUrl(cwd, kind, hash, run.runId),
    }
    this.descriptors.set(callId, { cwd, descriptor })
    return descriptor
  }

  /** Resolve a running present's canonical descriptor by `cwd + callId`. */
  resolveDescriptor(cwd: string, callId: string): PresentArtifactDescriptor | null {
    const entry = this.descriptors.get(callId)
    if (entry === undefined || entry.cwd !== cwd) return null
    return entry.descriptor
  }

  /** Drop a present's descriptor once the tool settled (replay uses durable meta). */
  forgetDescriptor(callId: string): void {
    this.descriptors.delete(callId)
  }

  /**
   * Register an in-band present and wait for the submission (or abort/timeout).
   * The durable write path (`submit`) settles the same registry, so a result
   * landing after a timeout still reaches disk and `get_result`. The waiter is
   * registered *before* the durable read, so a result that landed earlier — or
   * a resumed run that is already submitted — resolves immediately instead of
   * waiting out the timeout.
   */
  async present(cwd: string, kind: ArtifactKind, hash: string, runId: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<PresentOutcome> {
    const files = this.filesFor(cwd)
    const run = await files.readRun(kind, hash, runId)
    if (run === null || run.kind !== kind || run.artifactHash !== hash) {
      return { kind: 'no-result', reason: 'error', detail: `unknown run '${runId}' for ${CATEGORY_DIRS[kind]}/${hash}` }
    }
    const key = runId
    const existing = this.pending.get(key)
    if (existing !== undefined) {
      if (existing.outcome !== undefined) return existing.outcome
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
    // Align with durable storage after registering, so the two race windows
    // (submit before register, submit during register) both resolve.
    const existingResult = await files.readResult(kind, hash, runId)
    if (existingResult !== null) {
      settle({ kind: 'result', result: existingResult })
      return { kind: 'result', result: existingResult }
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

  private settlePending(runId: string, outcome: PresentOutcome): void {
    const pending = this.pending.get(runId)
    if (pending === undefined) return
    if (pending.outcome !== undefined) return
    pending.outcome = outcome
    for (const waiter of pending.waiters.splice(0)) waiter(outcome)
    this.pending.delete(runId)
  }

  /**
   * The durable-first opaque submission path (artifact server → this): claim
   * the per-run result envelope with the raw JSON payload via an atomic
   * write-once, advance the lesson to `qa`, then settle any pending in-band
   * present. Idempotent per run — concurrently too: exactly one caller wins,
   * every caller returns the same winning envelope.
   */
  async submit(cwd: string, kind: ArtifactKind, hash: string, runId: string, payload: unknown): Promise<{ result: ResultEnvelope; alreadySubmitted: boolean }> {
    const files = this.filesFor(cwd)
    const run = await files.readRun(kind, hash, runId)
    if (run === null) throw new Error(`unknown run '${runId}' for ${CATEGORY_DIRS[kind]}/${hash}`)
    if (run.kind !== kind || run.artifactHash !== hash) throw new Error(`run '${runId}' does not belong to ${CATEGORY_DIRS[kind]}/${hash}`)
    const result: ResultEnvelope = {
      kind,
      targetId: run.targetId,
      artifactHash: hash,
      runId,
      submittedAt: new Date().toISOString(),
      payload,
    }
    const wrote = await files.writeResultOnce(kind, hash, runId, result)
    this.registerWorkspace(cwd)
    if (kind === 'lesson' && wrote) await this.setLessonState(cwd, run.targetId, 'qa')
    const durable = wrote ? result : (await files.readResult(kind, hash, runId)) ?? result
    this.settlePending(runId, { kind: 'result', result: durable })
    return { result: durable, alreadySubmitted: !wrote }
  }

  /**
   * Run-aware result read: `runId` reads exactly that run; without it the
   * latest submitted run of the artifact wins.
   */
  async getResult(cwd: string, kind: ArtifactKind, hash: string, runId?: string): Promise<{ runId: string; result: ResultEnvelope } | null> {
    const files = this.filesFor(cwd)
    if (runId !== undefined) {
      const result = await files.readResult(kind, hash, runId)
      return result === null ? null : { runId, result }
    }
    const latest = await files.latestSubmittedRun(kind, hash)
    if (latest === null) return null
    const result = await files.readResult(kind, hash, latest.runId)
    return result === null ? null : { runId: latest.runId, result }
  }

  /**
   * Save the model's opaque grading report for one run, wrapped in a mechanism
   * envelope. Validates run + artifact association and that the run already has
   * a result; then atomically replaces the per-run feedback. The payload is
   * stored verbatim — never schema-checked or interpreted.
   */
  async saveFeedback(cwd: string, kind: ArtifactKind, hash: string, runId: string, payload: unknown): Promise<FeedbackEnvelope> {
    const files = this.filesFor(cwd)
    const run = await files.readRun(kind, hash, runId)
    if (run === null) throw new Error(`unknown run '${runId}' for ${CATEGORY_DIRS[kind]}/${hash}`)
    if (run.kind !== kind || run.artifactHash !== hash) throw new Error(`run '${runId}' does not belong to ${CATEGORY_DIRS[kind]}/${hash}`)
    if ((await files.readResult(kind, hash, runId)) === null) {
      throw new Error(`run '${runId}' has no result yet — grade only after submission`)
    }
    const feedback: FeedbackEnvelope = {
      kind,
      targetId: run.targetId,
      artifactHash: hash,
      runId,
      savedAt: new Date().toISOString(),
      payload,
    }
    await files.writeFeedback(kind, hash, runId, feedback)
    this.registerWorkspace(cwd)
    return feedback
  }

  // ── review plan ──────────────────────────────────────────────────────────

  /** Validate a review-plan source run: exists, has a result, belongs to the lesson. */
  private async resolveSourceRun(cwd: string, kind: ArtifactKind, hash: string, runId: string, lessonId: string): Promise<ArtifactRun> {
    const files = this.filesFor(cwd)
    const run = await files.readRun(kind, hash, runId)
    if (run === null) throw new Error(`unknown source run '${runId}' for ${CATEGORY_DIRS[kind]}/${hash}`)
    if (run.kind !== kind || run.artifactHash !== hash) throw new Error(`run '${runId}' does not belong to ${CATEGORY_DIRS[kind]}/${hash}`)
    if (run.targetId !== lessonId) throw new Error(`run '${runId}' belongs to lesson '${run.targetId}', not '${lessonId}'`)
    if ((await files.readResult(kind, hash, runId)) === null) {
      throw new Error(`run '${runId}' has no result yet — rate only graded runs`)
    }
    return run
  }

  /**
   * Compute the read-only candidate for `update_review_plan` before any
   * confirmation: validate the source run, read the current card, apply the
   * explicit model rating, and report the next due date — without writing.
   */
  async computeReviewPlan(cwd: string, lessonId: string, rating: ReviewRating, sourceKind: ArtifactKind, sourceHash: string, sourceRunId: string, reason?: string): Promise<ReviewPlanProposal> {
    if (!isSafeSegment(lessonId)) throw new Error(`unsafe lesson id '${lessonId}'`)
    await this.resolveSourceRun(cwd, sourceKind, sourceHash, sourceRunId, lessonId)
    const files = this.filesFor(cwd)
    const current = await files.readCard(lessonId)
    const card = (current === null ? newCard() : current.card as unknown as Card)
    const alreadyApplied = (current?.history ?? []).some(record => record.sourceRunId === sourceRunId)
    const next = nextCard(card, rating, Date.now())
    return {
      lessonId,
      rating,
      sourceRunId,
      ...(reason !== undefined && reason.length > 0 ? { reason } : {}),
      current,
      nextCard: next as unknown as Record<string, unknown>,
      due: next.due instanceof Date ? next.due.toISOString() : String(next.due),
      alreadyApplied,
    }
  }

  /**
   * Commit one review-plan update: re-validate the source run, re-read the
   * card, re-check the idempotency key, apply the rating, and write the card +
   * history atomically.
   */
  async commitReviewPlan(cwd: string, lessonId: string, rating: ReviewRating, sourceKind: ArtifactKind, sourceHash: string, sourceRunId: string, reason?: string): Promise<CardFile> {
    if (!isSafeSegment(lessonId)) throw new Error(`unsafe lesson id '${lessonId}'`)
    await this.resolveSourceRun(cwd, sourceKind, sourceHash, sourceRunId, lessonId)
    const files = this.filesFor(cwd)
    const current = await files.readCard(lessonId)
    const history = current?.history ?? []
    if (history.some(record => record.sourceRunId === sourceRunId)) {
      throw new Error(`source run '${sourceRunId}' already applied to review plan`)
    }
    const card = (current === null ? newCard() : current.card as unknown as Card)
    const next = nextCard(card, rating, Date.now())
    const record: ReviewRecord = {
      at: new Date().toISOString(),
      rating,
      sourceRunId,
      ...(reason !== undefined && reason.length > 0 ? { reason } : {}),
    }
    const cardFile: CardFile = {
      lessonId,
      card: next as unknown as Record<string, unknown>,
      history: [...history, record],
    }
    await files.writeCard(cardFile)
    this.registerWorkspace(cwd)
    return cardFile
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
}

export default LearningService
