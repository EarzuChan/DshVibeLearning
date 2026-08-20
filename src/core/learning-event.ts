// 氛围学习会话事件的唯一事件入口：事件构造与追加只允许发生在本文件，外部不得直接触碰官方 feedback/record 载荷

import type {Session, SessionEvent} from '@deepseek-ai/dsh-session'

// 借用官方'feedback/record'事件来当我们的事件载体
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'feedback/record': { text: string }
    }
}

// ---入---

const LEARNING_ENTERED_TEXT = 'learning/enter'

// 记录当前会话进入氛围学习
export function recordLearningEnteredToSession(session: Session): void {
    session.append('feedback/record', {text: LEARNING_ENTERED_TEXT})
}

// 事件是否为氛围学习进入标记
export function isLearningEntered(event: SessionEvent): boolean {
    return event.type === 'feedback/record' && event.data.text === LEARNING_ENTERED_TEXT
}

// ---纲---

const CHANGE_OUTLINE_PREFIX = 'learning/change-outline:'

// 记录当前会话激活纲目的切换。null 表示明确没有激活纲目
export function recordLearningOutlineChangeToSession(session: Session, outlineId: string | null): void {
    session.append('feedback/record', {text: `${CHANGE_OUTLINE_PREFIX}${outlineId ?? 'null'}`})
}

// 从事件中解析当前会话激活纲目
export function parseLearningChangeOutline(event: SessionEvent): string | null | undefined {
    if (event.type !== 'feedback/record' || !event.data.text.startsWith(CHANGE_OUTLINE_PREFIX)) return undefined // 非我事件

    const value = event.data.text.slice(CHANGE_OUTLINE_PREFIX.length)
    return value === 'null' ? null : value
}
