import type {Context} from '@deepseek-ai/cordis'
import LearningService from './core/index.ts'
import type {Config as LearningConfig} from './core/index.ts'
import {installLearnCommand} from './command/index.ts'
import {installCourseAuthoringSkill} from './skill/index.ts'
import {installLearningRoutes} from './the-so-called-backend/index.ts'

// 插件显示名称，也是诊断中的「光纤」名称
export const name = 'dsh-vibe-learning'

// 插件依赖的外部服务，**不包含由插件自身挂载的 learning**
export const inject = ['commands', 'skills', 'tools', 'userQuestions', 'agents', 'webServer']

// 由加载器校验并补默认值的插件配置。zod
export const Config = LearningService.Config

// 组装 DVL 插件能力，先挂载 LearningService，再让其余消费者等待 learning 就绪。后端的 Cordis，前端的见 frontend/ 下
export function apply(ctx: Context, config?: LearningConfig): void {
  // 会话、工作区的“处理”，在插件服务里负责
  ctx.plugin(LearningService, config ?? {})

  // 下面算是离体可用的，THINKING：为什么不在插件服务内拨弄？

  // 挂载命令和Skill
  ctx.inject(['learning', 'commands', 'skills', 'tools', 'userQuestions', 'agents'], (scope: Context) => {
    installLearnCommand(scope)
    installCourseAuthoringSkill(scope)
  })

  // 挂载工件路由
  ctx.inject(['learning', 'webServer'], (scope: Context) => installLearningRoutes(scope))
}