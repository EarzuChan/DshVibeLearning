# Vibe Learning Plugin for DeepSeek Harness

为 DeepSeek Harness 打造的一款氛围学习插件：用户在会话开启氛围学习后，Agent 能与用户共建多层大纲、交互式上课与课后答疑、安排 FSRS 复习计划、创建小测；用户还能在 DeepSeek Harness 内直接记笔记。

设计灵感源于我（Earzu Chan）的个人工作流。

## 使用

```sh
dsh plugin --profile web add dsh-vibe-learning # 添加本插件到你的配置项
dsh web # 持久生效，直接使用
```

在新会话，键入 `/learn` 命令使会话进入氛围学习，也可以顺带说明想学什么，如 `/learn 我想系统学一遍线性代数`；未进入氛围学习的会话，模型仍可以进行其他方面工作，但无法使用 DVL 提供的工具和内容。

进入氛围学习后，将使本会话的工作区转变为学习工作区，届时将在会话Tab中增加一个学习面板，可在其中查看您的纲目、复习、小测。

我们还在界面右上角增加了“当前会话的活跃纲目”与“笔记”功能。笔记是全局可用、分册组织、分级权限（约束了模型对您笔记的查看和编辑性）的。

目前核心代码基本完善，但 UI 和 Prompt 等尚在持续打磨，您可参见我的[待办](docs/todo.md)文件。

## 项目架构、关键流程、关键概念与模型的解析

将在之后更新本内容。

## 配置

需要查看 DVL 的关键日志（进入学习、切换纲目、呈现与 Run 终局、子代理归属、路由失败等）时，安装 `@deepseek-ai/cordis-plugin-logger-console`，并取消 [cordis.patch.yml](cordis.patch.yml) 中对应段落的注释。

## 已知限制（POC）

- 需要 DeepSeek Harness `>=0.2.2-alpha.2 <0.3.0`。
- Run 只在创建它的进程内有效：进程重启后，未完成的 Run 会在下次读取时自动记为放弃，需要重新呈现。
- 桌面版暂不支持在外部浏览器打开 Run 页面，请在会话内的 In-band 视图中作答。
- 学习 API 依托官方 Connection 鉴权；工件页面在沙箱化的不透明源中运行，无法使用 localStorage 等浏览器存储。
- 创作子代理只支持一级，且只能创作工件，不能改大纲、复习计划或呈现工件。
- 复习到期为被动提醒（每轮快照 + UI 显示）；无后台定时推送。
- 大纲并发编辑无 CAS（tmp+rename 原子写，last-wins）。
- UI 上或会存在信息不同步的现象，请您手动点击学习面板中的刷新按钮。

## 备注

本项目正在早期开发阶段，不排除会有大量破坏兼容性的修改。
项目以 MIT 协议开源，请在 MIT 协议允许的情况下合理合法使用。

如果您觉得这个项目实用，请为我点个 Star。若您能参与开发工作那就更好了，欢迎随时投 PR 或者与我取得联系。

本项目属于[LinuxDo社区](https://linux.do/)共建项目，该社区还有很多更带派的项目和小伙伴，欢迎前往。

联系我：contact@earzuchan.me。

DeepSeek Harness 是 DeepSeek 公司的商标。本项目是第三方的 DeepSeek Harness 插件，从未宣称也无意争取什么官方地位，请注意分辨。
