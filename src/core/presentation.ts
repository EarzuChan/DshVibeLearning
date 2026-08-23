// In-band Present 的临时占用关系，不保存 ToolCall 或 Run 的持久状态

// Present大思想=（推进状态机、创建并绑定工件+）模型调用present_artifact得到result+模型批改并调用工具保存（+评估是否创建复习+推进状态机+回复学习情况给用户）
// present_artifact本身（即InBand）=取得Run并占用之->展示并等待Run被Abort/Complete，直到超时->返回情况给模型->解除占用
// Run生命周期!=present_artifact生命周期；present_artifact设计为=tool_call生命周期
// Run是跨进程的（其的设立=有该文件夹，其的结束=有该Outcome。无需各种持久化和复杂生命周期管理逻辑），但present_artifact是跨进程后无法恢复的，进程重启后ToolCall被自动补全为失败；由于Run的占用态也丢了而不会自然恢复，故也正好无需清理。这套连招神奇地达到了一个闭环，但得看看细节有没有坑

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
