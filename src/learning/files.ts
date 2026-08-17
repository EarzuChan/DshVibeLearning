/**
 * Workspace file domain: everything DVL stores per workspace lives under
 * `<cwd>/.dsh/learning/`. Directory existence alone marks a learning
 * workspace — no manifest. All writes are tmp-file + rename so a torn write
 * never publishes a half record.
 *
 * Artifacts are immutable and hash-addressed; every presentation/answer
 * attempt is a separate run under `<category>/<hash>/runs/<runId>/`. The
 * artifact root holds only `index.html` + `meta.json` — result and feedback
 * are per-run facts, never artifact-root files.
 * @module dvl/learning/files
 */

import { randomUUID } from 'node:crypto'
import { link, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { isSafeSegment } from '../shared/hash.ts'
import type {
  ArtifactKind, ArtifactMeta, ArtifactRun, ArtifactRunSummary, CardFile, FeedbackEnvelope,
  Outline, OutlineNode, ResultEnvelope,
} from '../shared/types.ts'

/** The workspace-side learning root, relative to the workspace cwd. */
export const LEARNING_DIR = '.dsh/learning'

/** Artifact-kind → directory name under the learning root. */
export const CATEGORY_DIRS: Record<ArtifactKind, string> = {
  lesson: 'lessons',
  review: 'reviews',
  quiz: 'quizzes',
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/** Artifact id used as a directory name: hex-ish hash, never a path. */
export function isValidArtifactHash(hash: string): boolean {
  return /^[a-f0-9]{6,64}$/iu.test(hash)
}

/** Run id used as a directory name: a safe single segment (uuid-shaped). */
export function isValidRunId(runId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(runId)
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error: unknown) {
    if (isEnoent(error)) return null
    throw error
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/**
 * Atomically publish a JSON file only if it does not exist yet (write-once).
 * Writes a complete temp file, then hard-links it into place: the link either
 * creates the file atomically or fails with `EEXIST` when someone else won.
 * Returns true when this call created the file, false when it already existed.
 */
async function writeJsonOnce(path: string, value: unknown): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await link(tmp, path)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error: unknown) {
    if (isEnoent(error)) return false
    throw error
  }
}

/** 读取端防御：历史文件里根节点可能写成空串，统一归一为 null */
function normalizeOutlineParents(outline: Outline | null): Outline | null {
  if (outline === null) return null
  let changed = false
  const nodes = outline.nodes.map(node => {
    if (node.parentId !== '') return node
    changed = true
    return { ...node, parentId: null } as OutlineNode
  })
  return changed ? { ...outline, nodes } : outline
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return await readdir(dir, { withFileTypes: true }).then(entries =>
      entries.filter(entry => entry.isDirectory()).map(entry => entry.name))
  } catch (error: unknown) {
    if (isEnoent(error)) return []
    throw error
  }
}

/**
 * Accessor over one workspace's `.dsh/learning/` tree. Never caches:
 * every read hits disk, so cross-session edits are visible immediately.
 */
export class LearningFiles {
  readonly cwd: string

  constructor(cwd: string) {
    this.cwd = cwd
  }

  get root(): string {
    return join(this.cwd, LEARNING_DIR)
  }

  private dirFor(kind: ArtifactKind): string {
    return join(this.root, CATEGORY_DIRS[kind])
  }

  private artifactDir(kind: ArtifactKind, hash: string): string {
    return join(this.dirFor(kind), hash)
  }

  private runsDir(kind: ArtifactKind, hash: string): string {
    return join(this.artifactDir(kind, hash), 'runs')
  }

  private runDir(kind: ArtifactKind, hash: string, runId: string): string {
    if (!isValidRunId(runId)) throw new Error(`unsafe run id '${runId}'`)
    return join(this.runsDir(kind, hash), runId)
  }

  // ── marker / root ────────────────────────────────────────────────────────

  async exists(): Promise<boolean> {
    return pathExists(this.root)
  }

  /** Create the learning root (the workspace becomes a learning workspace). */
  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true })
  }

  // ── active outline pointer ───────────────────────────────────────────────

  private get activeFile(): string {
    return join(this.root, 'active.json')
  }

  async readActive(): Promise<string | null> {
    const value = await readJson<{ outlineId: string }>(this.activeFile)
    return value?.outlineId ?? null
  }

  async writeActive(outlineId: string | null): Promise<void> {
    if (outlineId === null) {
      try {
        await rm(this.activeFile)
      } catch (error: unknown) {
        if (!isEnoent(error)) throw error
      }
      return
    }
    await writeJson(this.activeFile, { outlineId })
  }

  // ── outlines ─────────────────────────────────────────────────────────────

  private get outlinesDir(): string {
    return join(this.root, 'outlines')
  }

  private outlineFile(outlineId: string): string {
    if (!isSafeSegment(outlineId)) throw new Error(`unsafe outline id '${outlineId}'`)
    return join(this.outlinesDir, `${outlineId}.json`)
  }

  async readOutline(outlineId: string): Promise<Outline | null> {
    return normalizeOutlineParents(await readJson<Outline>(this.outlineFile(outlineId)))
  }

  async listOutlines(): Promise<Outline[]> {
    let names: string[]
    try {
      names = await readdir(this.outlinesDir)
    } catch (error: unknown) {
      if (isEnoent(error)) return []
      throw error
    }
    const outlines: Outline[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const outline = normalizeOutlineParents(await readJson<Outline>(join(this.outlinesDir, name)))
      if (outline !== null) outlines.push(outline)
    }
    outlines.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    return outlines
  }

  async writeOutline(outline: Outline): Promise<void> {
    await this.ensureRoot()
    await writeJson(this.outlineFile(outline.id), outline)
  }

  async deleteOutline(outlineId: string): Promise<void> {
    try {
      await rm(this.outlineFile(outlineId))
    } catch (error: unknown) {
      if (!isEnoent(error)) throw error
    }
  }

  // ── review cards ─────────────────────────────────────────────────────────

  private get cardsDir(): string {
    return join(this.root, 'cards')
  }

  private cardFile(lessonId: string): string {
    if (!isSafeSegment(lessonId)) throw new Error(`unsafe lesson id '${lessonId}'`)
    return join(this.cardsDir, `${lessonId}.json`)
  }

  async readCard(lessonId: string): Promise<CardFile | null> {
    return readJson<CardFile>(this.cardFile(lessonId))
  }

  async listCards(): Promise<CardFile[]> {
    let names: string[]
    try {
      names = await readdir(this.cardsDir)
    } catch (error: unknown) {
      if (isEnoent(error)) return []
      throw error
    }
    const cards: CardFile[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const card = await readJson<CardFile>(join(this.cardsDir, name))
      if (card !== null) cards.push(card)
    }
    return cards
  }

  async writeCard(card: CardFile): Promise<void> {
    await this.ensureRoot()
    await writeJson(this.cardFile(card.lessonId), card)
  }

  async deleteCard(lessonId: string): Promise<void> {
    try {
      await rm(this.cardFile(lessonId))
    } catch (error: unknown) {
      if (!isEnoent(error)) throw error
    }
  }

  // ── artifacts ────────────────────────────────────────────────────────────

  async writeArtifact(kind: ArtifactKind, hash: string, html: string): Promise<void> {
    if (!isValidArtifactHash(hash)) throw new Error(`unsafe artifact hash '${hash}'`)
    const dir = this.artifactDir(kind, hash)
    await mkdir(dir, { recursive: true })
    const tmp = join(dir, `.${randomUUID()}.tmp`)
    await writeFile(tmp, html, 'utf8')
    await rename(tmp, join(dir, 'index.html'))
  }

  async readArtifactHtml(kind: ArtifactKind, hash: string): Promise<string | null> {
    try {
      return await readFile(join(this.artifactDir(kind, hash), 'index.html'), 'utf8')
    } catch (error: unknown) {
      if (isEnoent(error)) return null
      throw error
    }
  }

  async writeMeta(kind: ArtifactKind, hash: string, meta: ArtifactMeta): Promise<void> {
    await writeJson(join(this.artifactDir(kind, hash), 'meta.json'), meta)
  }

  async readMeta(kind: ArtifactKind, hash: string): Promise<ArtifactMeta | null> {
    return readJson<ArtifactMeta>(join(this.artifactDir(kind, hash), 'meta.json'))
  }

  /** List artifacts of one kind, each with its full run history. */
  async listArtifacts(kind: ArtifactKind): Promise<Array<{ hash: string; meta: ArtifactMeta; runs: ArtifactRunSummary[] }>> {
    let names: string[]
    try {
      names = await readdir(this.dirFor(kind))
    } catch (error: unknown) {
      if (isEnoent(error)) return []
      throw error
    }
    const rows: Array<{ hash: string; meta: ArtifactMeta; runs: ArtifactRunSummary[] }> = []
    for (const hash of names) {
      if (!isValidArtifactHash(hash)) continue
      const meta = await this.readMeta(kind, hash)
      if (meta === null) continue
      rows.push({ hash, meta, runs: await this.listRuns(kind, hash) })
    }
    rows.sort((left, right) => left.meta.createdAt.localeCompare(right.meta.createdAt))
    return rows
  }

  async deleteArtifact(kind: ArtifactKind, hash: string): Promise<void> {
    try {
      await rm(this.artifactDir(kind, hash), { recursive: true, force: true })
    } catch (error: unknown) {
      if (!isEnoent(error)) throw error
    }
  }

  // ── runs ─────────────────────────────────────────────────────────────────

  async writeRun(kind: ArtifactKind, hash: string, run: ArtifactRun): Promise<void> {
    if (!isValidArtifactHash(hash)) throw new Error(`unsafe artifact hash '${hash}'`)
    await writeJson(join(this.runDir(kind, hash, run.runId), 'run.json'), run)
  }

  async readRun(kind: ArtifactKind, hash: string, runId: string): Promise<ArtifactRun | null> {
    return readJson<ArtifactRun>(join(this.runDir(kind, hash, runId), 'run.json'))
  }

  /** Find a run of this artifact by the DSH tool call id that created it. */
  async findRunByCallId(kind: ArtifactKind, hash: string, callId: string): Promise<ArtifactRun | null> {
    for (const run of await this.listRunRecords(kind, hash)) {
      if (run.callId === callId) return run
    }
    return null
  }

  /** Latest run of this artifact that has a submitted result, else null. */
  async latestSubmittedRun(kind: ArtifactKind, hash: string): Promise<ArtifactRun | null> {
    let latest: ArtifactRun | null = null
    let latestSubmittedAt = ''
    for (const run of await this.listRunRecords(kind, hash)) {
      const result = await this.readResult(kind, hash, run.runId)
      if (result === null) continue
      if (latest === null || result.submittedAt > latestSubmittedAt) {
        latest = run
        latestSubmittedAt = result.submittedAt
      }
    }
    return latest
  }

  /** One run's status summary (no payload bodies). */
  async listRuns(kind: ArtifactKind, hash: string): Promise<ArtifactRunSummary[]> {
    const records = await this.listRunRecords(kind, hash)
    const summaries: ArtifactRunSummary[] = []
    for (const run of records) {
      summaries.push({
        runId: run.runId,
        createdAt: run.createdAt,
        hasResult: (await this.readResult(kind, hash, run.runId)) !== null,
        hasFeedback: (await this.readFeedback(kind, hash, run.runId)) !== null,
      })
    }
    summaries.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    return summaries
  }

  async readResult(kind: ArtifactKind, hash: string, runId: string): Promise<ResultEnvelope | null> {
    return readJson<ResultEnvelope>(join(this.runDir(kind, hash, runId), 'result.json'))
  }

  /** Write-once: the first submission wins; concurrent duplicates return false. */
  async writeResultOnce(kind: ArtifactKind, hash: string, runId: string, result: ResultEnvelope): Promise<boolean> {
    return writeJsonOnce(join(this.runDir(kind, hash, runId), 'result.json'), result)
  }

  async readFeedback(kind: ArtifactKind, hash: string, runId: string): Promise<FeedbackEnvelope | null> {
    return readJson<FeedbackEnvelope>(join(this.runDir(kind, hash, runId), 'feedback.json'))
  }

  async writeFeedback(kind: ArtifactKind, hash: string, runId: string, feedback: FeedbackEnvelope): Promise<void> {
    await writeJson(join(this.runDir(kind, hash, runId), 'feedback.json'), feedback)
  }

  /** Read every run record of one artifact (no status derivation). */
  private async listRunRecords(kind: ArtifactKind, hash: string): Promise<ArtifactRun[]> {
    const dir = this.runsDir(kind, hash)
    const runIds = await listDirs(dir)
    const runs: ArtifactRun[] = []
    for (const runId of runIds) {
      if (!isValidRunId(runId)) continue
      const run = await this.readRun(kind, hash, runId)
      if (run !== null) runs.push(run)
    }
    runs.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    return runs
  }

  // ── validation ───────────────────────────────────────────────────────────

  /**
   * Validate a model-supplied artifact path: it must resolve inside the
   * workspace and name `<root>/<category>/<hash>/index.html`.
   * @returns the derived artifact hash.
   */
  validateArtifactPath(kind: ArtifactKind, path: string): string {
    const absolute = resolve(path)
    const dir = resolve(this.artifactDir(kind, ''))
    if (absolute === dir || !absolute.startsWith(dir + sep)) {
      throw new Error(`artifact path must live under ${dir}`)
    }
    const rest = absolute.slice(dir.length + 1)
    const [hash, ...tail] = rest.split(sep)
    if (hash === undefined || tail.join(sep) !== 'index.html' || !isValidArtifactHash(hash)) {
      throw new Error(`artifact path must be <learning>/${CATEGORY_DIRS[kind]}/<hash>/index.html`)
    }
    return hash
  }
}
