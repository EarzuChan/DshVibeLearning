/**
 * The keyed `present_artifact` toolview. Running: an auto-expanded responsive
 * iframe over the server-issued canonical run URL (fetched by `cwd + callId`).
 * Settled: a collapsed one-line record (submitted / timeout / interrupted /
 * error) that can be manually re-expanded to review the artifact via the
 * durable presentation metadata. The iframe never closes on its own network
 * state — only the durable `tool/result` collapses it.
 * @module dvl/client/PresentArtifactToolView
 */

import { useEffect, useState } from 'react'
import type { ToolCallBlock, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import type { PresentToolViewProps } from './contract.ts'
import type { ArtifactCategory, PresentArtifactDescriptorDto } from './types.ts'
import css from './PresentArtifactToolView.module.css'

/** How a settled present reads from its durable block. */
type SettleOutcome = 'submitted' | 'timeout' | 'interrupted' | 'error'

/** Join a settled result's content blocks into display text. */
function resultTextOf(block: ToolResultNode): string {
  const parts: string[] = []
  for (const part of block.content) {
    if (part.type === 'text') parts.push(part.text)
    else parts.push(JSON.stringify(part))
  }
  return parts.join('\n')
}

/** Classify a settled present from its durable result node. */
function settleOutcomeOf(block: ToolResultNode): SettleOutcome {
  if (block.isError || block.error !== undefined) {
    return block.error?.code === 'interrupted' ? 'interrupted' : 'error'
  }
  const text = resultTextOf(block)
  if (text !== '') {
    try {
      const parsed = JSON.parse(text) as { kind?: unknown; reason?: unknown }
      if (parsed !== null && typeof parsed === 'object') {
        if (parsed.kind === 'result') return 'submitted'
        if (parsed.kind === 'no-result') {
          if (parsed.reason === 'timeout') return 'timeout'
          if (parsed.reason === 'interrupted') return 'interrupted'
        }
      }
    } catch {
      // fall through
    }
  }
  return 'error'
}

/** Narrow the durable result meta to a canonical descriptor (or null). */
function metaDescriptorOf(block: ToolResultNode): PresentArtifactDescriptorDto | null {
  const meta = block.meta
  if (meta === null || typeof meta !== 'object') return null
  const descriptor = meta as PresentArtifactDescriptorDto
  if (typeof descriptor.url === 'string' && typeof descriptor.runId === 'string') return descriptor
  return null
}

/** The fixed responsive iframe sandbox (same-origin bridge preserved). */
const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups'

/**
 * Render the `present_artifact` toolview.
 * @param props - runtime (owner) + store + inject + locale shares.
 * @returns the toolview tree.
 */
export function PresentArtifactToolView(props: PresentToolViewProps) {
  const { callId, block, cwd, t, actions, resolveDescriptor } = props
  const settled = 'kind' in block
  const outcome: SettleOutcome | null = settled ? settleOutcomeOf(block) : null
  const metaDescriptor: PresentArtifactDescriptorDto | null = settled ? metaDescriptorOf(block) : null

  const [liveDescriptor, setLiveDescriptor] = useState<PresentArtifactDescriptorDto | null>(null)
  const [fetchFailed, setFetchFailed] = useState(false)
  const [expanded, setExpanded] = useState(!settled)
  const [frameKey, setFrameKey] = useState(0)

  const descriptor = settled ? metaDescriptor : liveDescriptor

  // Collapse the iframe the moment the durable tool/result lands.
  useEffect(() => {
    if (settled) setExpanded(false)
  }, [settled])

  // While running, resolve the canonical descriptor from the server by
  // `cwd + callId` (retry until the tool has created the run).
  useEffect(() => {
    if (settled) return
    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      if (cancelled) return
      if (cwd === undefined || cwd === '') {
        setFetchFailed(true)
        return
      }
      const found = await resolveDescriptor(cwd, callId).catch(() => null)
      if (cancelled) return
      if (found !== null) {
        setLiveDescriptor(found)
        actions.observePresentRun(callId, {
          category: found.category as ArtifactCategory,
          hash: found.hash,
          runId: found.runId,
        })
        return
      }
      attempts += 1
      if (attempts >= 30) {
        setFetchFailed(true)
        return
      }
      timer = setTimeout(() => { void tick() }, 400)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [settled, cwd, callId, resolveDescriptor, actions])

  // A settled present no longer occupies the live-run registry.
  useEffect(() => {
    if (settled) actions.forgetPresentRun(callId)
  }, [settled, callId, actions])

  const openExternal = (): void => {
    if (descriptor !== null) window.open(descriptor.url, '_blank', 'noopener')
  }

  const outcomeLabel = settled
    ? outcome === 'submitted' ? t('present.outcome.submitted')
      : outcome === 'timeout' ? t('present.outcome.timeout')
        : outcome === 'interrupted' ? t('present.outcome.interrupted')
          : t('present.outcome.error')
    : t('present.running')

  const title = descriptor?.title ?? t('present.title')

  return (
    <div className={css.root} data-settled={settled || undefined} data-outcome={outcome ?? 'running'}>
      <div className={css.header}>
        <button
          type="button"
          className={css.summary}
          aria-expanded={expanded}
          onClick={() => { setExpanded(v => !v) }}
        >
          <span className={css.chevron} aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          <span className={css.title}>{title}</span>
          <span className={css.sep} aria-hidden>·</span>
          <span className={css.outcome}>{outcomeLabel}</span>
        </button>
        <div className={css.actions}>
          <button type="button" className={css.miniButton} disabled={descriptor === null} onClick={openExternal}>
            {t('present.openExternal')}
          </button>
          {expanded && descriptor !== null && (
            <button type="button" className={css.miniButton} onClick={() => { setFrameKey(k => k + 1) }}>
              {t('present.refresh')}
            </button>
          )}
          <button type="button" className={css.miniButton} onClick={() => { setExpanded(v => !v) }}>
            {expanded ? t('present.collapse') : t('present.expand')}
          </button>
        </div>
      </div>

      {expanded && descriptor !== null && (
        <div className={css.frameWrap}>
          <div className={css.urlBar}>
            <span className={css.urlLabel}>{t('present.url')}</span>
            <span className={css.url}>{descriptor.url}</span>
          </div>
          <iframe
            key={frameKey}
            className={css.frame}
            src={descriptor.url}
            title={descriptor.title}
            sandbox={FRAME_SANDBOX}
            allow="clipboard-write"
          />
        </div>
      )}

      {expanded && descriptor === null && (
        <div className={css.status}>
          {settled || fetchFailed ? t('present.unavailable') : t('present.preparing')}
        </div>
      )}
    </div>
  )
}
