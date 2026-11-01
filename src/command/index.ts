// DVL 面向用户的唯一学习入口：/learn [学习意图]，进入氛围学习并可顺带把意图交给模型

import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {CommandInvocation, CommandResult} from '@deepseek-ai/dsh-commands'
import type {LearningService} from '../core/index.ts'

// 已进入学习模式的情况下，调用本命令将仅仅显示
async function getCurrentStatusText(learning: LearningService, agent: Agent): Promise<string> {
    const state = learning.getCurrentSessionDvlLearningState(agent)

    if (!state.entered) throw new Error('明明Enter方法已经确认进入了，怎么可能没进入！！！')

    const hasEnteredText = "您已在进行氛围学习，"
    if (state.activeOutlineId === null) return `${hasEnteredText}您当前还没有激活的纲目`

    const cwd = learning.getCurrentSessionCwd(agent)
    const outline = cwd === null ? null : await learning.readOutline(cwd, state.activeOutlineId)
    return outline === null ? `${hasEnteredText}不过您激活的纲目 ${state.activeOutlineId} 不可用` : `${hasEnteredText}当前激活的纲目：${outline.title}`
}

const BOOT_MESSAGE = '目前氛围学习开启了。请先了解用户想学什么、目标与基础；如需要创建大纲，请用 update_outline 落盘，然后用 activate_outline 激活'

// 执行 /learn 调用：可选参数是用户的学习意图，首次进入时随进入通知一起交给模型，已进入时单独转达
async function execute(learning: LearningService, invocation: CommandInvocation): Promise<CommandResult> {
    const prompt = invocation.rawInput.trim()

    try {
        const isTheFirstTimeTryToEnterVibeLearning = await learning.enterVibeLearning(invocation.agent, prompt.length === 0 ? BOOT_MESSAGE : `${BOOT_MESSAGE}

用户随 /learn 附带的学习意图：${prompt}`)
        if (isTheFirstTimeTryToEnterVibeLearning) return {kind: 'success', text: '氛围学习现已开启，请好好享受您的学习时光'}

        if (prompt.length > 0) learning.notify(invocation.agent, '用户的学习意图', `用户通过 /learn 表达了学习意图：${prompt}`)
        return {kind: 'success', text: await getCurrentStatusText(learning, invocation.agent)}
    } catch (error: unknown) {
        return {kind: 'error', text: error instanceof Error ? error.message : `进入氛围学习失败：${String(error)}`}
    }
}

// 注册所有会话都可见的根级 /learn 命令
export function installLearnCommand(ctx: Context, learning: LearningService): void {
    ctx.commands.register({
        name: 'learn',
        description: '进入氛围学习，可附带学习意图',
        input: {hint: '想学什么（可选），如：我想系统学一遍线性代数'},
        handler: invocation => execute(learning, invocation),
    })
}
