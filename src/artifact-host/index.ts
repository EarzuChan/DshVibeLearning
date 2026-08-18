/**
 * DVL 的 HTTP 面：全部挂在 DSH webServer 的 `/learning` 前缀路由上
 * （同源访问，无独立 server、无端口配置、无 CORS 需求）：
 * 提供只读预览与活动 Run 的工件 HTML、注入基础主题与 `window.DVL.submit` 桥、
 * 通过 HTTP 接收不透明提交、解析工具视图的运行态描述符、托管面向 GUI 的 JSON API
 * @module dvl/artifact-host
 */

import type {IncomingMessage, ServerResponse} from 'node:http'
import {randomUUID} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
// Type-only：让 webServer 的 Context 声明合并对本文件可见
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import type {SessionId} from '@deepseek-ai/dsh-session'
import {SessionId as brandSessionId} from '@deepseek-ai/dsh-session'
import {isValidArtifactHash, isValidRunId} from '../core/files.ts'
import type {LearningService} from '../core/index.ts'
import {artifactKindOf, type ArtifactKind} from '../shared/artifacts.ts'
import type {CardDto, InbandPresentRequest, LearningStateDto, OutlineDto} from '../shared/api.ts'
import type {NoteAccess} from '../shared/model.ts'
import {LEARNING_ROUTE_PREFIX} from '../shared/routes.ts'


const MAX_BODY_BYTES = 10 * 1024 * 1024

const THEME_CSS = [
    ':root { --dvl-font: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }',
    'body.dvl-artifact { font-family: var(--dvl-font); margin: 0; line-height: 1.6; }',
    '.dvl-slide { max-width: 860px; margin: 0 auto; padding: 32px 24px; }',
].join('\n')

/**
 * 提交桥接器。该组件仅提供原始 JSON 有效负载；
 * `window.DVL.submit` 将其发布到页面相对的 `./submit` 端点，因此运行标识来自规范 URL 本身（位于 `/learning/…/runs/<runId>/index.html` 的活动 Run 页面解析为 `/learning/…/runs/<runId>/submit`）。
 * 只读预览页面没有 Run 段，因此其 `./submit` 请求会被服务端拒绝。此处没有任何内容包含 `workspaceId`/`category`/`hash`/`runId` ——该组件既不知道也不转发任何机制字段
 */
const BRIDGE_JS = `(function () {
    function submit(payload) {
        return fetch("./submit", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload === undefined ? null : payload),
        }).then(function (r) {
            return r.json();
        });
    }

    window.DVL = {submit: submit};
})();`

// 注入基础主题与提交桥，不包含单次运行或目标状态
function injectIntoHtml(html: string): string {
    const injection = `<link rel="stylesheet" href="/learning/theme.css">
<script src="/learning/bridge.js"></script>`

    const headClose = /<\/head>/iu.exec(html)

    if (headClose !== null) return `${html.slice(0, headClose.index)}${injection}\n${html.slice(headClose.index)}`

    const bodyOpen = /<body[^>]*>/iu.exec(html)
    if (bodyOpen !== null) {
        const at = bodyOpen.index + bodyOpen[0].length
        return `${html.slice(0, at)}\n${injection}${html.slice(at)}`
    }

    return `${injection}\n${html}`
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value)

    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body)})
    res.end(body)
}

function sendText(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
    res.writeHead(status, {'Content-Type': type, 'Content-Length': Buffer.byteLength(body)})
    res.end(body)
}

function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0

        req.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_BODY_BYTES) {
                reject(new Error('request body too large'))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })

        req.on('end', () => {
            if (chunks.length === 0) {
                resolve({})
                return
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
            } catch (error: unknown) {
                reject(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`))
            }
        })

        req.on('error', reject)
    })
}

const asString = (value: unknown): string => typeof value === 'string' ? value : ''
const asTags = (value: unknown): string[] => Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
const asAccess = (value: unknown): NoteAccess => value === 'private' || value === 'readable' || value === 'readwrite' ? value : 'readable'

/**
 * 把 DVL 的全部 HTTP 端点挂到 DSH webServer 的 `/learning` 前缀路由。
 * 同源访问：浏览器 fetch 相对路径即可，端口由 DSH 自己管理
 * @param ctx - plugin context（须已提供 webServer 与 learning）
 */
export function installLearningRoutes(ctx: Context): void {
    const learning: LearningService = ctx.learning

    const refreshWorkspaces = (): void => {
        const registry = ctx.get('workspaceRegistry')
        if (registry === undefined) return
        for (const workspace of registry.list()) learning.registerWorkspace(workspace.path)
    }

    const resolveCwd = (workspaceId: string): string | null => {
        refreshWorkspaces()
        return learning.resolveWorkspace(workspaceId)
    }

    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')

        if (req.method === 'OPTIONS') {
            sendJson(res, 204, {})
            return
        }
        const path = url.pathname
        if (req.method === 'GET' && path === '/learning/theme.css') {
            sendText(res, 200, THEME_CSS, 'text/css; charset=utf-8')
            return
        }
        if (req.method === 'GET' && path === '/learning/bridge.js') {
            sendText(res, 200, BRIDGE_JS, 'application/javascript; charset=utf-8')
            return
        }

        // ── 不透明提交 ────────────────────────────────────────────────
        // run 身份取自规范 URL，请求正文只包含不带机制字段的原始 JSON payload
        const submitRunMatch = /^\/learning\/([a-f0-9]{12})\/(lessons|reviews|quizzes)\/([a-f0-9]{6,64})\/runs\/([a-z0-9_-]{1,128})\/submit$/iu.exec(path)
        if (req.method === 'POST' && submitRunMatch !== null) {
            const workspaceId = submitRunMatch[1]
            const kind = artifactKindOf(submitRunMatch[2])
            const hash = submitRunMatch[3]
            const runId = submitRunMatch[4]
            if (kind === null || workspaceId === undefined || hash === undefined || runId === undefined || !isValidRunId(runId)) {
                sendJson(res, 400, {ok: false, error: 'bad run target'})
                return
            }
            const cwd = resolveCwd(workspaceId)
            if (cwd === null) {
                sendJson(res, 404, {ok: false, error: '未知的工作区'})
                return
            }
            const payload = await readBody(req)
            const {alreadySubmitted} = await learning.submit(cwd, kind, hash, runId, payload)
            sendJson(res, 200, {ok: true, alreadySubmitted})
            return
        }

        // 只读预览没有 run 路径段，因此拒绝其 submit 请求
        const previewSubmitMatch = /^\/learning\/([a-f0-9]{12})\/(lessons|reviews|quizzes)\/([a-f0-9]{6,64})\/submit$/iu.exec(path)
        if (req.method === 'POST' && previewSubmitMatch !== null) {
            sendJson(res, 403, {ok: false, error: 'read-only preview: start an attempt to submit'})
            return
        }

        // ── 运行中展示描述符解析 ──────────────────────────────────────
        if (req.method === 'GET' && path === '/learning/api/present/descriptor') {
            const cwdParam = url.searchParams.get('cwd')
            const callId = url.searchParams.get('callId') ?? ''
            if (cwdParam === null || callId.length === 0) {
                sendJson(res, 400, {ok: false, error: 'cwd and callId are required'})
                return
            }
            learning.registerWorkspace(cwdParam)
            const descriptor = learning.resolveDescriptor(cwdParam, callId)
            if (descriptor === null) {
                sendJson(res, 404, {ok: false, error: 'no running present for this call'})
                return
            }
            sendJson(res, 200, descriptor)
            return
        }

        // ── GUI 状态 ───────────────────────────────────────────────────
        if (req.method === 'GET' && path === '/learning/api/state') {
            const cwdParam = url.searchParams.get('cwd')
            let cwd: string | null = cwdParam !== null ? cwdParam : resolveCwd(url.searchParams.get('workspaceId') ?? '')
            if (cwd === null) {
                sendJson(res, 404, {error: '未知的工作区'})
                return
            }
            learning.registerWorkspace(cwd)
            const files = learning.filesFor(cwd)
            const snapshot = await learning.snapshot(cwd)
            const outlines: OutlineDto[] = []
            for (const outline of await learning.listOutlines(cwd)) {
                outlines.push({
                    ...outline,
                    active: outline.id === snapshot.activeOutlineId,
                    nodeCount: outline.nodes.length,
                })
            }
            const cards: CardDto[] = []
            for (const cardFile of await files.listCards()) {
                const card = cardFile.card as { due?: unknown }
                cards.push({
                    lessonId: cardFile.lessonId,
                    due: typeof card.due === 'string' ? card.due : card.due instanceof Date ? card.due.toISOString() : null,
                    history: cardFile.history,
                })
            }
            const state: LearningStateDto = {
                workspaceId: snapshot.workspaceId,
                cwd,
                learningDirExists: snapshot.learningDirExists,
                activeOutlineId: snapshot.activeOutlineId,
                outlines,
                cards,
                lessons: await files.listArtifacts('lesson'),
                reviews: await files.listArtifacts('review'),
                quizzes: await files.listArtifacts('quiz'),
                notes: learning.notes.snapshot(),
            }
            sendJson(res, 200, state)
            return
        }

        // ── 全局笔记独立端点：不依赖任何 workspace/cwd ──────────────
        if (req.method === 'GET' && path === '/learning/api/notes') {
            sendJson(res, 200, learning.notes.snapshot())
            return
        }

        if (req.method === 'POST' && path === '/learning/api/notes') {
            const body = await readBody(req) as Record<string, unknown>
            const action = typeof body.action === 'string' ? body.action : ''
            const notes = learning.notes

            try {
                switch (action) {
                    case 'folder:add':
                        sendJson(res, 200, notes.addFolder(asString(body.name)))
                        return

                    case 'folder:rename':
                        await notes.renameFolder(asString(body.folderId), asString(body.name))
                        sendJson(res, 200, {ok: true})
                        return

                    case 'folder:delete':
                        await notes.deleteFolder(asString(body.folderId))
                        sendJson(res, 200, {ok: true})
                        return

                    case 'note:add':
                        sendJson(res, 200, notes.addNote({
                            folderId: asString(body.folderId),
                            title: asString(body.title),
                            markdown: asString(body.markdown),
                            tags: asTags(body.tags),
                            access: asAccess(body.access),
                        }))
                        return

                    case 'note:update':
                        sendJson(res, 200, notes.updateNote(asString(body.noteId), {
                            ...(typeof body.title === 'string' ? {title: body.title} : {}),
                            ...(typeof body.markdown === 'string' ? {markdown: body.markdown} : {}),
                            ...(Array.isArray(body.tags) ? {tags: asTags(body.tags)} : {}),
                            ...(body.access === 'private' || body.access === 'readable' || body.access === 'readwrite' ? {access: asAccess(body.access)} : {}),
                            ...(typeof body.folderId === 'string' ? {folderId: body.folderId} : {}),
                        }))
                        return

                    case 'note:delete':
                        await notes.deleteNote(asString(body.noteId))
                        sendJson(res, 200, {ok: true})
                        return

                    default:
                        sendJson(res, 400, {error: `unknown notes action '${action}'`})
                        return
                }
            } catch (error: unknown) {
                sendJson(res, 400, {error: error instanceof Error ? error.message : String(error)})
                return
            }
        }

        if (req.method === 'POST' && path === '/learning/api/inband-present') {
            const body = await readBody(req) as Partial<InbandPresentRequest>
            const workspaceId = asString(body.workspaceId)
            const category = asString(body.category)
            const hash = asString(body.hash)
            const kind = artifactKindOf(category)

            if (kind === null || !isValidArtifactHash(hash)) {
                sendJson(res, 400, {ok: false, error: 'bad artifact target'})
                return
            }
            const cwd = resolveCwd(workspaceId)
            if (cwd === null) {
                sendJson(res, 404, {ok: false, error: '未知的工作区'})
                return
            }
            const meta = await learning.filesFor(cwd).readMeta(kind, hash)
            if (meta === null) {
                sendJson(res, 404, {ok: false, error: 'unknown artifact'})
                return
            }
            const instruction =
                `用户从学习面板对工件发起了一次 in-band 呈现（${kind}，hash ${hash}，标题「${meta.title}」）：`
                + `请调用 present_artifact(kind='${kind}', target_id='${meta.targetId}', path='${cwd}/.dsh/learning/${category}/${hash}/index.html', title='${meta.title}') `
                + '并走完流程（present → 拿到 result → 批改 → save_feedback 保存报告 → 按需 update_review_plan → 回复用户）。'
            const sessionId = asString(body.sessionId)
            let agent: Agent | undefined = sessionId.length > 0 ? ctx.agents.get(brandSessionId(sessionId)) : undefined
            if (agent !== undefined) {
                learning.notify(agent, instruction)
                sendJson(res, 200, {ok: true, mode: 'current-session', sessionId})
                return
            }

            // 实验路径：在当前工作区的新会话中驱动固定流程
            try {
                const handle = await ctx.agents.create({
                    sessionId: brandSessionId(randomUUID()) as SessionId,
                    meta: {cwd},
                })
                learning.markEntered(handle.agent.session)
                handle.agent.steer(createUserMessage({
                    content: [{type: 'text', text: instruction}],
                    source: {kind: 'plugin', plugin: 'learning-web'},
                }))
                sendJson(res, 200, {ok: true, mode: 'new-session', sessionId: String(handle.agent.id)})
            } catch (error: unknown) {
                sendJson(res, 500, {ok: false, error: error instanceof Error ? error.message : String(error)})
            }
            return
        }

        // 活动 run 页面：/learning/<ws>/<category>/<hash>/runs/<runId>/index.html
        const runMatch = /^\/learning\/([a-f0-9]{12})\/(lessons|reviews|quizzes)\/([a-f0-9]{6,64})\/runs\/([a-z0-9_-]{1,128})\/index\.html$/iu.exec(path)
        if (req.method === 'GET' && runMatch !== null) {
            const workspaceId = runMatch[1]
            const kind = artifactKindOf(runMatch[2])
            const hash = runMatch[3]
            const runId = runMatch[4]
            if (kind === null || workspaceId === undefined || hash === undefined || runId === undefined || !isValidRunId(runId)) {
                sendText(res, 404, 'not found')
                return
            }
            const cwd = resolveCwd(workspaceId)
            if (cwd === null) {
                sendText(res, 404, '未知的工作区')
                return
            }
            const files = learning.filesFor(cwd)
            const run = await files.readRun(kind, hash, runId)
            if (run === null || run.kind !== kind || run.artifactHash !== hash) {
                sendText(res, 404, 'run not found')
                return
            }
            const html = await files.readArtifactHtml(kind, hash)
            if (html === null) {
                sendText(res, 404, 'artifact not found')
                return
            }
            sendText(res, 200, injectIntoHtml(html), 'text/html; charset=utf-8')
            return
        }

        // 只读预览页面：/learning/<workspaceId>/<category>/<hash>/index.html
        const match = /^\/learning\/([a-f0-9]{12})\/(lessons|reviews|quizzes)\/([a-f0-9]{6,64})\/index\.html$/iu.exec(path)
        if (req.method === 'GET' && match !== null) {
            const workspaceId = match[1]
            const kind = artifactKindOf(match[2])
            const hash = match[3]
            if (kind === null || workspaceId === undefined || hash === undefined) {
                sendText(res, 404, 'not found')
                return
            }
            const cwd = resolveCwd(workspaceId)
            if (cwd === null) {
                sendText(res, 404, '未知的工作区')
                return
            }
            const html = await learning.filesFor(cwd).readArtifactHtml(kind, hash)
            if (html === null) {
                sendText(res, 404, 'artifact not found')
                return
            }
            sendText(res, 200, injectIntoHtml(html), 'text/html; charset=utf-8')
            return
        }

        sendText(res, 404, 'not found')
    }

    // 前缀路由：webServer 保证只把 /learning 与 /learning/* 交给本 handler
    ctx.effect(() => ctx.webServer.register({
        kind: 'prefix', path: LEARNING_ROUTE_PREFIX, handler: (req, res) => {
            void handle(req, res).catch((error: unknown) => {
                ctx.logger.warn(`dvl: learning route error: ${error instanceof Error ? error.message : String(error)}`)
                if (!res.headersSent) sendJson(res, 500, {error: error instanceof Error ? error.message : String(error)})
                else res.destroy()
            })
        }
    }), 'dvl: /learning routes')
}
