import type {} from '@deepseek-ai/dsh-session-projection/types'

// 氛围学习会话投影的线缆值
export interface DvlLearningProjection {
  readonly entered: boolean
  readonly enteredAt: string | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    readonly dvlLearning: DvlLearningProjection
  }
}
