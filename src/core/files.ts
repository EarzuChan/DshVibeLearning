// 学习工作区的路径与原子文件操作，不承载业务状态机

import {randomUUID} from 'node:crypto'
import {link, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile} from 'node:fs/promises'
import {dirname, join, resolve, sep} from 'node:path'
import type {ArtifactHash, ArtifactKind, ArtifactTarget} from '../shared/artifacts.ts'
import {ARTIFACT_CATEGORY_BY_KIND} from '../shared/artifacts.ts'
import {isSafeSegment} from '../util/identifiers.ts'

// ---实用常量---

export const LEARNING_DIR = '.dsh/learning'
export const LEARNING_ARTIFACT_PATH_PATTERN = `${LEARNING_DIR}/artifacts/<lessons|reviews|quizzes>/<hash>/index.html`

// ---文件实用方法---

export function isEnoent(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

export function isValidArtifactHash(hash: string): hash is ArtifactHash {
    return /^[a-f0-9]{6,64}$/iu.test(hash)
}

export function isValidRunId(runId: string): boolean {
    return /^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(runId)
}

export async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory()
    } catch (error: unknown) {
        if (isEnoent(error)) return false
        throw error
    }
}

export async function readJson<T>(path: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as T
    } catch (error: unknown) {
        if (isEnoent(error)) return null
        throw error
    }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), {recursive: true})
    const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
}

export async function writeJsonOnce(path: string, value: unknown): Promise<boolean> {
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
        await unlink(tmp).catch(() => undefined)
    }
}

export async function listDirectories(path: string): Promise<string[]> {
    try {
        return (await readdir(path, {withFileTypes: true})).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch (error: unknown) {
        if (isEnoent(error)) return []
        throw error
    }
}

export async function listJsonFiles(path: string): Promise<string[]> {
    try {
        return (await readdir(path, {withFileTypes: true})).filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name)
    } catch (error: unknown) {
        if (isEnoent(error)) return []
        throw error
    }
}

export async function removePath(path: string, recursive = false): Promise<void> {
    try {
        await rm(path, recursive ? {recursive: true, force: true} : undefined)
    } catch (error: unknown) {
        if (!isEnoent(error)) throw error
    }
}

export async function isLearningWorkspace(cwd: string): Promise<boolean> {
    return isDirectory(join(cwd, LEARNING_DIR))
}

export class LearningFiles {
    readonly root: string

    // 与实际CWD关联
    constructor(readonly cwd: string) {
        this.root = join(cwd, LEARNING_DIR)
    }


    // ---路径拼凑---

    get outlinesDir(): string {
        return join(this.root, 'outlines')
    }

    get reviewPlansDir(): string {
        return join(this.root, 'review-plans')
    }

    get temporaryReviewPlanRoundsFile(): string {
        return join(this.root, 'artifacts', 'reviews', 'man.json')
    }

    outlineFile(id: string): string {
        if (!isSafeSegment(id)) throw new Error(`不安全的纲目 ID：${id}`)
        return join(this.outlinesDir, `${id}.json`)
    }

    reviewPlanFile(id: string): string {
        if (!isSafeSegment(id)) throw new Error(`不安全的复习计划 ID：${id}`)
        return join(this.reviewPlansDir, `${id}.json`)
    }

    artifactCategoryDir(kind: ArtifactKind): string {
        return join(this.root, 'artifacts', ARTIFACT_CATEGORY_BY_KIND[kind])
    }

    artifactDir(kind: ArtifactKind, hash: ArtifactHash): string {
        if (!isValidArtifactHash(hash)) throw new Error(`不安全的工件哈希：${hash}`)
        return join(this.artifactCategoryDir(kind), hash)
    }

    artifactHtml(kind: ArtifactKind, hash: ArtifactHash): string {
        return join(this.artifactDir(kind, hash), 'index.html')
    }

    runsDir(kind: ArtifactKind, hash: ArtifactHash): string {
        return join(this.artifactDir(kind, hash), 'runs')
    }

    runDir(kind: ArtifactKind, hash: ArtifactHash, runId: string): string {
        if (!isValidRunId(runId)) throw new Error(`不安全的 Run ID：${runId}`)
        return join(this.runsDir(kind, hash), runId)
    }

    outcomeFile(kind: ArtifactKind, hash: ArtifactHash, runId: string): string {
        return join(this.runDir(kind, hash, runId), 'outcome.json')
    }

    feedbackFile(kind: ArtifactKind, hash: ArtifactHash, runId: string): string {
        return join(this.runDir(kind, hash, runId), 'feedback.json')
    }

    // ---实际方法---

    async currentIsLearningWorkspace(): Promise<boolean> {
        return isDirectory(this.root)
    }

    async createLearningWorkspace(): Promise<void> {
        await mkdir(this.root, {recursive: true})
    }

    // 未被使用？！
    async confirmLearningWorkspace(): Promise<void> {
        if (!await this.currentIsLearningWorkspace()) throw new Error(`学习工作区目录不存在：${this.root}`)
    }

    validateArtifactPath(kind: ArtifactKind, path: string): ArtifactTarget {
        const absolute = resolve(path)
        const category = resolve(this.artifactCategoryDir(kind))

        if (absolute === category || !absolute.startsWith(category + sep)) throw new Error(`工件路径必须位于目录下：${category}`)

        const rest = absolute.slice(category.length + 1)
        const [hash, ...tail] = rest.split(sep)
        if (hash === undefined || tail.join(sep) !== 'index.html' || !isValidArtifactHash(hash)) throw new Error(`工件路径必须符合格式：<learning>/artifacts/${ARTIFACT_CATEGORY_BY_KIND[kind]}/<hash>/index.html`)

        return {kind, hash}
    }
}
