/**
 * dsh-vibe-learning（DVL）：DeepSeek Harness 的第三方学习处境插件。
 * 其包含核心服务、一系列会话工具、`/learn` 命令一套、课程创作 Skill 以及挂在 DSH webServer 上的学习工件路由。
 * @module dsh-vibe-learning
 */

import { Context } from '@deepseek-ai/cordis'
import LearningService from './learning/index.ts'
// TODO：learning包应该改名叫core
import type { Config as LearningConfig } from './learning/index.ts'
// TODO：他妈的，下面这几个包里的`-learning`都应该去掉
import { installToolBoot } from './tool-learning/index.ts'
import { installLearnCommand } from './command-learning/index.ts'
import { installCourseAuthoringSkill } from './skill-learning/index.ts'
import { installLearningRoutes } from './web/index.ts'

// 插件显示名称，也是诊断中的"光纤"名称
export const name = 'dsh-vibe-learning'

/**
 * External services the whole plugin consumes. `learning` is deliberately absent:
 * this plugin itself mounts it, so listing it would deadlock the loader's inject wait.
 */
export const inject = ['commands', 'skills', 'tools', 'userQuestions', 'agents', 'webServer']

/** Plugin config schema (validated + defaulted by the loader). */
export const Config = LearningService.Config

/**
 * Compose the DVL surface. The learning service mounts first; everything else runs inside a scope that additionally waits for `ctx.learning`,
 * so the property is ready before any consumer reads it.
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config?: LearningConfig): void {
  ctx.plugin(LearningService, config ?? {})

  ctx.inject(['learning', 'commands', 'skills', 'tools', 'userQuestions', 'agents'], (scope: Context) => {
    installToolBoot(scope)
    installLearnCommand(scope)
    installCourseAuthoringSkill(scope)
  })

  // 学习工件路由：挂在 DSH webServer 的 /learning 前缀（同源，无独立端口）
  ctx.inject(['learning', 'webServer'], (scope: Context) => installLearningRoutes(scope))
}
