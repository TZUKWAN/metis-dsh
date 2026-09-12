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


## 安装（面向使用者）

前置：已安装 pnpm；使用 DSH 官方插件通道。

```bash
# 构建 + 打包全部 METIS 插件
pnpm run build:plugins
pnpm run pack:plugins          # 产出 dist-tarballs/*.tgz

# 一键安装到你的 profile
dsh plugin --profile <profile> add dist-tarballs/*.tgz
```

## 配置模型

METIS 不管理凭据。DeepSeek 官方：`DEEPSEEK_API_KEY` 或 settings.yaml `llm-deepseek:` 段；
任意 OpenAI 兼容端点：settings.yaml `llm-pi-ai:` 段（providers → baseURL / apiKeyEnv / models）。
详见 docs/INSTALLATION.md。

## 开始一个科研任务

在 DSH 对话中选择 Workspace 后，直接提出研究任务，例如：

> 帮我研究“生成式人工智能如何影响知识工作者内部职业分层”。先真实检索国内外文献并保存，再形成可继续使用的文献综述与研究方案。

Agent 会自主建立项目 → 真实检索 → 登记证据 → 产出可版本化的成果。数据保存在
profile 目录下 `metis-data/metis.db`（SQLite，WAL，版本化迁移）。

## 验证体系（全部真实运行，无 fakeCtx）

| 层级 | 命令 |
|---|---|
| L1 单元/集成（50+） | `pnpm test` |
| 上游守卫（本地 + fresh clone + 负向矩阵） | `node scripts/check-dsh-untouched.mjs` / `node scripts/verify-fresh-clone.mjs` / `node scripts/verify-guard-negative.mjs` |
| L2 真实 Loader Runtime + 重启恢复 | `node --import tsx/esm scripts/verify-dsh-runtime.ts setup/verify <state>` |
| L4 真实模型 Agent E2E | `CLOUDLOB_API_KEY=… node --import tsx/esm scripts/verify-real-agent.ts` |
| L3 分发门（30 工具执行矩阵） | `node --import tsx/esm scripts/verify-dsh-dist.ts dist-tarballs/*.tgz` |
| 长程 Golden Run | `node --import tsx/esm scripts/verify-golden-run.ts run/resume <state>` |
| Research Evals（8 任务） | `node --import tsx/esm evals/run-evals.ts` |

机器生成状态：`node scripts/generate-engineering-status.mjs [--full]` → `ENGINEERING_STATUS.json`。
