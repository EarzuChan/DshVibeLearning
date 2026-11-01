// 氛围学习会话记录的唯一入口：记录的构造、追加与解析只允许发生在本文件，其他地方不直接触碰会话日志

import {z} from 'zod'
import {appendPluginRecord, pluginRecordOf, type Session, type SessionEvent} from '@deepseek-ai/dsh-session'

// 采用 DSH 的插件记录（带 ignorable 标记的 `plugin:` 命名空间事件）：不认识它的构建会保留并跳过，卸载本插件也不会让会话无法加载
const ENTER = 'plugin:dsh-vibe-learning/enter'
const CHANGE_OUTLINE = 'plugin:dsh-vibe-learning/change-outline'
const DELEGATE = 'plugin:dsh-vibe-learning/delegate'

declare module '@deepseek-ai/dsh-session/types' {
    interface PluginRecordMap {
        /** 本会话进入氛围学习 */
        'plugin:dsh-vibe-learning/enter': Record<string, never>
        /** 本会话激活纲目的切换，null 表示明确没有激活纲目 */
        'plugin:dsh-vibe-learning/change-outline': {readonly outlineId: string | null}
        /** 本会话是某个学习会话派出的子代理，只负责创作工件 */
        'plugin:dsh-vibe-learning/delegate': {readonly rootSessionId: string}
    }
}

// 已存记录的载荷可能来自旧构建，使用前一律校验
const changeOutlineSchema = z.object({outlineId: z.string().min(1).nullable()})
const delegateSchema = z.object({rootSessionId: z.string().min(1)})

// ---入---

// 记录当前会话进入氛围学习
export function recordLearningEnteredToSession(session: Session): void {
    appendPluginRecord(session, ENTER, {})
}

// 事件是否为氛围学习进入记录
export function isLearningEntered(event: SessionEvent): boolean {
    return pluginRecordOf(event)?.type === ENTER
}

// ---纲---

// 记录当前会话激活纲目的切换
export function recordLearningOutlineChangeToSession(session: Session, outlineId: string | null): void {
    appendPluginRecord(session, CHANGE_OUTLINE, {outlineId})
}

// 从事件中解析当前会话激活纲目；undefined 表示非我记录或载荷无效
export function parseLearningChangeOutline(event: SessionEvent): string | null | undefined {
    const record = pluginRecordOf(event)
    if (record?.type !== CHANGE_OUTLINE) return undefined

    const parsed = changeOutlineSchema.safeParse(record.data)
    return parsed.success ? parsed.data.outlineId : undefined
}

// ---子代理---

// 记录当前会话是学习会话派出的子代理
export function recordLearningDelegateToSession(session: Session, rootSessionId: string): void {
    appendPluginRecord(session, DELEGATE, {rootSessionId})
}

// 从事件中解析子代理所属的学习根会话；undefined 表示非我记录或载荷无效
export function parseLearningDelegate(event: SessionEvent): string | undefined {
    const record = pluginRecordOf(event)
    if (record?.type !== DELEGATE) return undefined

    const parsed = delegateSchema.safeParse(record.data)
    return parsed.success ? parsed.data.rootSessionId : undefined
}
