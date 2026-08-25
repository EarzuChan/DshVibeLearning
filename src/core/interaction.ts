import {randomUUID} from 'node:crypto'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {InteractionContent, InteractionOption, PendingInteractionDto} from '../shared/api.ts'

export type InteractionEvent = {readonly type: 'requested'; readonly interaction: PendingInteractionDto} | {readonly type: 'resolved'; readonly interactionId: string} | {readonly type: 'cleared'; readonly interactionId: string}
type Listener = (sessionId: string, event: InteractionEvent) => void

// 我们的 Interaction——未来允许自定义展示、全局窗口、不让跳过...如果未来官方更新了这些，那我们的可以未来退休了。这个是个"艰难时刻"自用的infra

interface PendingInteraction {
    readonly interaction: PendingInteractionDto
    readonly resolve: (optionId: string) => void
    readonly reject: (error: Error) => void
    readonly abort: () => void
    readonly signal?: AbortSignal
}

export interface InteractionRequest {
    readonly agent: Agent
    readonly title: string
    readonly content: InteractionContent
    readonly options: readonly InteractionOption[]
    readonly signal?: AbortSignal
}

export class InteractionService {
    private readonly pending = new Map<string, PendingInteraction>()
    private readonly listeners = new Set<Listener>()

    async ask(request: InteractionRequest): Promise<string> {
        if (request.signal?.aborted === true) throw new Error('交互已中止')
        if (request.options.length === 0) throw new Error('交互必须至少提供一个选项')

        const interaction: PendingInteractionDto = {id: randomUUID(), sessionId: String(request.agent.session.id), title: request.title, content: request.content, options: request.options}
        const result = new Promise<string>((resolve, reject) => {
            const abort = (): void => {
                this.pending.delete(interaction.id)
                this.emit(interaction.sessionId, {type: 'cleared', interactionId: interaction.id})
                reject(new Error('交互已中止'))
            }
            this.pending.set(interaction.id, {interaction, resolve, reject, abort, signal: request.signal})
            if (request.signal !== undefined) request.signal.addEventListener('abort', abort, {once: true})
        })

        this.emit(interaction.sessionId, {type: 'requested', interaction})
        return result
    }

    pendingFor(sessionId: string): readonly PendingInteractionDto[] {
        return [...this.pending.values()].filter(item => item.interaction.sessionId === sessionId).map(item => item.interaction)
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    respond(interactionId: string, sessionId: string, optionId: string): void {
        const pending = this.pending.get(interactionId)
        if (pending === undefined || pending.interaction.sessionId !== sessionId) throw new Error('交互不存在或已结束')
        if (!pending.interaction.options.some(option => option.id === optionId)) throw new Error('交互选项无效')
        this.pending.delete(interactionId)
        pending.signal?.removeEventListener('abort', pending.abort)
        pending.resolve(optionId)
        this.emit(sessionId, {type: 'resolved', interactionId})
    }

    private emit(sessionId: string, event: InteractionEvent): void {
        for (const listener of this.listeners) listener(sessionId, event)
    }
}
