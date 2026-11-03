// DVL HTTP：无状态工件页面、Run 终局、前端查询和意图投递

import type {IncomingMessage, ServerResponse} from 'node:http'
import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {LearningService} from '../core/index.ts'
import type {DataChange, DataResetSignal} from '../core/data-change-bus.ts'
import {isLearningWorkspace, isValidArtifactId, isValidRunId, LEARNING_DIR} from '../core/files.ts'
import {generateWorkspaceHashIdOf} from '../util/identifiers.ts'
import {findOutlineLesson, outlineArtifactIds} from '../core/outline.ts'
import {artifactKindOf} from '../shared/artifacts.ts'
import type {AbortRunRequest, DeleteLearningEntityRequest, DirectRunRequest, InbandPresentRequest, LearningDataDto} from '../shared/api.ts'
import {CORDIS_EFFECT_BACKEND_ROUTES, DVL_SERVER_ROUTE_PREFIX} from '../shared/constants.ts'
import {dueReviewSessionTitle, ownerOutlineIdOf, presentSessionTitle, renderDueReviewInstruction, renderPresentInstruction, resolveArtifactOwner, type PanelSessionContext} from '../core/panel-intent.ts'
import type {NoteAccess} from '../shared/model.ts'
import {getWorkspaceCwdOrNullByItsHashId, recordWorkspaceHashIdByGeneratingItFromItsCwd} from './workspace-hash-id-related.ts'

const MAX_BODY_BYTES = 10 * 1024 * 1024

// 工件页一律以 CSP sandbox 隔离成不透明源：即使被直接打开，也读不到宿主的 cookie、存储和同源接口
const ARTIFACT_PAGE_HEADERS = {'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-modals allow-popups', 'Cache-Control': 'no-store'}

// Run 提交/放弃来自不透明源的工件页，只对这两个端点开放跨源，凭据是 Run 路径本身
const RUN_ACTION_CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600'}

const ARTIFACT_ID = '[a-f0-9]{16}'
const RUN_ACTION_PATTERN = new RegExp(`^/learning/([a-f0-9]{12})/(lessons|reviews|quizzes)/(${ARTIFACT_ID})/runs/([a-z0-9_-]{1,128})/(submit|abort)$`, 'iu')
const RUN_PAGE_PATTERN = new RegExp(`^/learning/([a-f0-9]{12})/(lessons|reviews|quizzes)/(${ARTIFACT_ID})/runs/([a-z0-9_-]{1,128})/index\\.html$`, 'iu')
const PREVIEW_PATTERN = new RegExp(`^/learning/([a-f0-9]{12})/(lessons|reviews|quizzes)/(${ARTIFACT_ID})/index\\.html$`, 'iu')
const THEME_CSS = `:root { --dvl-font: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
body.dvl-artifact { font-family: var(--dvl-font); margin: 0; line-height: 1.6; }`
const BRIDGE_JS = `(function () {
    window.DVL = {submit: function (payload) {
        return fetch("./submit", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload === undefined ? null : payload)}).then(function (response) { return response.json() })
    }}
})()`

function injectIntoHtml(html: string, writable: boolean): string {
    const injection = `<link rel="stylesheet" href="/learning/theme.css">${writable ? '\n<script src="/learning/bridge.js"></script>' : ''}`
    const headClose = /<\/head>/iu.exec(html)
    if (headClose !== null) return `${html.slice(0, headClose.index)}${injection}\n${html.slice(headClose.index)}`
    return `${injection}\n${html}`
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
    const body = JSON.stringify(value)
    res.writeHead(status, {...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body)})
    res.end(body)
}

function sendText(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8', headers: Record<string, string> = {}): void {
    res.writeHead(status, {...headers, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body)})
    res.end(body)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name]
    return Array.isArray(value) ? value[0] : value
}

// 没有官方 Connection 服务时的兜底：只放行回环 Host，拒绝浏览器标明的跨站请求
function fallbackRejection(req: IncomingMessage): 403 | undefined {
    const host = (headerOf(req, 'host') ?? '').replace(/:\d+$/u, '').replace(/^\[|\]$/gu, '')
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') return 403
    return headerOf(req, 'sec-fetch-site') === 'cross-site' ? 403 : undefined
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
            if (chunks.length === 0) return resolve({})
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

// 伟大安装点
export function installLearningRoutes(ctx: Context, learning: LearningService): void {
    // 这个**的确需要**CWD先有所被记住。但我觉得这是合理的，因为一般用户，在 UI 上也是先看到这个工作区（这就隐含已记住其了），再去想办法用它的端点服务。故目前尚算合理
    const resolveCwd = (workspaceId: string): string | null => getWorkspaceCwdOrNullByItsHashId(ctx, workspaceId)

    // 学习面板的意图投递：目标会话（含前端刚新建的）由核心负责等待上线、继承模型、命名与进入学习
    const deliverIntent = async (body: {readonly sessionId?: unknown; readonly sourceSessionId?: unknown; readonly outlineMode?: unknown; readonly freshSession?: unknown}, summary: string, outlineId: string | null, sessionTitle: string, build: (session: PanelSessionContext) => string): Promise<{ok: true; sessionId: string}> => {
        const sessionId = asString(body.sessionId)
        const mode = body.outlineMode === 'switch' || body.outlineMode === 'keep' ? body.outlineMode : 'auto'

        await learning.deliverPanelIntent(sessionId, asString(body.sourceSessionId), summary, outlineId === null ? null : {id: outlineId, mode}, build, body.freshSession === true ? sessionTitle : null)
        return {ok: true, sessionId}
    }

    // 学习 API 先过官方的 Host/Origin 与浏览器鉴权；写请求另需自定义头
    const rejectionOf = (req: IncomingMessage): number | undefined => {
        const connection = ctx.get('connection')
        const rejection = connection === undefined ? fallbackRejection(req) : connection.requestRejection(req)
        if (rejection !== undefined) return rejection
        return req.method === 'POST' && headerOf(req, 'x-dvl') !== '1' ? 403 : undefined
    }

    // 核心处理。伟大的“无状态随时斥候”
    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const path = url.pathname

        if (req.method === 'GET' && path === '/learning/theme.css') return sendText(res, 200, THEME_CSS, 'text/css; charset=utf-8', {'Access-Control-Allow-Origin': '*'})
        if (req.method === 'GET' && path === '/learning/bridge.js') return sendText(res, 200, BRIDGE_JS, 'application/javascript; charset=utf-8', {'Access-Control-Allow-Origin': '*'})

        const runAction = RUN_ACTION_PATTERN.exec(path)
        if (req.method === 'OPTIONS' && runAction !== null) {
            res.writeHead(204, RUN_ACTION_CORS)
            res.end()
            return
        }

        if (req.method === 'POST' && runAction !== null) {
            const cwd = resolveCwd(runAction[1] ?? '')
            const kind = artifactKindOf(runAction[2])
            const artifactId = runAction[3]
            const runId = runAction[4]
            if (cwd === null || kind === null || artifactId === undefined || runId === undefined || !isValidRunId(runId)) return sendJson(res, 404, {outcome: 'error', detail: 'Run 目标无效'}, RUN_ACTION_CORS)
            const ref = {cwd, kind, artifactId, runId}
            const body = await readBody(req)
            const outcome = runAction[5] === 'submit' ? {state: 'completed' as const, payload: body} : {state: 'aborted' as const, ...((body as {reason?: unknown}).reason === undefined ? {} : {reason: asString((body as {reason?: unknown}).reason)})}
            if (!await learning.runs.exists(ref)) return sendJson(res, 404, {outcome: 'error', detail: 'Run 不存在'}, RUN_ACTION_CORS)

            const finished = await learning.finishRun(ref, outcome)
            return sendJson(res, 200, {outcome: finished.outcome.state, alreadyFinished: finished.alreadyFinished}, RUN_ACTION_CORS)
        }

        if (path.startsWith('/learning/api/')) {
            const rejection = rejectionOf(req)
            if (rejection !== undefined) {
                ctx.logger.warn(`拒绝学习 API 请求（${rejection}）：${req.method ?? ''} ${path}`)
                return sendJson(res, rejection, {error: '请求未通过鉴权'})
            }
        }

        if (req.method === 'GET' && path === '/learning/api/present/live') {
            const cwd = url.searchParams.get('cwd')
            const callId = url.searchParams.get('callId')
            if (cwd === null || callId === null) return sendJson(res, 400, {error: '必须提供 cwd 和 callId'})
            const descriptor = await learning.livePresent(cwd, callId)
            return descriptor === null ? sendJson(res, 404, {error: '该 Tool Call 当前没有 In-band Present'}) : sendJson(res, 200, descriptor)
        }

        // ---这俩私家高级交互弹窗---

        if (req.method === 'GET' && path === '/learning/api/interactions/stream') {
            const sessionId = url.searchParams.get('sessionId')
            if (sessionId === null || sessionId.length === 0) return sendJson(res, 400, {error: '必须提供 sessionId'})
            res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive'})
            res.write(': connected\n\n')
            const send = (event: unknown): void => { res.write(`data: ${JSON.stringify(event)}\n\n`) }
            const dispose = learning.interactions.subscribe((targetSessionId, event) => { if (targetSessionId === sessionId) send(event) })
            for (const interaction of learning.interactions.pendingFor(sessionId)) send({type: 'requested', interaction})
            const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000)
            heartbeat.unref?.()
            req.on('close', () => { clearInterval(heartbeat); dispose() })
            return
        }

        const interactionResponse = /^\/learning\/api\/interactions\/([^/]+)\/respond$/u.exec(path)
        if (req.method === 'POST' && interactionResponse !== null) {
            const interactionId = interactionResponse[1]
            const body = await readBody(req) as {readonly sessionId?: unknown; readonly optionId?: unknown}
            if (interactionId === undefined || typeof body.sessionId !== 'string' || typeof body.optionId !== 'string') return sendJson(res, 400, {error: '交互响应无效'})
            try {
                learning.interactions.respond(interactionId, body.sessionId, body.optionId)
                return sendJson(res, 200, {ok: true})
            } catch (error: unknown) {
                return sendJson(res, 409, {error: error instanceof Error ? error.message : String(error)})
            }
        }

        if (req.method === 'POST' && path === '/learning/api/runs') {
            const body = await readBody(req) as Partial<DirectRunRequest>
            const cwd = resolveCwd(asString(body.workspaceId))
            const kind = artifactKindOf(asString(body.category))
            const artifactId = asString(body.artifactId)
            if (cwd === null || kind === null || !isValidArtifactId(artifactId)) return sendJson(res, 400, {error: '工件目标无效'})
            const run = await learning.obtainDirectRun(cwd, kind, artifactId)
            return sendJson(res, 200, await learning.describeRun(run))
        }

        if (req.method === 'POST' && path === '/learning/api/runs/abort') {
            const body = await readBody(req) as Partial<AbortRunRequest>
            const cwd = resolveCwd(asString(body.workspaceId))
            const kind = artifactKindOf(asString(body.category))
            const artifactId = asString(body.artifactId)
            const runId = asString(body.runId)
            if (cwd === null || kind === null || !isValidArtifactId(artifactId) || !isValidRunId(runId)) return sendJson(res, 400, {error: 'Run 目标无效'})
            const finished = await learning.finishRun({cwd, kind, artifactId, runId}, {state: 'aborted', ...(body.reason === undefined ? {} : {reason: body.reason})})
            return sendJson(res, 200, {outcome: finished.outcome.state, alreadyFinished: finished.alreadyFinished})
        }

        if (req.method === 'POST' && path === '/learning/api/delete') {
            const body = await readBody(req) as Partial<DeleteLearningEntityRequest> & {readonly workspaceId?: unknown}
            const cwd = resolveCwd(asString(body.workspaceId))
            if (cwd === null) return sendJson(res, 404, {error: '未知的工作区'})
            if (body.target === 'outline') await learning.deleteOutline(cwd, asString(body.id))
            else if (body.target === 'review-plan') await learning.deleteReviewPlan(cwd, asString(body.id), body.preserveArtifacts === true)
            else if (body.target === 'artifact') {
                const kind = artifactKindOf(asString(body.category))
                if (kind === null) return sendJson(res, 400, {error: '工件类型无效'})
                await learning.deleteArtifact(cwd, kind, asString(body.artifactId))
            } else return sendJson(res, 400, {error: '删除目标无效'})
            return sendJson(res, 200, {ok: true})
        }

        if (req.method === 'GET' && path === '/learning/api/state') {
            const cwdParam = url.searchParams.get('cwd')
            const cwd = cwdParam ?? resolveCwd(url.searchParams.get('workspaceId') ?? '')
            if (cwd === null) return sendJson(res, 404, {error: '未知的工作区'})
            recordWorkspaceHashIdByGeneratingItFromItsCwd(cwd)

            const outlines = await learning.listOutlines(cwd)
            const reviewPlans = await learning.reviewPlansFor(cwd).list()
            const temporaryReviews = await learning.reviewPlansFor(cwd).temporaryManifest()
            const lessons = await learning.listArtifacts(cwd, 'lesson')
            const references = new Set<string>()
            for (const outline of outlines) for (const artifactId of outlineArtifactIds(outline)) references.add(artifactId)
            const data: LearningDataDto = {outlines, reviewPlans, temporaryReviews, orphanLessonIds: lessons.filter(artifact => !references.has(artifact.artifactId)).map(artifact => artifact.artifactId), lessons, reviews: await learning.listArtifacts(cwd, 'review'), quizzes: await learning.listArtifacts(cwd, 'quiz')}
            return sendJson(res, 200, data)
        }

        if (req.method === 'GET' && path === '/learning/api/changes') {
            const lastEventId = Array.isArray(req.headers['last-event-id']) ? req.headers['last-event-id'][0] : req.headers['last-event-id']
            const lastId = Number.parseInt(url.searchParams.get('since') ?? lastEventId ?? '0', 10)
            const changes = Number.isFinite(lastId) ? learning.dataChanges.eventsSince(lastId) : null
            res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive'})
            res.write(': connected\n\n')
            if (changes === null) {
                const reset = learning.dataChanges.resetSignal()
                res.write(`id: ${reset.id}\ndata: ${JSON.stringify(reset)}\n\n`)
            } else for (const change of changes) res.write(`id: ${change.id}\ndata: ${JSON.stringify(change)}\n\n`)
            const send = (change: DataChange | DataResetSignal): void => { res.write(`id: ${change.id}\ndata: ${JSON.stringify(change)}\n\n`) }
            const dispose = learning.dataChanges.subscribe(send)
            const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000)
            heartbeat.unref?.()
            req.on('close', () => { clearInterval(heartbeat); dispose() })
            return
        }

        if (req.method === 'GET' && path === '/learning/api/workspace') {
            const cwd = url.searchParams.get('cwd')
            if (cwd === null || cwd.length === 0) return sendJson(res, 400, {error: '需要提供 cwd'})
            recordWorkspaceHashIdByGeneratingItFromItsCwd(cwd)
            return sendJson(res, 200, {cwd, workspaceId: generateWorkspaceHashIdOf(cwd), isLearningWorkspace: await isLearningWorkspace(cwd)})
        }

        if (req.method === 'GET' && path === '/learning/api/notes') return sendJson(res, 200, learning.notes.snapshot())
        if (req.method === 'POST' && path === '/learning/api/notes') {
            const body = await readBody(req) as Record<string, unknown>
            const action = asString(body.action)
            const notes = learning.notes
            switch (action) {
                case 'folder:add': return sendJson(res, 200, await notes.addFolder(asString(body.name)))
                case 'folder:rename': await notes.renameFolder(asString(body.folderId), asString(body.name)); return sendJson(res, 200, {ok: true})
                case 'folder:delete': await notes.deleteFolder(asString(body.folderId)); return sendJson(res, 200, {ok: true})
                case 'note:add': return sendJson(res, 200, await notes.addNote({folderId: asString(body.folderId), title: asString(body.title), markdown: asString(body.markdown), tags: asTags(body.tags), access: asAccess(body.access)}))
                case 'note:update': return sendJson(res, 200, await notes.updateNote(asString(body.noteId), {...(typeof body.title === 'string' ? {title: body.title} : {}), ...(typeof body.markdown === 'string' ? {markdown: body.markdown} : {}), ...(Array.isArray(body.tags) ? {tags: asTags(body.tags)} : {}), ...(body.access === 'private' || body.access === 'readable' || body.access === 'readwrite' ? {access: asAccess(body.access)} : {}), ...(typeof body.folderId === 'string' ? {folderId: body.folderId} : {})}))
                case 'note:delete': await notes.deleteNote(asString(body.noteId)); return sendJson(res, 200, {ok: true})
                default: return sendJson(res, 400, {error: `未知的笔记操作：${action}`})
            }
        }

        if (req.method === 'POST' && path === '/learning/api/inband-present') {
            const body = await readBody(req) as Partial<InbandPresentRequest>
            const cwd = resolveCwd(asString(body.workspaceId))
            if (cwd === null) return sendJson(res, 404, {ok: false, error: '未知的工作区'})

            if (body.intent === 'start-due-review') {
                const plan = await learning.reviewPlansFor(cwd).read(asString(body.planId))
                if (plan === null) return sendJson(res, 404, {ok: false, error: '复习计划不存在'})

                const outline = await learning.readOutline(cwd, plan.outlineId)
                return sendJson(res, 200, await deliverIntent(body, '开始到期复习', plan.outlineId, dueReviewSessionTitle(plan, outline), session => renderDueReviewInstruction(plan, outline, session)))
            }

            if (body.intent !== 'present-existing') return sendJson(res, 400, {ok: false, error: '会话内呈现的意图无效'})
            const kind = artifactKindOf(asString(body.category))
            const artifactId = asString(body.artifactId)
            if (kind === null || !isValidArtifactId(artifactId) || !await learning.artifactsFor(cwd).exists(kind, artifactId)) return sendJson(res, 404, {ok: false, error: '工件不存在'})
            const runId = body.runId === undefined ? undefined : asString(body.runId)
            if (runId !== undefined && (!isValidRunId(runId) || !await learning.runs.exists({cwd, kind, artifactId, runId}) || await learning.runs.outcome({cwd, kind, artifactId, runId}) !== null)) return sendJson(res, 409, {ok: false, error: '指定的 Run 不是 Active'})
            const title = await learning.artifactsFor(cwd).title(kind, artifactId)
            const owner = resolveArtifactOwner(kind, artifactId, await learning.listOutlines(cwd), await learning.reviewPlansFor(cwd).list(), await learning.reviewPlansFor(cwd).temporaryManifest())
            const runs = await learning.runs.list(kind, artifactId, cwd)
            const artifactPath = learning.filesFor(cwd).artifactHtml(kind, artifactId)

            return sendJson(res, 200, await deliverIntent(body, `呈现工件「${title}」`, ownerOutlineIdOf(owner), presentSessionTitle(kind, title, owner), session => renderPresentInstruction({kind, title, path: artifactPath, ...(runId === undefined ? {} : {runId}), owner, runs, session})))
        }

        // Run 页面服务创建时冻结的副本，后续对工件的编辑不影响进行中的 Run
        const runPage = RUN_PAGE_PATTERN.exec(path)
        if (req.method === 'GET' && runPage !== null) {
            const cwd = resolveCwd(runPage[1] ?? '')
            const kind = artifactKindOf(runPage[2])
            const artifactId = runPage[3]
            const runId = runPage[4]
            if (cwd === null || kind === null || artifactId === undefined || runId === undefined) return sendText(res, 404, '未找到')
            const ref = {cwd, kind, artifactId, runId}
            if (!await learning.runs.exists(ref)) return sendText(res, 404, 'Run 不存在')
            if (await learning.runs.outcome(ref) !== null) return sendText(res, 410, 'Run 已终结')
            const html = await learning.runs.frozenHtml(ref)
            return html === null ? sendText(res, 404, '工件不存在') : sendText(res, 200, injectIntoHtml(html, true), 'text/html; charset=utf-8', ARTIFACT_PAGE_HEADERS)
        }

        // 只读预览凭后端签发的预览钥访问
        const preview = PREVIEW_PATTERN.exec(path)
        if (req.method === 'GET' && preview !== null) {
            const cwd = resolveCwd(preview[1] ?? '')
            const kind = artifactKindOf(preview[2])
            const artifactId = preview[3]
            if (cwd === null || kind === null || artifactId === undefined) return sendText(res, 404, '未找到')
            if (!learning.verifyPreviewKey(preview[1] ?? '', kind, artifactId, url.searchParams.get('k') ?? '')) return sendText(res, 403, '预览钥无效')

            const html = await learning.artifactsFor(cwd).readHtml(kind, artifactId)
            return html === null ? sendText(res, 404, '工件不存在') : sendText(res, 200, injectIntoHtml(html, false), 'text/html; charset=utf-8', ARTIFACT_PAGE_HEADERS)
        }

        sendText(res, 404, '未找到')
    }

    // 总入口点和兜底
    ctx.effect(() => ctx.webServer.register({kind: 'prefix', path: DVL_SERVER_ROUTE_PREFIX, handler: (req, res) => {
        void handle(req, res).catch((error: unknown) => {
            ctx.logger.warn(`学习路由处理失败：${error instanceof Error ? error.message : String(error)}`)
            if (!res.headersSent) sendJson(res, 500, {error: error instanceof Error ? error.message : String(error)})
            else res.destroy()
        })
    }}), CORDIS_EFFECT_BACKEND_ROUTES)
}
