/**
 * DVL browser-half HTTP client over the local artifact server. Pure fetch
 * wrappers + URL builders — no ctx, no React; the apply closure supplies the
 * origin and re-fetch callback. This module is internal (never re-exported).
 * @module dvl/client/api
 */

import type { NotesActions } from './contract.ts'
import type { ArtifactCategory, InbandPresentResult, LearningStateDto } from './types.ts'

/** The artifact server's default local port, matching the host `config.port` default. */
export const DEFAULT_PORT = 4182

/** Origin of the local artifact server (127.0.0.1 only). */
export function originOf(port: number): string {
  return `http://127.0.0.1:${port}`
}

/** One JSON GET/POST against the artifact server; throws on non-2xx. */
async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`dvl: ${response.status} ${response.statusText} ${detail}`.trim())
  }
  return response.json() as Promise<T>
}

/** Fetch the full learning state for one workspace cwd. */
export function fetchState(origin: string, cwd: string): Promise<LearningStateDto> {
  return requestJson<LearningStateDto>(`${origin}/learning/api/state?cwd=${encodeURIComponent(cwd)}`)
}

/** POST the in-band present request and return the server's settlement. */
export function inbandPresent(
  origin: string,
  workspaceId: string,
  category: ArtifactCategory,
  hash: string,
  sessionId: string,
): Promise<InbandPresentResult> {
  return requestJson<InbandPresentResult>(`${origin}/learning/api/inband-present`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, category, hash, sessionId }),
  })
}

/**
 * Build the notes-action face over the shared `/learning/api/notes` endpoint.
 * Every mutation re-fetches the state (the notes snapshot rides it) so the
 * GUI cards stay in sync without a second polling loop.
 * @param origin - artifact server origin.
 * @param refresh - the caller's state re-fetch.
 * @returns the notes CRUD face.
 */
export function buildNotesActions(origin: string, refresh: () => Promise<void>): NotesActions {
  const post = async (body: Record<string, unknown>): Promise<void> => {
    await requestJson<{ ok?: boolean }>(`${origin}/learning/api/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    await refresh()
  }
  return {
    addFolder: name => post({ action: 'folder:add', name }),
    renameFolder: (folderId, name) => post({ action: 'folder:rename', folderId, name }),
    deleteFolder: folderId => post({ action: 'folder:delete', folderId }),
    addNote: input => post({
      action: 'note:add',
      folderId: input.folderId,
      title: input.title,
      markdown: input.markdown,
      tags: input.tags,
      access: input.access,
    }),
    updateNote: (noteId, input) => post({ action: 'note:update', noteId, ...input }),
    deleteNote: noteId => post({ action: 'note:delete', noteId }),
  }
}

/** Build an artifact's absolute serve URL (iframe and external browser alike). */
export function artifactUrl(origin: string, workspaceId: string, category: ArtifactCategory, hash: string): string {
  return `${origin}/learning/${workspaceId}/${category}/${hash}/index.html`
}
