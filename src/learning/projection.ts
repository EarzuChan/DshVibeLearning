/**
 * DVL 学习处境 session projection：把借用的官方 feedback/record 进入标记折叠成
 * `dvlLearning` 键的整值投影，供客户端（useProjection）与宿主 reconcile 消费
 * @module dvl/learning/projection
 */

// TODO：以上的文件还没翻看（这句于主人而言，不关LLM的事儿这一句）

import { z } from 'zod'
// 拉入 Context merge（sessionProjections 服务）与投影类型表（augmentation 目标）
import '@deepseek-ai/dsh-session-projection'
import '@deepseek-ai/dsh-session-projection/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isLearningEntered, learningEnteredAt } from '../shared/learning-event.ts'

/** 投影键 `dvlLearning` 的线缆值 */
export interface DvlLearningProjection {
  readonly entered: boolean
  readonly enteredAt: string | null
}

// 类型表合并：客户端 useProjection('dvlLearning') 的键由此声明
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 学习处境单向阀：由借用的官方 feedback/record 进入标记折叠 */
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
    if (!isLearningEntered(event)) return state
    return { entered: true, enteredAt: learningEnteredAt(event.data.text) }
  },
  view(state: FoldState): DvlLearningProjection {
    return { entered: state.entered, enteredAt: state.enteredAt }
  },
}
