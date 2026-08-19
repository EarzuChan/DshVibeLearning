// DVL 面向用户的唯一学习入口：无参进入氛围学习，其余学习意图全部交给模型自然语言处理

import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {CommandInvocation, CommandResult} from '@deepseek-ai/dsh-commands'

// 已进入学习模式的情况下，调用本命令将仅仅显示
async function getCurrentStatusText(ctx: Context, agent: Agent): Promise<string> {
    const state = ctx.learning.getCurrentSessionDvlLearningState(agent)

    if (!state.entered) throw new Error('明明Enter方法已经确认进入了，怎么可能没进入！！！')

    const hasEnteredText = "您已在进行氛围学习，"
    if (state.activeOutlineId === null) return `${hasEnteredText}您当前还没有激活的纲目`

    const cwd = ctx.learning.getCurrentSessionCwd(agent)
    const outline = cwd === null ? null : await ctx.learning.readOutline(cwd, state.activeOutlineId)
    return outline === null ? `${hasEnteredText}不过您激活的纲目 ${state.activeOutlineId} 不可用` : `${hasEnteredText}当前激活的纲目：${outline.title}`
}

// 执行用户的无参 /learn 调用
async function execute(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
    if (invocation.rawInput.trim().length > 0) return {kind: 'error', text: '/learn 不需要参数。您进入后直接用自然说明学习意图即可'}

    try {
        const isTheFirstTimeTryToEnterVibeLearning = await ctx.learning.enterVibeLearning(invocation.agent, '目前氛围学习开启了。请先了解用户想学什么、目标与基础；如需要创建大纲，请用 update_outline 落盘，然后用 activate_outline 激活')
        return {kind: 'success', text: isTheFirstTimeTryToEnterVibeLearning ? '氛围学习现已开启，请好好享受您的学习时光' : await getCurrentStatusText(ctx, invocation.agent)}
    } catch (error: unknown) {
        return {kind: 'error', text: error instanceof Error ? error.message : `进入氛围学习失败：${String(error)}`}
    }
}

// 注册所有会话都可见的根级 /learn 命令
export function installLearnCommand(ctx: Context): void {
    ctx.commands.register({
        name: 'learn',
        description: '进入氛围学习',
        handler: invocation => execute(ctx, invocation),
    })
}
