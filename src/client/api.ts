/**
 * DVL browser-half HTTP client：同源相对路径 fetch（挂在 DSH webServer 的 /learning 前缀下）
 * 纯 fetch 包装 + URL 构造——无 ctx、无 React、无端口/origin 概念
 * @module dvl/client/api
 */

import type { NotesActions } from './contract.ts'
import { LEARNING_ROUTE_PREFIX } from '../shared/routes.ts'
import type { ArtifactCategory, InbandPresentResult, LearningStateDto, NotesDto, PresentArtifactDescriptorDto } from './types.ts'

/** One JSON GET/POST（同源相对路径）；throws on non-2xx */
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`dvl: ${response.status} ${response.statusText} ${detail}`.trim())
  }
  return response.json() as Promise<T>
}

/** Fetch the full learning state for one workspace cwd. */
export function fetchState(cwd: string): Promise<LearningStateDto> {
  return requestJson<LearningStateDto>(`${LEARNING_ROUTE_PREFIX}/api/state?cwd=${encodeURIComponent(cwd)}`)
}

/** POST the in-band present request and return the server's settlement. */
export function inbandPresent(workspaceId: string, category: ArtifactCategory, hash: string, sessionId: string): Promise<InbandPresentResult> {
  return requestJson<InbandPresentResult>(`${LEARNING_ROUTE_PREFIX}/api/inband-present`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, category, hash, sessionId }),
  })
}

/**
 * Resolve a running present's canonical descriptor from the server by
 * `cwd + callId`. Returns null when the server has no such running present
 * (e.g. it settled already, or the tool has not created the run yet).
 */
export async function resolveDescriptor(cwd: string, callId: string): Promise<PresentArtifactDescriptorDto | null> {
  const response = await fetch(`${LEARNING_ROUTE_PREFIX}/api/present/descriptor?cwd=${encodeURIComponent(cwd)}&callId=${encodeURIComponent(callId)}`)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`dvl: ${response.status} ${response.statusText}`)
  return response.json() as Promise<PresentArtifactDescriptorDto>
}

/** Fetch the global notes snapshot（不依赖任何 workspace） */
export function fetchNotes(): Promise<NotesDto> {
  return requestJson<NotesDto>(`${LEARNING_ROUTE_PREFIX}/api/notes`)
}

/**
 * Build the notes-action face over the shared `/learning/api/notes` endpoint.
 * Every mutation re-fetches the notes snapshot so the GUI stays in sync
 * @param refresh - the caller's notes re-fetch.
 * @returns the notes CRUD face.
 */
export function buildNotesActions(refresh: () => Promise<void>): NotesActions {
  const post = async (body: Record<string, unknown>): Promise<void> => {
    await requestJson<{ ok?: boolean }>(`${LEARNING_ROUTE_PREFIX}/api/notes`, {
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

/**
 * Build an artifact's read-only preview URL (no run id → submission disabled).
 * Canonical active-run URLs are never built here: they arrive from the server
 * via the presentation descriptor.
 */
export function artifactUrl(workspaceId: string, category: ArtifactCategory, hash: string): string {
  return `${LEARNING_ROUTE_PREFIX}/${workspaceId}/${category}/${hash}/index.html`
}
