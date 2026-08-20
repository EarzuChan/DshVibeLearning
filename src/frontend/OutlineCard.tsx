// 会话头部当前纲目卡：显隐只由会话 projection 决定，内容只读学习工作区快照

import {useMemo, useState} from 'react'
import clsx from 'clsx'
import {IconChevronDownOutline14} from '@deepseek-ai/dsh-client-ui-primitives'
import type {OutlineCardProps} from './contract.ts'
import type {} from '../shared/projection.ts'
import type {OutlineLessonNode, OutlineNode} from '../shared/model.ts'
import css from './OutlineCard.module.css'

function lessonNodes(nodes: readonly OutlineNode[]): OutlineLessonNode[] {
    const lessons: OutlineLessonNode[] = []
    for (const node of nodes) {
        if (node.kind === 'lesson') lessons.push(node)
        else lessons.push(...lessonNodes(node.children))
    }
    return lessons
}

export function OutlineCard({useLearning, useProjection, t}: OutlineCardProps) {
    const learning = useLearning(source => source.learning)
    const projection = useProjection('dvlLearning')
    const [expanded, setExpanded] = useState(false)

    const active = useMemo(() => {
        if (learning.data === null || projection?.entered !== true || projection.activeOutlineId === null) return null
        const outline = learning.data.outlines.find(candidate => candidate.id === projection.activeOutlineId) ?? null
        return outline === null ? null : {outline, lessons: lessonNodes(outline.tree)}
    }, [learning.data, projection])

    if (projection?.entered !== true) return null

    return (
        <div className={css.card}>
            <button type="button" className={css.header} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
                <span className={css.title}>{t('card.outline.title')}</span>
                <IconChevronDownOutline14 className={clsx(css.chevron, expanded && css.chevronOpen)}/>
            </button>

            {expanded && <div className={css.body}>{learning.phase === 'error' ? <div className={css.empty}>{t('state.error')}</div> : learning.phase !== 'ready' ? <div className={css.empty}>{t('state.loading')}</div> : active === null ? <div className={css.empty}>{t('card.outline.empty')}</div> : <ul className={css.list}>{active.lessons.map(lesson => {
                const current = active.outline.workflow.currentLessonId === lesson.id
                const completed = active.outline.workflow.completedLessonIds.includes(lesson.id)
                return <li key={lesson.id} className={clsx(css.lesson, current && css.lessonCurrent)}><span className={css.lessonTitle}>{lesson.title}</span>{current && <span className={css.currentBadge}>{active.outline.workflow.phase === 'qa' ? '答疑中' : '学习中'}</span>}{completed && <span className={css.currentBadge}>已完成</span>}</li>
            })}</ul>}</div>}
        </div>
    )
}
