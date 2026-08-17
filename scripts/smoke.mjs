import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LearningService from '/Users/earzuchan/Documents/Sources/DshVibeLearning/lib/learning/index.js'
import { startArtifactServer } from '/Users/earzuchan/Documents/Sources/DshVibeLearning/lib/web/index.js'
import { workspaceIdOf, contentHash } from '/Users/earzuchan/Documents/Sources/DshVibeLearning/lib/shared/hash.js'

const ws = await mkdtemp(join(tmpdir(), 'dvl-ws-'))
const ctx = new Context()
ctx.provide('logger', { info: () => {}, warn: console.warn, error: console.error })
const config = { port: 4199, dataDir: await mkdtemp(join(tmpdir(), 'dvl-data-')) }
await ctx.plugin(LearningService, config)
const service = ctx.learning
startArtifactServer(ctx)
await new Promise(r => setTimeout(r, 300))

const files = service.filesFor(ws)
await files.ensureRoot()
const html = '<html><head></head><body><h1>lesson</h1></body></html>'
const hash = contentHash(html)
await files.writeArtifact('lesson', hash, html)
await service.registerArtifact(ws, 'lesson', 'lesson-1', join(ws, '.dsh/learning/lessons', hash, 'index.html'), '第一课')
service.registerWorkspace(ws)
const wsId = workspaceIdOf(ws)

// 1. artifact URL serves with injection
const url = `http://127.0.0.1:4199/learning/${wsId}/lessons/${hash}/index.html`
const resp = await fetch(url)
const served = await resp.text()
console.log('SERVE:', resp.status, JSON.stringify(served.slice(0, 120)))

// 2. submit writes result.json
const submit = await fetch('http://127.0.0.1:4199/learning/submit', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workspaceId: wsId, category: 'lessons', hash, result: { targetId: 'lesson-1', score: 0.8, payload: { a: 1 } } }),
})
console.log('SUBMIT:', submit.status, JSON.stringify(await submit.json()))
const result = await files.readResult('lesson', hash)
console.log('RESULT_FILE:', JSON.stringify(result))
const outline = await service.listOutlines(ws)
console.log('OUTLINES:', outline.length)

// 3. state API
const state = await (await fetch(`http://127.0.0.1:4199/learning/api/state?cwd=${encodeURIComponent(ws)}`)).json()
console.log('STATE:', state.workspaceId === wsId, 'lessons:', state.lessons.length, 'notes:', state.notes.folders.length)

// 4. notes API + model filter
const folder = await (await fetch('http://127.0.0.1:4199/learning/api/notes', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'folder:add', name:'数学'}) })).json()
const note = await (await fetch('http://127.0.0.1:4199/learning/api/notes', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'note:add', folderId: folder.id, title:'笔记1', markdown:'# hi', tags:[`workspace:${wsId}`, 'outline:o1'], access:'readwrite'}) })).json()
console.log('NOTES:', folder.name, note.title, JSON.stringify(service.notes.filterForModel(`workspace:${wsId}`, ['outline:o1'])))

// 5. in-band present resolves via submit
const pendingPromise = service.present(ws, 'quiz', 'aabbcc', { timeoutMs: 8000 })
setTimeout(async () => { await service.submit(ws, 'quiz', 'aabbcc', { targetId: 'lesson-1', score: 0.5 }) }, 400)
const outcome = await pendingPromise
console.log('INBAND:', outcome.kind, outcome.kind === 'result' ? outcome.result.score : outcome.reason)
process.exit(0)
