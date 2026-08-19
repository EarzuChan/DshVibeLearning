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
export const LEARNING_ARTIFACT_PATH = `${LEARNING_DIR}/<lessons|reviews|quizzes>/<hash>/index.html`

// 是否文件不存在
function isEnoent(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

// 检查作为目录名的工件哈希是否合法
export function isValidArtifactHash(hash: string): boolean {
    return /^[a-f0-9]{6,64}$/iu.test(hash)
}

// 检查作为目录名的 run ID 是否为安全的单路径段
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
        await unlink(tmp).catch(() => {
        })
    }
}

// 学习根目录的独立探测入口，只判断目录存在，不读取任何业务数据
export async function isLearningWorkspace(cwd: string): Promise<boolean> {
    return isDirectory(join(cwd, LEARNING_DIR))
}

// 确认路径存在且是目录，不存在返回 false，其他异常原样抛出
async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory()
    } catch (error: unknown) {
        if (isEnoent(error)) return false
        throw error
    }
}

// 校验纲目基础结构；这里不负责修复或创建任何文件
function confirmOutline(outline: Outline): void {
    if (typeof outline.id !== 'string' || outline.id.length === 0) throw new Error('纲目 ID 无效')
    if (typeof outline.title !== 'string' || outline.title.length === 0) throw new Error('纲目标题无效')
    if (!Array.isArray(outline.nodes) || outline.nodes.length === 0) throw new Error('纲目节点为空')

    const ids = new Set<string>()
    for (const node of outline.nodes) {
        if (typeof node?.id !== 'string' || node.id.length === 0) throw new Error('节点 ID 无效')
        if (ids.has(node.id)) throw new Error(`节点 ID 重复（${node.id}）`)
        ids.add(node.id)
    }

    for (const node of outline.nodes) {
        if (node.parentId !== null && !ids.has(node.parentId)) throw new Error(`节点 ${node.id} 引用不存在的父节点`)
        if (node.kind === 'lesson' && (typeof node.lessonId !== 'string' || node.lessonId.length === 0)) throw new Error(`课程节点 ${node.id} 缺少 lessonId`)
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

    constructor(cwd: string) {
        this.cwd = cwd
    }

    get currentLearningDir(): string {
        return join(this.cwd, LEARNING_DIR)
    }

    private dirFor(kind: ArtifactKind): string {
        return join(this.currentLearningDir, ARTIFACT_CATEGORY_BY_KIND[kind])
    }

    private getArtifactDir(kind: ArtifactKind, hash: string): string {
        return join(this.dirFor(kind), hash)
    }

    private getRunsDir(kind: ArtifactKind, hash: string): string {
        return join(this.getArtifactDir(kind, hash), 'runs')
    }

    private getRunDir(kind: ArtifactKind, hash: string, runId: string): string {
        if (!isValidRunId(runId)) throw new Error(`不安全的 run ID：${runId}`)
        return join(this.getRunsDir(kind, hash), runId)
    }

    // ---根目录---

    async currentIsLearningWorkspace(): Promise<boolean> {
        return isDirectory(this.currentLearningDir)
    }

    // TIPS：或是仅在初次进入氛围学习时创建学习根目录；已存在文件或目录时保持原样，由确认阶段负责报损坏
    async createLearningWorkspace(): Promise<void> {
        await mkdir(this.currentLearningDir, {recursive: true})
    }

    // ---Require几件套---

    private async requireCurrentLearningWorkspaceAvailable() {
        if (!await this.currentIsLearningWorkspace()) throw new Error(`学习工作区目录不存在啊一个：${this.currentLearningDir}`)
    }

    private requireOutlineAvailable(outline: Parameters<typeof confirmOutline>[0]) {
        try {
            confirmOutline(outline)
        } catch (error: unknown) {
            throw new Error(`纲目 ${outline.id} 无效：${error instanceof Error ? error.message : String(error)}`)
        }
    }

    // **确认**学习工作区与指定会话纲目可用。不创建、不修复、不覆盖语义数据
    async requireCurrentLearningWorkspaceAndAllOutlinesReallyAvailable(additionalRequiredOutlineId: string | null) {
        await this.requireCurrentLearningWorkspaceAvailable()

        const outlines = await this.listOutlines()

        const outlineAdditionalRequired = additionalRequiredOutlineId !== null
        let requiredOutlineIsConfirmed = false

        for (const outline of outlines) {
            this.requireOutlineAvailable(outline)

            if (outlineAdditionalRequired && outline.id === additionalRequiredOutlineId) requiredOutlineIsConfirmed = true
        }

        if (outlineAdditionalRequired && !requiredOutlineIsConfirmed) throw new Error(`当前会话激活纲目不存在：${additionalRequiredOutlineId}`)
    }

    // 同轮激活纲目变化后的轻量确认，只验证工作区目录与新纲目本身，不重复扫描全部纲目
    async requireCurrentLearningWorkspaceAndSpecificOutlineReallyAvailable(outlineId: string) {
        await this.requireCurrentLearningWorkspaceAvailable()

        const outline = await this.readOutline(outlineId)
        if (outline === null) throw new Error(`当前会话激活纲目不存在：${outlineId}`)

        this.requireOutlineAvailable(outline)
    }

    // ---纲目---

    private get outlinesDir(): string {
        return join(this.currentLearningDir, 'outlines')
    }

    private getOutlineFile(outlineId: string): string {
        if (!isSafeSegment(outlineId)) throw new Error(`不安全的纲目 ID：${outlineId}`)
        return join(this.outlinesDir, `${outlineId}.json`)
    }

    async readOutline(outlineId: string): Promise<Outline | null> {
        return normalizeOutlineParents(await readJson<Outline>(this.getOutlineFile(outlineId)))
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
        await writeJson(this.getOutlineFile(outline.id), outline)
    }

    async deleteOutline(outlineId: string): Promise<void> {
        try {
            await rm(this.getOutlineFile(outlineId))
        } catch (error: unknown) {
            if (!isEnoent(error)) throw error
        }
    }

    // ---复习卡片---

    private get cardsDir(): string {
        return join(this.currentLearningDir, 'cards')
    }

    private getCardFile(lessonId: string): string {
        if (!isSafeSegment(lessonId)) throw new Error(`不安全的课程 ID：${lessonId}`)
        return join(this.cardsDir, `${lessonId}.json`)
    }

    async readCard(lessonId: string): Promise<CardFile | null> {
        return readJson<CardFile>(this.getCardFile(lessonId))
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
        await writeJson(this.getCardFile(card.lessonId), card)
    }

    async deleteCard(lessonId: string): Promise<void> {
        try {
            await rm(this.getCardFile(lessonId))
        } catch (error: unknown) {
            if (!isEnoent(error)) throw error
        }
    }

    // ---工件---

    async writeArtifact(kind: ArtifactKind, hash: string, html: string): Promise<void> {
        if (!isValidArtifactHash(hash)) throw new Error(`不安全的工件哈希：${hash}`)

        const dir = this.getArtifactDir(kind, hash)
        await mkdir(dir, {recursive: true})

        const tmp = join(dir, `.${randomUUID()}.tmp`)
        await writeFile(tmp, html, 'utf8')
        await rename(tmp, join(dir, 'index.html'))
    }

    async readArtifactHtml(kind: ArtifactKind, hash: string): Promise<string | null> {
        try {
            return await readFile(join(this.getArtifactDir(kind, hash), 'index.html'), 'utf8')
        } catch (error: unknown) {
            if (isEnoent(error)) return null
            throw error
        }
    }

    async writeMeta(kind: ArtifactKind, hash: string, meta: ArtifactMeta): Promise<void> {
        await writeJson(join(this.getArtifactDir(kind, hash), 'meta.json'), meta)
    }

    async readMeta(kind: ArtifactKind, hash: string): Promise<ArtifactMeta | null> {
        return readJson<ArtifactMeta>(join(this.getArtifactDir(kind, hash), 'meta.json'))
    }

    // 列出一种类型的全部工件及其完整 run 历史
    async listArtifacts(kind: ArtifactKind): Promise<Array<{ hash: string, meta: ArtifactMeta, runs: ArtifactRunSummary[] }>> {
        let names: string[]

        try {
            names = await readdir(this.dirFor(kind))
        } catch (error: unknown) {
            if (isEnoent(error)) return []
            throw error
        }

        const rows: Array<{ hash: string, meta: ArtifactMeta, runs: ArtifactRunSummary[] }> = []
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
            await rm(this.getArtifactDir(kind, hash), {recursive: true, force: true})
        } catch (error: unknown) {
            if (!isEnoent(error)) throw error
        }
    }

    // ---运行记录（RUN）---

    async writeRun(kind: ArtifactKind, hash: string, run: ArtifactRun): Promise<void> {
        if (!isValidArtifactHash(hash)) throw new Error(`不安全的工件哈希：${hash}`)
        await writeJson(join(this.getRunDir(kind, hash, run.runId), 'run.json'), run)
    }

    async readRun(kind: ArtifactKind, hash: string, runId: string): Promise<ArtifactRun | null> {
        return readJson<ArtifactRun>(join(this.getRunDir(kind, hash, runId), 'run.json'))
    }

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

    async readResult(kind: ArtifactKind, hash: string, runId: string): Promise<ResultEnvelope | null> {
        return readJson<ResultEnvelope>(join(this.getRunDir(kind, hash, runId), 'result.json'))
    }

    // 结果只允许首次提交成功，并发重复提交返回 false
    async writeResultOnce(kind: ArtifactKind, hash: string, runId: string, result: ResultEnvelope): Promise<boolean> {
        return writeJsonOnce(join(this.getRunDir(kind, hash, runId), 'result.json'), result)
    }

    async readFeedback(kind: ArtifactKind, hash: string, runId: string): Promise<FeedbackEnvelope | null> {
        return readJson<FeedbackEnvelope>(join(this.getRunDir(kind, hash, runId), 'feedback.json'))
    }

    async writeFeedback(kind: ArtifactKind, hash: string, runId: string, feedback: FeedbackEnvelope): Promise<void> {
        await writeJson(join(this.getRunDir(kind, hash, runId), 'feedback.json'), feedback)
    }

    // 读取单个工件的全部 run 原始记录，不派生状态
    private async listRunRecords(kind: ArtifactKind, hash: string): Promise<ArtifactRun[]> {
        const runIds = await listDirs(this.getRunsDir(kind, hash))
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
        const dir = resolve(this.getArtifactDir(kind, ''))
        if (absolute === dir || !absolute.startsWith(dir + sep)) throw new Error(`工件路径必须位于目录下：${dir}`)

        const rest = absolute.slice(dir.length + 1)
        const [hash, ...tail] = rest.split(sep)
        if (hash === undefined || tail.join(sep) !== 'index.html' || !isValidArtifactHash(hash)) throw new Error(`工件路径必须符合格式：<learning>/${ARTIFACT_CATEGORY_BY_KIND[kind]}/<hash>/index.html`)

        return hash
    }
}
