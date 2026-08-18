import type {ArtifactKind} from './artifacts.ts'

// 单个课程节点的学习进度状态
export type LessonState = 'not-started' | 'learning' | 'qa' | 'done'

// 纲目树中的一个节点，group 可嵌套，lesson 为叶子课程
export interface OutlineNode {
  readonly id: string
  readonly kind: 'group' | 'lesson'
  readonly title: string
  readonly order: number
  readonly parentId: string | null
  readonly lessonId?: string
  readonly state?: LessonState
  readonly artifactHash?: string
  readonly description?: string
}

// 持久化纲目文件
export interface Outline {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly nodes: OutlineNode[]
}

// 单个工件的元数据
export interface ArtifactMeta {
  readonly kind: ArtifactKind
  readonly targetId: string
  readonly title: string
  readonly createdAt: string
}

// 工件下展示的一次运行摘要
export interface ArtifactRunSummary {
  readonly runId: string
  readonly createdAt: string
  readonly hasResult: boolean
  readonly hasFeedback: boolean
}

// 笔记访问权限
export type NoteAccess = 'private' | 'readable' | 'readwrite'

// 笔记文件夹
export interface NoteFolder {
  readonly id: string
  readonly name: string
  readonly createdAt: string
}

// 一条全局存储的笔记
export interface Note {
  readonly id: string
  readonly folderId: string
  readonly title: string
  readonly markdown: string
  readonly tags: readonly string[]
  readonly access: NoteAccess
  readonly createdAt: string
  readonly updatedAt: string
}

// 笔记数据库
export interface NotesDb {
  readonly folders: NoteFolder[]
  readonly notes: Note[]
}

// 模型完成一次判阅后明确给出的 FSRS 评级
export type ReviewRating = 'again' | 'hard' | 'good' | 'easy'

// 一次已完成的复习记录
export interface ReviewRecord {
  readonly at: string
  readonly rating: ReviewRating
  readonly sourceRunId: string
  readonly reason?: string
}
