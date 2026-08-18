// DVL 面向用户的 /learn 命令族：单向进入氛围学习、切换激活纲目，并把复习与小测意图交给模型处理

import {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {CommandInvocation, CommandResult} from '@deepseek-ai/dsh-commands'
import {isSafeSegment} from '../core/identifiers.ts'

const HINT = '[<纲目 ID>|review <课程 ID>|quiz <课程 ID> [要求]]'
const USAGE = `用法：/learn ${HINT}`

type Parsed = {readonly kind: 'enter'} | {readonly kind: 'activate'; readonly outlineId: string} | {readonly kind: 'review'; readonly lessonId: string} | {readonly kind: 'quiz'; readonly lessonId: string; readonly prompt?: string} | {readonly kind: 'invalid'; readonly detail: string}

function parse(rawInput: string): Parsed {
    const input = rawInput.trim()

    // 无参时直接进入学习模式
    if (input.length === 0) return {kind: 'enter'}

    const review = /^review\s+(\S+)$/iu.exec(input)
    if (review !== null) {
        const lessonId = review[1]
        return lessonId === undefined || !isSafeSegment(lessonId) ? {kind: 'invalid', detail: 'review 需要一个安全的课程 ID'} : {kind: 'review', lessonId}
    }

    const quiz = /^quiz\s+(\S+)(?:\s+([\s\S]*))?$/iu.exec(input)
    if (quiz !== null) {
        const lessonId = quiz[1]
        if (lessonId === undefined || !isSafeSegment(lessonId)) return {kind: 'invalid', detail: 'quiz 需要一个安全的课程 ID'}
        return {kind: 'quiz', lessonId, ...(quiz[2] !== undefined && quiz[2].trim().length > 0 ? {prompt: quiz[2].trim()} : {})}
    }

    // 单参时切换纲目
    if (!isSafeSegment(input)) return {kind: 'invalid', detail: `纲目 ID「${input}」不安全`}
    return {kind: 'activate', outlineId: input}
}

function requireCwd(agent: Agent): string | null { return agent.session.header.cwd ?? null }

async function statusText(ctx: Context, agent: Agent): Promise<string> {
    const learning = ctx.learning
    const cwd = requireCwd(agent)

    if (cwd === null) return Promise.resolve('氛围学习已开启（本会话无工作区目录）。') // CHECK：这什么情况？

    const snapshot = await learning.snapshot(cwd)
    const lines: string[] = ['氛围学习已开启。']

    // CHECK：这会不会和那个实时状态prompt有重复？
    if (snapshot.activeOutlineId === null) lines.push('当前没有激活纲目；可用 /learn <纲目 ID> 激活。')
    else {
        const active = snapshot.outlines.find(outline => outline.active)
        lines.push(`激活纲目：${active?.title ?? snapshot.activeOutlineId}`)

        if (snapshot.currentLessons.length > 0) for (const lesson of snapshot.currentLessons) lines.push(`当前课程：${lesson.title}`)
    }

    if (snapshot.dueCards.length > 0) lines.push(`到期复习：${snapshot.dueCards.length} 项`)
    return lines.join('\n')
}

// 执行用户的`/learn`调用
async function execute(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
    const learning = ctx.learning
    const agent = invocation.agent
    const parsed = parse(invocation.rawInput)

    switch (parsed.kind) {
        case 'invalid':
            return {kind: 'error', text: `${parsed.detail}\n${USAGE}`}

        // ---进入（带参与直接）---

        case 'enter': {
            let first: boolean

            try {
                first = await learning.enter(agent, '氛围学习已开启。请先与用户共建学习大纲（了解想学什么、目标与基础），大纲经用户确认后通过 update_outline 落盘并 activate_outline 激活；若本工作区已有纲目，请提示用户用 /learn <outline-id> 激活或直接说出想学的纲目。')
            } catch (error: unknown) {
                return {kind: 'error', text: error instanceof Error ? error.message : `进入氛围学习失败：${String(error)}`}
            }

            if (!first) return {kind: 'success', text: await statusText(ctx, agent)}
            return {kind: 'success', text: '氛围学习已开启（一次性，不可退出）。'}
        }

        // FUCK、TODO：最终还是要模型去调用工具方法。那不如算了，直接让用户口述来切换纲吧。不需要这个命令都行，可以回头去掉
        case 'activate': {
            let first: boolean

            try {
                first = await learning.enter(agent, `用户通过 /learn 指定了纲目 ${parsed.outlineId}：请调用 activate_outline('${parsed.outlineId}') 激活它，然后向用户确认切换成功并报告当前进度。`)
            } catch (error: unknown) {
                return {kind: 'error', text: error instanceof Error ? error.message : `切换纲目失败：${String(error)}`}
            }

            if (!first) learning.notify(agent, `用户通过 /learn 要求切换纲目 ${parsed.outlineId}：请调用 activate_outline('${parsed.outlineId}') 激活它，然后向用户确认切换成功并报告当前进度。`)
            return {kind: 'success', text: `已通知模型切换到纲目 ${parsed.outlineId}。`}
        }

        // ---复习和小测---

        // FUCK、TODO：其实我感觉这也纯他妈多余。你只要在模型 system prompt 里面规范好如何让模型创建复习和小测就够了。这个岂不纯多余：因为这两个命令他妈的也纯粹只是代替用户去发 prompt 而已，没有直接执行任何DVL的实际操作（如让复习强制到期）

        case 'review': {
            if (!learning.hasEntered(agent.session.events)) return {kind: 'error', text: `尚未进入氛围学习。请先执行 /learn。\n${USAGE}`}

            const cwd = requireCwd(agent)
            if (cwd === null) return {kind: 'error', text: '本会话无工作区目录，无法复习。'}

            learning.notify(agent, `用户发起了一次强制复习（lessonId: ${parsed.lessonId}）：请生成一份全新的复习工件（review，针对该课薄弱点），写入约定路径后 present_artifact(kind=review, target_id=...)；拿到 result 后批改（主观题按 rubric），用 save_feedback 保存报告，回复用户；如需推进复习计划，再调用 update_review_plan。`)
            return {kind: 'success', text: `已通知模型复习课程 ${parsed.lessonId}。`}
        }

        case 'quiz': {
            if (!learning.hasEntered(agent.session.events)) return {kind: 'error', text: `尚未进入氛围学习。请先执行 /learn。\n${USAGE}`}

            learning.notify(agent, `用户发起了一次小测（lessonId: ${parsed.lessonId}${parsed.prompt !== undefined ? `；用户要求：${parsed.prompt}` : ''}）：请生成一份 quiz 工件，写入约定路径后 present_artifact(kind=quiz, target_id=...)，拿到 result 后批改，用 save_feedback 保存报告，最后回复用户。`)
            return {kind: 'success', text: `已通知模型对课程 ${parsed.lessonId} 发起小测。`}
        }
    }
}

// ---

// 注册所有会话都可见的根级 /learn 命令
export function installLearnCommand(ctx: Context): void {
    ctx.commands.register({
        name: 'learn',
        description: '进入氛围学习 / 切换纲目 / 复习 / 小测',
        input: {hint: HINT},
        handler: invocation => execute(ctx, invocation),
    })
}
