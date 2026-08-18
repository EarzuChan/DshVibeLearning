import {Context} from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-skill' // 向 ctx 提供 skills

// THINKING：这里暂时写得比较简略。。。最后再写好点

const DESCRIPTION = '创作 DVL 课程工件（lesson / review / quiz）的规范。工件 = 自含 HTML（内联 JS/CSS），幻灯片式讲学 + 可视化 + 即时小题；结果经系统注入的 window.DVL.submit(anyJsonValue) 提交为不透明 JSON：记录题目与真实作答、附确定答案/正确情况与足够判阅上下文，不输出最终分数。'

const CONTENT = `# 关于课程工件的创作

创作 DVL 课程工件的规范。工件 = 一个自含 HTML 文件（内联 JS/CSS）；
服务器会统一注入基础主题样式与提交桥 window.DVL。

## 结构：课本 + 附着
- 课本：幻灯片式逐页讲学。每页必须可视化（图/表/动画/交互演示），把概念讲明白；页间有连贯叙事。
  页面中可结合「答案确定的即时小题」（工件内即时判定）。
- 附着：课本结束后，附随堂小题或课后作业——可为确定题（即时判定），也可为主观题（收集原文，不判定）。

## 提交（不透明 JSON）
结束页收集全部作答，调 window.DVL.submit(anyJsonValue) 提交。
anyJsonValue 是任意 JSON 值（对象/数组/原始值/null 均可），DVL 不规定结构：
- 记录题目与真实作答（原文）；
- 有确定答案时附答案/正确情况（正确与否、期望答案、实际作答）；
- 带足上下文，使模型脱离 lesson 也能独立判阅；
- **不要**输出最终分数、总分或任何评分字段。

## 存放
按系统 prompt 给定的路径约定，将 index.html 写入工作区 learning 目录的对应分类，随后由模型 present。`

// 将课程工件创作 skill 注册到运行时 registry，正文直接内联，不使用目录
export function installCourseAuthoringSkill(ctx: Context): void {
  ctx.skills.register({
    name: 'course-authoring',
    description: DESCRIPTION,
    whenToUse: '创作 DVL 课程 / 复习 / 小测工件前必读。',
    source: 'custom',
    content: CONTENT,
  })
}