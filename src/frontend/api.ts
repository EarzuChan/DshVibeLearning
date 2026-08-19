// DVL 浏览器端 HTTP 客户端：通过 DSH webServer 的 /learning 前缀使用同源相对路径请求，仅负责 fetch 包装与 URL 构造

import type {NotesActions} from './contract.ts'
import type {ArtifactCategory} from '../shared/artifacts.ts'
import type {InbandPresentRequest, InbandPresentResult, LearningStateDto, LearningWorkspaceDto, NotesDto, PresentArtifactDescriptor} from '../shared/api.ts'
import {LEARNING_ROUTE_PREFIX} from '../shared/routes.ts'

// 执行 JSON GET/POST 请求，非 2xx 时抛出错误
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`DVL：请求失败 ${response.status} ${response.statusText} ${detail}`.trim())
  }

  return await response.json() as Promise<T>
}

// 获取指定工作区 cwd 的完整学习状态
export function fetchState(cwd: string): Promise<LearningStateDto> { return requestJson<LearningStateDto>(`${LEARNING_ROUTE_PREFIX}/api/state?cwd=${encodeURIComponent(cwd)}`) }

// 仅探测当前 cwd 是否为学习工作区，不读取纲目、工件或卡片
export function fetchLearningWorkspace(cwd: string): Promise<LearningWorkspaceDto> { return requestJson<LearningWorkspaceDto>(`${LEARNING_ROUTE_PREFIX}/api/workspace?cwd=${encodeURIComponent(cwd)}`) }

// 发起带内展示请求并返回服务端结束结果
export function inbandPresent(workspaceId: string, category: ArtifactCategory, hash: string, sessionId: string): Promise<InbandPresentResult> {
  const body: InbandPresentRequest = {workspaceId, category, hash, sessionId}
  return requestJson<InbandPresentResult>(`${LEARNING_ROUTE_PREFIX}/api/inband-present`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
}

// 根据 cwd + callId 获取运行中展示的规范描述符，服务端不存在对应运行时返回 null
export async function resolveDescriptor(cwd: string, callId: string): Promise<PresentArtifactDescriptor | null> {
  const response = await fetch(`${LEARNING_ROUTE_PREFIX}/api/present/descriptor?cwd=${encodeURIComponent(cwd)}&callId=${encodeURIComponent(callId)}`)
  if (response.status === 404) return null

  if (!response.ok) throw new Error(`DVL：请求展示描述符失败 ${response.status} ${response.statusText}`)
  return await response.json() as Promise<PresentArtifactDescriptor>
}

// 获取不依赖工作区的全局笔记快照
export function fetchNotes(): Promise<NotesDto> { return requestJson<NotesDto>(`${LEARNING_ROUTE_PREFIX}/api/notes`) }

// 构造笔记 CRUD 操作接口，每次写入后重新获取笔记快照以保持界面同步
export function buildNotesActions(refresh: () => Promise<void>): NotesActions {
  const post = async (body: Record<string, unknown>): Promise<void> => {
    await requestJson<{ok?: boolean}>(`${LEARNING_ROUTE_PREFIX}/api/notes`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
    await refresh()
  }

  return {
    addFolder: name => post({action: 'folder:add', name}),
    renameFolder: (folderId, name) => post({action: 'folder:rename', folderId, name}),
    deleteFolder: folderId => post({action: 'folder:delete', folderId}),
    addNote: input => post({action: 'note:add', folderId: input.folderId, title: input.title, markdown: input.markdown, tags: input.tags, access: input.access}),
    updateNote: (noteId, input) => post({action: 'note:update', noteId, ...input}),
    deleteNote: noteId => post({action: 'note:delete', noteId}),
  }
}

// 构造工件只读预览 URL，不带 run id，因此禁用提交
export function artifactUrl(workspaceId: string, category: ArtifactCategory, hash: string): string { return `${LEARNING_ROUTE_PREFIX}/${workspaceId}/${category}/${hash}/index.html` }
