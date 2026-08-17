/**
 * The floating "current outline" card in the session header utilities slot:
 * 仅学习会话显示（dvlLearning projection），数据只读学习域——
 * idle/loading 显示加载中，error 显示失败
 * @module dvl/client/OutlineCard
 */
import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OutlineCardProps } from './contract.ts'
// Type-only：拉入 dvlLearning 键（useProjection 的类型表）
import type {} from './projection-types.ts'
import type { OutlineNodeDto } from './types.ts'
import css from './OutlineCard.module.css'

/** The lesson-state labels for the current-course highlight. */
const CURRENT_STATE: Record<'learning' | 'qa', 'lesson.state.learning' | 'lesson.state.qa'> = {
  learning: 'lesson.state.learning',
  qa: 'lesson.state.qa',
}

/** Flatten the active outline's lesson nodes in walk order（空串 parentId 视为根） */
function lessonNodes(nodes: readonly OutlineNodeDto[]): OutlineNodeDto[] {
  const byParent = new Map<string | null, OutlineNodeDto[]>()
  for (const node of nodes) {
    const key = node.parentId === '' ? null : node.parentId
    const list = byParent.get(key)
    if (list === undefined) byParent.set(key, [node])
    else list.push(node)
  }
  const lessons: OutlineNodeDto[] = []
  const walk = (parentId: string | null): void => {
    for (const child of (byParent.get(parentId) ?? []).slice().sort((a, b) => a.order - b.order)) {
      if (child.kind === 'lesson') lessons.push(child)
      else walk(child.id)
    }
  }
  walk(null)
  return lessons
}

/**
 * Render the collapsible outline card.
 * @param props - runtime + store + locale shares.
 * @returns the card tree.
 */
export function OutlineCard({ useLearning, useProjection, t }: OutlineCardProps) {
  const learning = useLearning(s => s.learning)
  const projection = useProjection('dvlLearning')
  const [expanded, setExpanded] = useState(false)

  const active = useMemo(() => {
    const state = learning.state
    if (state === null) return null
    const outline = state.outlines.find(o => o.id === state.activeOutlineId) ?? state.outlines.find(o => o.active) ?? null
    if (outline === null) return null
    return { outline, lessons: lessonNodes(outline.nodes) }
  }, [learning.state])

  // 非学习会话：整体不渲染
  if (projection?.entered !== true) return null

  return (
    <div className={css.card}>
      <button
        type="button"
        className={css.header}
        aria-expanded={expanded}
        onClick={() => { setExpanded(v => !v) }}
      >
        <span className={css.title}>{t('card.outline.title')}</span>
        <IconChevronDownOutline14 className={clsx(css.chevron, expanded && css.chevronOpen)} />
      </button>
      {expanded && (
        <div className={css.body}>
          {learning.phase === 'error'
            ? <div className={css.empty}>{t('state.error')}</div>
            : learning.phase !== 'ready'
              ? <div className={css.empty}>{t('state.loading')}</div>
              : active === null
                ? <div className={css.empty}>{t('card.outline.empty')}</div>
                : (
                  <ul className={css.list}>
                    {active.lessons.map((lesson) => {
                      const current = lesson.state === 'learning' || lesson.state === 'qa'
                      return (
                        <li
                          key={lesson.id}
                          className={clsx(css.lesson, current && css.lessonCurrent)}
                        >
                          <span className={css.lessonTitle}>{lesson.title}</span>
                          {current && (
                            <span className={css.currentBadge}>
                              {t(CURRENT_STATE[lesson.state as 'learning' | 'qa'])}
                            </span>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
        </div>
      )}
    </div>
  )
}
