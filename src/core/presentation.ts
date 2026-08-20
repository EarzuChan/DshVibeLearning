// In-band Present 的临时占用关系，不保存 Tool Call 或 Run 的持久状态

import type {InBandLease, RunRef} from './types.ts'

function runKey(run: RunRef): string {
    return `${run.cwd}\u0000${run.kind}\u0000${run.hash}\u0000${run.runId}`
}

interface PendingInBandLease {
    readonly callId: string
    readonly sessionId: string
    run?: RunRef
}

export class InBandPresentationRegistry {
    private readonly byCall = new Map<string, PendingInBandLease>()
    private readonly bySession = new Map<string, PendingInBandLease>()
    private readonly byRun = new Map<string, InBandLease>()

    reserve(callId: string, sessionId: string): void {
        const existing = this.byCall.get(callId)
        if (existing !== undefined) {
            if (existing.sessionId === sessionId) return
            throw new Error('同一 Tool Call 已在其他会话进行 In-band Present')
        }
        if (this.bySession.has(sessionId)) throw new Error('当前会话已有正在进行的 In-band Present')
        const lease = {callId, sessionId}
        this.byCall.set(callId, lease)
        this.bySession.set(sessionId, lease)
    }

    attach(callId: string, run: RunRef): InBandLease {
        const pending = this.byCall.get(callId)
        if (pending === undefined) throw new Error('In-band Present 尚未预留')
        if (pending.run !== undefined) {
            if (runKey(pending.run) === runKey(run)) return pending as InBandLease
            throw new Error('同一 Tool Call 已在呈现其他 Run')
        }
        if (this.byRun.has(runKey(run))) throw new Error('该 Run 已由其他会话 In-band Present')
        pending.run = run
        this.byRun.set(runKey(run), pending as InBandLease)
        return pending as InBandLease
    }

    release(callId: string): void {
        const lease = this.byCall.get(callId)
        if (lease === undefined) return
        this.byCall.delete(callId)
        if (this.bySession.get(lease.sessionId) === lease) this.bySession.delete(lease.sessionId)
        if (lease.run !== undefined && this.byRun.get(runKey(lease.run)) === lease) this.byRun.delete(runKey(lease.run))
    }

    forCall(callId: string): InBandLease | null {
        const lease = this.byCall.get(callId)
        return lease?.run === undefined ? null : lease as InBandLease
    }

    forSession(sessionId: string): InBandLease | null {
        const lease = this.bySession.get(sessionId)
        return lease?.run === undefined ? null : lease as InBandLease
    }

    forRun(run: RunRef): InBandLease | null {
        return this.byRun.get(runKey(run)) ?? null
    }
}
