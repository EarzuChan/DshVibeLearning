// 氛围学习会话事件的唯一事件入口：事件构造与追加只允许发生在本文件，其他地方不直接触碰事件相关

import type {Session, SessionEvent} from '@deepseek-ai/dsh-session'

// 借用官方'feedback/record'事件来当我们的真事件“外壳”。为什么要这样？因为目前自定义事件会被，即使是`0.1.1-rc.2`，在重开会话时“吃拿卡要”（会话被判有误，拒绝进一步加载）
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'feedback/record': { text: string } // text的内容，是届时我们真正的“事件”
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
