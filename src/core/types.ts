import type {ArtifactKind} from '../shared/artifacts.ts'
import type {LessonState, ReviewRating, ReviewRecord} from '../shared/model.ts'

// 一次工件展示或作答尝试
export interface ArtifactRun {
  readonly runId: string
  readonly artifactHash: string
  readonly kind: ArtifactKind
  readonly targetId: string
  readonly callId: string
  readonly createdAt: string
}

// 不透明提交结果的机制信封
export interface ResultEnvelope {
  readonly kind: ArtifactKind
  readonly targetId: string
  readonly artifactHash: string
  readonly runId: string
  readonly submittedAt: string
  readonly payload: unknown
}

// 不透明判阅报告的机制信封
export interface FeedbackEnvelope {
  readonly kind: ArtifactKind
  readonly targetId: string
  readonly artifactHash: string
  readonly runId: string
  readonly savedAt: string
  readonly payload: unknown
}

// 持久化 FSRS 卡片文件
export interface CardFile {
  readonly lessonId: string
  readonly card: Record<string, unknown>
  readonly history: ReviewRecord[]
}

// 带内展示结束结果
export type PresentOutcome = {readonly kind: 'result'; readonly result: ResultEnvelope} | {readonly kind: 'no-result'; readonly reason: 'interrupted' | 'timeout' | 'error'; readonly detail?: string}

// 复习计划确认写入前的候选
export interface ReviewPlanProposal {
  readonly lessonId: string
  readonly rating: ReviewRating
  readonly sourceRunId: string
  readonly reason?: string
  readonly current: CardFile | null
  readonly nextCard: Record<string, unknown>
  readonly due: string
  readonly alreadyApplied: boolean
}

// 每轮快照注入的单个纲目信息
export interface SnapshotOutline {
  readonly id: string
  readonly title: string
  readonly active: boolean
}

// 每轮快照注入的当前课程信息
export interface SnapshotLesson {
  readonly id: string
  readonly title: string
  readonly state: LessonState
}

// 每轮快照注入的到期复习信息
export interface SnapshotCard {
  readonly lessonId: string
  readonly lessonTitle: string
  readonly due: string
  readonly state: string
  readonly overdue: boolean
}

// 每轮注入的完整学习状态快照
export interface LearningSnapshot {
  readonly workspaceId: string
  readonly learningDirExists: boolean
  readonly activeOutlineId: string | null
  readonly outlines: SnapshotOutline[]
  readonly currentLessons: SnapshotLesson[]
  readonly dueCards: SnapshotCard[]
}
