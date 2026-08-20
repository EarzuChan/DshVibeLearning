// 会话头部工具区的当前纲目浮动卡片，仅学习会话显示，只读学习域状态

import {useMemo, useState} from 'react'
import clsx from 'clsx'
import {IconChevronDownOutline14} from '@deepseek-ai/dsh-client-ui-primitives'
import type {OutlineCardProps} from './contract.ts'
import type {} from '../shared/projection.ts'
import type {OutlineNode} from '../shared/model.ts'
import css from './OutlineCard.module.css'

// 当前课程状态对应的显示标签
const CURRENT_STATE: Record<'learning' | 'qa', 'lesson.state.learning' | 'lesson.state.qa'> = {learning: 'lesson.state.learning', qa: 'lesson.state.qa'}

// 按遍历顺序展开激活纲目的课程节点，空 parentId 视为根节点
function lessonNodes(nodes: readonly OutlineNode[]): OutlineNode[] {
  const byParent = new Map<string | null, OutlineNode[]>()

  for (const node of nodes) {
    const key = node.parentId === '' ? null : node.parentId
    const list = byParent.get(key)
    if (list === undefined) byParent.set(key, [node])
    else list.push(node)
  }

  const lessons: OutlineNode[] = []
  const walk = (parentId: string | null): void => {
    for (const child of (byParent.get(parentId) ?? []).slice().sort((a, b) => a.order - b.order)) if (child.kind === 'lesson') lessons.push(child)
    else walk(child.id)
  }

  walk(null)
  return lessons
}

// 渲染可折叠的当前纲目卡片
export function OutlineCard({useLearning, useProjection, t}: OutlineCardProps) {
  const learning = useLearning(s => s.learning)
  const projection = useProjection('dvlLearning')
  const [expanded, setExpanded] = useState(false)

  // 活跃纲目：反应式派生而来
  const activeOutline = useMemo(() => {
    const state = learning.data

    if (state === null) return null
    if (projection?.entered !== true) return null

    const outline = projection === undefined ? null : state.outlines.find(o => o.id === projection.activeOutlineId) ?? null

    // TIPS：activeOutlineId 由投影即时更新；但新建的大纲的数据列表仍依赖 /state 刷新。如模型先 update 再 activate，激活指针立刻能变，但怕大纲详情尚未进入前端 learningSource

    if (outline === null) return null

    return {outline, lessons: lessonNodes(outline.nodes)}
  }, [learning.data, projection])

  // 未进入学习：不渲染
  if (projection?.entered !== true) return null

  return (
      <div className={css.card}>
        <button type="button" className={css.header} aria-expanded={expanded} onClick={() => { setExpanded(v => !v) }}>
          <span className={css.title}>{t('card.outline.title')}</span>
          <IconChevronDownOutline14 className={clsx(css.chevron, expanded && css.chevronOpen)} />
        </button>

        {expanded && (
            <div className={css.body}>
              {learning.phase === 'error' ? <div className={css.empty}>{t('state.error')}</div> : learning.phase !== 'ready' ? <div className={css.empty}>{t('state.loading')}</div> : activeOutline === null ? <div className={css.empty}>{t('card.outline.empty')}</div> : (
                  <ul className={css.list}>
                    {activeOutline.lessons.map(lesson => {
                      const current = lesson.state === 'learning' || lesson.state === 'qa'
                      return (
                          <li key={lesson.id} className={clsx(css.lesson, current && css.lessonCurrent)}>
                            <span className={css.lessonTitle}>{lesson.title}</span>
                            {current && <span className={css.currentBadge}>{t(CURRENT_STATE[lesson.state as 'learning' | 'qa'])}</span>}
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
