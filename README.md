# dsh-vibe-learning

一个 DeepSeek Harness（`dsh`）插件，用于 Vibe Learning。WIP。

## 结构

```
DshVibeLearning/
├── package.json       # 声明 dsh.bundle（分发用的组合层清单）
├── tsconfig.json      # TypeScript 构建配置（src → lib）
├── src/index.ts       # 插件入口（name + apply，暂无业务代码）
├── cordis.yml         # 本地开发 overlay：--patch 从源码加载
├── cordis.patch.yml   # bundle 层：按包名加载构建产物
└── README.md
```

## 开发

把插件装进一个 profile 并启动：

```sh
dsh plugin --profile dev add .       # pnpm 链接本地 checkout 并加入 bundle 层
dsh --profile dev
```

验证层是否生效（不启动）：

```sh
dsh --profile dev --dump-config      # 应出现 "# == dsh-vibe-learning" 层
```

## 源码级热迭代（可选）

在 DsHarness 源码 checkout 里，用 `--patch` 从 TypeScript 源码加载（配合 HMR）：

```sh
cd /path/to/DsHarness
pnpm dsh web --patch ../DshVibeLearning/cordis.yml
```