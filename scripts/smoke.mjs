// 冒烟：只覆盖不依赖 DSH 宿主就能验证、又最容易悄悄坏掉的关键契约。跑在 lib 构建产物上：pnpm build && pnpm smoke

import assert from 'node:assert/strict'
import {mkdtemp, readFile, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import LearningService from '../lib/core/index.js'
import {dvlLearningProjection} from '../lib/core/projection.js'
import {renderSnapshot} from '../lib/core/prompt.js'
import {presentSessionTitle, renderPresentInstruction, resolveArtifactOwner} from '../lib/core/panel-intent.js'
import {installLearningRoutes} from '../lib/the-so-called-backend/index.js'
import {recordWorkspaceHashIdByGeneratingItFromItsCwd} from '../lib/the-so-called-backend/workspace-hash-id-related.js'
import {installLearningTools} from '../lib/tool/index.js'
import {generateWorkspaceHashIdOf} from '../lib/util/identifiers.js'

const results = []
async function check(name, fn) {
    try {
        await fn()
        results.push([name, true])
    } catch (error) {
        results.push([name, false])
        console.error(`✗ ${name}\n`, error)
    }
}

const ws = await mkdtemp(join(tmpdir(), 'dvl-ws-'))
const ctx = new Context()
await ctx.plugin(LearningService, {dataDir: await mkdtemp(join(tmpdir(), 'dvl-data-'))})
const learning = ctx.learning
assert.ok(learning !== undefined, '学习服务未能挂载')

// ---会话投影：插件记录的折叠---

const record = (type, data) => ({type: `plugin:dsh-vibe-learning/${type}`, ignorable: true, seq: 0, time: 0, data})
const fold = events => events.reduce((state, event) => dvlLearningProjection.apply(state, event), dvlLearningProjection.init())

await check('投影：进入单向、纲目后写后得、子代理归属只认第一条', () => {
    assert.deepEqual(fold([]), {entered: false, activeOutlineId: null, delegatedFrom: null})
    assert.deepEqual(fold([record('enter', {}), record('change-outline', {outlineId: 'a'}), record('change-outline', {outlineId: null}), record('enter', {})]), {entered: true, activeOutlineId: null, delegatedFrom: null})
    assert.equal(fold([record('delegate', {rootSessionId: 'r1'}), record('delegate', {rootSessionId: 'r2'})]).delegatedFrom, 'r1')
})

await check('投影：非 ignorable、非本插件或载荷无效的事件一律忽略', () => {
    assert.equal(fold([{type: 'plugin:dsh-vibe-learning/enter', data: {}}]).entered, false)
    assert.equal(fold([record('change-outline', {outlineId: 42})]).activeOutlineId, null)
    assert.equal(fold([{type: 'feedback/record', ignorable: true, data: {text: 'x'}}]).entered, false)
})

// ---快照文案---

await check('快照：激活纲目只列本纲目的到期复习', () => {
    const text = renderSnapshot({workspaceId: 'w', learningDirExists: true, activeOutlineId: 'math', outlines: [{id: 'math', title: '数学', phase: 'learning', dueReviewCount: 1}], currentLesson: null, dueReviews: [{planId: 'p', lessonId: 'l', lessonTitle: '数学第一课', dueAt: '2026-01-01T00:00:00.000Z'}]})
    assert.ok(text.includes('激活大纲：数学（learning）'))
    assert.ok(text.includes('数学第一课'))
})

// ---工件与 Run---

const HTML_V1 = '<html><head></head><body><h1>第一版</h1></body></html>'
const HTML_V2 = '<html><head></head><body><h1>第二版</h1></body></html>'

const allocated = await learning.allocateArtifact(ws, 'lesson')
const artifactId = allocated.artifactId
await writeFile(allocated.path, HTML_V1)

await check('工件：allocate 给出 16 位随机 hex 与对应路径，两次不重复', async () => {
    assert.match(artifactId, /^[a-f0-9]{16}$/u)
    assert.equal(allocated.path, learning.filesFor(ws).artifactHtml('lesson', artifactId))
    assert.notEqual((await learning.allocateArtifact(ws, 'lesson')).artifactId, artifactId)
})

const run = await learning.obtainDirectRun(ws, 'lesson', artifactId)
await writeFile(allocated.path, HTML_V2)

await check('Run：使用创建时的冻结副本，不受后续编辑影响', async () => {
    assert.equal(await learning.runs.frozenHtml(run), HTML_V1)
    assert.equal(await learning.runs.outcome(run), null)
})

await check('Run：终局只写一次', async () => {
    const extra = await learning.obtainDirectRun(ws, 'lesson', artifactId)
    const first = await learning.finishRun(extra, {state: 'completed', payload: {a: 1}})
    const second = await learning.finishRun(extra, {state: 'aborted'})
    assert.equal(first.alreadyFinished, false)
    assert.equal(second.alreadyFinished, true)
    assert.equal(second.outcome.state, 'completed')
})

await check('Run：别的进程留下的未终结 Run 读取时判为 aborted', async () => {
    const stale = await learning.obtainDirectRun(ws, 'lesson', artifactId)
    await writeFile(learning.filesFor(ws).runBootFile('lesson', artifactId, stale.runId), JSON.stringify({bootId: 'another-process'}))
    const outcome = await learning.runs.outcome(stale)
    assert.equal(outcome?.state, 'aborted')
    assert.ok(JSON.parse(await readFile(learning.filesFor(ws).outcomeFile('lesson', artifactId, stale.runId), 'utf8')).state === 'aborted')
})

// ---大纲：多会话修订与会话内呈现的情境---

const sessionA = {id: 'session-a'}
const sessionB = {id: 'session-b'}
const draft = await learning.normalizeOutline(ws, {title: '终端入门', tree: [{kind: 'lesson', title: '第一课'}, {kind: 'lesson', title: '第二课'}]}, null)
const [lesson1, lesson2] = draft.tree.map(node => node.id)
const savedByA = await learning.saveOutline(ws, draft, sessionA)

await check('大纲：写入递增修订号并记下写入会话', () => {
    assert.equal(savedByA.revision, 1)
    assert.equal(savedByA.lastWriterSessionId, 'session-a')
})

learning.markOutlineSeen(sessionB, ws, savedByA)
const advancedByB = await learning.updateOutlineWorkflow(ws, draft.id, 'learning', lesson1, sessionB)

await check('大纲：其他会话推进后，旧视角的写入被拒绝并要求先 get_outline', async () => {
    assert.equal(advancedByB.revision, 2)
    await assert.rejects(learning.updateOutlineWorkflow(ws, draft.id, 'qa', null, sessionA), error => error.message.includes('get_outline') && error.message.includes('session-b'))

    learning.markOutlineSeen(sessionA, ws, advancedByB)
    assert.equal((await learning.updateOutlineWorkflow(ws, draft.id, 'qa', null, sessionA)).revision, 3)
})

await check('快照：激活大纲被其他会话修改时提示以快照为准', () => {
    const text = renderSnapshot({workspaceId: 'w', learningDirExists: true, activeOutlineId: draft.id, outlines: [{id: draft.id, title: '终端入门', phase: 'qa', dueReviewCount: 0}], currentLesson: null, dueReviews: [], staleOutline: {writerSessionId: 'session-b', seenRevision: 1, revision: 3}})
    assert.ok(text.includes('会话 session-b') && text.includes('以本快照为准'))
})

await check('会话内呈现：按归属与会话大纲给出正常流程或回看', async () => {
    const lessonArtifact = await learning.allocateArtifact(ws, 'lesson')
    await writeFile(lessonArtifact.path, HTML_V1)
    await learning.updateOutlineWorkflow(ws, draft.id, 'learning', lesson2, null)
    await learning.updateOutlineArtifactBinding(ws, draft.id, lesson2, lessonArtifact.artifactId, null)

    const owner = resolveArtifactOwner('lesson', lessonArtifact.artifactId, await learning.listOutlines(ws), [], {rounds: []})
    assert.equal(owner.role, 'lesson')
    assert.equal(owner.lessonId, lesson2)

    const base = {kind: 'lesson', title: '第二课', path: lessonArtifact.path, owner, runs: []}
    const current = renderPresentInstruction({...base, session: {activeOutlineId: draft.id, activated: true, knowsOutline: false}})
    assert.ok(current.includes('第 2 课「第二课」') && current.includes('正常课程流程') && current.includes('已为本次呈现'))
    assert.ok(current.includes(`请先调用 get_outline(outline_id='${draft.id}')`) && current.includes('当前正是这一课'))
    assert.equal(current.split('第 2 课「第二课」').length, 2)

    const known = renderPresentInstruction({...base, session: {activeOutlineId: draft.id, activated: false, knowsOutline: true}})
    assert.ok(!known.includes('get_outline') && known.includes('请调用 present_artifact'))

    const elsewhere = renderPresentInstruction({...base, session: {activeOutlineId: 'other-outline', activated: false, knowsOutline: true}})
    assert.ok(elsewhere.includes('只是回看') && !elsewhere.includes('正常课程流程'))

    assert.equal(presentSessionTitle('lesson', '第二课', owner), '学习 · 第 2 课「第二课」')
})

await check('复习计划：刚立下时按半小时到一小时的学习步到期，而非几分钟后', async () => {
    const minutesUntil = prepared => (Date.parse(prepared.dueAt) - Date.now()) / 60000
    const good = minutesUntil(await learning.createReviewPlan(ws, {outlineId: draft.id, lessonId: lesson1, rating: 'good'}))
    const again = minutesUntil(await learning.createReviewPlan(ws, {outlineId: draft.id, lessonId: lesson1, rating: 'again'}))

    assert.ok(good > 55 && good <= 61, `good 应约 1 小时后到期，实际 ${good.toFixed(1)} 分钟`)
    assert.ok(again > 25 && again <= 31, `again 应约 30 分钟后到期，实际 ${again.toFixed(1)} 分钟`)
})

await check('会话内呈现：当前课程已过呈现阶段时按回看处理，且不称其为历史工件', async () => {
    await learning.updateOutlineWorkflow(ws, draft.id, 'qa', lesson2, null)

    const owner = resolveArtifactOwner('lesson', (await learning.readOutline(ws, draft.id)).artifactBindings[lesson2], await learning.listOutlines(ws), [], {rounds: []})
    const text = renderPresentInstruction({kind: 'lesson', title: '第二课', path: 'x', owner, runs: [], session: {activeOutlineId: draft.id, activated: false, knowsOutline: true}})
    assert.ok(text.includes('已过呈现阶段（qa）') && !text.includes('历史或非当前') && !text.includes('正常课程流程'))
})

// ---HTTP 路由：用替身 webServer 挂在真实 http 服务上---

let routeHandler
const routeCtx = {effect: fn => fn(), webServer: {register: route => { routeHandler = route.handler; return () => {} }}, logger: {info() {}, warn() {}}, get: () => undefined}
installLearningRoutes(routeCtx, learning)

const server = createServer((req, res) => routeHandler(req, res))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

recordWorkspaceHashIdByGeneratingItFromItsCwd(ws)
const wsId = generateWorkspaceHashIdOf(ws)
const runPath = `/learning/${wsId}/lessons/${artifactId}/runs/${run.runId}`

await check('路由：Run 页面带 CSP sandbox，内容为冻结副本并注入提交桥', async () => {
    const response = await fetch(`${origin}${runPath}/index.html`)
    const body = await response.text()
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-security-policy') ?? '', /^sandbox allow-scripts/u)
    assert.ok(body.includes('第一版') && body.includes('/learning/bridge.js'))
})

await check('路由：只读预览必须带有效预览钥', async () => {
    const summary = (await learning.listArtifacts(ws, 'lesson')).find(item => item.artifactId === artifactId)
    assert.ok(summary?.previewUrl.includes('?k='))
    assert.equal((await fetch(`${origin}/learning/${wsId}/lessons/${artifactId}/index.html`)).status, 403)
    assert.equal((await fetch(`${origin}/learning/${wsId}/lessons/${artifactId}/index.html?k=${'0'.repeat(32)}`)).status, 403)

    const ok = await fetch(`${origin}${summary.previewUrl}`)
    assert.equal(ok.status, 200)
    assert.ok((await ok.text()).includes('第二版'))
})

await check('路由：Run 提交接受不透明源的跨源预检与提交', async () => {
    const preflight = await fetch(`${origin}${runPath}/submit`, {method: 'OPTIONS'})
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*')

    const submitted = await fetch(`${origin}${runPath}/submit`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'null'}, body: JSON.stringify({answer: 1})})
    assert.equal(submitted.status, 200)
    assert.equal(submitted.headers.get('access-control-allow-origin'), '*')
    assert.equal((await learning.runs.outcome(run))?.state, 'completed')
})

await check('路由：学习 API 写请求缺 X-DVL 头或被标为跨站时拒绝', async () => {
    const body = JSON.stringify({workspaceId: wsId, category: 'lessons', artifactId})
    assert.equal((await fetch(`${origin}/learning/api/runs`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body})).status, 403)
    assert.equal((await fetch(`${origin}/learning/api/notes`, {headers: {'Sec-Fetch-Site': 'cross-site'}})).status, 403)
    assert.equal((await fetch(`${origin}/learning/api/runs`, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-DVL': '1'}, body})).status, 200)
})

server.close()

// ---工具：按会话角色声明，参数错误改写为中文---

const tools = new Map()
installLearningTools({tools: {register: (def, options) => { tools.set(def.name, {def, options}); return () => {} }}}, learning)
const agent = {id: 's1', session: {header: {cwd: ws}}}
const whenOf = async (name, audience) => {
    const original = learning.audienceOf
    learning.audienceOf = () => audience
    try {
        return await tools.get(name).options.when({agent})
    } finally {
        learning.audienceOf = original
    }
}

await check('工具：未进入学习的会话一个都不声明，创作子代理只拿创作与只读工具', async () => {
    for (const name of tools.keys()) assert.equal(await whenOf(name, 'none'), false, name)
    const authored = []
    for (const name of tools.keys()) if (await whenOf(name, 'author')) authored.push(name)
    assert.deepEqual(authored.sort(), ['allocate_artifact', 'get_outline', 'get_review_plan'])
    assert.equal(await whenOf('update_outline', 'root'), true)
})

await check('工具：参数校验失败返回中文 error 结果而非抛出英文异常', async () => {
    const execute = tools.get('allocate_artifact').def.execute
    const unparsable = await execute('{"kind": "les', {agent})
    assert.equal(unparsable.outcome, 'error')
    assert.ok(unparsable.detail.startsWith('参数 JSON 无法解析'))

    const invalid = await execute({kind: 'novel'}, {agent})
    assert.equal(invalid.outcome, 'error')
    assert.ok(invalid.detail.startsWith('参数不符合工具契约'))

    const valid = await execute({kind: 'quiz'}, {agent})
    assert.equal(valid.outcome, 'succeeded')
    assert.match(valid.artifact_id, /^[a-f0-9]{16}$/u)
})

// ---汇总---

for (const [name, ok] of results) console.log(`${ok ? '✓' : '✗'} ${name}`)
const failed = results.filter(([, ok]) => !ok).length
console.log(failed === 0 ? `冒烟通过（${results.length} 项）` : `冒烟失败：${failed}/${results.length} 项`)
process.exit(failed === 0 ? 0 : 1)
