import type {ArtifactCategory, ArtifactKind} from './artifacts.ts'
import type {ArtifactMeta, ArtifactRunSummary, Note, NoteFolder, Outline, OutlineNode, ReviewRecord} from './model.ts'

// 服务端签发的规范展示描述符
export interface PresentArtifactDescriptor {
  readonly version: 1
  readonly callId: string
  readonly workspaceId: string
  readonly kind: ArtifactKind
  readonly category: ArtifactCategory
  readonly hash: string
  readonly targetId: string
  readonly title: string
  readonly runId: string
  readonly url: string
}

// 学习状态响应中的单个纲目
export interface OutlineDto extends Pick<Outline, 'id' | 'title' | 'createdAt' | 'updatedAt'> {
  readonly nodeCount: number
  readonly nodes: readonly OutlineNode[]
}

// 学习状态响应中的单个 FSRS 复习卡片
export interface CardDto {
  readonly lessonId: string
  readonly due: string | null
  readonly history: readonly ReviewRecord[]
}

// 学习状态响应中的单个已创作工件
export interface ArtifactDto {
  readonly hash: string
  readonly meta: ArtifactMeta
  readonly runs: readonly ArtifactRunSummary[]
}

// 笔记接口响应
export interface NotesDto {
  readonly folders: readonly NoteFolder[]
  readonly notes: readonly Note[]
}

// 学习状态接口响应
export interface LearningStateDto {
  readonly workspaceId: string
  readonly cwd: string
  readonly learningDirExists: boolean
  readonly outlines: readonly OutlineDto[]
  readonly cards: readonly CardDto[]
  readonly lessons: readonly ArtifactDto[]
  readonly reviews: readonly ArtifactDto[]
  readonly quizzes: readonly ArtifactDto[]
  readonly notes: NotesDto
}

// 工作区存在性探测接口响应
export interface LearningWorkspaceDto {
  readonly cwd: string
  readonly isLearningWorkspace: boolean
}

// 带内展示接口请求
export interface InbandPresentRequest {
  readonly workspaceId: string
  readonly category: ArtifactCategory
  readonly hash: string
  readonly sessionId: string
}

// 带内展示接口响应
export interface InbandPresentResult {
  readonly ok: boolean
  readonly mode: 'current-session' | 'new-session'
  readonly sessionId: string
  readonly error?: string
}
