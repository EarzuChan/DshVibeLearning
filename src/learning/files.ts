/**
 * Workspace file domain: everything DVL stores per workspace lives under
 * `<cwd>/.dsh/learning/`. Directory existence alone marks a learning
 * workspace — no manifest. All writes are tmp-file + rename so a torn write
 * never publishes a half record.
 * @module dvl/learning/files
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { isSafeSegment } from '../shared/hash.ts'
import type { ArtifactKind, ArtifactMeta, CardFile, FeedbackFile, Outline, ResultEnvelope } from '../shared/types.ts'

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error: unknown) {
    if (isEnoent(error)) return false
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
    return readJson<Outline>(this.outlineFile(outlineId))
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
      const outline = await readJson<Outline>(join(this.outlinesDir, name))
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

  async listArtifacts(kind: ArtifactKind): Promise<Array<{ hash: string; meta: ArtifactMeta; hasResult: boolean; hasFeedback: boolean }>> {
    let names: string[]
    try {
      names = await readdir(this.dirFor(kind))
    } catch (error: unknown) {
      if (isEnoent(error)) return []
      throw error
    }
    const rows: Array<{ hash: string; meta: ArtifactMeta; hasResult: boolean; hasFeedback: boolean }> = []
    for (const hash of names) {
      if (!isValidArtifactHash(hash)) continue
      const meta = await this.readMeta(kind, hash)
      if (meta === null) continue
      rows.push({
        hash,
        meta,
        hasResult: (await this.readResult(kind, hash)) !== null,
        hasFeedback: (await this.readFeedback(kind, hash)) !== null,
      })
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

  async readResult(kind: ArtifactKind, hash: string): Promise<ResultEnvelope | null> {
    return readJson<ResultEnvelope>(join(this.artifactDir(kind, hash), 'result.json'))
  }

  async writeResult(kind: ArtifactKind, hash: string, result: ResultEnvelope): Promise<void> {
    await writeJson(join(this.artifactDir(kind, hash), 'result.json'), result)
  }

  async readFeedback(kind: ArtifactKind, hash: string): Promise<FeedbackFile | null> {
    return readJson<FeedbackFile>(join(this.artifactDir(kind, hash), 'feedback.json'))
  }

  async writeFeedback(kind: ArtifactKind, hash: string, feedback: FeedbackFile): Promise<void> {
    await writeJson(join(this.artifactDir(kind, hash), 'feedback.json'), feedback)
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
