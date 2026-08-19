// keyed present_artifact 工具视图：运行时展示服务端签发的规范 run URL，结束后折叠为可重新展开的一行记录

import {useEffect, useState} from 'react'
import type {ToolResultNode} from '@deepseek-ai/dsh-client-runtime/client'
import type {PresentToolViewProps} from './contract.ts'
import type {PresentArtifactDescriptor} from '../shared/api.ts'
import css from './PresentArtifactToolView.module.css'

// present_artifact 结束后的四种状态
type SettleOutcome = 'submitted' | 'timeout' | 'interrupted' | 'error'

// 将持久化结果中的所有内容块拼成展示文本
function resultTextOf(block: ToolResultNode): string {
  const parts: string[] = []
  for (const part of block.content) {
    if (part.type === 'text') parts.push(part.text)
    else parts.push(JSON.stringify(part))
  }

  return parts.join('\n')
}

// 从持久化结果节点判断 present_artifact 的结束状态
function settleOutcomeOf(block: ToolResultNode): SettleOutcome {
  if (block.isError || block.error !== undefined) return block.error?.code === 'interrupted' ? 'interrupted' : 'error'

  const text = resultTextOf(block)
  if (text !== '') {
    try {
      const parsed = JSON.parse(text) as {kind?: unknown; reason?: unknown}

      if (parsed !== null && typeof parsed === 'object') {
        if (parsed.kind === 'result') return 'submitted'

        if (parsed.kind === 'no-result') {
          if (parsed.reason === 'timeout') return 'timeout'
          if (parsed.reason === 'interrupted') return 'interrupted'
        }
      }
    } catch {}
  }

  return 'error'
}

// 从持久化结果 meta 中提取规范展示描述符，不合法时返回 null
function metaDescriptorOf(block: ToolResultNode): PresentArtifactDescriptor | null {
  const meta = block.meta
  if (meta === null || typeof meta !== 'object') return null

  const descriptor = meta as PresentArtifactDescriptor
  if (typeof descriptor.url === 'string' && typeof descriptor.runId === 'string') return descriptor
  return null
}

// iframe 固定 sandbox 配置，保留同源桥接能力
const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups'

// 渲染 present_artifact 工具视图
export function InBandPresentArtifactView(props: PresentToolViewProps) {
  const {callId, block, cwd, t, actions, resolveDescriptor} = props
  const settled = 'kind' in block
  const outcome: SettleOutcome | null = settled ? settleOutcomeOf(block) : null
  const metaDescriptor: PresentArtifactDescriptor | null = settled ? metaDescriptorOf(block) : null

  const [liveDescriptor, setLiveDescriptor] = useState<PresentArtifactDescriptor | null>(null)
  const [fetchFailed, setFetchFailed] = useState(false)
  const [expanded, setExpanded] = useState(!settled)
  const [frameKey, setFrameKey] = useState(0)

  const descriptor = settled ? metaDescriptor : liveDescriptor

  // 持久化 tool/result 一到就立即折叠 iframe
  useEffect(() => { if (settled) setExpanded(false) }, [settled])

  // 运行期间通过 cwd + callId 从服务端轮询规范展示描述符，直到 run 创建完成
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
        actions.observePresentRun(callId, {category: found.category, hash: found.hash, runId: found.runId})
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

  // 已结束的 present 不再占用实时 run 注册表
  useEffect(() => { if (settled) actions.forgetPresentRun(callId) }, [settled, callId, actions])

  const openExternal = (): void => { if (descriptor !== null) window.open(descriptor.url, '_blank', 'noopener') }
  const outcomeLabel = settled ? outcome === 'submitted' ? t('present.outcome.submitted') : outcome === 'timeout' ? t('present.outcome.timeout') : outcome === 'interrupted' ? t('present.outcome.interrupted') : t('present.outcome.error') : t('present.running')
  const title = descriptor?.title ?? t('present.title')

  return (
      <div className={css.root} data-settled={settled || undefined} data-outcome={outcome ?? 'running'}>
        <div className={css.header}>
          <button type="button" className={css.summary} aria-expanded={expanded} onClick={() => { setExpanded(v => !v) }}>
            <span className={css.chevron} aria-hidden="true">{expanded ? '▾' : '▸'}</span>
            <span className={css.title}>{title}</span>
            <span className={css.sep} aria-hidden>·</span>
            <span className={css.outcome}>{outcomeLabel}</span>
          </button>

          <div className={css.actions}>
            <button type="button" className={css.miniButton} disabled={descriptor === null} onClick={openExternal}>{t('present.openExternal')}</button>
            {expanded && descriptor !== null && <button type="button" className={css.miniButton} onClick={() => { setFrameKey(k => k + 1) }}>{t('present.refresh')}</button>}
            <button type="button" className={css.miniButton} onClick={() => { setExpanded(v => !v) }}>{expanded ? t('present.collapse') : t('present.expand')}</button>
          </div>
        </div>

        {expanded && descriptor !== null && (
            <div className={css.frameWrap}>
              <div className={css.urlBar}>
                <span className={css.urlLabel}>{t('present.url')}</span>
                <span className={css.url}>{descriptor.url}</span>
              </div>
              <iframe key={frameKey} className={css.frame} src={descriptor.url} title={descriptor.title} sandbox={FRAME_SANDBOX} allow="clipboard-write" />
            </div>
        )}

        {expanded && descriptor === null && <div className={css.status}>{settled || fetchFailed ? t('present.unavailable') : t('present.preparing')}</div>}
      </div>
  )
}
