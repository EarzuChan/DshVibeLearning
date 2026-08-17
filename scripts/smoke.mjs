import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import LearningService from '/Users/earzuchan/Documents/Sources/DshVibeLearning/lib/learning/index.js'
import { installLearningRoutes } from '/Users/earzuchan/Documents/Sources/DshVibeLearning/lib/web/index.js'
import { workspaceIdOf, contentHash } from '/Users/earzuchan/Documents/Sources/DshVibeLearning/lib/shared/hash.js'

const ws = await mkdtemp(join(tmpdir(), 'dvl-ws-'))
const ctx = new Context()
ctx.provide('logger', { info: () => {}, warn: console.warn, error: console.error })
const config = { dataDir: await mkdtemp(join(tmpdir(), 'dvl-data-')) }
await ctx.plugin(LearningService, config)
const service = ctx.learning
// 真 WebServer：port 0 让 OS 分配，验证 DVL 路由与 URL 构造对任意端口的适应性
await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
ctx.inject(['webServer', 'learning'], scope => installLearningRoutes(scope))
await new Promise(r => setTimeout(r, 300))
const PORT = ctx.webServer.port

const files = service.filesFor(ws)
await files.ensureRoot()
const html = '<html><head></head><body><h1>lesson</h1><button onclick="window.DVL.submit({q:[1,null,\"x\"]})">submit</button></body></html>'
const hash = contentHash(html)
const artifactPath = join(ws, '.dsh/learning/lessons', hash, 'index.html')
await mkdir(join(ws, '.dsh/learning/lessons', hash), { recursive: true })
await writeFile(artifactPath, html)
service.registerWorkspace(ws)
const wsId = workspaceIdOf(ws)
const base = `http://127.0.0.1:${PORT}/learning/${wsId}/lessons/${hash}`

async function expectThrow(label, fn, re) {
  try {
    await fn()
    console.log(label + ': FAIL (no throw)')
  } catch (error) {
    console.log(label + ':', re.test(error instanceof Error ? error.message : String(error)))
  }
}

// 1. run creation + resume (same callId) + reattempt (new callId)
const d1 = await service.createOrResumeRun(ws, 'lesson', 'lesson-1', artifactPath, 'call-1', '第一课')
const d1r = await service.createOrResumeRun(ws, 'lesson', 'lesson-1', artifactPath, 'call-1', '第一课')
const d2 = await service.createOrResumeRun(ws, 'lesson', 'lesson-1', artifactPath, 'call-2', '第一课')
const d3 = await service.createOrResumeRun(ws, 'lesson', 'lesson-1', artifactPath, 'call-3', '第一课')
const d4 = await service.createOrResumeRun(ws, 'lesson', 'lesson-1', artifactPath, 'call-4', '第一课')
const d5 = await service.createOrResumeRun(ws, 'lesson', 'lesson-1', artifactPath, 'call-5', '第一课')
console.log('RUNS:', d1.runId === d1r.runId, d1.runId !== d2.runId, d1.kind, d1.category)

// 2. descriptor resolver
console.log('DESCRIPTOR:', service.resolveDescriptor(ws, 'call-1')?.runId === d1.runId, service.resolveDescriptor('/bogus', 'call-1') === null)

// 3. run URL serves with bridge, no __DVL_TARGET__
const served = await (await fetch(d1.url)).text()
console.log('RUN_SERVE:', served.includes('/learning/bridge.js'), !served.includes('__DVL_TARGET__'))

// 4. bridge actually executes: relative ./submit + pure payload body (no mechanism fields)
const bridgeJs = await (await fetch(`http://127.0.0.1:${PORT}/learning/bridge.js`)).text()
let captured = null
const bridgeCtx = {
  window: {},
  fetch: (url, opts) => { captured = { url, opts }; return Promise.resolve({ json: () => Promise.resolve({ ok: true }) }) },
}
runInNewContext(bridgeJs, bridgeCtx, { filename: 'bridge.js' })
const bridgePayload = { q: [1, null, 'x'] }
await bridgeCtx.window.DVL.submit(bridgePayload)
console.log('BRIDGE:', captured.url === './submit', captured.opts.method === 'POST', captured.opts.body === JSON.stringify(bridgePayload), captured.opts.headers['Content-Type'] === 'application/json')

// 5. iframe + standalone resolve ./submit to the same run-scoped endpoint
const submitPath = new URL('./submit', d1.url).pathname
console.log('SUBMIT_PATH:', submitPath === `/learning/${wsId}/lessons/${hash}/runs/${d1.runId}/submit`, submitPath.includes(d1.runId))

// 6. preview is read-only: no run segment, its submit is rejected
const preview = await (await fetch(`${base}/index.html`)).text()
const previewSubmit = await fetch(`${base}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nope: true }) })
console.log('PREVIEW_READONLY:', preview.includes('/learning/bridge.js'), !preview.includes('/runs/'), previewSubmit.status === 403)

// 7. run-scoped opaque submit: body is the raw payload, preserved verbatim
const payload = { answers: ['a', 1, null, { ok: true }], notes: 'raw' }
const submit = await fetch(`${base}/runs/${d1.runId}/submit`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})
const submitBody = await submit.json()
console.log('SUBMIT:', submit.status, submitBody.ok === true, submitBody.alreadySubmitted === false)

// 8. idempotent duplicate POST: not overwritten
const dup = await fetch(`${base}/runs/${d1.runId}/submit`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify('DIFFERENT'),
})
const dupBody = await dup.json()
const result = await files.readResult('lesson', hash, d1.runId)
console.log('IDEMPOTENT:', dupBody.alreadySubmitted === true, JSON.stringify(result.payload) === JSON.stringify(payload))

// 9. concurrent same-run submit: exactly one winner, both see the same durable result
const [cA, cB] = await Promise.all([
  service.submit(ws, 'lesson', hash, d3.runId, { which: 'A' }),
  service.submit(ws, 'lesson', hash, d3.runId, { which: 'B' }),
])
const winners = [cA, cB].filter(r => !r.alreadySubmitted).length
const dupes = [cA, cB].filter(r => r.alreadySubmitted).length
console.log('CONCURRENT_IDEMPOTENT:', winners === 1, dupes === 1, JSON.stringify(cA.result.payload) === JSON.stringify(cB.result.payload))

// 10. null payload preserved exactly
await service.submit(ws, 'lesson', hash, d2.runId, null)
const nullResult = await files.readResult('lesson', hash, d2.runId)
console.log('NULL_PAYLOAD:', nullResult.payload === null)

// 11. run-aware get_result (explicit run + latest)
const explicit = await service.getResult(ws, 'lesson', hash, d1.runId)
const latest = await service.getResult(ws, 'lesson', hash)
console.log('GET_RESULT:', explicit.runId === d1.runId, latest !== null && typeof latest.runId === 'string')

// 12. present aligns with a durable result that already landed (no timeout)
const immediate = await service.present(ws, 'lesson', hash, d1.runId, { timeoutMs: 5000 })
console.log('PRESENT_ALREADY_SUBMITTED:', immediate.kind === 'result', immediate.result?.runId === d1.runId)

// 13. in-band present resolves via submit (registered before the write)
const pendingPromise = service.present(ws, 'lesson', hash, d4.runId, { timeoutMs: 8000 })
setTimeout(async () => { await service.submit(ws, 'lesson', hash, d4.runId, { again: true }) }, 100)
const outcome = await pendingPromise
console.log('INBAND:', outcome.kind, outcome.kind === 'result' ? outcome.result.runId === d4.runId : outcome.reason)

// 14. save_feedback: opaque report wrapped + replace + requires result
const feedback = await service.saveFeedback(ws, 'lesson', hash, d1.runId, { markdown: 'good job', analysis: { gaps: [] } })
console.log('FEEDBACK_SAVE:', feedback.runId === d1.runId, feedback.payload.markdown === 'good job')
await service.saveFeedback(ws, 'lesson', hash, d1.runId, { markdown: 'revised' })
const feedback2 = await files.readFeedback('lesson', hash, d1.runId)
console.log('FEEDBACK_REPLACE:', feedback2.payload.markdown === 'revised')
await expectThrow('FEEDBACK_NO_RESULT', () => service.saveFeedback(ws, 'lesson', hash, d5.runId, null), /has no result yet/)

// 15. review plan: source validation (exists / has result / belongs to lesson) + idempotency
const proposal = await service.computeReviewPlan(ws, 'lesson-1', 'good', 'lesson', hash, d1.runId, '掌握不错')
console.log('REVIEW_PROPOSAL:', proposal.alreadyApplied === false, typeof proposal.due === 'string')
await expectThrow('REVIEW_WRONG_LESSON', () => service.computeReviewPlan(ws, 'lesson-2', 'good', 'lesson', hash, d1.runId), /belongs to lesson 'lesson-1'/)
await expectThrow('REVIEW_UNKNOWN_RUN', () => service.computeReviewPlan(ws, 'lesson-1', 'good', 'lesson', hash, 'no-such-run-id'), /unknown source run/)
await expectThrow('REVIEW_NO_RESULT', () => service.computeReviewPlan(ws, 'lesson-1', 'good', 'lesson', hash, d5.runId), /has no result yet/)
const card = await service.commitReviewPlan(ws, 'lesson-1', 'good', 'lesson', hash, d1.runId, '掌握不错')
const proposal2 = await service.computeReviewPlan(ws, 'lesson-1', 'hard', 'lesson', hash, d1.runId)
console.log('REVIEW_COMMIT:', card.history.length === 1, card.history[0].rating === 'good', proposal2.alreadyApplied === true)
await expectThrow('REVIEW_IDEMPOTENT', () => service.commitReviewPlan(ws, 'lesson-1', 'hard', 'lesson', hash, d1.runId), /already applied/)

// 16. state API surfaces run history + learningDirExists
const state = await (await fetch(`http://127.0.0.1:${PORT}/learning/api/state?cwd=${encodeURIComponent(ws)}`)).json()
const lesson = state.lessons.find(l => l.hash === hash)
console.log('STATE:', state.workspaceId === wsId, lesson.runs.length === 5, lesson.runs.filter(r => r.hasResult).length === 4)
console.log('STATE_LEARNING_DIR:', state.learningDirExists === true)

// 17. 全局笔记独立端点（不依赖 workspace）
const notesGet = await fetch(`http://127.0.0.1:${PORT}/learning/api/notes`)
const notesBody = await notesGet.json()
console.log('NOTES_ENDPOINT:', notesGet.status === 200, Array.isArray(notesBody.folders), Array.isArray(notesBody.notes))

// 18. 投影折叠：dvlLearning 单向阀（空日志 → 未进入；feedback/record 进入标记 → entered 且幂等）
const { dvlLearningProjection } = await import('../lib/learning/projection.js')
const { learningEnteredText } = await import('../lib/shared/learning-event.js')
const emptySnap = dvlLearningProjection.view(dvlLearningProjection.apply(dvlLearningProjection.init(), { type: 'other', data: {} }))
const enteredState = dvlLearningProjection.apply(dvlLearningProjection.init(), { type: 'feedback/record', data: { text: learningEnteredText('2026-08-17T00:00:00.000Z') } })
const enteredAgain = dvlLearningProjection.apply(enteredState, { type: 'feedback/record', data: { text: learningEnteredText('2099-01-01T00:00:00.000Z') } })
const enteredSnap = dvlLearningProjection.view(enteredState)
const againSnap = dvlLearningProjection.view(enteredAgain)
console.log('PROJECTION:', emptySnap.entered === false, enteredSnap.entered === true, enteredSnap.enteredAt === '2026-08-17T00:00:00.000Z', againSnap.enteredAt === enteredSnap.enteredAt)

console.log('SMOKE OK')
process.exit(0)
