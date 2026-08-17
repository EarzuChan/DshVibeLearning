# dsh-vibe-learning — Vibe Learning (DVL)

一个 **DeepSeek Harness（dsh）的第三方学习插件**：把会话变成「学习会话」——与用户共建多层大纲（主纲/子纲/课程）、上课（交互式课程 WebApp）、课后答疑、FSRS 复习、小测、记笔记。学习模式是**单向阀**：进入后不退出，重启后由会话日志自动恢复。

源码非官方、独立仓库、单独发布；只以 peerDependency 依赖 `@deepseek-ai/dsh-*`。

## 安装 / 加载

**无头（只测宿主面）**——从源码加载，tsx source launch，无需安装：

```sh
cd /Users/earzuchan/Documents/Sources/DsHarness
pnpm dsh --profile headless --patch /绝对路径/DshVibeLearning/cordis.yml "say hi"
```

**Web（完整栈：宿主 + 客户端 UI）**——需先构建并把本包装进 profile（客户端 roster 按裸包名解析）：

```sh
cd /Users/earzuchan/Documents/Sources/DshVibeLearning
pnpm run build                                  # tsc 宿主 + tsdown 单文件客户端 bundle（lib/client.js）
cd ~/.dsh/profiles/web && pnpm add /绝对路径/DshVibeLearning   # 把 dsh-vibe-learning 装进 web profile

cd /Users/earzuchan/Documents/Sources/DsHarness
pnpm dsh --profile web --patch /绝对路径/DshVibeLearning/cordis.web.yml --port 3090
```

注意：`cordis.yml`（dev overlay，绝对源码路径）只加载宿主半侧；`cordis.web.yml` 用**裸包名** `dsh-vibe-learning`，宿主 Loader 与客户端 `modules` 扫描器都能解析，是完整栈的临时挂法。`--port` 避开已占用的 3080。

## 组成

单包单入口 `src/index.ts`，内部分五块（都在本包内，无需拆行）：

| 块 | 职责 |
|---|---|
| `learning/` | `ctx.learning` 核心服务：工作区文件域、全局笔记、FSRS（ts-fsrs）、`learning/entered` 事件、P0/P1/P2 prompt、in-band present 注册表 |
| `tool-learning/` | 8 个模型工具，按学习会话挂到 agent 作用域（非学习会话零工具） |
| `command-learning/` | `/learn` 命令族 |
| `skill-learning/` | `course-authoring` skill（catalog 描述 + 内联正文；`skill/course-authoring.md` 为同文源稿） |
| `web/` | 工件 HTTP 服务器（127.0.0.1，端口 config 默认 4182）：统一 URL、主题 + `window.DVL.submit` 桥注入、submit 端点、GUI JSON API |

## 工作区文件布局

```
.dsh/learning/                     # 目录存在 = 学习工作区（无 manifest）
  active.json                      # 当前激活纲目 id（只由用户命令改）
  outlines/<outlineId>.json        # 纲目树 + 每课状态（未开始/学习中/答疑中/完成）
  lessons/<hash>/index.html        # 课程工件 + meta.json + result.json + feedback.json
  cards/<lessonId>.json            # FSRS 卡（每课一张，ts-fsrs Card 原样持久化）
  reviews/<hash>/index.html        # 复习工件（每次复习全新生成）
  quizzes/<hash>/index.html        # 小测工件
```

- `<hash>` = 工件内容 sha256 前 16 位 → 内容不变 id 不变；纲目修改后不再被引用的工件/卡**自动清除**。
- result = 独立 JSON（信封 kind/targetId/submittedAt/score? + 自由 payload）；feedback = 独立 JSON（md 文本含在 JSON 里）。都不进 HTML。
- 笔记 = 全局存储（config `dataDir`，默认 `~/.dsh-vibe-learning/notes.json`），不属于任何工作区文件；模型面按「当前工作区 + tags」过滤。

## 命令

- `/learn` —— 进入学习模式（单向阀，一次性；模型回应并开始共建大纲）
- `/learn <outline-id>` —— 进入并激活指定纲目（模型调 `activate_outline` 后回应）
- `/learn review <lesson-id>` —— 强制到期复习（无卡则建卡；模型走小连招）
- `/learn quiz <lesson-id> [要求]` —— 小测（小连招）

## 工具（模型面，8 个）

`present_artifact` · `get_result` · `get_outline` · `update_outline`（工具内自确认）· `activate_outline` · `filter_notes` · `get_note` · `update_note`（工具内自确认）。
确认弹窗复用 `userQuestions`，返回值 = confirmed / cancelled / error。

## Prompt 面

- **P0 boot line**（非学习会话常驻）：一句开启提示 + `/learn` 引导。
- **P1 全量规范**（学习会话）：状态机、小连招、工件三类与路径约定、result/feedback 格式、笔记模型面、工具纪律。
- **P2 每轮快照**（`agent/pre-step` durable 消息）：激活纲目、当前课（学习中/答疑中）、到期复习清单。

## 客户端 UI（`src/client/`）

学习 tab（纲目们/复习们/小测们）、对话页两个悬浮卡（当前纲目卡、笔记卡）、工件 iframe 呈现与 in-band 触发。数据直连 `/learning/api/state` 等本地端点。入口 `src/client/index.ts` 以 `inject` + `apply` 形式注册 `conversation.view` 与 `conversation.session.header.utilities` 两个槽位，三处共享一个 store handle（每会话一实例）；`dsh.client` manifest（`platform: 'web'`）已在 package.json 声明。

**官方 Web shell 不含第三方客户端包**：并入需在你的自定义 shell 的 bundle patch 里加 `dsh.client` 行并重建（官方主仓库不动）。

> 浏览器加载是**单文件 bundle**（`/plugins/<id>/client.js`，含 CSS Modules 内联与 `__ModuleLoader__` 工厂壳）。本仓库 `tsdown.config.ts` 复刻了 DsHarness 的 `clientBundle` 客户端面，`pnpm run build` 已产出 `lib/client.js`（`exports["./client"]` 指向它）。

## 配置（插件 row 的 config，全部有默认值）

```yaml
config:
  port: 4182                  # 工件服务器端口（127.0.0.1）
  dataDir: ~/.dsh-vibe-learning
  ratingThresholds:           # 客观分 → FSRS 评级
    again: 0.4
    hard: 0.7
    good: 0.9
  presentTimeoutMs: 3600000   # in-band present 最长等待
```

## 已验证

- `npx tsc -p tsconfig.json` 与 `npx tsc -p tsconfig.client.json` 均零错误；`pnpm run build` 出 `lib/`（宿主）与 `lib/client.js`（客户端 bundle）。
- headless profile `--patch cordis.yml` 加载无错（LLM 正常应答）。
- web profile 完整栈：宿主插件加载、工件服务器绑 4182、boot manifest 含 `dsh-vibe-learning`、`/plugins/dsh-vibe-learning/client.js` 200、`/learning/api/state` 200。
- `scripts/smoke.mjs` 端到端：工件 serve + 注入、submit 落盘 result、state API、笔记 API + 模型面过滤、in-band present resolve。

## 已知限制（POC）

- `learning/entered` 事件未标 `ignorable`：卸载 DVL 后含该事件的旧会话日志可能拒绝加载。
- GUI in-band「新开会话」为实验路径（直接 `ctx.agents.create`，未走 preset 组合）。
- 复习到期为被动提醒（每轮快照 + GUI）；无后台定时推送。
- 大纲并发编辑无 CAS（tmp+rename 原子写，last-wins）。
- 客户端 UI 需并入自定义 shell 构建后才可见（官方 web shell 不含第三方客户端包；临时挂法见上文「安装 / 加载」的 web 完整栈）。
