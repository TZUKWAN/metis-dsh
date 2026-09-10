# LEGACY INVENTORY — metis-alpha2（迁移来源，只读）

> 导入时间：2026-09-09；来源：`D:\LATEXTEST\metis-alpha2-release`
> 位置：`metis/legacy/metis-alpha2`（2980 文件，约 3.7 GB；node_modules/dist*/release/logs/backups 等构建产物未复制）
> 原始结构未修改（T2-002）。

## 顶层结构

| 条目 | 职责 |
|---|---|
| `engine/**`（40 模块） | 科研领域引擎核心（详见下表） |
| `electron/**` | Electron 主进程：IPC、provider runtime 装配、PersistenceStore、ProviderProfileStore、ChatTurnService、ScenarioWorkflowService、事件桥 |
| `src/**` | React renderer：ChatPage、Topic、Scenario Workbench、成果/投稿/基金 UI |
| `docs/**` | 领域文档 |
| `scripts/**` | 构建/验收脚本 |
| `tests/**` | vitest 测试（engine/frontend/electron 分项目） |
| `build/` `vendor/` | GenOffice（docx/pptx/xlsx 引擎）运行时与 vendored 资产 |
| `package.json` 及 4 个 tsconfig / vitest 配置 | 工程配置 |

## engine/ 40 模块清单（职责速记）

artifacts（成果）、auxiliary、behavior、capabilities（能力导入/CapabilityVault）、context（上下文压缩）、core（AgentLoop/RateLimiter/Config/HookBus/ContextEngine/EvidenceLedger/Approval）、evals、evidence（证据/引用/来源）、export、goal、hitl、im、io、latex、learning、literature（文献域）、mail、manifest、mcp、memory、multiagent、outcomes、persistence（SQLite 存储）、personalization（个性化场景）、pptx、providers（LLM 提供方）、qa、research、routing、runtime、security、setup、skills、sources（外部源抓取）、submission（投稿/期刊）、tools（工具注册与内建工具）、viewers、workflow（工作流引擎）、workspace、writing。

## 已知高价值领域资产（供 Phase 03 Capability Matrix 详判）

- Literature adapters/parsers：NCPSSD、Crossref、OpenAlex、LetPub、万维（engine/literature、engine/sources、engine/submission）
- Evidence：EvidenceLedger、citation normalization、DOI 核验（engine/evidence、engine/core/EvidenceLedger）
- Funding：模板解析、章节树、限字数、版本 diff（personalization/funding 相关 + electron FundingTemplate*）
- Artifact：领域 schema、版本、GenOffice 纯文件能力（engine/artifacts、engine/outcomes、build/vendor GenOffice）
- Scenario：工作流/场景定义与解析（engine/manifest、engine/workflow、personalization）
- Persistence：SQLite schema 与领域数据（engine/persistence）
- 大量纯函数与网络 fixture（tests/、fixtures/）

## 明确的通用基础设施（预判 DROP_DSH_NATIVE，Phase 03 正式判定）

AgentLoop、ToolRegistry/Dispatcher、HookBus、Provider 抽象与 OpenAICompatProvider、Chat/Session runtime、Goal runtime、Skills/MCP runtime、Permissions/HITL、Electron 壳、Chat/Workspace/模型设置 UI。
