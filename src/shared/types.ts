/**
 * DVL durable JSON vocabulary. Everything here must survive `JSON.stringify`
 * round-trips; the workspace files (`<cwd>/.dsh/learning/**`) are the
 * authoritative copy.
 * @module dvl/shared/types
 */

/** Course-progression state of one lesson node inside an outline. */
export type LessonState = 'not-started' | 'learning' | 'qa' | 'done'

/** The three artifact kinds a model can author and present. */
export type ArtifactKind = 'lesson' | 'review' | 'quiz'

/** One node of an outline tree. `group` nests; `lesson` is a leaf course. */
export interface OutlineNode {
  readonly id: string
  readonly kind: 'group' | 'lesson'
  readonly title: string
  /** Sibling order; ascending. */
  readonly order: number
  /** `null` hangs directly under the outline root. */
  readonly parentId: string | null
  /** Stable course id (lesson nodes only; preserved across outline edits). */
  readonly lessonId?: string
  /** Course-progression state (lesson nodes only; default `not-started`). */
  readonly state?: LessonState
  /** Current lesson artifact content hash, when one has been presented. */
  readonly artifactHash?: string
  /** Optional free-form course goal/notes for the model. */
  readonly description?: string
}

/** The durable outline file (`outlines/<id>.json`). */
export interface Outline {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly nodes: OutlineNode[]
}

/** Per-artifact bookkeeping (`meta.json` beside `index.html`). */
export interface ArtifactMeta {
  readonly kind: ArtifactKind
  /** Lesson id this artifact belongs to (review/quiz artifacts too). */
  readonly targetId: string
  readonly title: string
  readonly createdAt: string
}

/**
 * One presentation/answer attempt (`runs/<runId>/run.json`). Mechanism only:
 * artifact identity, the owning tool call, and creation time. No pedagogical
 * judgement lives here.
 */
export interface ArtifactRun {
  readonly runId: string
  readonly artifactHash: string
  readonly kind: ArtifactKind
  readonly targetId: string
  /** The DSH tool `callId` that created/resumed this run (idempotency key). */
  readonly callId: string
  readonly createdAt: string
}

/**
 * The mechanism envelope DVL wraps around an opaque submission
 * (`runs/<runId>/result.json`). `payload` is the artifact's raw JSON value,
 * preserved verbatim — DVL never parses its teaching semantics.
 */
export interface ResultEnvelope {
  readonly kind: ArtifactKind
  readonly targetId: string
  readonly artifactHash: string
  readonly runId: string
  readonly submittedAt: string
  /** Arbitrary JSON value as submitted by `window.DVL.submit(...)`. */
  readonly payload: unknown
}

/**
 * The mechanism envelope DVL wraps around the model's opaque grading report
 * (`runs/<runId>/feedback.json`). `payload` is the model's raw JSON value,
 * preserved verbatim — DVL never validates its schema or reads its meaning.
 */
export interface FeedbackEnvelope {
  readonly kind: ArtifactKind
  readonly targetId: string
  readonly artifactHash: string
  readonly runId: string
  readonly savedAt: string
  readonly payload: unknown
}

/** One run as listed under an artifact (no payload bodies, only status facts). */
export interface ArtifactRunSummary {
  readonly runId: string
  readonly createdAt: string
  readonly hasResult: boolean
  readonly hasFeedback: boolean
}

export type NoteAccess = 'private' | 'readable' | 'readwrite'

export interface NoteFolder {
  readonly id: string
  readonly name: string
  readonly createdAt: string
}

/**
 * One note. Storage is global (plugin data dir), never the workspace.
 * `tags` use prefixes: `workspace:<id>`, `outline:<id>`, `lesson:<id>`
 * (any count). The model surface sees only `readable`/`readwrite` notes whose
 * tags include the current workspace.
 */
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
  readonly folders: NoteFolder[]
  readonly notes: Note[]
}

/** The explicit FSRS rating a model reports after grading one run. */
export type ReviewRating = 'again' | 'hard' | 'good' | 'easy'

/** One finished review; kept in the card file's history. */
export interface ReviewRecord {
  readonly at: string
  /** Explicit model-reported FSRS rating (never derived from a score). */
  readonly rating: ReviewRating
  /** The result run this rating was drawn from (idempotency source). */
  readonly sourceRunId: string
  /** Optional free-form rationale for the rating. */
  readonly reason?: string
}

/** Durable FSRS card file (`cards/<lessonId>.json`). */
export interface CardFile {
  readonly lessonId: string
  /** Serialized ts-fsrs `Card`. */
  readonly card: Record<string, unknown>
  readonly history: ReviewRecord[]
}

/**
 * Canonical presentation descriptor owned by the server. The toolview fetches
 * it by `cwd + callId` while a present runs; after settlement it is recovered
 * from the durable `present_artifact` tool result metadata.
 */
export interface PresentArtifactDescriptor {
  readonly version: 1
  readonly callId: string
  readonly workspaceId: string
  readonly kind: ArtifactKind
  /** URL category segment: `lessons` | `reviews` | `quizzes`. */
  readonly category: string
  readonly hash: string
  readonly targetId: string
  readonly title: string
  /** The active run's unguessable id (present in the canonical URL). */
  readonly runId: string
  /** Canonical active-run URL, issued by the server. */
  readonly url: string
}

/** How an in-band `present_artifact` settles. */
export type PresentOutcome =
  | { readonly kind: 'result'; readonly result: ResultEnvelope }
  | {
    readonly kind: 'no-result'
    readonly reason: 'interrupted' | 'timeout' | 'error'
    readonly detail?: string
  }

/**
 * The read-only candidate the review-plan tool shows before confirmation.
 * Nothing here is durable until `commitReviewPlan` writes the card file.
 */
export interface ReviewPlanProposal {
  readonly lessonId: string
  readonly rating: ReviewRating
  readonly sourceRunId: string
  readonly reason?: string
  /** Current card file (null when no card exists yet). */
  readonly current: CardFile | null
  /** Candidate next card after applying `rating`. */
  readonly nextCard: Record<string, unknown>
  /** Candidate next due, ISO timestamp. */
  readonly due: string
  /** Whether `sourceRunId` was already applied to this card's history. */
  readonly alreadyApplied: boolean
}

/** What the per-turn snapshot (P2) injects about one outline. */
export interface SnapshotOutline {
  readonly id: string
  readonly title: string
  readonly active: boolean
}

/** What the per-turn snapshot injects about a course currently in flight. */
export interface SnapshotLesson {
  readonly id: string
  readonly title: string
  readonly state: LessonState
}

/** What the per-turn snapshot injects about a due review. */
export interface SnapshotCard {
  readonly lessonId: string
  readonly lessonTitle: string
  readonly due: string
  readonly state: string
  readonly overdue: boolean
}

/** Full learning-state snapshot for the P2 prompt and the GUI API. */
export interface LearningSnapshot {
  readonly workspaceId: string
  readonly learningDirExists: boolean
  readonly activeOutlineId: string | null
  readonly outlines: SnapshotOutline[]
  /** Lessons in `learning`/`qa` state (the current course position). */
  readonly currentLessons: SnapshotLesson[]
  /** Cards due now, ascending by due time. */
  readonly dueCards: SnapshotCard[]
}
