# Vibe Learning Plugin for DeepSeek Harness

DeepSeek Harness（DSH）的一款氛围学习插件：用户在会话开启氛围学习后，Agent 能与用户共建多层大纲、交互式上课与课后答疑、安排 FSRS 复习计划、创建小测；用户还能在 DSH 内直接记笔记。

# 最高指示：以下文档未修订，未必对，可以不看

## 加载

单次实例体验：
```sh
dsh --profile web --patch /pathToYour/DshVibeLearning/cordis.patch.yml --port 3090 # 在 3090 上运行本实例，不干扰可能的3080默认实例
```

持久安装使用：
```sh
dsh plugin --profile web add dsh-vibe-learning # 安装到 web 这个配置
dsh web # 默认实例持久生效
```

## 组成

单包单入口 `src/index.ts`，内部按七类职责组织：

| 块 | 职责 |
|---|---|
| `core/` | `ctx.learning` 核心服务：工作区文件域、全局笔记、FSRS、run 生命周期、会话进入标记与 Prompt |
| `tool/` | 模型工具适配层 |
| `cmd/` | `/learn` 命令适配层 |
| `skill/` | `course-authoring` Skill 适配层 |
| `artifact-host/` | 挂靠 DSH webServer 的学习工件托管、提交端点与 frontend HTTP API |
| `frontend/` | 浏览器端学习界面、悬浮卡与工具视图 |
| `shared/` | 宿主与 frontend 共用的模型、HTTP 契约、projection 线缆类型及纯常量 |

## 工件与 Run

- **Artifact 不可变**，以内容 hash 寻址；**每次呈现/作答是一个独立 run**。
- 服务器拥有 URL：`present_artifact` 用 DSH `callId` 创建/恢复 run，生成带不可猜测 `runId` 的 canonical URL；toolview 经 `cwd + callId` 解析 descriptor，settled/replay 时从 durable tool `presentationMeta` 恢复。
- 同一 `runId` 重复提交幂等；明确「重新作答」= 新 run（独立 result/feedback）。

```
.dsh/learning/                          # 目录存在 = 学习工作区（无 manifest）
  outlines/<outlineId>.json             # 纲目树 + 每课状态（未开始/学习中/答疑中/完成）
  lessons/<hash>/index.html             # 课程工件（只含 index.html + meta.json）
  lessons/<hash>/runs/<runId>/          # run.json + result.json + feedback.json
  cards/<lessonId>.json                 # FSRS 卡（每课一张，ts-fsrs Card 原样持久化）
  reviews/<hash>/…                      # 复习工件（每次复习全新生成）
  quizzes/<hash>/…                      # 小测工件
```

- `<hash>` = 工件内容 sha256 前 16 位 → 内容不变 id 不变；纲目修改后不再被引用的工件/卡**自动清除**。
- `run.json` 只存机制信息（artifact / target / callId / 创建时间），不存教学判断。
- result = DVL 机制信封（`kind/targetId/artifactHash/runId/submittedAt` + 不透明 `payload`），**DVL 不解析教学语义**；feedback = 每 run 一份的机制信封（`runId/savedAt` + 不透明 `payload`），同样不解析其 schema。
- 笔记 = 全局存储（config `dataDir`，默认 `~/.dsh-vibe-learning/notes.json`），不属于任何工作区文件；模型面按「当前工作区 + tags」过滤。

## 提交

工件调用系统注入的 `window.DVL.submit(anyJsonValue)`；`anyJsonValue` 是任意 JSON，作为这次课程 Run 的结果载荷。只读预览页没有 Run 段，服务器拒绝其的 `./submit` 。DVL 只做 JSON/体积校验、run 归属校验、原子幂等落盘，结果载荷完整返回给模型（以让模型进行后续批改作业）。

## 模型批改链路

```text
模型设计 artifact 与 result 形态
→ 用户学习、作答
→ DVL 原样存 result
→ in-band：present retValue 返回 result / standalone：get_result(run_id)
→ 模型研判 → save_feedback(kind, hash, run_id, 任意 JSON) 保存报告
→ 模型向用户解释（报告 + 分析 + 复习计划状态）
→ 模型可选 update_review_plan（唯一推进 FSRS 的路径）
```

## 命令

- `/learn` —— 进入氛围学习（单向阀，一次性；模型回应并开始共建大纲）
- 当前激活纲目是会话事件 `dvl://learning/change-outline:<outlineId|null>` 的投影值，不属于工作区文件；同一工作区的多个会话可以有不同激活纲目。

## 工具（模型面，10 个）

`present_artifact` · `get_result`（run-aware）· `save_feedback`（不透明报告）· `get_outline` · `update_outline`（工具内自确认）· `activate_outline` · `filter_notes` · `get_note` · `update_note`（工具内自确认）· `update_review_plan`（工具内自确认）。

- `present_artifact` 创建/恢复 run，返回 `run_id + url + result`；present/result **零隐式卡片副作用**。
- `save_feedback(kind, hash, run_id, feedback)` 把模型的批改报告作为不透明 JSON 原样落盘到该 run；系统负责 run 归属、`已有 result` 校验与路径，不校验 feedback schema。
- `update_review_plan(lesson_id, source_kind, source_hash, source_run_id, rating, reason)` 是**唯一**创建/推进 FSRS 卡的路径；系统校验 source run 真实存在、已有 result、且归属该 lesson；`source_run_id` 作幂等来源，不能重复推进。
- 确认弹窗复用 `userQuestions`，返回值 = confirmed / cancelled / error。

## Prompt 面

- **P0 boot line**（非学习会话常驻）：一句开启提示 + `/learn` 引导。
- **P1 全量规范**（学习会话）：状态机、作答后的固定流程（present → result → 判阅 → save_feedback → 按需 update_review_plan → 回复用户）、工件三类与路径约定、不透明 result/feedback、显式复习计划、笔记模型面、工具纪律。
- **P2 每轮快照**（`agent/pre-step` durable 消息）：激活纲目、当前课（学习中/答疑中）、到期复习清单。

## 客户端 UI（`src/frontend/`）

有：学习 tab（纲目/复习/小测，含每工件 run 历史）、对话页两个悬浮卡（当前纲目卡、笔记卡）、`present_artifact` Keyed Tool View（以提供对话IN-BAND课程学习体验）。

**官方 Web shell 不含第三方客户端包**：并入需在你的自定义 shell 的 bundle patch 里加 `dsh.client` 行并重建（官方主仓库不动）。

> 浏览器加载是**单文件 bundle**（`/plugins/<id>/client.js`，含 CSS Modules 内联与 `__ModuleLoader__` 工厂壳）。本仓库 `tsdown.config.ts` 复刻了 DsHarness 的 `clientBundle` 客户端面，`pnpm run build` 产出 `lib/client.js`（`exports["./client"]` 指向它）。

## 配置（插件 config，全部有默认值）

```yaml
config:
  dataDir: ~/.dsh-vibe-learning
  presentTimeoutMs: 3600000   # in-band present 最长等待
```

## 已知限制（POC）

- GUI in-band“新开会话”为实验路径（直接 `ctx.agents.create`，未走 preset 组合）。
- 复习到期为被动提醒（每轮快照 + GUI）；无后台定时推送。
- 大纲并发编辑无 CAS（tmp+rename 原子写，last-wins）。
- 客户端 UI 需并入自定义 shell 构建后才可见（官方 Web Shell 不含第三方客户端包）。
