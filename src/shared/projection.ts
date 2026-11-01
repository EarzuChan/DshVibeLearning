import type {} from '@deepseek-ai/dsh-session-projection/types'

// 氛围学习会话投影的线缆值
export interface SessionDvlLearningState {
  readonly entered: boolean
  readonly activeOutlineId: string | null
  readonly delegatedFrom: string | null // 若本会话是学习会话派出的子代理，则为该学习根会话 ID
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    readonly dvlLearning: SessionDvlLearningState
  }

  interface SessionProjectionMap {
    readonly dvlLearning: SessionDvlLearningState
  }
}
