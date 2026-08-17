# dsh-vibe-learning — Vibe Learning (DVL)

一个 **DeepSeek Harness（dsh）的第三方学习插件**：把会话变成「学习会话」——与用户共建多层大纲（主纲/子纲/课程）、上课（交互式课程 WebApp）、课后答疑、FSRS 复习、小测、记笔记。

源码系独立仓库、单独发布；只以 peerDependency 依赖 `@deepseek-ai/dsh-*`。

## 加载

```sh
dsh --profile web --patch /path/to/DshVibeLearning/cordis.web.yml # --port 3090
```

## 组成

单包单入口 `src/index.ts`，内部分六块（都在本包内，无需拆行）：

| 块 | 职责 |
|---|---|
| `learning/` | `ctx.learning` 核心服务：工作区文件域、全局笔记、FSRS（ts-fsrs）、run 生命周期、canonical descriptor 注册表、进入标记（借用官方 `feedback/record`）、P0/P1/P2 prompt |
| `tool-learning/` | 10 个模型工具，按学习会话挂到 agent 作用域（非学习会话零工具） |
| `command-learning/` | `/learn` 命令族 |
| `skill-learning/` | `course-authoring` skill（catalog 描述 + 内联正文；`skill/course-authoring.md` 为同文源稿） |
| `web/` | 工件 HTTP 服务器（127.0.0.1，端口 config 默认 4182）：只读预览 URL、canonical run URL、主题 + `window.DVL.submit` 桥注入、run-scoped 不透明 submit 端点、descriptor 解析、GUI JSON API |
| `client/` | 浏览器半：学习 tab、悬浮卡、`present_artifact` keyed toolview |

## 工件与 Run

- **Artifact 不可变**，以内容 hash 寻址；**每次呈现/作答是一个独立 run**。
- 服务器拥有 URL：`present_artifact` 用 DSH `callId` 创建/恢复 run，生成带不可猜测 `runId` 的 canonical URL；toolview 经 `cwd + callId` 解析 descriptor，settled/replay 时从 durable tool `presentationMeta` 恢复。
- 同一 `runId` 重复提交幂等；明确「重新作答」= 新 run（独立 result/feedback）。

```
.dsh/learning/                          # 目录存在 = 学习工作区（无 manifest）
  active.json                           # 当前激活纲目 id（只由用户命令改）
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

## 提交（不透明 JSON）

工件调用系统注入的 `window.DVL.submit(anyJsonValue)`；`anyJsonValue` 是任意 JSON 值（对象/数组/原始值/null）。bridge 只把 payload POST 到**页面相对**的 `./submit`——run 身份来自 canonical URL（`/…/runs/<runId>/index.html` → `/…/runs/<runId>/submit`），工件不携带也不回传任何机制字段；只读预览页没有 run 段，其 `./submit` 被服务器拒绝。DVL 只做 JSON/体积校验、run 归属校验、原子幂等落盘、完整返回给模型——**不解析题型、答案结构、correctness、rubric、score 或总分**。

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

- `/learn` —— 进入学习处境（单向阀，一次性；模型回应并开始共建大纲）
- `/learn <outline-id>` —— 进入并激活指定纲目（模型调 `activate_outline` 后回应）
- `/learn review <lesson-id>` —— 强制复习（不建卡；模型生成 review 工件走作答后固定流程）
- `/learn quiz <lesson-id> [要求]` —— 小测（作答后固定流程）

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

## 客户端 UI（`src/client/`）

学习 tab（纲目们/复习们/小测们，含每工件 run 历史）、对话页两个悬浮卡（当前纲目卡、笔记卡）、`present_artifact` keyed toolview（running 展开 iframe、settled 自动收起并可回看）。数据直连 `/learning/api/state` 等本地端点。入口 `src/client/index.ts` 以 `inject` + `apply` 形式注册 `conversation.view`、`conversation.session.header.utilities` 与 `tool.call.toolview`（key `present_artifact`），共享一个 store handle（每会话一实例）；`dsh.client` manifest（`platform: 'web'`）已在 package.json 声明，`inject` 含 `@deepseek-ai/dsh-client-ui-tool`。

**官方 Web shell 不含第三方客户端包**：并入需在你的自定义 shell 的 bundle patch 里加 `dsh.client` 行并重建（官方主仓库不动）。

> 浏览器加载是**单文件 bundle**（`/plugins/<id>/client.js`，含 CSS Modules 内联与 `__ModuleLoader__` 工厂壳）。本仓库 `tsdown.config.ts` 复刻了 DsHarness 的 `clientBundle` 客户端面，`pnpm run build` 已产出 `lib/client.js`（`exports["./client"]` 指向它）。

## 配置（插件 row 的 config，全部有默认值）

```yaml
config:
  port: 4182                  # 工件服务器端口（127.0.0.1）
  dataDir: ~/.dsh-vibe-learning
  presentTimeoutMs: 3600000   # in-band present 最长等待
```

## 已验证

- `pnpm run typecheck`（宿主 + 客户端）零错误；`pnpm run build` 出 `lib/`（宿主）与 `lib/client.js`（客户端 bundle）。
- `scripts/smoke.mjs` 端到端：run 创建/恢复/重新作答、descriptor 解析、bridge 真实执行（相对 `./submit` + 纯 payload body）、只读预览拒绝提交、不透明 JSON 提交（含 null payload）、同 run 并发幂等提交、run-aware get_result、present 对已落盘 result 立即解除挂起、save_feedback（归属/无 result 拒绝/覆盖）、复习计划 source 校验与幂等、state API run 历史。

## 已知限制（POC）

- GUI in-band「新开会话」为实验路径（直接 `ctx.agents.create`，未走 preset 组合）。
- 复习到期为被动提醒（每轮快照 + GUI）；无后台定时推送。
- 大纲并发编辑无 CAS（tmp+rename 原子写，last-wins）。
- 客户端 UI 需并入自定义 shell 构建后才可见（官方 web shell 不含第三方客户端包）。
