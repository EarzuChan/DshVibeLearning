/**
 * dsh-vibe-learning — Vibe Learning (DVL): a third-party learning-mode plugin for DeepSeek Harness.
 * One plugin entry composing the core service (`ctx.learning`), the per-session tools, the `/learn` command,
 * the course-authoring skill, and the artifact HTTP server.
 * @module dsh-vibe-learning
 */

import { Context } from '@deepseek-ai/cordis'
import LearningService from './learning/index.ts'
import type { Config as LearningConfig } from './learning/index.ts'
import { installToolBoot } from './tool-learning'
import { installLearnCommand } from './command-learning'
import { installCourseAuthoringSkill } from './skill-learning'
import { startArtifactServer } from './web'

/** Plugin display name — also the fiber name in diagnostics. */
export const name = 'dsh-vibe-learning'

/**
 * External services the whole plugin consumes. `learning` is deliberately absent:
 * this plugin itself mounts it, so listing it would deadlock the loader's inject wait.
 */
export const inject = ['commands', 'skills', 'tools', 'userQuestions', 'agents']

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
    startArtifactServer(scope)
  })
}
