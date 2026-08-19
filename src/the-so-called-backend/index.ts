// TIPS，作用：工件架设 + 前端可调的API

import type {IncomingMessage, ServerResponse} from 'node:http'
import {randomUUID} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver' // 让 webServer 的 Context 声明合并对本文件可见
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {SessionId} from '@deepseek-ai/dsh-session'
import {SessionId as brandSessionId} from '@deepseek-ai/dsh-session'
import {LEARNING_DIR, isLearningWorkspace, isValidArtifactHash, isValidRunId} from '../core/files.ts'
import type {LearningService} from '../core/index.ts'
import {generateWorkspaceHashIdOf} from '../core/identifiers.ts'
import {recordWorkspaceHashIdByGeneratingItFromItsCwd, getWorkspaceCwdOrNullByItsHashId} from './workspace-hash-id-related.ts'
import {artifactKindOf} from '../shared/artifacts.ts'
import type {CardDto, InbandPresentRequest, LearningStateDto, OutlineDto} from '../shared/api.ts'
import type {NoteAccess} from '../shared/model.ts'
import {LEARNING_ROUTE_PREFIX} from '../shared/routes.ts'

const MAX_BODY_BYTES = 10 * 1024 * 1024

const THEME_CSS = `:root { --dvl-font: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
body.dvl-artifact { font-family: var(--dvl-font); margin: 0; line-height: 1.6; }
.dvl-slide { max-width: 860px; margin: 0 auto; padding: 32px 24px; }`

// 只负责提交原始 JSON，运行身份完全取自当前页面 URL
const BRIDGE_JS = `(function () {
    function submit(payload) {
        return fetch("./submit", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload === undefined ? null : payload)
        }).then(function (r) {
            return r.json()
        })
    }

    window.DVL = {submit: submit}
})()`

// 向工件 HTML 注入CSS、JS
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
                reject(new Error('请求正文过大'))
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
                reject(new Error(`JSON 请求正文无效：${error instanceof Error ? error.message : String(error)}`))
            }
        })

        req.on('error', reject)
    })
}

const asString = (value: unknown): string => typeof value === 'string' ? value : ''
const asTags = (value: unknown): string[] => Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
const asAccess = (value: unknown): NoteAccess => value === 'private' || value === 'readable' || value === 'readwrite' ? value : 'readable'

// ---

// 注册全部 /learning HTTP 路由
export function installLearningRoutes(ctx: Context): void {
    const learning: LearningService = ctx.learning

    const resolveCwd = (workspaceId: string): string | null => {
        return getWorkspaceCwdOrNullByItsHashId(ctx, workspaceId)
    }

    // TIPS：最高总伺服
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

        // ---TIPS：伺服提交/API调用---

        // TIPS：接收工件的活动 Run 的不透明提交
        const submitRunMatch = /^\/learning\/([a-f0-9]{12})\/(lessons|reviews|quizzes)\/([a-f0-9]{6,64})\/runs\/([a-z0-9_-]{1,128})\/submit$/iu.exec(path)
        if (req.method === 'POST' && submitRunMatch !== null) {
            const workspaceId = submitRunMatch[1]
            const kind = artifactKindOf(submitRunMatch[2])
            const hash = submitRunMatch[3]
            const runId = submitRunMatch[4]

            if (kind === null || workspaceId === undefined || hash === undefined || runId === undefined || !isValidRunId(runId)) {
                sendJson(res, 400, {ok: false, error: '运行目标无效'})
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

        // TIPS：只读预览，禁止提交
        const previewSubmitMatch = /^\/learning\/([a-f0-9]{12})\/(lessons|reviews|quizzes)\/([a-f0-9]{6,64})\/submit$/iu.exec(path)
        if (req.method === 'POST' && previewSubmitMatch !== null) {
            sendJson(res, 403, {ok: false, error: '只读预览无法提交，请先开始一次作答'})
            return
        }

        // 获取运行中的展示描述符
        if (req.method === 'GET' && path === '/learning/api/present/descriptor') {
            const cwdParam = url.searchParams.get('cwd')
            const callId = url.searchParams.get('callId') ?? ''

            if (cwdParam === null || callId.length === 0) {
                sendJson(res, 400, {ok: false, error: '必须提供 cwd 和 callId'})
                return
            }

            recordWorkspaceHashIdByGeneratingItFromItsCwd(cwdParam)

            const descriptor = learning.resolveDescriptor(cwdParam, callId)
            if (descriptor === null) {
                sendJson(res, 404, {ok: false, error: '该调用当前没有正在运行的工件展示'})
                return
            }

            sendJson(res, 200, descriptor)
            return
        }

        // TIPS：获取 GUI 学习状态
        if (req.method === 'GET' && path === '/learning/api/state') {
            const cwdParam = url.searchParams.get('cwd')
            let cwd: string | null = cwdParam !== null ? cwdParam : resolveCwd(url.searchParams.get('workspaceId') ?? '')

            if (cwd === null) {
                sendJson(res, 404, {error: '未知的工作区'})
                return
            }

            recordWorkspaceHashIdByGeneratingItFromItsCwd(cwd)

            const files = learning.filesFor(cwd)
            const learningDirExists = await files.currentIsLearningWorkspace()
            const outlines: OutlineDto[] = []
            for (const outline of learningDirExists ? await learning.listOutlines(cwd) : []) outlines.push({...outline, nodeCount: outline.nodes.length})

            const cards: CardDto[] = []
            for (const cardFile of learningDirExists ? await files.listCards() : []) {
                const card = cardFile.card as { due?: unknown }
                cards.push({lessonId: cardFile.lessonId, due: typeof card.due === 'string' ? card.due : card.due instanceof Date ? card.due.toISOString() : null, history: cardFile.history})
            }

            const state: LearningStateDto = {workspaceId: generateWorkspaceHashIdOf(cwd), cwd, learningDirExists, outlines, cards, lessons: await files.listArtifacts('lesson'), reviews: await files.listArtifacts('review'), quizzes: await files.listArtifacts('quiz'), notes: learning.notes.snapshot()}
            sendJson(res, 200, state)
            return
        }

        // 仅探测工作区是否存在学习目录
        if (req.method === 'GET' && path === '/learning/api/workspace') {
            const cwdParam = url.searchParams.get('cwd')

            if (cwdParam === null || cwdParam.length === 0) {
                sendJson(res, 400, {error: '需要提供 cwd'})
                return
            }

            recordWorkspaceHashIdByGeneratingItFromItsCwd(cwdParam)
            sendJson(res, 200, {cwd: cwdParam, isLearningWorkspace: await isLearningWorkspace(cwdParam)})
            return
        }

        // ---TIPS：笔记这一块---

        // 获取全部全局笔记
        if (req.method === 'GET' && path === '/learning/api/notes') {
            sendJson(res, 200, learning.notes.snapshot())
            return
        }

        // 修改全局笔记
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
                        sendJson(res, 200, notes.addNote({folderId: asString(body.folderId), title: asString(body.title), markdown: asString(body.markdown), tags: asTags(body.tags), access: asAccess(body.access)}))
                        return

                    case 'note:update':
                        sendJson(res, 200, notes.updateNote(asString(body.noteId), {...(typeof body.title === 'string' ? {title: body.title} : {}), ...(typeof body.markdown === 'string' ? {markdown: body.markdown} : {}), ...(Array.isArray(body.tags) ? {tags: asTags(body.tags)} : {}), ...(body.access === 'private' || body.access === 'readable' || body.access === 'readwrite' ? {access: asAccess(body.access)} : {}), ...(typeof body.folderId === 'string' ? {folderId: body.folderId} : {})}))
                        return

                    case 'note:delete':
                        await notes.deleteNote(asString(body.noteId))
                        sendJson(res, 200, {ok: true})
                        return

                    default:
                        sendJson(res, 400, {error: `未知的笔记操作：${action}`})
                        return
                }
            } catch (error: unknown) {
                sendJson(res, 400, {error: error instanceof Error ? error.message : String(error)})
                return
            }
        }

        // ---TIPS：GUI触发工件展示的处理点---

        // 从学习面板发起IN-BAND展示
        if (req.method === 'POST' && path === '/learning/api/inband-present') {
            const body = await readBody(req) as Partial<InbandPresentRequest>
            const workspaceId = asString(body.workspaceId)
            const category = asString(body.category)
            const hash = asString(body.hash)
            const kind = artifactKindOf(category)

            if (kind === null || !isValidArtifactHash(hash)) {
                sendJson(res, 400, {ok: false, error: '工件目标无效'})
                return
            }

            const cwd = resolveCwd(workspaceId)
            if (cwd === null) {
                sendJson(res, 404, {ok: false, error: '未知的工作区'})
                return
            }

            const meta = await learning.filesFor(cwd).readMeta(kind, hash)
            if (meta === null) {
                sendJson(res, 404, {ok: false, error: '未知的工件'})
                return
            }

            const instruction = `用户从学习面板对工件发起了一次带内呈现（${kind}，hash ${hash}，标题「${meta.title}」）：
请调用 present_artifact(kind='${kind}', target_id='${meta.targetId}', path='${cwd}/${LEARNING_DIR}/${category}/${hash}/index.html', title='${meta.title}')
并走完流程（present → 拿到 result → 批改 → save_feedback 保存报告 → 按需 update_review_plan → 回复用户）。`

            const sessionId = asString(body.sessionId)
            let agent: Agent | undefined = sessionId.length > 0 ? ctx.agents.get(brandSessionId(sessionId)) : undefined

            if (agent !== undefined) {
                learning.notify(agent, instruction)
                sendJson(res, 200, {ok: true, mode: 'current-session', sessionId})
                return
            }

            // TIPS：测试性。没有可复用会话时，新建会话执行
            try {
                const neoSession = await ctx.agents.create({sessionId: brandSessionId(randomUUID()) as SessionId, meta: {cwd}})
                await learning.enterVibeLearning(neoSession.agent, instruction) // 使之直接进入学习模式，并使用该指导来bootstrap模型
                sendJson(res, 200, {ok: true, mode: 'new-session', sessionId: String(neoSession.agent.id)})
            } catch (error: unknown) {
                sendJson(res, 500, {ok: false, error: error instanceof Error ? error.message : String(error)})
            }

            return
        }

        // ---TIPS：架设页面---

        // 展示活动 Run 页面
        const runMatch = /^\/learning\/([a-f0-9]{12})\/(lessons|reviews|quizzes)\/([a-f0-9]{6,64})\/runs\/([a-z0-9_-]{1,128})\/index\.html$/iu.exec(path)
        if (req.method === 'GET' && runMatch !== null) {
            const workspaceId = runMatch[1]
            const kind = artifactKindOf(runMatch[2])
            const hash = runMatch[3]
            const runId = runMatch[4]

            if (kind === null || workspaceId === undefined || hash === undefined || runId === undefined || !isValidRunId(runId)) {
                sendText(res, 404, '未找到')
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
                sendText(res, 404, '未找到对应运行')
                return
            }

            const html = await files.readArtifactHtml(kind, hash)
            if (html === null) {
                sendText(res, 404, '未找到对应工件')
                return
            }

            sendText(res, 200, injectIntoHtml(html), 'text/html; charset=utf-8')
            return
        }

        // 展示只读预览页面
        const match = /^\/learning\/([a-f0-9]{12})\/(lessons|reviews|quizzes)\/([a-f0-9]{6,64})\/index\.html$/iu.exec(path)
        if (req.method === 'GET' && match !== null) {
            const workspaceId = match[1]
            const kind = artifactKindOf(match[2])
            const hash = match[3]

            if (kind === null || workspaceId === undefined || hash === undefined) {
                sendText(res, 404, '未找到')
                return
            }

            const cwd = resolveCwd(workspaceId)
            if (cwd === null) {
                sendText(res, 404, '未知的工作区')
                return
            }

            const html = await learning.filesFor(cwd).readArtifactHtml(kind, hash)
            if (html === null) {
                sendText(res, 404, '未找到对应工件')
                return
            }

            sendText(res, 200, injectIntoHtml(html), 'text/html; charset=utf-8')
            return
        }

        sendText(res, 404, '未找到')
    }

    // TIPS：给 DSH 的 Server 搞里头
    ctx.effect(() => ctx.webServer.register({
        kind: 'prefix', path: LEARNING_ROUTE_PREFIX, handler: (req, res) => {
            void handle(req, res).catch((error: unknown) => {
                ctx.logger.warn(`学习路由处理失败：${error instanceof Error ? error.message : String(error)}`)

                if (!res.headersSent) sendJson(res, 500, {error: error instanceof Error ? error.message : String(error)})
                else res.destroy() // 不发回了
            })
        },
    }), 'dvl: /learning routes')
}
