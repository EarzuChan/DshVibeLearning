/**
 * The floating "current outline" card in the session header utilities slot:
 * a collapsible header that expands to the active outline's full lesson list,
 * with the current lesson (state `learning`/`qa`) highlighted and labeled.
 * Read-only — data arrives through the store seat, verbs through the inject
 * face.
 * @module dvl/client/OutlineCard
 */
import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { OutlineCardProps } from './contract.ts'
import type { LessonState, OutlineNodeDto } from './types.ts'
import css from './OutlineCard.module.css'

/** The lesson-state labels for the current-course highlight. */
const CURRENT_STATE: Record<'learning' | 'qa', 'lesson.state.learning' | 'lesson.state.qa'> = {
  learning: 'lesson.state.learning',
  qa: 'lesson.state.qa',
}

/** Flatten the active outline's lesson nodes in walk order (groups ignored). */
function lessonNodes(nodes: readonly OutlineNodeDto[]): OutlineNodeDto[] {
  const byParent = new Map<string | null, OutlineNodeDto[]>()
  for (const node of nodes) {
    const list = byParent.get(node.parentId)
    if (list === undefined) byParent.set(node.parentId, [node])
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
export function OutlineCard({ useStore, t }: OutlineCardProps) {
  const state = useStore(s => s.learningState)
  const [expanded, setExpanded] = useState(false)

  const active = useMemo(() => {
    if (state === null) return null
    const outline = state.outlines.find(o => o.id === state.activeOutlineId) ?? state.outlines.find(o => o.active) ?? null
    if (outline === null) return null
    return { outline, lessons: lessonNodes(outline.nodes) }
  }, [state])

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
          {active === null
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
