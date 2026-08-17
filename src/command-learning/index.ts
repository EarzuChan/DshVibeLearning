/**
 * The human-facing `/learn` command family: enter 学习处境 (one-way),
 * switch the active outline, and hand review/quiz intents to the model.
 * Read-only status stays in the GUI; every command here has an effect and wakes the model.
 * @module dvl/command-learning
 */

import {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {CommandInvocation, CommandResult} from '@deepseek-ai/dsh-commands'
import {isSafeSegment} from '../shared/hash.ts'


const USAGE = 'Usage: /learn [<outline-id>|review <lesson-id>|quiz <lesson-id> [要求]]'

type Parsed = { readonly kind: 'enter' } | { readonly kind: 'activate'; readonly outlineId: string } | { readonly kind: 'review'; readonly lessonId: string } | { readonly kind: 'quiz'; readonly lessonId: string; readonly prompt?: string } | { readonly kind: 'invalid'; readonly detail: string }

function parse(rawInput: string): Parsed {
    const input = rawInput.trim()

    // 无参时直接进入
    if (input.length === 0) return {kind: 'enter'}

    const review = /^review\s+(\S+)$/iu.exec(input)
    if (review !== null) {
        const lessonId = review[1]

        return lessonId === undefined || !isSafeSegment(lessonId) ? {kind: 'invalid', detail: 'review requires a safe lesson id'} : {kind: 'review', lessonId}
    }

    const quiz = /^quiz\s+(\S+)(?:\s+([\s\S]*))?$/iu.exec(input)
    if (quiz !== null) {
        const lessonId = quiz[1]
        if (lessonId === undefined || !isSafeSegment(lessonId)) return {kind: 'invalid', detail: 'quiz requires a safe lesson id'}
        return {kind: 'quiz', lessonId, ...(quiz[2] !== undefined && quiz[2].trim().length > 0 ? {prompt: quiz[2].trim()} : {})}
    }

    // 单参：切换 outline
    if (!isSafeSegment(input)) return {kind: 'invalid', detail: `unsafe outline id '${input}'`}
    return {kind: 'activate', outlineId: input}
}

function requireCwd(agent: Agent): string | null {
    return agent.session.header.cwd ?? null
}

async function statusText(ctx: Context, agent: Agent): Promise<string> {
    const learning = ctx.learning

    const cwd = requireCwd(agent)
    if (cwd === null) return Promise.resolve('学习处境已开启（本会话无工作区目录）。') // CHECK：Whaaaat？

    const snapshot = await learning.snapshot(cwd)
    const lines: string[] = ['学习处境已开启。']

    if (snapshot.activeOutlineId === null) lines.push('当前没有激活纲目；/learn <outline-id> 可激活。')
    else {
        const active = snapshot.outlines.find(outline => outline.active)
        lines.push(`激活纲目：${active?.title ?? snapshot.activeOutlineId}`)

        if (snapshot.currentLessons.length > 0) for (const lesson of snapshot.currentLessons) lines.push(`当前课程：${lesson.title}`)
    }

    if (snapshot.dueCards.length > 0) lines.push(`到期复习：${snapshot.dueCards.length} 项`)
    return lines.join('\n')
}

async function execute(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
    const learning = ctx.learning
    const agent = invocation.agent
    const parsed = parse(invocation.rawInput)

    switch (parsed.kind) {
        case 'invalid':
            return {kind: 'error', text: `${parsed.detail}\n${USAGE}`}

        case 'enter': {
            let first: boolean
            try {
                first = await learning.enter(agent, '学习处境已开启。请先与用户共建学习大纲（了解想学什么、目标与基础），大纲经用户确认后通过 update_outline 落盘并 activate_outline 激活；若本工作区已有纲目，请提示用户用 /learn <outline-id> 激活或直接说出想学的纲目。')
            } catch (error: unknown) {
                return {kind: 'error', text: error instanceof Error ? error.message : String(error)}
            }

            if (!first) return {kind: 'success', text: await statusText(ctx, agent)}
            return {kind: 'success', text: '学习处境已开启（一次性，不可退出）。'}
        }

        case 'activate': {
            let first: boolean
            try {
                first = await learning.enter(agent, `用户通过 /learn 指定了纲目 ${parsed.outlineId}：请调用 activate_outline('${parsed.outlineId}') 激活它，然后向用户确认切换成功并报告当前进度。`)
            } catch (error: unknown) {
                return {kind: 'error', text: error instanceof Error ? error.message : String(error)}
            }

            if (!first) learning.notify(agent, `用户通过 /learn 要求切换纲目 ${parsed.outlineId}：请调用 activate_outline('${parsed.outlineId}') 激活它，然后向用户确认切换成功并报告当前进度。`)
            return {kind: 'success', text: `已通知模型切换到纲目 ${parsed.outlineId}。`}
        }

        case 'review': {
            if (!learning.hasEntered(agent.session.events)) return {kind: 'error', text: `尚未进入学习处境。请先 /learn。\n${USAGE}`}

            const cwd = requireCwd(agent)
            if (cwd === null) return {kind: 'error', text: '本会话无工作区目录，无法复习。'}

            learning.notify(agent, `用户发起了一次强制复习（lessonId: ${parsed.lessonId}）：请生成一份全新的复习工件（review，针对该课薄弱点），写入约定路径后 present_artifact(kind=review, target_id=...)；拿到 result 后批改（主观题按 rubric），用 save_feedback 保存报告，回复用户；如需推进复习计划，再调用 update_review_plan。`)
            return {kind: 'success', text: `已通知模型复习课程 ${parsed.lessonId}。`}
        }

        case 'quiz': {
            if (!learning.hasEntered(agent.session.events)) return {kind: 'error', text: `尚未进入学习处境。请先 /learn。\n${USAGE}`}

            learning.notify(agent, `用户发起了一次小测（lessonId: ${parsed.lessonId}${parsed.prompt !== undefined ? `；用户要求：${parsed.prompt}` : ''}）：请生成一份 quiz 工件，写入约定路径后 present_artifact(kind=quiz, target_id=...)，拿到 result 后批改，用 save_feedback 保存报告，最后回复用户。`)

            return {kind: 'success', text: `已通知模型对课程 ${parsed.lessonId} 发起小测。`}
        }
    }
}

/** Register the `/learn` command (root level: it is the entry in every session). */
export function installLearnCommand(ctx: Context): void {
    ctx.commands.register({
        name: 'learn',
        description: '进入学习处境 / 切换纲目 / 复习 / 小测',
        input: {hint: '[<outline-id>|review <lesson-id>|quiz <lesson-id> [要求]]'},
        handler: invocation => execute(ctx, invocation),
    })
}
