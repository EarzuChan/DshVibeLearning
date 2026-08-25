import type {Context} from '@deepseek-ai/cordis'
import LearningService from './core/index.ts'
import type {Config as LearningConfig} from './core/index.ts'

// 插件显示名称，也是诊断中的「光纤」名称
export const name = 'dsh-vibe-learning'

// 插件依赖的外部服务，**不包含由插件自身挂载的 learning**
export const inject = ['commands', 'skills', 'tools', 'agents', 'webServer']

// 由加载器校验并补默认值的插件配置。zod
export const Config = LearningService.Config

// 后端插件入口只负责挂载统一拥有 DVL 生命周期的 LearningService，前端入口见 frontend/
export function apply(ctx: Context, config?: LearningConfig): void {
    ctx.plugin(LearningService, config ?? {})
}
