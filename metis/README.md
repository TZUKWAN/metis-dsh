# METIS Research Plugins — on DeepSeek Harness

本目录（`metis/**`）是 METIS Research Plugin Family 的唯一开发位置。

## 核心原则

> **DeepSeek Harness 负责通用智能体系统；METIS 负责科研领域知识、科研数据、科研工具和科研方法学。**

- **DSH upstream untouched**：本仓库内 `apps/**`、`packages/**`、`docs/**`、`scripts/**`、根 `package.json`、`pnpm-workspace.yaml`、tsconfig 等全部视为只读。任何对 `metis/**` 之外的修改都是违例。
- METIS 不维护独立的 Agent Runtime / Chat / Model / Workspace / Goal / Plan / Skill / MCP Runtime / Electron 壳 / 通用 UI——这些一律使用 DSH 原生能力。
- METIS 只做**科研领域插件**：Research Context、Evidence、Literature、Academic Providers、Scenarios、Artifacts、Funding、Submission，以及极少量确有必要的 UI 插件。
- 每个插件独立安装、独立卸载、独立构建；未安装的插件对模型上下文零污染。

## 目录

```
metis/
├── legacy/       旧 METIS（metis-alpha2）只读副本——迁移来源，禁止修改
├── plugins/      独立插件（每个插件一个目录，独立 package.json）
├── shared/       插件间共享的纯领域库
├── tests/        跨插件集成测试
├── fixtures/     网络响应 / 文档解析 fixture
├── migration/    能力矩阵、删除/复用清单、数据迁移计划
├── docs/         METIS 增量架构与各插件文档
├── scripts/      check-dsh-untouched 等守护脚本
└── reports/      基线报告、验收报告
```

## 当前状态

见 [MIGRATION_STATUS.md](./MIGRATION_STATUS.md)。基线锁定见 [DSH_BASELINE.json](./DSH_BASELINE.json)。

## 任务来源

《DeepSeek Harness × METIS 插件化重构：详细任务清单》。按其第 34 节推荐顺序严格执行；
每阶段通过对应 Gate 后才进入下一阶段。
