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

/** The result envelope the artifact submits; `payload` is free-form. */
export interface ResultEnvelope {
  readonly kind: ArtifactKind
  readonly targetId: string
  readonly submittedAt: string
  /** Objective score in [0,1] when the artifact reports one (FSRS input). */
  readonly score?: number
  /** Free-form submission JSON: auto-judged details + raw subjective answers. */
  readonly payload?: unknown
}

/** Model-written grading feedback (`feedback.json` beside the artifact). */
export interface FeedbackFile {
  /** The feedback body, markdown. */
  readonly markdown: string
  readonly gradedAt: string
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

/** One finished review; kept in the card file's history. */
export interface ReviewRecord {
  readonly at: string
  /** FSRS grade: Again=1 Hard=2 Good=3 Easy=4. */
  readonly rating: number
  readonly score?: number
  /** Artifact hash of that review lesson, for回看. */
  readonly reviewHash?: string
}

/** Durable FSRS card file (`cards/<lessonId>.json`). */
export interface CardFile {
  readonly lessonId: string
  /** Serialized ts-fsrs `Card`. */
  readonly card: Record<string, unknown>
  readonly history: ReviewRecord[]
}

/** How an in-band `present_artifact` settles. */
export type PresentOutcome =
  | { readonly kind: 'result'; readonly result: ResultEnvelope }
  | {
    readonly kind: 'no-result'
    readonly reason: 'interrupted' | 'timeout' | 'error'
    readonly detail?: string
  }

/** Score → FSRS grade thresholds (config). */
export interface RatingThresholds {
  /** Below this → Again. */
  readonly again: number
  /** Below this (at/above `again`) → Hard. */
  readonly hard: number
  /** Below this (at/above `hard`) → Good; at/above → Easy. */
  readonly good: number
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
