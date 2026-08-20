// present_artifact 工具视图：主体跟随 Tool Call，Run 只作为该调用当前或最后一次呈现的附属事实

import {useEffect, useState} from 'react'
import type {ToolResultNode} from '@deepseek-ai/dsh-client-runtime/client'
import type {PresentToolViewProps} from './contract.ts'
import type {ArtifactRunDescriptor} from '../shared/api.ts'
import css from './PresentArtifactToolView.module.css'

type SettleOutcome = 'completed' | 'aborted' | 'timed-out' | 'interrupted' | 'error'

function resultTextOf(block: ToolResultNode): string {
    const parts: string[] = []
    for (const part of block.content) parts.push(part.type === 'text' ? part.text : JSON.stringify(part))
    return parts.join('\n')
}

function settleOutcomeOf(block: ToolResultNode): SettleOutcome {
    if (block.isError || block.error !== undefined) return block.error?.code === 'interrupted' ? 'interrupted' : 'error'
    try {
        const parsed = JSON.parse(resultTextOf(block)) as {outcome?: unknown}
        if (parsed.outcome === 'completed' || parsed.outcome === 'aborted' || parsed.outcome === 'timed-out' || parsed.outcome === 'interrupted') return parsed.outcome
    } catch {}
    return 'error'
}

function metaDescriptorOf(block: ToolResultNode): ArtifactRunDescriptor | null {
    const meta = block.meta
    if (meta === null || typeof meta !== 'object') return null
    const descriptor = meta as ArtifactRunDescriptor
    return descriptor.version === 2 && typeof descriptor.url === 'string' && typeof descriptor.runId === 'string' ? descriptor : null
}

const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups'

export function InBandPresentArtifactView({callId, block, cwd, t, resolveDescriptor, abortRun}: PresentToolViewProps) {
    const settled = 'kind' in block
    const outcome = settled ? settleOutcomeOf(block) : null
    const [liveDescriptor, setLiveDescriptor] = useState<ArtifactRunDescriptor | null>(null)
    const [fetchFailed, setFetchFailed] = useState(false)
    const [expanded, setExpanded] = useState(!settled)
    const [frameKey, setFrameKey] = useState(0)
    const [aborting, setAborting] = useState(false)
    const [manuallyAborted, setManuallyAborted] = useState(false)
    const descriptor = settled ? metaDescriptorOf(block) : liveDescriptor
    const runCanRemainActive = (!settled || outcome === 'timed-out' || outcome === 'interrupted') && !manuallyAborted

    useEffect(() => { if (settled) setExpanded(false) }, [settled])

    useEffect(() => {
        if (settled) return
        let cancelled = false
        let attempts = 0
        let timer: ReturnType<typeof setTimeout> | undefined

        const tick = async (): Promise<void> => {
            if (cancelled) return
            if (cwd === undefined || cwd === '') return setFetchFailed(true)
            const found = await resolveDescriptor(cwd, callId).catch(() => null)
            if (cancelled) return
            if (found !== null) return setLiveDescriptor(found)
            if (++attempts >= 30) return setFetchFailed(true)
            timer = setTimeout(() => void tick(), 400)
        }

        void tick()
        return () => {
            cancelled = true
            if (timer !== undefined) clearTimeout(timer)
        }
    }, [settled, cwd, callId, resolveDescriptor])

    const abort = async (): Promise<void> => {
        if (descriptor === null) return
        setAborting(true)
        try {
            await abortRun(descriptor)
            setManuallyAborted(true)
        } finally {
            setAborting(false)
        }
    }

    const settledStatus = !settled ? t('present.running') : outcome === 'completed' ? t('present.outcome.submitted') : outcome === 'aborted' ? '已放弃' : outcome === 'timed-out' ? t('present.outcome.timeout') : outcome === 'interrupted' ? t('present.outcome.interrupted') : t('present.outcome.error')
    const status = manuallyAborted ? `${settledStatus} · Run 已放弃` : settledStatus

    return (
        <div className={css.root} data-settled={settled || undefined} data-outcome={outcome ?? 'running'}>
            <div className={css.header}>
                <button type="button" className={css.summary} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><span className={css.chevron} aria-hidden="true">{expanded ? '▾' : '▸'}</span><span className={css.title}>{descriptor?.title ?? t('present.title')}</span><span className={css.sep} aria-hidden>·</span><span className={css.outcome}>{status}</span></button>
                <div className={css.actions}>
                    <button type="button" className={css.miniButton} disabled={descriptor === null || !runCanRemainActive} onClick={() => { if (descriptor !== null && runCanRemainActive) window.open(descriptor.url, '_blank', 'noopener') }}>{t('present.openExternal')}</button>
                    {runCanRemainActive && descriptor !== null && <button type="button" className={css.miniButton} disabled={aborting} onClick={() => void abort()}>{aborting ? '处理中' : '放弃'}</button>}
                    {expanded && descriptor !== null && runCanRemainActive && <button type="button" className={css.miniButton} onClick={() => setFrameKey(key => key + 1)}>{t('present.refresh')}</button>}
                    <button type="button" className={css.miniButton} onClick={() => setExpanded(value => !value)}>{expanded ? t('present.collapse') : t('present.expand')}</button>
                </div>
            </div>

            {expanded && descriptor !== null && runCanRemainActive && <div className={css.frameWrap}><div className={css.urlBar}><span className={css.urlLabel}>{t('present.url')}</span><span className={css.url}>{descriptor.url}</span></div><iframe key={frameKey} className={css.frame} src={descriptor.url} title={descriptor.title} sandbox={FRAME_SANDBOX} allow="clipboard-write"/></div>}
            {expanded && descriptor !== null && !runCanRemainActive && <div className={css.status}>本次 Run 已终结</div>}
            {expanded && descriptor === null && <div className={css.status}>{settled || fetchFailed ? t('present.unavailable') : t('present.preparing')}</div>}
        </div>
    )
}
