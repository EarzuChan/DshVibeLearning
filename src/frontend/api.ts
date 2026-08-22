// DVL 浏览器端 HTTP 客户端：通过 DSH webServer 的 /learning 前缀使用同源相对路径请求，仅负责 fetch 包装与 URL 构造

import type {NotesActions} from './contract.ts'
import type {ArtifactCategory} from '../shared/artifacts.ts'
import type {AbortRunRequest, ArtifactRunDescriptor, DataChangeDto, DeleteLearningEntityRequest, DirectRunRequest, InbandPresentRequest, InbandPresentResult, LearningDataDto, LearningWorkspaceDto, NotesDto} from '../shared/api.ts'
import {DVL_SERVER_ROUTE_PREFIX} from '../shared/constants.ts'

// 执行 JSON GET/POST 请求，非 2xx 时抛出错误
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`DVL（前端）请求失败 ${response.status} ${response.statusText} ${detail}`.trim())
  }

  return await response.json() as Promise<T>
}

// 获取指定工作区 cwd 的完整学习状态
export function fetchLearningData(cwd: string): Promise<LearningDataDto> { return requestJson<LearningDataDto>(`${DVL_SERVER_ROUTE_PREFIX}/api/state?cwd=${encodeURIComponent(cwd)}`) }

// 仅探测当前 cwd 是否为学习工作区，不读取纲目、工件或卡片
export function fetchLearningWorkspace(cwd: string): Promise<LearningWorkspaceDto> { return requestJson<LearningWorkspaceDto>(`${DVL_SERVER_ROUTE_PREFIX}/api/workspace?cwd=${encodeURIComponent(cwd)}`) }

// 创建数据失效流；调用方负责关闭，断线由浏览器 EventSource 自行重连
export function openDataChangeStream(onChange: (change: DataChangeDto) => void): EventSource {
  const source = new EventSource(`${DVL_SERVER_ROUTE_PREFIX}/api/changes`)
  source.onmessage = event => onChange(JSON.parse(event.data) as DataChangeDto)
  return source
}

// 发起带内展示请求并返回服务端结束结果
export function inbandPresentExisting(workspaceId: string, category: ArtifactCategory, hash: string, sessionId: string, runId?: string): Promise<InbandPresentResult> {
  const body: InbandPresentRequest = {intent: 'present-existing', workspaceId, category, hash, sessionId, ...(runId === undefined ? {} : {runId})}
  return requestJson<InbandPresentResult>(`${DVL_SERVER_ROUTE_PREFIX}/api/inband-present`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
}

// 请求模型在指定会话中开始一个已经到期的复习期次
export function startDueReview(workspaceId: string, planId: string, sessionId: string): Promise<InbandPresentResult> {
  const body: InbandPresentRequest = {intent: 'start-due-review', workspaceId, planId, sessionId}
  return requestJson<InbandPresentResult>(`${DVL_SERVER_ROUTE_PREFIX}/api/inband-present`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
}

// 显式创建一次不经过模型的 Direct Run
export function createDirectRun(workspaceId: string, category: ArtifactCategory, hash: string): Promise<ArtifactRunDescriptor> {
  const body: DirectRunRequest = {workspaceId, category, hash}
  return requestJson<ArtifactRunDescriptor>(`${DVL_SERVER_ROUTE_PREFIX}/api/runs`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})
}

// 由用户终结一个仍然活跃的 Run
export function abortRun(workspaceId: string, category: ArtifactCategory, hash: string, runId: string): Promise<void> {
  const body: AbortRunRequest = {workspaceId, category, hash, runId}
  return requestJson<unknown>(`${DVL_SERVER_ROUTE_PREFIX}/api/runs/abort`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}).then(() => undefined)
}

// 执行一个经过界面确认的学习实体删除命令
export function deleteLearningEntity(workspaceId: string, body: DeleteLearningEntityRequest): Promise<void> {
  return requestJson<unknown>(`${DVL_SERVER_ROUTE_PREFIX}/api/delete`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({workspaceId, ...body})}).then(() => undefined)
}

// 根据 cwd + callId 获取运行中展示的规范描述符，服务端不存在对应运行时返回 null
export async function resolveDescriptor(cwd: string, callId: string): Promise<ArtifactRunDescriptor | null> {
  const response = await fetch(`${DVL_SERVER_ROUTE_PREFIX}/api/present/live?cwd=${encodeURIComponent(cwd)}&callId=${encodeURIComponent(callId)}`)
  if (response.status === 404) return null

  if (!response.ok) throw new Error(`DVL：请求展示描述符失败 ${response.status} ${response.statusText}`)
  return await response.json() as Promise<ArtifactRunDescriptor>
}

// 获取不依赖工作区的全局笔记快照
export function fetchNotes(): Promise<NotesDto> { return requestJson<NotesDto>(`${DVL_SERVER_ROUTE_PREFIX}/api/notes`) }

// 构造笔记 CRUD 操作接口，写入后的界面同步统一由后端变更流触发
export function buildNotesActions(): NotesActions {
  const post = async (body: Record<string, unknown>): Promise<void> => { await requestJson<{ok?: boolean}>(`${DVL_SERVER_ROUTE_PREFIX}/api/notes`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}) }

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
export function artifactUrl(workspaceId: string, category: ArtifactCategory, hash: string): string { return `${DVL_SERVER_ROUTE_PREFIX}/${workspaceId}/${category}/${hash}/index.html` }

// 构造一个已经存在的 Run 页面 URL
export function runUrl(workspaceId: string, category: ArtifactCategory, hash: string, runId: string): string { return `${DVL_SERVER_ROUTE_PREFIX}/${workspaceId}/${category}/${hash}/runs/${runId}/index.html` }
