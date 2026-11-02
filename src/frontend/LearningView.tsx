// 学习视图：只呈现后端学习快照并发送原子命令，不在前端维护第二套业务状态

import {useCallback, useMemo, useState} from 'react'
import clsx from 'clsx'
import {Button, IconRefreshOutlineMedium, Modal} from '@deepseek-ai/dsh-client-ui-primitives'
import type {LearningViewProps} from './contract.ts'
import type {ArtifactCategory} from '../shared/artifacts.ts'
import type {LearningDataDto, PanelOutlineMode} from '../shared/api.ts'
import type {ArtifactSummary, Outline, OutlineNode, ReviewPlan, ReviewPlanRound} from '../shared/model.ts'
import css from './LearningView.module.css'

type Tab = 'outlines' | 'reviews' | 'quizzes'
type InbandTarget = {kind: 'artifact'; category: ArtifactCategory; artifactId: string; runId?: string} | {kind: 'due-review'; planId: string}

// 会话内呈现对话框：先选会话；目标会话激活着别的大纲时再问怎么处理
type InbandDialog = {stage: 'session'; target: InbandTarget} | {stage: 'outline'; target: InbandTarget; activeOutlineTitle: string; ownerOutlineTitle: string}

interface ViewFace {
    t: LearningViewProps['t']
    api: LearningViewProps['api']
    onPreview: (category: ArtifactCategory, artifactId: string) => void
    onRun: (category: ArtifactCategory, artifactId: string, runId: string) => void
    onInband: (category: ArtifactCategory, artifactId: string, runId?: string) => void
}

// 会话内呈现的目标归属哪个大纲：课程看绑定，复习看计划或临时期次，小测与游离工件无归属
function ownerOutlineIdOf(data: LearningDataDto, target: InbandTarget): string | null {
    if (target.kind === 'due-review') return data.reviewPlans.find(plan => plan.id === target.planId)?.outlineId ?? null
    if (target.category === 'lessons') return data.outlines.find(outline => Object.values(outline.artifactBindings).includes(target.artifactId))?.id ?? null
    if (target.category === 'quizzes') return null

    const plan = data.reviewPlans.find(item => item.rounds.some(round => round.artifactId === target.artifactId))
    return plan?.outlineId ?? data.temporaryReviews.rounds.find(round => round.artifactId === target.artifactId)?.outlineId ?? null
}

function flattenNodes(nodes: readonly OutlineNode[], depth = 0): Array<{node: OutlineNode; depth: number}> {
    const rows: Array<{node: OutlineNode; depth: number}> = []
    for (const node of nodes) {
        rows.push({node, depth})
        if (node.kind === 'group') rows.push(...flattenNodes(node.children, depth + 1))
    }
    return rows
}

function workflowLabel(outline: Outline): string {
    if (outline.workflow.phase === 'not-started') return '未开始'
    if (outline.workflow.phase === 'completed') return '已完成'
    return outline.workflow.phase === 'learning' ? '学习中' : '答疑中'
}

function artifactOf(artifacts: readonly ArtifactSummary[], artifactId?: string): ArtifactSummary | null {
    return artifactId === undefined ? null : artifacts.find(artifact => artifact.artifactId === artifactId) ?? null
}

function ArtifactBlock({artifact, category, face, deletable = false}: {artifact: ArtifactSummary; category: ArtifactCategory; face: ViewFace; deletable?: boolean}) {
    const {t, api, onPreview, onRun, onInband} = face
    const [creating, setCreating] = useState(false)
    const activeRuns = artifact.runs.filter(run => run.state === 'active')
    const hasInband = activeRuns.some(run => run.inBandSessionId !== undefined)

    const createRun = async (): Promise<void> => {
        setCreating(true)
        try {
            const descriptor = await api.createDirectRun(category, artifact.artifactId)
            onRun(category, artifact.artifactId, descriptor.runId)
        } finally {
            setCreating(false)
        }
    }

    return (
        <div className={css.artifactBlock}>
            <div className={css.artifactRow}>
                <div className={css.artifactHead}>
                    <span className={css.artifactTitle}>{artifact.title}</span>
                    <span className={css.metaBadge}>{t('artifact.runs', {n: artifact.runs.length})}</span>
                    <span className={css.outlineMeta}>{new Date(artifact.modifiedAt).toLocaleString()}</span>
                </div>
                <div className={css.artifactActions}>
                    <Button size="sm" variant="outline" onClick={() => onPreview(category, artifact.artifactId)}>{t('artifact.preview')}</Button>
                    {activeRuns.length === 0 && <Button size="sm" variant="outline" disabled={creating} onClick={() => void createRun()}>{creating ? t('state.loading') : '直接作答'}</Button>}
                    {activeRuns.length === 0 && <Button size="sm" variant="primary" onClick={() => onInband(category, artifact.artifactId)}>{t('artifact.inband')}</Button>}
                    {deletable && <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`确定删除工件「${artifact.title}」及其全部作答吗？`)) void api.deleteArtifact(category, artifact.artifactId) }}>删除</Button>}
                </div>
            </div>

            {artifact.runs.length === 0 ? <div className={css.empty}>{t('artifact.run.empty')}</div> : (
                <ul className={css.runList}>
                    {artifact.runs.map(run => (
                        <li key={run.runId} className={css.runRow}>
                            <span className={css.runId}>{run.runId}</span>
                            <span className={css.metaBadge}>{run.state === 'active' ? '进行中' : run.state === 'completed' ? '已完成' : '已放弃'}</span>
                            <span className={css.outlineMeta}>{new Date(run.modifiedAt).toLocaleString()}</span>
                            {run.hasFeedback && <span className={css.metaBadge}>{t('artifact.run.feedback')}</span>}
                            {run.inBandSessionId !== undefined && <span className={css.metaBadge}>会话内 · {api.sessionTitle(run.inBandSessionId) ?? run.inBandSessionId.slice(0, 8)}</span>}
                            {run.state === 'active' && run.inBandSessionId === undefined && <Button size="sm" variant="outline" onClick={() => onRun(category, artifact.artifactId, run.runId)}>继续作答</Button>}
                            {run.state === 'active' && run.inBandSessionId === undefined && !hasInband && <Button size="sm" variant="primary" onClick={() => onInband(category, artifact.artifactId, run.runId)}>交给会话来继续</Button>}
                            {run.state === 'active' && <Button size="sm" variant="ghost" onClick={() => void api.abortRun(category, artifact.artifactId, run.runId)}>放弃</Button>}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

function OutlineBlock({outline, state, active, face}: {outline: Outline; state: LearningDataDto; active: boolean; face: ViewFace}) {
    const [expanded, setExpanded] = useState(active)
    const rows = useMemo(() => flattenNodes(outline.tree), [outline.tree])

    return (
        <div className={css.outline}>
            <div className={css.outlineHeader}>
                <button type="button" className={css.outlineToggle} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><span className={css.outlineChevron} aria-hidden="true">{expanded ? '▾' : '▸'}</span><span className={css.outlineTitle}>{outline.title}</span>{active && <span className={css.badge}>{face.t('outlines.active')}</span>}<span className={css.outlineMeta}>{workflowLabel(outline)}</span></button>
                <Button size="sm" variant="ghost" onClick={event => { event.stopPropagation(); if (window.confirm(`确定删除纲目「${outline.title}」及其独占附属工件吗？`)) void face.api.deleteOutline(outline.id) }}>删除</Button>
            </div>

            {expanded && (
                <div className={css.outlineBody}>
                    <ul className={css.nodeList}>
                        {rows.map(({node, depth}) => {
                            const current = node.kind === 'lesson' && outline.workflow.currentLessonId === node.id
                            const completed = node.kind === 'lesson' && outline.workflow.completedLessonIds.includes(node.id)
                            const artifact = node.kind === 'lesson' ? artifactOf(state.lessons, outline.artifactBindings[node.id]) : null
                            return (
                                <li key={node.id} className={clsx(css.node, node.kind === 'group' && css.nodeGroup)} style={{paddingLeft: `${12 + depth * 16}px`}}>
                                    <div className={css.nodeLine}>
                                        <span className={css.nodeTitle}>{node.title}</span>
                                        {current && <span className={css.stateBadge}>{workflowLabel(outline)}</span>}
                                        {completed && <span className={css.metaBadge}>已完成</span>}
                                    </div>
                                    {artifact !== null && <ArtifactBlock artifact={artifact} category="lessons" face={face}/>}
                                </li>
                            )
                        })}
                    </ul>
                </div>
            )}
        </div>
    )
}

function OutlinesTab({state, activeOutlineId, face}: {state: LearningDataDto; activeOutlineId: string | null; face: ViewFace}) {
    const orphans = state.lessons.filter(artifact => state.orphanLessonIds.includes(artifact.artifactId))
    return (
        <div className={css.section}>
            {state.outlines.length === 0 && <div className={css.empty}>{face.t('outlines.empty')}</div>}
            {state.outlines.map(outline => <OutlineBlock key={outline.id} outline={outline} state={state} active={outline.id === activeOutlineId} face={face}/>)}
            {orphans.length > 0 && <h3 className={css.blockLabel}>游离课程工件</h3>}
            {orphans.map(artifact => <ArtifactBlock key={artifact.artifactId} artifact={artifact} category="lessons" face={face} deletable/>)}
        </div>
    )
}

function activeRound(plan: ReviewPlan): ReviewPlanRound | null {
    return plan.rounds.find(round => round.state === 'active') ?? null
}

function ReviewPlanBlock({plan, face, onStart}: {plan: ReviewPlan; face: ViewFace; onStart: (planId: string) => void}) {
    const round = activeRound(plan)
    const dueAt = String(plan.card.due)
    const due = round === null && !Number.isNaN(Date.parse(dueAt)) && Date.parse(dueAt) <= Date.now()
    return <div className={css.artifactBlock}><div className={css.cardRow}><span className={css.cardId}>{plan.lessonId}</span><span className={css.cardHistory}>{plan.rounds.filter(item => item.state === 'completed').length} 次已完成</span><span className={css.cardDue}>{round !== null ? `进行中 · ${round.id}` : due ? '已到期' : `计划于 ${new Date(dueAt).toLocaleString()}`}</span>{round === null && due && <Button size="sm" variant="primary" onClick={() => onStart(plan.id)}>开始复习</Button>}<Button size="sm" variant="outline" onClick={() => { if (window.confirm('删除计划并把历史工件转入临时复习区吗？')) void face.api.deleteReviewPlan(plan.id, true) }}>保留工件并删除计划</Button><Button size="sm" variant="ghost" onClick={() => { if (window.confirm('删除计划及其独占历史工件吗？')) void face.api.deleteReviewPlan(plan.id, false) }}>全部删除</Button></div><ul className={css.runList}>{plan.rounds.map(item => <li key={item.id} className={css.runRow}><span className={css.runId}>{item.id}</span><span className={css.outlineMeta}>{new Date(item.startedAt).toLocaleString()}</span><span className={css.metaBadge}>{item.state === 'active' ? '进行中' : '已完成'}</span>{item.artifactId !== undefined && <span className={css.metaBadge}>工件 {item.artifactId}</span>}{item.completedAt !== undefined && <span className={css.outlineMeta}>{new Date(item.completedAt).toLocaleString()}</span>}</li>)}</ul></div>
}

function ReviewsTab({state, face, onStart}: {state: LearningDataDto; face: ViewFace; onStart: (planId: string) => void}) {
    const temporary = new Set(state.temporaryReviews.rounds.flatMap(item => item.artifactId === undefined ? [] : [item.artifactId]))
    const temporaryArtifacts = state.reviews.filter(artifact => temporary.has(artifact.artifactId))
    const planned = new Set(state.reviewPlans.flatMap(plan => plan.rounds.flatMap(round => round.artifactId === undefined ? [] : [round.artifactId])))
    const unexplained = state.reviews.filter(artifact => !temporary.has(artifact.artifactId) && !planned.has(artifact.artifactId))

    return (
        <div className={css.section}>
            <h3 className={css.blockLabel}>复习计划</h3>
            {state.reviewPlans.length === 0 && <div className={css.empty}>暂无复习计划</div>}
            {state.reviewPlans.map(plan => <ReviewPlanBlock key={plan.id} plan={plan} face={face} onStart={onStart}/>)}
            <h3 className={css.blockLabel}>计划期次工件</h3>
            {state.reviewPlans.flatMap(plan => plan.rounds).flatMap(round => round.artifactId === undefined ? [] : state.reviews.filter(artifact => artifact.artifactId === round.artifactId)).map(artifact => <ArtifactBlock key={artifact.artifactId} artifact={artifact} category="reviews" face={face}/>)}
            <h3 className={css.blockLabel}>临时复习</h3>
            {state.temporaryReviews.rounds.length > 0 && <ul className={css.runList}>{state.temporaryReviews.rounds.map(round => <li key={round.id} className={css.runRow}><span className={css.runId}>{round.id}</span><span className={css.outlineMeta}>{round.lessonId}</span><span className={css.metaBadge}>{round.artifactId === undefined ? '待生成工件' : '已绑定工件'}</span>{round.artifactId !== undefined && <span className={css.metaBadge}>{round.artifactId}</span>}</li>)}</ul>}
            {temporaryArtifacts.length === 0 && <div className={css.empty}>暂无临时复习</div>}
            {temporaryArtifacts.map(artifact => <ArtifactBlock key={artifact.artifactId} artifact={artifact} category="reviews" face={face} deletable/>)}
            {unexplained.length > 0 && <h3 className={css.blockLabel}>未挂载复习工件</h3>}
            {unexplained.map(artifact => <ArtifactBlock key={artifact.artifactId} artifact={artifact} category="reviews" face={face} deletable/>)}
        </div>
    )
}

export function LearningView(props: LearningViewProps) {
    const {api, useLearning, useProjection, useStore, actions, t, sessionId} = props
    const learning = useLearning(source => source.learning)
    const projection = useProjection('dvlLearning') ?? {entered: false, activeOutlineId: null, delegatedFrom: null}
    const tab = useStore(state => state.tab)
    const preview = useStore(state => state.preview)
    const [refreshing, setRefreshing] = useState(false)
    const [dialog, setDialog] = useState<InbandDialog | null>(null)
    const setInbandTarget = (target: InbandTarget | null): void => setDialog(target === null ? null : {stage: 'session', target})
    const allArtifacts = learning.data === null ? [] : [...learning.data.lessons, ...learning.data.reviews, ...learning.data.quizzes]
    const currentSessionHasInband = allArtifacts.some(artifact => artifact.runs.some(run => run.inBandSessionId === String(sessionId)))

    const refresh = useCallback(async (): Promise<void> => {
        setRefreshing(true)
        try {
            await api.refresh()
        } finally {
            setRefreshing(false)
        }
    }, [api])

    const onPreview = (category: ArtifactCategory, artifactId: string): void => actions.setPreview(preview?.category === category && preview.artifactId === artifactId && preview.runId === undefined ? null : {category, artifactId})
    const onRun = (category: ArtifactCategory, artifactId: string, runId: string): void => actions.setPreview({category, artifactId, runId})
    const face: ViewFace = {t, api, onPreview, onRun, onInband: (category, artifactId, runId) => setInbandTarget({kind: 'artifact', category, artifactId, ...(runId === undefined ? {} : {runId})})}

    const deliver = async (target: InbandTarget, targetSessionId: string, mode: PanelOutlineMode): Promise<void> => {
        setDialog(null)

        if (target.kind === 'artifact') await api.inbandPresentExisting(target.category, target.artifactId, targetSessionId, mode, target.runId)
        else await api.startDueReview(target.planId, targetSessionId, mode)
    }

    // 选了当前会话且它激活着别的大纲时，先问用户怎么处理；其余情况由后端在没有激活大纲时自动激活
    const chooseSession = (targetSessionId: string): void => {
        if (dialog === null || learning.data === null) return

        const ownerOutlineId = ownerOutlineIdOf(learning.data, dialog.target)
        const titleOf = (id: string): string => learning.data?.outlines.find(outline => outline.id === id)?.title ?? id
        const mismatched = targetSessionId === String(sessionId) && ownerOutlineId !== null && projection.activeOutlineId !== null && projection.activeOutlineId !== ownerOutlineId

        if (mismatched) setDialog({stage: 'outline', target: dialog.target, activeOutlineTitle: titleOf(projection.activeOutlineId as string), ownerOutlineTitle: titleOf(ownerOutlineId)})
        else void deliver(dialog.target, targetSessionId, 'auto')
    }

    // 最近推进所属大纲的会话，作为推荐项
    const recommended = useMemo(() => {
        if (dialog === null || learning.data === null) return null

        const ownerOutlineId = ownerOutlineIdOf(learning.data, dialog.target)
        const writer = learning.data.outlines.find(outline => outline.id === ownerOutlineId)?.lastWriterSessionId ?? null
        if (writer === null || writer === String(sessionId)) return null

        const title = api.sessionTitle(writer)
        return title === null ? null : {sessionId: writer, title}
    }, [dialog, learning.data, sessionId, api])

    const paneRun = preview?.runId === undefined ? null : allArtifacts.find(artifact => artifact.artifactId === preview.artifactId)?.runs.find(run => run.runId === preview.runId) ?? null
    const paneUrl = preview === null ? null : preview.runId === undefined ? api.artifactUrl(preview.category, preview.artifactId) : api.runUrl(preview.category, preview.artifactId, preview.runId)
    const paneLabel = preview?.runId === undefined ? '只读预览' : paneRun?.state === 'active' ? '作答中' : '本次作答已结束'

    return (
        <div className={css.frame}>
            <header className={css.toolbar}>
                <nav className={css.tabs} role="tablist" aria-label={t('view.label')}>
                    {([['outlines', 'tab.outlines'], ['reviews', 'tab.reviews'], ['quizzes', 'tab.quizzes']] as const).map(([id, key]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={clsx(css.tab, tab === id && css.tabActive)} onClick={() => actions.setTab(id as Tab)}>{t(key)}</button>)}
                </nav>
                <Button size="sm" variant="ghost" icon={<IconRefreshOutlineMedium/>} disabled={refreshing} onClick={() => void refresh()}>{refreshing ? t('toolbar.refreshing') : t('toolbar.refresh')}</Button>
            </header>

            <div className={css.body}>
                {learning.phase === 'error' ? <div className={css.status}>{learning.error ?? t('state.error')}</div> : learning.phase === 'idle' ? <div className={css.status}>{t('state.idle')}</div> : learning.data === null ? <div className={css.status}>{t('state.loading')}</div> : tab === 'outlines' ? <OutlinesTab state={learning.data} activeOutlineId={projection.activeOutlineId} face={face}/> : tab === 'reviews' ? <ReviewsTab state={learning.data} face={face} onStart={planId => setInbandTarget({kind: 'due-review', planId})}/> : <div className={css.section}>{learning.data.quizzes.length === 0 && <div className={css.empty}>暂无小测工件</div>}{learning.data.quizzes.map(artifact => <ArtifactBlock key={artifact.artifactId} artifact={artifact} category="quizzes" face={face} deletable/>)}</div>}
            </div>

            {preview !== null && paneUrl !== null && (
                <div className={css.preview}>
                    <div className={css.previewHeader}>
                        <span className={css.previewLabel}>{paneLabel}</span>
                        <span className={css.previewActions}>
                            <Button size="sm" variant="ghost" disabled={preview.runId !== undefined && paneRun?.state !== 'active'} onClick={() => window.open(paneUrl, '_blank', 'noopener')}>在外部打开</Button>
                            <Button size="sm" variant="ghost" onClick={() => actions.setPreview(null)}>{t('artifact.previewClose')}</Button>
                        </span>
                    </div>
                    <iframe key={paneUrl} className={css.previewFrame} src={paneUrl} title={paneLabel} sandbox="allow-scripts allow-forms allow-modals allow-popups" allow="clipboard-write"/>
                </div>
            )}

            <Modal open={dialog?.stage === 'session'} onClose={() => setDialog(null)} closeLabel={t('notes.cancel')} title={t('artifact.inband.dialog.title')} footer={<><Button variant="outline" onClick={() => setDialog(null)}>{t('notes.cancel')}</Button>{recommended !== null && <Button variant="outline" onClick={() => chooseSession(recommended.sessionId)}>{`推荐：${recommended.title}`}</Button>}<Button variant="primary" disabled={currentSessionHasInband} onClick={() => chooseSession(String(sessionId))}>{t('artifact.inband.current')}</Button><Button variant="outline" onClick={() => chooseSession('')}>{t('artifact.inband.new')}</Button></>}><p className={css.inbandHint}>{currentSessionHasInband ? '当前会话已有正在进行的会话内呈现，可改用其他会话' : '选择由哪个会话的模型来呈现、批改并跟进'}{recommended !== null && `。「${recommended.title}」最近推进过所属大纲`}</p></Modal>

            {dialog?.stage === 'outline' && <Modal open onClose={() => setDialog(null)} closeLabel={t('notes.cancel')} title="当前会话激活着另一个大纲" footer={<><Button variant="outline" onClick={() => setDialog(null)}>取消这次会话内呈现</Button><Button variant="outline" onClick={() => void deliver(dialog.target, String(sessionId), 'keep')}>{dialog.target.kind === 'artifact' ? '仅回看（不切换）' : '不切换，直接开始'}</Button><Button variant="primary" onClick={() => void deliver(dialog.target, String(sessionId), 'switch')}>{dialog.target.kind === 'artifact' ? '切换并呈现' : '切换大纲并开始复习'}</Button></>}><p className={css.inbandHint}>{`当前会话激活的是「${dialog.activeOutlineTitle}」，而${dialog.target.kind === 'artifact' ? '该工件' : '该复习'}属于「${dialog.ownerOutlineTitle}」。切换后模型会按「${dialog.ownerOutlineTitle}」的进度跟进；不切换则${dialog.target.kind === 'artifact' ? '只作回看，不改变学习进度' : '照常复习，但会话的激活大纲保持不变'}。`}</p></Modal>}
        </div>
    )
}
