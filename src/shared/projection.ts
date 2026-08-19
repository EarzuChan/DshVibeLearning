import type {} from '@deepseek-ai/dsh-session-projection/types'

// 氛围学习会话投影的线缆值
export interface SessionDvlLearningState {
  readonly entered: boolean
  readonly activeOutlineId: string | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    readonly dvlLearning: SessionDvlLearningState
  }
}
