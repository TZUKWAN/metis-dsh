# METIS CAPABILITY MATRIX（Phase 03 主矩阵）

> 判定依据：DSH commit `d347e70`（master）当前 checkout 的真实文档与包结构（AGENTS.md 仓库布局 + extension-cookbook.md 功能→机制映射表）。
> 处置枚举：DROP_DSH_NATIVE / REUSE_DOMAIN_CODE / CONVERT_TO_PLUGIN / CONVERT_TO_PROVIDER / CONVERT_TO_TOOL / CONVERT_TO_COMMAND / CONVERT_TO_SKILL / CONVERT_TO_SCENARIO / CONVERT_TO_SHARED_LIBRARY / DEFER / DELETE
> 状态标记：✅ 已判定 / 🔍 待详判（Phase 03 验收前补全行级字段）

## 1. 通用基础设施逐项判定（任务清单 3.3，26 项）

| # | Legacy Module | Legacy Path | DSH Equivalent? | DSH Capability/Package | Disposition | Notes |
|---|---|---|---|---|---|---|
| T3-001 | AgentLoop | engine/core/AgentLoop.ts | Yes | `core/agent-loop`（插件不得改 loop） | ✅ DROP_DSH_NATIVE | DSH agent-loop 是产品脊柱 |
| T3-002 | ToolRegistry | engine/core + engine/tools | Yes | `ctx.tools.register()` + `ctx.tools.restrict()` | ✅ DROP_DSH_NATIVE | METIS 工具改为逐插件注册 |
| T3-003 | ToolDispatcher | engine/tools/ToolDispatcher | Yes | DSH tools 执行管线（execute/post-execute/result） | ✅ DROP_DSH_NATIVE | |
| T3-004 | HookBus | engine/core/HookBus.ts | Yes | Cordis 事件 + `tools/*` waterfall hooks | ✅ DROP_DSH_NATIVE | |
| T3-005 | Provider abstraction | engine/providers/BaseProvider.ts | Yes | `dsh-llm` LlmAdapter Service Definition | ✅ DROP_DSH_NATIVE | |
| T3-006 | OpenAI compatible client | engine/providers/OpenAICompatProvider.ts | Yes（部分） | `dsh-llm` providers；自定义协议→ `registerAdapter` | 🔍 DROP_DSH_NATIVE；若需 OpenRouter 专属路由行为，评估 `adding-an-llm-adapter` 指南后另判 | |
| T3-007 | Reasoning effort handling | providers/ChatTurn 相关 | Yes | LLM adapter 层 | ✅ DROP_DSH_NATIVE | |
| T3-008 | Chat runtime | electron/ChatTurnService + src ChatPage | Yes | DSH Chat/Session/agent | ✅ DROP_DSH_NATIVE | |
| T3-009 | Chat persistence | engine/persistence（agent_events/messages） | Yes | `session/`（JSONL + projection，Model-visible ⟺ logged） | ✅ DROP_DSH_NATIVE | |
| T3-010 | Session persistence | PersistenceStore sessions | Yes | `session/session-persistence-jsonl` | ✅ DROP_DSH_NATIVE | fs-ext 是其依赖（已解决编译） |
| T3-011 | Goal runtime | engine/goal | Yes | `ctx.goals` + goal-round-driver | ✅ DROP_DSH_NATIVE | |
| T3-012 | Plan runtime | （旧 METIS 无独立 plan） | Yes | `plan/plan-mode` | ✅ DROP_DSH_NATIVE | |
| T3-013 | Skills runtime | engine/skills | Yes | `skill/` registry + section 注入 | ✅ DROP_DSH_NATIVE；METIS 方法学内容 → CONVERT_TO_SKILL | |
| T3-014 | MCP runtime | engine/mcp | Yes | 一个 MCP server 一个 plugin 模式 | ✅ DROP_DSH_NATIVE | |
| T3-015 | Subagent runtime | engine/multiagent | Yes | `ctx.subagents` provider registry | ✅ DROP_DSH_NATIVE | |
| T3-016 | Permissions | electron 权限逻辑 | Yes | `tools/pre-execute` + `ctx.approval` | ✅ DROP_DSH_NATIVE | |
| T3-017 | Approval/HITL | engine/hitl | Yes | interaction/approval + ask-user | ✅ DROP_DSH_NATIVE | |
| T3-018 | Shell abstraction | （旧 METIS 无独立 shell） | Yes | `shell/` bash capability | ✅ DROP_DSH_NATIVE | |
| T3-019 | Filesystem abstraction | engine/io | Yes | `fs/` capability + policy | ✅ DROP_DSH_NATIVE | |
| T3-020 | Sandbox | （无） | Yes | `ctx.sandbox` / landlock | ✅ DROP_DSH_NATIVE | |
| T3-021 | Credential Store | electron SecureStorage + provider-profiles | Yes | `credentials/` | 🔍 领域配置（provider profiles 结构）待判：可能 CONVERT_TO_PLUGIN 内部配置；凭据本体用 DSH | |
| T3-022 | Settings Store | electron settings | Yes | `settings/` | ✅ DROP_DSH_NATIVE；科研专属设置进插件 config | |
| T3-023 | Electron shell | electron/main.ts | Yes | DSH Web/Desktop | ✅ DROP_DSH_NATIVE | |
| T3-024 | Conversation UI | src/pages/ChatPage 等 | Yes | DSH Web Client（ConversationNodeDefinition 可选挂点） | ✅ DROP_DSH_NATIVE | |
| T3-025 | Workspace UI | src 各 Workspace 页面 | Yes | DSH Workspace | ✅ DROP_DSH_NATIVE | |
| T3-026 | Model settings UI | 设置页模型连接 | Yes | DSH Settings/Models | ✅ DROP_DSH_NATIVE | |

## 2. 科研领域资产（任务清单 3.4，重点保留）

| # | 资产 | Legacy Path（主要） | Disposition | Target Plugin | 复用方式 |
|---|---|---|---|---|---|
| T3-027 | 科研项目领域 schema | electron/projects + persistence | ✅ CONVERT_TO_PLUGIN | core | 重建精简 schema（T9-003 字段集） |
| T3-028 | Evidence schema | engine/evidence | ✅ CONVERT_TO_PLUGIN（领域部分） | evidence | 迁移 schema 设计；存储适配 DSH 约定 |
| T3-029 | Evidence Ledger | engine/core/EvidenceLedger.ts | ✅ REUSE_DOMAIN_CODE | evidence | 纯逻辑迁移+测试 |
| T3-030 | Provenance 逻辑 | engine/evidence | ✅ REUSE_DOMAIN_CODE | evidence | |
| T3-031 | Citation normalization | engine/evidence/citation* | ✅ REUSE_DOMAIN_CODE | literature/shared | 纯函数直迁 |
| T3-032 | DOI 核验 | engine/sources / evidence | ✅ REUSE_DOMAIN_CODE | literature-crossref | 解析与校验纯函数直迁 |
| T3-033 | NCPSSD adapter/parser | engine/sources（ncpssd） | ✅ CONVERT_TO_PROVIDER | literature-ncpssd | parser 分离；获取层按 DSH web capability 重接 |
| T3-034 | Crossref adapter/parser | engine/sources（crossref） | ✅ CONVERT_TO_PROVIDER | literature-crossref | parser + fixture 直迁 |
| T3-035 | OpenAlex adapter/parser | engine/sources（openalex） | ✅ CONVERT_TO_PROVIDER | literature-openalex | 同上 |
| T3-036 | Semantic Scholar adapter | 待盘点确认存在性 | 🔍 存在则 CONVERT_TO_PROVIDER | literature-ss | |
| T3-037 | arXiv adapter | 待盘点确认 | 🔍 同上 | literature-arxiv | |
| T3-038 | LetPub parser | engine/submission | ✅ CONVERT_TO_PROVIDER | submission-letpub | Phase 21 |
| T3-039 | 万维 parser | engine/submission | ✅ CONVERT_TO_PROVIDER | submission-wanwei | Phase 21 |
| T3-040 | Journal catalog/identity | engine/submission | ✅ REUSE_DOMAIN_CODE | submission | |
| T3-041 | 投稿要求解析 | engine/submission | ✅ REUSE_DOMAIN_CODE | submission | |
| T3-042 | Funding template analyzer | electron FundingTemplate* | ✅ REUSE_DOMAIN_CODE | funding | parser 纯化后迁移 |
| T3-043 | 章节树解析 | funding 解析链 | ✅ REUSE_DOMAIN_CODE | funding | |
| T3-044 | 限字数提取 | funding 解析链 | ✅ REUSE_DOMAIN_CODE | funding | |
| T3-045 | 表格结构解析 | funding/docx 链 | ✅ REUSE_DOMAIN_CODE | funding | |
| T3-046 | 模板版本 diff | funding | ✅ REUSE_DOMAIN_CODE | funding | |
| T3-047 | Artifact domain | engine/artifacts | ✅ CONVERT_TO_PLUGIN | artifact | 领域身份/版本保留；文件走 DSH Files |
| T3-048 | Artifact version | engine/artifacts + persistence | ✅ CONVERT_TO_PLUGIN | artifact | |
| T3-049 | GenOffice 纯文件能力 | build/vendor GenOffice | 🔍 DEFER（Phase 22 判许可证与独立性） | office | |
| T3-050 | 科研场景方法学定义 | personalization 场景 | ✅ CONVERT_TO_SCENARIO | scenario | 转为 Scenario Definition（instructions/skills/tools），弃旧引擎 |
| T3-051 | 经过大量测试的纯函数 | tests/ 覆盖的 engine/* | ✅ REUSE_DOMAIN_CODE | 按域归属 | 逐个随域迁移 |
| T3-052 | 网络响应 fixture | tests/fixtures | ✅ REUSE_DOMAIN_CODE | 各 provider | 直迁 |
| T3-053 | 文档解析 fixture | tests/fixtures | ✅ REUSE_DOMAIN_CODE | funding/office | 直迁 |

## 3. 其余主要模块处置（Phase 03 续判清单预填）

| Legacy 模块 | 初判 Disposition | Target | Notes |
|---|---|---|---|
| engine/persistence（SQLite） | 🔍 待 T4 判定 | — | 关系型 schema 可能优于 KV；数据文件归 metis 标准位置 |
| engine/literature（域逻辑） | CONVERT_TO_PLUGIN | literature 核心 | Provider contract 全新设计（T11），复用域模型 |
| engine/mail / im | DEFER | — | 科研闭环非核心（第三期再判） |
| engine/latex | 🔍 待判 | artifact 附属 | LaTeX 编译若需要作为 artifact 工具 |
| engine/writing | 🔍 待判 | scenario/skill | 写作方法学 → skill 内容 |
| engine/learning / memory / personalization | 大部分 DEFER/DROP | — | 与 DSH memory/skills 重叠；个性化场景定义除外 |
| engine/qa / evals / research / routing | 🔍 待判 | scenario/research 工具 | 逐个按"科研闭环贡献"判定 |
| engine/outcomes / viewers / export | CONVERT_TO_PLUGIN（部分） | artifact | 成果呈现/导出的纯逻辑 |
| engine/hitl 中的领域审批流 | DROP_DSH_NATIVE | — | 通用审批走 DSH approval |
| engine/setup / security / routing / runtime | 🔍 待判（多为装配胶水） | — | 预判大部分 DROP |
| engine/capabilities（CapabilityVault） | 🔍 待判 | core/evidence | 能力源清单若仍需要 |
| src/** UI | DROP（默认） | — | 极少数确有必要者进 Phase 23 评估 |
| METIS_TASK1_FINAL_REPORT.md / HANDOFF 等文档 | 只读参考 | — | 迁移背景资料 |

## 4. 输出物

- 本矩阵（METIS_CAPABILITY_MATRIX.md）
- DELETION_LIST.md / REUSE_LIST.md（Phase 03 验收前由本矩阵展开为行级条目）
- DATA_MIGRATION_PLAN.md（Phase 04）
