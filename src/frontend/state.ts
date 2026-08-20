import type {LearningDataDto, NotesDto} from '../shared/api.ts'

// 加载域四态
export type LoadPhase = 'idle' | 'loading' | 'ready' | 'error'

// 当前工作区的学习状态与加载相位
export interface WorkspaceDomain {
  readonly cwd: string | null
  readonly workspaceId: string | null
  readonly isLearningWorkspace: boolean
}

// 学习工作区内容数据与加载相位
export interface LearningDomain {
  readonly phase: LoadPhase
  readonly data: LearningDataDto | null
  readonly error: string | null
}

// 全局笔记与加载相位
export interface NotesDomain {
  readonly phase: LoadPhase
  readonly notes: NotesDto | null
  readonly error: string | null
}

// 工作区域数据源快照
export type WorkspaceSourceState = { readonly workspace: WorkspaceDomain }

// 学习域数据源快照
export type LearningSourceState = { readonly learning: LearningDomain }

// 笔记域数据源快照
export type NotesSourceState = { readonly notes: NotesDomain }
