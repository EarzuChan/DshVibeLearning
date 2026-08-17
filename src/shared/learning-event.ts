// 学习处境进入标记的唯一真源：借用官方 `feedback/record` 事件（text 带本包命名空间前缀）
// 作为本会话「真正进入过学习处境」的单向阀——官方事件保证不入模型上下文/派生历史、且在加载白名单内，重开会话不再拒载
// 只有真正的进入入口（/learn、/learn <outline-id>、学习面板新开会话）才会写下它，eview/quiz 子命令只是查询/复习指令，永远不写，故标记语义天然精确

import type { SessionEvent } from '@deepseek-ai/dsh-session'

// 类型合并：让 `session.append('feedback/record', …)` 与事件判定在编译期可见
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'feedback/record': { text: string } // 本包进入标记借用的官方事件：仅占用 text 字段，语义见 dvl/shared/learning-event
  }
}

// 进入标记的 text 前缀（`@` 后为进入时间戳），本包内检测一律以此为准
export const LEARNING_ENTERED_PREFIX = 'dvl://learning/entered'

// 事件是否为学习处境进入标记（类型守卫：通过后事件收窄为 feedback/record）
export function isLearningEntered(event: SessionEvent): event is SessionEvent<'feedback/record'> {
  return event.type === 'feedback/record'
    && typeof event.data.text === 'string'
    && event.data.text.startsWith(LEARNING_ENTERED_PREFIX)
}

// 构造进入标记的 text 载荷
export function learningEnteredText(at: string): string {
  return `${LEARNING_ENTERED_PREFIX}@${at}`
}

// 从标记 text 解出进入时间戳，无 `@` 时间戳时返回 null
export function learningEnteredAt(text: string): string | null {
  return text.startsWith(`${LEARNING_ENTERED_PREFIX}@`) ? text.slice(LEARNING_ENTERED_PREFIX.length + 1) : null
}