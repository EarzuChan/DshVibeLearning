/**
 * The learning view: one `conversation.view` list entry rendering three
 * sub-tabs (outlines / reviews / quizzes) over the learning domain state,
 * with a manual refresh button. 首次加载由生命周期控制器负责；本组件只消费
 * store，不再轮询
 * @module dvl/client/LearningView
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Button, IconRefreshOutline14, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LearningViewProps } from './contract.ts'
import type {
  ArtifactCategory, ArtifactDto, CardDto, LessonState, LearningStateDto, OutlineDto, OutlineNodeDto,
} from './types.ts'
import css from './LearningView.module.css'

/** One lesson-state badge label key. */
const STATE_KEY: Record<LessonState, 'lesson.state.notStarted' | 'lesson.state.learning' | 'lesson.state.qa' | 'lesson.state.done'> = {
  'not-started': 'lesson.state.notStarted',
  'learning': 'lesson.state.learning',
  'qa': 'lesson.state.qa',
  'done': 'lesson.state.done',
}

/** The three sub-tab ids (store currency). */
type Tab = 'outlines' | 'reviews' | 'quizzes'

/** Flatten one outline's node tree into indented rows（空串 parentId 视为根） */
function flattenNodes(nodes: readonly OutlineNodeDto[]): { node: OutlineNodeDto; depth: number }[] {
  const byParent = new Map<string | null, OutlineNodeDto[]>()
  for (const node of nodes) {
    const key = node.parentId === '' ? null : node.parentId
    const list = byParent.get(key)
    if (list === undefined) byParent.set(key, [node])
    else list.push(node)
  }
  const rows: { node: OutlineNodeDto; depth: number }[] = []
  const walk = (parentId: string | null, depth: number): void => {
    const children = (byParent.get(parentId) ?? []).slice().sort((a, b) => a.order - b.order)
    for (const child of children) {
      rows.push({ node: child, depth })
      if (child.kind === 'group') walk(child.id, depth + 1)
    }
  }
  walk(null, 0)
  return rows
}

/** Shared face threaded to row components (all read through props). */
interface ViewFace {
  t: LearningViewProps['t']
  openArtifact: (category: ArtifactCategory, hash: string) => void
  onPreview: (category: ArtifactCategory, hash: string) => void
  onInband: (category: ArtifactCategory, hash: string) => void
}

/** The outlines sub-tab body. */
function OutlinesTab({ state, t }: { state: LearningStateDto } & Pick<LearningViewProps, 't'>) {
  const outlines = state.outlines
  return (
    <div className={css.section}>
      {outlines.length === 0 && <div className={css.empty}>{t('outlines.empty')}</div>}
      {outlines.map(outline => <OutlineBlock key={outline.id} outline={outline} t={t} />)}
    </div>
  )
}

/** One outline header + its expandable node tree. */
function OutlineBlock({ outline, t }: { outline: OutlineDto } & Pick<LearningViewProps, 't'>) {
  const [expanded, setExpanded] = useState(outline.active)
  useEffect(() => { setExpanded(outline.active) }, [outline.active])
  const rows = useMemo(() => flattenNodes(outline.nodes), [outline.nodes])
  return (
    <div className={css.outline}>
      <button
        type="button"
        className={css.outlineHeader}
        aria-expanded={expanded}
        onClick={() => { setExpanded(v => !v) }}
      >
        <span className={css.outlineChevron} aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className={css.outlineTitle}>{outline.title}</span>
        {outline.active && <span className={css.badge}>{t('outlines.active')}</span>}
        <span className={css.outlineMeta}>{t('outlines.nodes', { n: outline.nodeCount })}</span>
      </button>
      {expanded && (
        <ul className={css.nodeList}>
          {rows.map(({ node, depth }) => (
            <li
              key={node.id}
              className={clsx(css.node, node.kind === 'group' && css.nodeGroup)}
              style={{ paddingLeft: `${12 + depth * 16}px` }}
            >
              <span className={css.nodeTitle}>{node.title}</span>
              {node.kind === 'lesson' && (
                <span className={clsx(css.stateBadge, css[`state_${node.state ?? 'not-started'}`])}>
                  {t(STATE_KEY[node.state ?? 'not-started'])}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The reviews / quizzes sub-tab: cards (reviews only) + artifact rows. */
function ArtifactsTab({
  kind, state, face,
}: {
  kind: 'reviews' | 'quizzes'
  state: LearningStateDto
  face: ViewFace
}) {
  const { t } = face
  const artifacts = kind === 'reviews' ? state.reviews : state.quizzes
  const cards = kind === 'reviews' ? state.cards : null
  return (
    <div className={css.section}>
      {cards !== null && (
        <>
          <h3 className={css.blockLabel}>{t('reviews.cards')}</h3>
          {cards.length === 0
            ? <div className={css.empty}>{t('reviews.emptyCards')}</div>
            : cards.map(card => <CardRow key={card.lessonId} card={card} t={t} />)}
        </>
      )}
      <h3 className={css.blockLabel}>{kind === 'reviews' ? t('reviews.artifacts') : t('tab.quizzes')}</h3>
      {artifacts.length === 0 && <div className={css.empty}>{t('reviews.emptyArtifacts')}</div>}
      {artifacts.map(artifact => (
        <ArtifactRow
          key={artifact.hash}
          artifact={artifact}
          category={kind === 'reviews' ? 'reviews' : 'quizzes'}
          face={face}
        />
      ))}
    </div>
  )
}

/** One due-review card row. */
function CardRow({ card, t }: { card: CardDto } & Pick<LearningViewProps, 't'>) {
  return (
    <div className={css.cardRow}>
      <span className={css.cardId}>{card.lessonId}</span>
      <span className={css.cardDue}>{card.due !== null ? t('reviews.due', { due: card.due }) : '—'}</span>
      <span className={css.cardHistory}>{t('reviews.historyCount', { n: card.history.length })}</span>
    </div>
  )
}

/** One artifact/lesson row with open / preview / in-band controls + run history. */
function ArtifactRow({ artifact, category, face }: { artifact: ArtifactDto; category: ArtifactCategory; face: ViewFace }) {
  const { t, openArtifact, onPreview, onInband } = face
  return (
    <div className={css.artifactBlock}>
      <div className={css.artifactRow}>
        <div className={css.artifactHead}>
          <span className={css.artifactTitle}>{artifact.meta.title}</span>
          <span className={css.metaBadge}>{t('artifact.runs', { n: artifact.runs.length })}</span>
        </div>
        <div className={css.artifactActions}>
          <Button size="sm" variant="outline" onClick={() => { openArtifact(category, artifact.hash) }}>
            {t('artifact.open')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => { onPreview(category, artifact.hash) }}>
            {t('artifact.preview')}
          </Button>
          <Button size="sm" variant="primary" onClick={() => { onInband(category, artifact.hash) }}>
            {t('artifact.inband')}
          </Button>
        </div>
      </div>
      {artifact.runs.length > 0 && (
        <ul className={css.runList}>
          {artifact.runs.map(run => (
            <li key={run.runId} className={css.runRow}>
              <span className={css.runId}>{run.runId}</span>
              {run.hasResult && <span className={css.metaBadge}>{t('artifact.run.result')}</span>}
              {run.hasFeedback && <span className={css.metaBadge}>{t('artifact.run.feedback')}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Render the learning view.
 * @param props - the four-shares composed props (runtime, store, inject face).
 * @returns the learning view tree.
 */
export function LearningView(props: LearningViewProps) {
  const { api, useLearning, useStore, actions, t, sessionId } = props
  const learning = useLearning(s => s.learning)
  const state = learning.state
  const tab = useStore(s => s.tab)
  const preview = useStore(s => s.preview)
  const presentRuns = useStore(s => s.presentRuns)
  const activePresentKeys = useMemo(
    () => new Set(Object.values(presentRuns).map(run => `${run.category}|${run.hash}`)),
    [presentRuns],
  )
  const [refreshing, setRefreshing] = useState(false)
  const [inbandTarget, setInbandTarget] = useState<{ category: ArtifactCategory; hash: string } | null>(null)

  // 手动刷新按钮：生命周期控制器负责首次加载，这里只在用户点击时重拉
  const refresh = useCallback(async () => {
    setRefreshing(true)
    try { await api.refresh() } finally { setRefreshing(false) }
  }, [api])

  const openArtifact = (category: ArtifactCategory, hash: string): void => { api.openArtifact(category, hash) }
  const onPreview = (category: ArtifactCategory, hash: string): void => {
    // An actively-presented run owns this artifact's surface; suppress the
    // conflicting manual read-only preview.
    if (activePresentKeys.has(`${category}|${hash}`)) return
    actions.setPreview(
      preview !== null && preview.hash === hash && preview.category === category ? null : { category, hash },
    )
  }
  const onInband = (category: ArtifactCategory, hash: string): void => { setInbandTarget({ category, hash }) }
  const face: ViewFace = { t, openArtifact, onPreview, onInband }

  const closeInband = (): void => { setInbandTarget(null) }
  const confirmInband = async (targetSessionId: string): Promise<void> => {
    if (inbandTarget === null) return
    const target = inbandTarget
    try {
      await api.inbandPresent(target.category, target.hash, targetSessionId)
    } finally {
      setInbandTarget(null)
    }
  }

  return (
    <div className={css.frame}>
      <header className={css.toolbar}>
        <nav className={css.tabs} role="tablist" aria-label={t('view.label')}>
          {([['outlines', 'tab.outlines'], ['reviews', 'tab.reviews'], ['quizzes', 'tab.quizzes']] as const).map(([id, labelKey]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={clsx(css.tab, tab === id && css.tabActive)}
              onClick={() => { actions.setTab(id as Tab) }}
            >
              {t(labelKey)}
            </button>
          ))}
        </nav>
        <Button size="sm" variant="ghost" icon={<IconRefreshOutline14 />} disabled={refreshing} onClick={() => { void refresh() }}>
          {refreshing ? t('toolbar.refreshing') : t('toolbar.refresh')}
        </Button>
      </header>

      <div className={css.body}>
        {learning.phase === 'error'
          ? <div className={css.status}>{t('state.error')}</div>
          : state === null
            ? <div className={css.status}>{t('state.loading')}</div>
            : tab === 'outlines'
              ? <OutlinesTab state={state} t={t} />
              : tab === 'reviews'
                ? <ArtifactsTab kind="reviews" state={state} face={face} />
                : <ArtifactsTab kind="quizzes" state={state} face={face} />}
      </div>

      {preview !== null && (
        <div className={css.preview}>
          <div className={css.previewHeader}>
            <span className={css.previewLabel}>{preview.category}</span>
            <Button size="sm" variant="ghost" onClick={() => { actions.setPreview(null) }}>
              {t('artifact.previewClose')}
            </Button>
          </div>
          <iframe
            className={css.previewFrame}
            src={api.artifactUrl(preview.category, preview.hash)}
            title={t('artifact.preview')}
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
            allow="clipboard-write"
          />
        </div>
      )}

      <Modal
        open={inbandTarget !== null}
        onClose={closeInband}
        closeLabel={t('notes.cancel')}
        title={t('artifact.inband.dialog.title')}
        footer={(
          <>
            <Button variant="outline" onClick={closeInband}>{t('notes.cancel')}</Button>
            <Button variant="primary" onClick={() => { void confirmInband(String(sessionId)) }}>{t('artifact.inband.current')}</Button>
            <Button variant="outline" onClick={() => { void confirmInband('') }}>{t('artifact.inband.new')}</Button>
          </>
        )}
      >
        <p className={css.inbandHint}>
          {t('artifact.inband.current')} · {t('artifact.inband.new')}
        </p>
      </Modal>
    </div>
  )
}
