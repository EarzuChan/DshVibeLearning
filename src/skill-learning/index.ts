/**
 * The course-authoring skill: catalog description carries the binding
 * contract (what a good course is, how results are submitted); the body is
 * what the model pulls when it actually authors an artifact.
 * @module dvl/skill-learning
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'


const DESCRIPTION = [
  '创作 DVL 课程工件（lesson / review / quiz）的规范。',
  '工件 = 自含 HTML（内联 JS/CSS），幻灯片式讲学 + 可视化 + 即时小题；',
  '结果经系统注入的 window.DVL.submit(result) 提交，客观题报 score，主观题附原文与 rubric。',
].join(' ')

const CONTENT = [
  '# course-authoring',
  '',
  '创作 DVL 课程工件的规范。工件 = 一个自含 HTML 文件（内联 JS/CSS）；',
  '服务器统一注入基础主题样式与提交桥 window.DVL。',
  '',
  '## 结构：课本 + 附着',
  '- 课本：幻灯片式逐页讲学。每页必须可视化（图/表/动画/交互演示），把概念讲明白；页间有连贯叙事。',
  '  页面中可结合「答案确定的即时小题」（工件内即时判定）。',
  '- 附着：课本结束后，附随堂小题或课后作业——可为确定题（即时判定），也可为主观题（收集原文，不判定）。',
  '',
  '## 提交',
  '结束页收集全部作答，调 window.DVL.submit(result) 提交。',
  'result 为 JSON：客观题附 score（0~1 得分率）与判定明细；主观题附原文与 rubric。',
  '',
  '## 存放',
  '按系统 prompt 给定的路径约定，将 index.html 写入工作区 learning 目录的对应分类，随后由模型 present。',
].join('\n')

/** Register the skill with the runtime registry (inline body; no directory). */
export function installCourseAuthoringSkill(ctx: Context): void {
  ctx.skills.register({
    name: 'course-authoring',
    description: DESCRIPTION,
    whenToUse: '创作 DVL 课程 / 复习 / 小测工件前必读。',
    source: 'custom',
    content: CONTENT,
  })
}
