# Vibe Learning Plugin for DeepSeek Harness

为 DeepSeek Harness 打造的一款氛围学习插件：用户在会话开启氛围学习后，Agent 能与用户共建多层大纲、交互式上课与课后答疑、安排 FSRS 复习计划、创建小测；用户还能在 DeepSeek Harness 内直接记笔记。

设计灵感源于作者（Earzu Chan）的个人工作流。

## 使用

单次实例体验：
```sh
dsh --profile web --patch /pathToYour/DshVibeLearning/cordis.patch.yml --port 3090 # 在 3090 上运行本实例，不干扰可能的3080默认实例
```

持久安装使用：
```sh
dsh plugin --profile web add dsh-vibe-learning # 安装到 web 这个配置
dsh web # 默认实例持久生效
```
# 最高指示：以下文档未修订，未必对，可以不看

## 项目架构、关键流程、关键概念与模型的解析

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

## 开发进展

可见我的[待办项](docs/todo.md)。

## 备注

本项目正在早期开发阶段，不排除会有大量破坏兼容性的修改。
项目以 MIT 协议开源，请在 MIT 协议允许的情况下合理合法使用。

联系我：kontakt@earzuchan.com。

DeepSeek Harness 是 DeepSeek 公司的商标。本项目是第三方的 DeepSeek Harness 插件，从未宣称也无意争取什么官方地位，请注意分辨。