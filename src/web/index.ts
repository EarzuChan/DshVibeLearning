/**
 * DVL artifact server (`learning-web`): serves authored WebApps over one
 * stable URL (iframe and external browser alike), injects the base theme and
 * the `window.DVL.submit` bridge, receives submissions over HTTP, and hosts
 * the GUI-facing JSON API (state + notes + in-band present).
 * @module dvl/learning-web
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as brandSessionId } from '@deepseek-ai/dsh-session'
import { CATEGORY_DIRS, isValidArtifactHash } from '../learning/files.ts'
import type { LearningService } from '../learning/index.ts'
import { workspaceIdOf } from '../shared/hash.ts'
import type { ArtifactKind, NoteAccess } from '../shared/types.ts'


const MAX_BODY_BYTES = 10 * 1024 * 1024

const THEME_CSS = [
  ':root { --dvl-font: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }',
  'body.dvl-artifact { font-family: var(--dvl-font); margin: 0; line-height: 1.6; }',
  '.dvl-slide { max-width: 860px; margin: 0 auto; padding: 32px 24px; }',
].join('\n')

const BRIDGE_JS = [
  '(function () {',
  '  function submit(result) {',
  '    return fetch("/learning/submit", {',
  '      method: "POST",',
  '      headers: { "Content-Type": "application/json" },',
  '      body: JSON.stringify(Object.assign({}, window.__DVL_TARGET__, { result: result })),',
  '    }).then(function (r) { return r.json(); });',
  '  }',
  '  window.DVL = { submit: submit };',
  '})();',
].join('\n')

function injectIntoHtml(html: string, target: { workspaceId: string; category: string; hash: string }): string {
  const injection = [
    '<link rel="stylesheet" href="/learning/theme.css">',
    '<script src="/learning/bridge.js"></script>',
    `<script>window.__DVL_TARGET__=${JSON.stringify(target)};</script>`,
  ].join('\n')
  const headClose = /<\/head>/iu.exec(html)
  if (headClose !== null) {
    return `${html.slice(0, headClose.index)}${injection}\n${html.slice(headClose.index)}`
  }
  const bodyOpen = /<body[^>]*>/iu.exec(html)
  if (bodyOpen !== null) {
    const at = bodyOpen.index + bodyOpen[0].length
    return `${html.slice(0, at)}\n${injection}\n${html.slice(at)}`
  }
  return `${injection}\n${html}`
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendText(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  })
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
const asAccess = (value: unknown): NoteAccess =>
  value === 'private' || value === 'readable' || value === 'readwrite' ? value : 'readable'

function categoryFromSegment(segment: string | undefined): ArtifactKind | null {
  if (segment === 'lessons') return 'lesson'
  if (segment === 'reviews') return 'review'
  if (segment === 'quizzes') return 'quiz'
  return null
}

/**
 * The GUI-facing backend. One server per plugin instance, bound to
 * 127.0.0.1 only; the port is plugin config.
 */
export function startArtifactServer(ctx: Context): void {
  const learning: LearningService = ctx.learning
  const port = learning.config.port ?? 4182

  const refreshWorkspaces = (): void => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return
    for (const workspace of registry.list()) learning.registerWorkspace(workspace.path)
  }

  const resolveCwd = (workspaceId: string): string | null => {
    refreshWorkspaces()
    return learning.resolveWorkspace(workspaceId)
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    void (async () => {
      try {
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
        if (req.method === 'POST' && path === '/learning/submit') {
          const body = await readBody(req) as { workspaceId?: unknown; category?: unknown; hash?: unknown; result?: unknown }
          const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
          const category = typeof body.category === 'string' ? body.category : ''
          const hash = typeof body.hash === 'string' ? body.hash : ''
          const kind = categoryFromSegment(category)
          if (kind === null || !isValidArtifactHash(hash)) {
            sendJson(res, 400, { ok: false, error: 'bad artifact target' })
            return
          }
          const cwd = resolveCwd(workspaceId)
          if (cwd === null) {
            sendJson(res, 404, { ok: false, error: 'unknown workspace' })
            return
          }
          const result = body.result
          if (typeof result !== 'object' || result === null || Array.isArray(result)) {
            sendJson(res, 400, { ok: false, error: 'result must be a JSON object' })
            return
          }
          const record = result as { targetId?: unknown; score?: unknown; payload?: unknown }
          const targetId = typeof record.targetId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(record.targetId)
            ? record.targetId
            : ''
          if (targetId === '') {
            sendJson(res, 400, { ok: false, error: 'result.targetId must be a safe non-empty id' })
            return
          }
          const score = typeof record.score === 'number' && Number.isFinite(record.score) ? record.score : undefined
          await learning.submit(cwd, kind, hash, { targetId, ...(score !== undefined ? { score } : {}), ...(record.payload !== undefined ? { payload: record.payload } : {}) })
          sendJson(res, 200, { ok: true })
          return
        }
        if (req.method === 'GET' && path.startsWith('/learning/api/state')) {
          const cwdParam = url.searchParams.get('cwd')
          let cwd: string | null = cwdParam !== null ? cwdParam : resolveCwd(url.searchParams.get('workspaceId') ?? '')
          if (cwd === null) {
            sendJson(res, 404, { error: 'unknown workspace' })
            return
          }
          learning.registerWorkspace(cwd)
          const files = learning.filesFor(cwd)
          const snapshot = await learning.snapshot(cwd)
          const outlines = []
          for (const outline of await learning.listOutlines(cwd)) {
            outlines.push({
              ...outline,
              active: outline.id === snapshot.activeOutlineId,
              nodeCount: outline.nodes.length,
            })
          }
          const cards = []
          for (const cardFile of await files.listCards()) {
            const card = cardFile.card as { due?: unknown }
            cards.push({
              lessonId: cardFile.lessonId,
              due: typeof card.due === 'string' ? card.due : null,
              history: cardFile.history,
            })
          }
          sendJson(res, 200, {
            workspaceId: snapshot.workspaceId,
            cwd,
            port,
            activeOutlineId: snapshot.activeOutlineId,
            outlines,
            cards,
            lessons: await files.listArtifacts('lesson'),
            reviews: await files.listArtifacts('review'),
            quizzes: await files.listArtifacts('quiz'),
            notes: learning.notes.snapshot(),
          })
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
                notes.renameFolder(asString(body.folderId), asString(body.name))
                sendJson(res, 200, { ok: true })
                return
              case 'folder:delete':
                notes.deleteFolder(asString(body.folderId))
                sendJson(res, 200, { ok: true })
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
                  ...(typeof body.title === 'string' ? { title: body.title } : {}),
                  ...(typeof body.markdown === 'string' ? { markdown: body.markdown } : {}),
                  ...(Array.isArray(body.tags) ? { tags: asTags(body.tags) } : {}),
                  ...(body.access === 'private' || body.access === 'readable' || body.access === 'readwrite' ? { access: asAccess(body.access) } : {}),
                  ...(typeof body.folderId === 'string' ? { folderId: body.folderId } : {}),
                }))
                return
              case 'note:delete':
                notes.deleteNote(asString(body.noteId))
                sendJson(res, 200, { ok: true })
                return
              default:
                sendJson(res, 400, { error: `unknown notes action '${action}'` })
                return
            }
          } catch (error: unknown) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
            return
          }
        }
        if (req.method === 'POST' && path === '/learning/api/inband-present') {
          const body = await readBody(req) as Record<string, unknown>
          const workspaceId = asString(body.workspaceId)
          const category = asString(body.category)
          const hash = asString(body.hash)
          const kind = categoryFromSegment(category)
          if (kind === null || !isValidArtifactHash(hash)) {
            sendJson(res, 400, { ok: false, error: 'bad artifact target' })
            return
          }
          const cwd = resolveCwd(workspaceId)
          if (cwd === null) {
            sendJson(res, 404, { ok: false, error: 'unknown workspace' })
            return
          }
          const meta = await learning.filesFor(cwd).readMeta(kind, hash)
          if (meta === null) {
            sendJson(res, 404, { ok: false, error: 'unknown artifact' })
            return
          }
          const instruction =
            `用户从学习面板对工件发起了一次 in-band 呈现（${kind}，hash ${hash}，标题「${meta.title}」）：`
            + `请调用 present_artifact(kind='${kind}', target_id='${meta.targetId}', path='${cwd}/.dsh/learning/${category}/${hash}/index.html', title='${meta.title}') `
            + '并走完小连招（present → 批改 → 反馈写入 feedback.json → 回复用户）。'
          const sessionId = asString(body.sessionId)
          let agent: Agent | undefined = sessionId.length > 0 ? ctx.agents.get(brandSessionId(sessionId)) : undefined
          if (agent !== undefined) {
            learning.notify(agent, instruction)
            sendJson(res, 200, { ok: true, mode: 'current-session', sessionId })
            return
          }
          // Experimental: drive the combo in a brand-new session of this workspace.
          try {
            const handle = await ctx.agents.create({
              sessionId: brandSessionId(randomUUID()) as SessionId,
              meta: { cwd },
            })
            handle.agent.session.append('learning/entered', { at: new Date().toISOString() })
            handle.agent.inject(createUserMessage({
              content: [{ type: 'text', text: instruction }],
              source: { kind: 'plugin', plugin: 'learning-web' },
            }))
            sendJson(res, 200, { ok: true, mode: 'new-session', sessionId: String(handle.agent.id) })
          } catch (error: unknown) {
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
          return
        }

        // Artifact HTML: /learning/<workspaceId>/<category>/<hash>/index.html
        const match = /^\/learning\/([a-f0-9]{12})\/(lessons|reviews|quizzes)\/([a-f0-9]{6,64})\/index\.html$/iu.exec(path)
        if (req.method === 'GET' && match !== null) {
          const workspaceId = match[1]
          const kind = categoryFromSegment(match[2])
          const hash = match[3]
          if (kind === null || workspaceId === undefined || hash === undefined) {
            sendText(res, 404, 'not found')
            return
          }
          const cwd = resolveCwd(workspaceId)
          if (cwd === null) {
            sendText(res, 404, 'unknown workspace')
            return
          }
          const html = await learning.filesFor(cwd).readArtifactHtml(kind, hash)
          if (html === null) {
            sendText(res, 404, 'artifact not found')
            return
          }
          sendText(res, 200, injectIntoHtml(html, { workspaceId, category: match[2], hash }), 'text/html; charset=utf-8')
          return
        }

        sendText(res, 404, 'not found')
      } catch (error: unknown) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    })()
  })

  server.on('error', (error: Error) => {
    ctx.logger.error(`dvl: artifact server failed on 127.0.0.1:${port}: ${error.message}`)
  })
  server.listen(port, '127.0.0.1', () => {
    ctx.logger.info(`dvl: artifact server on http://127.0.0.1:${port}`)
  })

  ctx.effect(() => () => {
    server.close()
  }, 'dvl.server()')
}

/** Compute the URL-facing workspace id (exported for the client). */
export function dvlWorkspaceId(cwd: string): string {
  return workspaceIdOf(cwd)
}

export { CATEGORY_DIRS }
