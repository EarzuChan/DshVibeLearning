import type {ArtifactTarget} from '../shared/artifacts.ts'
import type {OutlinePhase, RunOutcome} from '../shared/model.ts'

export interface ArtifactRef extends ArtifactTarget {
  readonly cwd: string
}

export interface RunRef extends ArtifactRef {
  readonly runId: string
}

export interface RunReuseKey {
  readonly namespace: string
  readonly value: string
}

export type PresentOutcome = {readonly outcome: 'completed'; readonly runId: string; readonly payload: unknown} | {readonly outcome: 'aborted'; readonly runId: string; readonly reason?: string} | {readonly outcome: 'timed-out'; readonly runId: string} | {readonly outcome: 'interrupted'; readonly runId: string} | {readonly outcome: 'error'; readonly detail: string}

export interface ArtifactRunDescriptor extends ArtifactTarget {
  readonly version: 2
  readonly workspaceId: string
  readonly title: string
  readonly runId: string
  readonly url: string
}

export interface InBandLease {
  readonly callId: string
  readonly sessionId: string
  readonly run: RunRef
}

export interface LivePresentCall {
  readonly descriptor: ArtifactRunDescriptor
  readonly lease: InBandLease
}

export interface SnapshotOutline {
  readonly id: string
  readonly title: string
  readonly phase: OutlinePhase
  readonly dueReviewCount: number
}

export interface SnapshotLesson {
  readonly id: string
  readonly title: string
  readonly phase: 'learning' | 'qa'
}

export interface SnapshotReview {
  readonly planId: string
  readonly lessonId: string
  readonly lessonTitle: string
  readonly dueAt: string
}

export interface LearningSnapshot {
  readonly workspaceId: string
  readonly learningDirExists: boolean
  readonly activeOutlineId: string | null
  readonly outlines: readonly SnapshotOutline[]
  readonly currentLesson: SnapshotLesson | null
  readonly dueReviews: readonly SnapshotReview[]
  readonly problem?: string
}

export function presentOutcomeOf(runId: string, outcome: RunOutcome): PresentOutcome {
  return outcome.state === 'completed' ? {outcome: 'completed', runId, payload: outcome.payload} : {outcome: 'aborted', runId, ...(outcome.reason === undefined ? {} : {reason: outcome.reason})}
}
