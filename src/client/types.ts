/**
 * DVL browser-half wire types: the shapes the learning artifact server's JSON
 * GUI API returns and accepts. Everything here is JSON over `fetch` — never
 * imported from the host side; the durable vocabulary is mirrored, not shared.
 * @module dvl/client/types
 */

/** Course-progression state of one lesson node. */
export type LessonState = 'not-started' | 'learning' | 'qa' | 'done'

/** One outline tree node from the server state response. */
export interface OutlineNodeDto {
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

/** One outline row from the server state response (`/learning/api/state`). */
export interface OutlineDto {
  readonly id: string
  readonly title: string
  readonly active: boolean
  readonly nodeCount: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly nodes: readonly OutlineNodeDto[]
}

/** One FSRS review card row from the server state response. */
export interface CardDto {
  readonly lessonId: string
  readonly due: string | null
  readonly history: readonly {
    readonly at: string
    readonly rating: number
    readonly score?: number
    readonly reviewHash?: string
  }[]
}

/** One authored artifact row (lesson/review/quiz) from the state response. */
export interface ArtifactDto {
  readonly hash: string
  readonly meta: {
    readonly kind: 'lesson' | 'review' | 'quiz'
    readonly targetId: string
    readonly title: string
    readonly createdAt: string
  }
  readonly hasResult: boolean
  readonly hasFeedback: boolean
}

/** Note access level; the same three tiers the model surface understands. */
export type NoteAccess = 'private' | 'readable' | 'readwrite'

/** One note folder from the state response. */
export interface NoteFolderDto {
  readonly id: string
  readonly name: string
  readonly createdAt: string
}

/** One note from the state response. */
export interface NoteDto {
  readonly id: string
  readonly folderId: string
  readonly title: string
  readonly markdown: string
  readonly tags: readonly string[]
  readonly access: NoteAccess
  readonly createdAt: string
  readonly updatedAt: string
}

/** The notes section of the state response. */
export interface NotesDto {
  readonly folders: readonly NoteFolderDto[]
  readonly notes: readonly NoteDto[]
}

/** The full `/learning/api/state` response body. */
export interface LearningStateDto {
  readonly workspaceId: string
  readonly cwd: string
  readonly port: number
  readonly activeOutlineId: string | null
  readonly outlines: readonly OutlineDto[]
  readonly cards: readonly CardDto[]
  readonly lessons: readonly ArtifactDto[]
  readonly reviews: readonly ArtifactDto[]
  readonly quizzes: readonly ArtifactDto[]
  readonly notes: NotesDto
}

/** The artifact URL categories as the server spells them in paths. */
export type ArtifactCategory = 'lessons' | 'reviews' | 'quizzes'

/** `/learning/api/inband-present` response. */
export interface InbandPresentResult {
  readonly ok: boolean
  readonly mode: 'current-session' | 'new-session'
  readonly sessionId: string
  readonly error?: string
}

/**
 * Derive the URL-facing workspace id (sha256(cwd) 12-hex prefix) in the
 * browser. Mirrors the host `workspaceIdOf` so a client that only knows the
 * canonical cwd can still address the workspace without a prior state round-trip.
 * @param cwd - canonical workspace directory.
 * @returns 12-hex-char lowercase workspace id.
 */
export async function workspaceIdOf(cwd: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cwd))
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex.slice(0, 12)
}
