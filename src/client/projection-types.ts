/**
 * 客户端侧的 dvlLearning 投影类型合并——与 src/learning/projection.ts 声明
 * 同一键（declaration merging 同表）；本文件只做类型，供 client tsconfig 拉入
 * @module dvl/client/projection-types
 */

import type {} from '@deepseek-ai/dsh-session-projection/types'

/** 投影键 `dvlLearning` 的线缆值（与 host 侧定义保持一致） */
export interface DvlLearningProjection {
  readonly entered: boolean
  readonly enteredAt: string | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 学习处境单向阀：由借用的官方 feedback/record 进入标记折叠 */
    dvlLearning: DvlLearningProjection
  }
}
