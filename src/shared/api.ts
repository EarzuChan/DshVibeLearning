import type {ArtifactCategory, ArtifactTarget} from './artifacts.ts'
import type {ArtifactSummary, Note, NoteFolder, Outline, ReviewPlan, TemporaryReviewPlanRoundManifest} from './model.ts'

export interface ArtifactRunDescriptor extends ArtifactTarget {
  readonly version: 2
  readonly workspaceId: string
  readonly title: string
  readonly runId: string
  readonly url: string
}

export interface NotesDto {
  readonly folders: readonly NoteFolder[]
  readonly notes: readonly Note[]
}

export interface LearningDataDto {
  readonly outlines: readonly Outline[]
  readonly reviewPlans: readonly ReviewPlan[]
  readonly temporaryReviews: TemporaryReviewPlanRoundManifest
  readonly orphanLessonHashes: readonly string[]
  readonly lessons: readonly ArtifactSummary[]
  readonly reviews: readonly ArtifactSummary[]
  readonly quizzes: readonly ArtifactSummary[]
}

export interface DataChangeDto {
  readonly id: number
  readonly channel: 'workspace' | 'learning' | 'notes' | 'reset'
  readonly workspaceId?: string
}

export interface LearningWorkspaceDto {
  readonly cwd: string
  readonly workspaceId: string
  readonly isLearningWorkspace: boolean
}

export type InbandPresentRequest = {readonly intent: 'present-existing'; readonly workspaceId: string; readonly category: ArtifactCategory; readonly hash: string; readonly runId?: string; readonly sessionId: string} | {readonly intent: 'start-due-review'; readonly workspaceId: string; readonly planId: string; readonly sessionId: string}

export interface InbandPresentResult {
  readonly ok: boolean
  readonly mode: 'current-session' | 'new-session'
  readonly sessionId: string
  readonly error?: string
}

export interface DirectRunRequest {
  readonly workspaceId: string
  readonly category: ArtifactCategory
  readonly hash: string
}

export interface AbortRunRequest extends DirectRunRequest {
  readonly runId: string
  readonly reason?: string
}

export type DeleteLearningEntityRequest = {readonly target: 'outline'; readonly id: string} | {readonly target: 'review-plan'; readonly id: string; readonly preserveArtifacts: boolean} | {readonly target: 'artifact'; readonly category: ArtifactCategory; readonly hash: string}
