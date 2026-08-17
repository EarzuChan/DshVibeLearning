/**
 * DVL 学习模式 session projection：把 `learning/entered` 单向阀折叠成
 * `dvlLearning` 键的整值投影，供客户端（useProjection）与宿主 reconcile 消费
 * @module dvl/learning/projection
 */

import { z } from 'zod'
// 拉入 Context merge（sessionProjections 服务）与投影类型表（augmentation 目标）
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 投影键 `dvlLearning` 的线缆值 */
export interface DvlLearningProjection {
  readonly entered: boolean
  readonly enteredAt: string | null
}

// 类型表合并：客户端 useProjection('dvlLearning') 的键由此声明
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 学习模式单向阀：由 learning/entered 事件折叠 */
    dvlLearning: DvlLearningProjection
  }
}

/** 线缆值校验 schema */
export const dvlLearningSchema = z.object({
  entered: z.boolean(),
  enteredAt: z.string().nullable(),
})

/** 折叠状态（entered 后不再变化） */
interface FoldState {
  readonly entered: boolean
  readonly enteredAt: string | null
}

/** 单向折叠：entered 一旦为真永远为真，后续同型事件无操作 */
export const dvlLearningProjection = {
  key: 'dvlLearning' as const,
  schema: dvlLearningSchema,
  stateVersion: 1,
  init(): FoldState {
    return { entered: false, enteredAt: null }
  },
  apply(state: FoldState, event: SessionEvent): FoldState {
    if (state.entered) return state
    if (event.type !== 'learning/entered') return state

    const at = typeof (event.data as { at?: unknown } | undefined)?.at === 'string'
      ? (event.data as { at: string }).at
      : ''
    return { entered: true, enteredAt: at === '' ? null : at }
  },
  view(state: FoldState): DvlLearningProjection {
    return { entered: state.entered, enteredAt: state.enteredAt }
  },
}
