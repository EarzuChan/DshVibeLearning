// DVL 的持久业务模型。业务实体持有工件，工件与 Run 不反向声明归属

import type {ArtifactHash, ArtifactTarget} from './artifacts.ts'

export type OutlinePhase = 'not-started' | 'learning' | 'qa' | 'completed'

export interface OutlineWorkflow {
  readonly phase: OutlinePhase
  readonly currentLessonId: string | null
  readonly completedLessonIds: readonly string[]
}

export interface OutlineGroupNode {
  readonly id: string
  readonly kind: 'group'
  readonly title: string
  readonly description?: string
  readonly children: readonly OutlineNode[]
}

export interface OutlineLessonNode {
  readonly id: string
  readonly kind: 'lesson'
  readonly title: string
  readonly description?: string
}

export type OutlineNode = OutlineGroupNode | OutlineLessonNode

export type OutlineArtifactBindings = Readonly<Record<string, string>>

export interface Outline {
  readonly id: string
  readonly title: string
  readonly tree: readonly OutlineNode[]
  readonly artifactBindings: OutlineArtifactBindings
  readonly workflow: OutlineWorkflow
}

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy'

export type FsrsCard = Record<string, unknown>

export interface ReviewPlanRound {
  readonly id: string
  readonly state: 'active' | 'completed'
  readonly startedAt: string
  readonly completedAt?: string
  readonly artifactHash?: ArtifactHash
}

export interface ReviewPlan {
  readonly id: string
  readonly outlineId: string
  readonly lessonId: string
  readonly card: FsrsCard
  readonly rounds: readonly ReviewPlanRound[]
}

export interface TemporaryReviewPlanRound {
  readonly id: string
  readonly outlineId: string
  readonly lessonId: string
  readonly startedAt: string
  readonly artifactHash?: ArtifactHash
}

export interface TemporaryReviewPlanRoundManifest {
  readonly rounds: readonly TemporaryReviewPlanRound[]
}

export type RunOutcome = {readonly state: 'completed'; readonly payload: unknown} | {readonly state: 'aborted'; readonly reason?: string}

export interface FeedbackEnvelope {
  readonly payload: unknown
}

export interface ArtifactRunSummary {
  readonly runId: string
  readonly state: 'active' | 'completed' | 'aborted'
  readonly hasFeedback: boolean
  readonly modifiedAt: string
  readonly inBandSessionId?: string
}

export interface ArtifactSummary extends ArtifactTarget {
  readonly title: string
  readonly modifiedAt: string
  readonly runs: readonly ArtifactRunSummary[]
}

// 笔记仍是插件全局数据，不属于学习工作区文件模型
export type NoteAccess = 'private' | 'readable' | 'readwrite'

export interface NoteFolder {
  readonly id: string
  readonly name: string
  readonly createdAt: string
}

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

export interface NotesDb {
  readonly folders: readonly NoteFolder[]
  readonly notes: readonly Note[]
}
