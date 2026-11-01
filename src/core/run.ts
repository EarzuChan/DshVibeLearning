// Durable Run、终局文件、临时复用键与 outcome 等待。Run 只承诺在创建它的进程内有效：重启后未终结的 Run 在被读到时判为 aborted

import {randomUUID} from 'node:crypto'
import {copyFile, mkdir, readFile, stat} from 'node:fs/promises'
import type {ArtifactKind} from '../shared/artifacts.ts'
import type {ArtifactRunSummary, FeedbackEnvelope, RunOutcome} from '../shared/model.ts'
import {ArtifactStore} from './artifact.ts'
import {isDirectory, isEnoent, LearningFiles, listDirectories, readJson, writeJson, writeJsonOnce} from './files.ts'
import type {ArtifactRef, RunRef, RunReuseKey} from './types.ts'

type OutcomeListener = (outcome: RunOutcome) => void

// 本进程的启动标记，写进每个 Run 目录
const BOOT_ID = randomUUID()

const STALE_RUN_REASON = '进程已重启，本次 Run 随之失效'

function artifactKey(ref: ArtifactRef): string {
    return `${ref.cwd}\u0000${ref.kind}\u0000${ref.artifactId}`
}

function runKey(ref: RunRef): string {
    return `${artifactKey(ref)}\u0000${ref.runId}`
}

function reuseKey(ref: ArtifactRef, key: RunReuseKey): string {
    return `${artifactKey(ref)}\u0000${key.namespace}\u0000${key.value}`
}

export class RunStore {
    private readonly keyedRuns = new Map<string, RunRef>()
    private readonly obtaining = new Map<string, Promise<RunRef>>()
    private readonly listeners = new Map<string, Set<OutcomeListener>>()

    files(cwd: string): LearningFiles {
        return new LearningFiles(cwd)
    }

    async exists(ref: RunRef): Promise<boolean> {
        return isDirectory(this.files(ref.cwd).runDir(ref.kind, ref.artifactId, ref.runId))
    }

    // 读取终局；未终结但属于其他进程的 Run 会在此惰性落盘为 aborted
    async outcome(ref: RunRef): Promise<RunOutcome | null> {
        const files = this.files(ref.cwd)
        const durable = await readJson<RunOutcome>(files.outcomeFile(ref.kind, ref.artifactId, ref.runId))
        if (durable !== null) return durable

        const boot = await readJson<{bootId?: unknown}>(files.runBootFile(ref.kind, ref.artifactId, ref.runId))
        if (boot?.bootId === BOOT_ID || !await this.exists(ref)) return null

        await writeJsonOnce(files.outcomeFile(ref.kind, ref.artifactId, ref.runId), {state: 'aborted', reason: STALE_RUN_REASON} satisfies RunOutcome)
        return readJson<RunOutcome>(files.outcomeFile(ref.kind, ref.artifactId, ref.runId))
    }

    // 读取 Run 创建时冻结的工件副本
    async frozenHtml(ref: RunRef): Promise<string | null> {
        try {
            return await readFile(this.files(ref.cwd).runArtifactHtml(ref.kind, ref.artifactId, ref.runId), 'utf8')
        } catch (error: unknown) {
            if (isEnoent(error)) return null
            throw error
        }
    }

    async obtain(artifact: ArtifactRef, key?: RunReuseKey, preferredRunId?: string): Promise<RunRef> {
        if (!await new ArtifactStore(this.files(artifact.cwd)).exists(artifact.kind, artifact.artifactId)) throw new Error(`工件不存在：${artifact.kind}/${artifact.artifactId}`)
        if (preferredRunId !== undefined && key === undefined) throw new Error('指定既有 Run 时必须同时提供复用键')
        if (key === undefined) return this.create(artifact)

        const id = reuseKey(artifact, key)
        const running = this.obtaining.get(id)
        if (running !== undefined) return running

        const operation = (async (): Promise<RunRef> => {
            const current = this.keyedRuns.get(id)
            if (current !== undefined && await this.exists(current) && await this.outcome(current) === null) {
                if (preferredRunId !== undefined && current.runId !== preferredRunId) throw new Error('同一复用键已经关联其他 Active Run')
                return current
            }

            const obtained = preferredRunId === undefined ? await this.create(artifact) : {...artifact, runId: preferredRunId}
            if (preferredRunId !== undefined && (!await this.exists(obtained) || await this.outcome(obtained) !== null)) throw new Error(`指定的 Run 不是 Active：${preferredRunId}`)
            this.keyedRuns.set(id, obtained)
            return obtained
        })()

        this.obtaining.set(id, operation)
        try {
            return await operation
        } finally {
            if (this.obtaining.get(id) === operation) this.obtaining.delete(id)
        }
    }

    // CHECK：竟无人用这个？？
    async peek(artifact: ArtifactRef, key: RunReuseKey): Promise<RunRef | null> {
        const current = this.keyedRuns.get(reuseKey(artifact, key))
        return current !== undefined && await this.exists(current) ? current : null
    }

    async create(artifact: ArtifactRef): Promise<RunRef> {
        const files = this.files(artifact.cwd)
        const run = {...artifact, runId: randomUUID()}

        await mkdir(files.runsDir(artifact.kind, artifact.artifactId), {recursive: true})
        await mkdir(files.runDir(artifact.kind, artifact.artifactId, run.runId), {recursive: false})

        await copyFile(files.artifactHtml(artifact.kind, artifact.artifactId), files.runArtifactHtml(artifact.kind, artifact.artifactId, run.runId))
        await writeJson(files.runBootFile(artifact.kind, artifact.artifactId, run.runId), {bootId: BOOT_ID})
        return run
    }

    async finish(ref: RunRef, outcome: RunOutcome): Promise<{outcome: RunOutcome; alreadyFinished: boolean}> {
        if (!await this.exists(ref)) throw new Error(`Run 不存在：${ref.runId}`)

        const wrote = await writeJsonOnce(this.files(ref.cwd).outcomeFile(ref.kind, ref.artifactId, ref.runId), outcome)

        const durable = wrote ? outcome : await this.outcome(ref)
        if (durable === null) throw new Error(`Run ${ref.runId} 的终局写入失败`)

        if (wrote) this.publish(ref, durable)

        return {outcome: durable, alreadyFinished: !wrote}
    }

    async saveFeedback(ref: RunRef, payload: unknown): Promise<FeedbackEnvelope> {
        const outcome = await this.outcome(ref)
        if (outcome?.state !== 'completed') throw new Error(`Run ${ref.runId} 尚未完成，不能保存批改`)

        const feedback: FeedbackEnvelope = {payload}
        await writeJson(this.files(ref.cwd).feedbackFile(ref.kind, ref.artifactId, ref.runId), feedback)

        return feedback
    }

    async feedback(ref: RunRef): Promise<FeedbackEnvelope | null> {
        return readJson<FeedbackEnvelope>(this.files(ref.cwd).feedbackFile(ref.kind, ref.artifactId, ref.runId))
    }

    async wait(ref: RunRef, options: {signal?: AbortSignal; timeoutMs: number}): Promise<RunOutcome | 'timed-out' | 'interrupted'> {
        const immediate = await this.outcome(ref)
        if (immediate !== null) return immediate

        return new Promise(resolve => {
            const listeners = this.listeners.get(runKey(ref)) ?? new Set<OutcomeListener>()
            this.listeners.set(runKey(ref), listeners)
            let settled = false

            const finish = (value: RunOutcome | 'timed-out' | 'interrupted'): void => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                options.signal?.removeEventListener('abort', abort)
                listeners.delete(receive)
                if (listeners.size === 0) this.listeners.delete(runKey(ref))
                resolve(value)
            }

            const receive = (outcome: RunOutcome): void => finish(outcome)
            const abort = (): void => finish('interrupted')
            const timer = setTimeout(() => finish('timed-out'), options.timeoutMs)
            timer.unref?.()
            listeners.add(receive)
            options.signal?.addEventListener('abort', abort, {once: true})

            void this.outcome(ref).then(outcome => { if (outcome !== null) finish(outcome) }, () => undefined)
        })
    }

    async list(kind: ArtifactKind, artifactId: string, cwd: string): Promise<ArtifactRunSummary[]> {
        const files = this.files(cwd)
        const runs: ArtifactRunSummary[] = []
        for (const runId of await listDirectories(files.runsDir(kind, artifactId))) {
            const ref = {cwd, kind, artifactId, runId}
            const outcome = await this.outcome(ref)
            const modifiedAt = (await stat(outcome === null ? files.runDir(kind, artifactId, runId) : files.outcomeFile(kind, artifactId, runId))).mtime.toISOString()
            runs.push({runId, state: outcome?.state ?? 'active', hasFeedback: await this.feedback(ref) !== null, modifiedAt})
        }
        return runs.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
    }

    private publish(ref: RunRef, outcome: RunOutcome): void {
        for (const listener of this.listeners.get(runKey(ref)) ?? []) listener(outcome)
    }
}
