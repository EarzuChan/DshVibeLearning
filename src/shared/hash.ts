/**
 * DVL hash helpers: content-addressed artifact ids and the workspace id used
 * in server URLs.
 * @module dvl/shared/hash
 */

import { createHash } from 'node:crypto'

/**
 * Short content hash used as an artifact directory name. Identical content
 * yields an identical id, so outline edits never force renames and
 * still-referenced artifacts survive unchanged.
 * @param data - content to hash.
 * @param length - hex characters to keep (default 16).
 * @returns lowercase hex prefix.
 */
export function contentHash(data: string, length = 16): string {
  return createHash('sha256').update(data).digest('hex').slice(0, length)
}

/**
 * The URL-facing workspace id: a short hash of the canonical cwd. The client
 * and the artifact URLs derive it the same way.
 * @param cwd - canonical workspace directory.
 * @returns 12-hex-char workspace id.
 */
export function workspaceIdOf(cwd: string): string {
  return contentHash(cwd, 12)
}

/** Directory-name guard for every id that becomes a file or URL segment. */
export function isSafeSegment(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(id)
}
