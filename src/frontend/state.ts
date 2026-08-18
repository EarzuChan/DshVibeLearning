import type {LearningStateDto, NotesDto} from '../shared/api.ts'

// 加载域四态
export type LoadPhase = 'idle' | 'loading' | 'ready' | 'error'

// 当前工作区的学习状态与加载相位
export interface LearningDomain {
  readonly phase: LoadPhase
  readonly state: LearningStateDto | null
  readonly isLearningWorkspace: boolean
  readonly error: string | null
}

// 全局笔记与加载相位
export interface NotesDomain {
  readonly phase: LoadPhase
  readonly notes: NotesDto | null
  readonly error: string | null
}
