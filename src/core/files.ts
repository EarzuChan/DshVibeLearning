// 工作区文件域：DVL 的工作区级数据全部存放在 <cwd>/.dsh/learning/，目录存在即代表学习工作区；所有写入均通过临时文件后 rename 原子发布，工件按哈希不可变寻址，每次展示或作答则独立保存为 run

import {randomUUID} from 'node:crypto'
import {link, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile} from 'node:fs/promises'
import {dirname, join, resolve, sep} from 'node:path'
import {isSafeSegment} from './identifiers.ts'
import {ARTIFACT_CATEGORY_BY_KIND, type ArtifactKind} from '../shared/artifacts.ts'
import type {ArtifactMeta, ArtifactRunSummary, Outline, OutlineNode} from '../shared/model.ts'
import type {ArtifactRun, CardFile, FeedbackEnvelope, ResultEnvelope} from './types.ts'

// 工作区内学习数据的相对根目录
export const LEARNING_DIR = '.dsh/learning'

function isEnoent(error: unknown): boolean { return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' }

// 检查作为目录名的工件哈希是否合法
export function isValidArtifactHash(hash: string): boolean { return /^[a-f0-9]{6,64}$/iu.test(hash) }

// 检查作为目录名的 run ID 是否为安全的单路径段
export function isValidRunId(runId: string): boolean { return /^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(runId) }

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error: unknown) {
    if (isEnoent(error)) return null
    throw error
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), {recursive: true})
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

// 仅在目标不存在时原子写入 JSON，当前调用成功创建返回 true，已有文件返回 false
async function writeJsonOnce(path: string, value: unknown): Promise<boolean> {
  await mkdir(dirname(path), {recursive: true})
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

// 读取端兼容历史数据，将根节点 parentId 的空字符串统一归一为 null
function normalizeOutlineParents(outline: Outline | null): Outline | null {
  if (outline === null) return null

  let changed = false
  const nodes = outline.nodes.map(node => {
    if (node.parentId !== '') return node
    changed = true
    return {...node, parentId: null} as OutlineNode
  })

  return changed ? {...outline, nodes} : outline
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return await readdir(dir, {withFileTypes: true}).then(entries => entries.filter(entry => entry.isDirectory()).map(entry => entry.name))
  } catch (error: unknown) {
    if (isEnoent(error)) return []
    throw error
  }
}

// 单个工作区 .dsh/learning/ 文件树访问器，不做缓存以保证跨会话修改立即可见
export class LearningFiles {
  readonly cwd: string

  constructor(cwd: string) { this.cwd = cwd }

  get root(): string { return join(this.cwd, LEARNING_DIR) }

  private dirFor(kind: ArtifactKind): string { return join(this.root, ARTIFACT_CATEGORY_BY_KIND[kind]) }

  private artifactDir(kind: ArtifactKind, hash: string): string { return join(this.dirFor(kind), hash) }

  private runsDir(kind: ArtifactKind, hash: string): string { return join(this.artifactDir(kind, hash), 'runs') }

  private runDir(kind: ArtifactKind, hash: string, runId: string): string {
    if (!isValidRunId(runId)) throw new Error(`不安全的 run ID：${runId}`)
    return join(this.runsDir(kind, hash), runId)
  }

  // ---根目录---

  async exists(): Promise<boolean> { return pathExists(this.root) }

  // 创建学习根目录，同时使当前工作区成为学习工作区
  async ensureRoot(): Promise<void> { await mkdir(this.root, {recursive: true}) }

  // ---当前纲目---

  private get activeFile(): string { return join(this.root, 'active.json') }

  async readActive(): Promise<string | null> {
    const value = await readJson<{outlineId: string}>(this.activeFile)
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

    await writeJson(this.activeFile, {outlineId})
  }

  // ---纲目---

  private get outlinesDir(): string { return join(this.root, 'outlines') }

  private outlineFile(outlineId: string): string {
    if (!isSafeSegment(outlineId)) throw new Error(`不安全的纲目 ID：${outlineId}`)
    return join(this.outlinesDir, `${outlineId}.json`)
  }

  async readOutline(outlineId: string): Promise<Outline | null> { return normalizeOutlineParents(await readJson<Outline>(this.outlineFile(outlineId))) }

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

  // ---复习卡片---

  private get cardsDir(): string { return join(this.root, 'cards') }

  private cardFile(lessonId: string): string {
    if (!isSafeSegment(lessonId)) throw new Error(`不安全的课程 ID：${lessonId}`)
    return join(this.cardsDir, `${lessonId}.json`)
  }

  async readCard(lessonId: string): Promise<CardFile | null> { return readJson<CardFile>(this.cardFile(lessonId)) }

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

  // ---工件---

  async writeArtifact(kind: ArtifactKind, hash: string, html: string): Promise<void> {
    if (!isValidArtifactHash(hash)) throw new Error(`不安全的工件哈希：${hash}`)

    const dir = this.artifactDir(kind, hash)
    await mkdir(dir, {recursive: true})

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

  async writeMeta(kind: ArtifactKind, hash: string, meta: ArtifactMeta): Promise<void> { await writeJson(join(this.artifactDir(kind, hash), 'meta.json'), meta) }

  async readMeta(kind: ArtifactKind, hash: string): Promise<ArtifactMeta | null> { return readJson<ArtifactMeta>(join(this.artifactDir(kind, hash), 'meta.json')) }

  // 列出一种类型的全部工件及其完整 run 历史
  async listArtifacts(kind: ArtifactKind): Promise<Array<{hash: string, meta: ArtifactMeta, runs: ArtifactRunSummary[]}>> {
    let names: string[]

    try {
      names = await readdir(this.dirFor(kind))
    } catch (error: unknown) {
      if (isEnoent(error)) return []
      throw error
    }

    const rows: Array<{hash: string, meta: ArtifactMeta, runs: ArtifactRunSummary[]}> = []
    for (const hash of names) {
      if (!isValidArtifactHash(hash)) continue

      const meta = await this.readMeta(kind, hash)
      if (meta === null) continue

      rows.push({hash, meta, runs: await this.listRuns(kind, hash)})
    }

    rows.sort((left, right) => left.meta.createdAt.localeCompare(right.meta.createdAt))
    return rows
  }

  async deleteArtifact(kind: ArtifactKind, hash: string): Promise<void> {
    try {
      await rm(this.artifactDir(kind, hash), {recursive: true, force: true})
    } catch (error: unknown) {
      if (!isEnoent(error)) throw error
    }
  }

  // ---运行记录（RUN）---

  async writeRun(kind: ArtifactKind, hash: string, run: ArtifactRun): Promise<void> {
    if (!isValidArtifactHash(hash)) throw new Error(`不安全的工件哈希：${hash}`)
    await writeJson(join(this.runDir(kind, hash, run.runId), 'run.json'), run)
  }

  async readRun(kind: ArtifactKind, hash: string, runId: string): Promise<ArtifactRun | null> { return readJson<ArtifactRun>(join(this.runDir(kind, hash, runId), 'run.json')) }

  // 按创建该 run 的 DSH 工具 call ID 查找运行记录
  async findRunByCallId(kind: ArtifactKind, hash: string, callId: string): Promise<ArtifactRun | null> {
    for (const run of await this.listRunRecords(kind, hash)) if (run.callId === callId) return run
    return null
  }

  // 查找该工件最近一次已有提交结果的 run
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

  // 列出单个工件的 run 状态摘要，不包含 payload 正文
  async listRuns(kind: ArtifactKind, hash: string): Promise<ArtifactRunSummary[]> {
    const records = await this.listRunRecords(kind, hash)
    const summaries: ArtifactRunSummary[] = []

    for (const run of records) summaries.push({runId: run.runId, createdAt: run.createdAt, hasResult: (await this.readResult(kind, hash, run.runId)) !== null, hasFeedback: (await this.readFeedback(kind, hash, run.runId)) !== null})

    summaries.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    return summaries
  }

  async readResult(kind: ArtifactKind, hash: string, runId: string): Promise<ResultEnvelope | null> { return readJson<ResultEnvelope>(join(this.runDir(kind, hash, runId), 'result.json')) }

  // 结果只允许首次提交成功，并发重复提交返回 false
  async writeResultOnce(kind: ArtifactKind, hash: string, runId: string, result: ResultEnvelope): Promise<boolean> { return writeJsonOnce(join(this.runDir(kind, hash, runId), 'result.json'), result) }

  async readFeedback(kind: ArtifactKind, hash: string, runId: string): Promise<FeedbackEnvelope | null> { return readJson<FeedbackEnvelope>(join(this.runDir(kind, hash, runId), 'feedback.json')) }

  async writeFeedback(kind: ArtifactKind, hash: string, runId: string, feedback: FeedbackEnvelope): Promise<void> { await writeJson(join(this.runDir(kind, hash, runId), 'feedback.json'), feedback) }

  // 读取单个工件的全部 run 原始记录，不派生状态
  private async listRunRecords(kind: ArtifactKind, hash: string): Promise<ArtifactRun[]> {
    const runIds = await listDirs(this.runsDir(kind, hash))
    const runs: ArtifactRun[] = []

    for (const runId of runIds) {
      if (!isValidRunId(runId)) continue
      const run = await this.readRun(kind, hash, runId)
      if (run !== null) runs.push(run)
    }

    runs.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    return runs
  }

  // ---路径校验---

  // 校验模型提供的工件路径必须位于当前工作区并严格符合 <root>/<category>/<hash>/index.html，返回其中的工件哈希
  validateArtifactPath(kind: ArtifactKind, path: string): string {
    const absolute = resolve(path)
    const dir = resolve(this.artifactDir(kind, ''))
    if (absolute === dir || !absolute.startsWith(dir + sep)) throw new Error(`工件路径必须位于目录下：${dir}`)

    const rest = absolute.slice(dir.length + 1)
    const [hash, ...tail] = rest.split(sep)
    if (hash === undefined || tail.join(sep) !== 'index.html' || !isValidArtifactHash(hash)) throw new Error(`工件路径必须符合格式：<learning>/${ARTIFACT_CATEGORY_BY_KIND[kind]}/<hash>/index.html`)

    return hash
  }
}
