# DELETION_LIST — 由 DSH 原生能力取代、不迁移的旧模块（Gate B）

> 这些模块**不会**出现在 METIS4DSH 的任何插件中。新开发禁止参考其实现（领域知识除外，见 REUSE_LIST）。
> 依据：DSH commit `d347e70` 当前文档（AGENTS.md 仓库布局、extension-cookbook.md 功能→机制映射）。

| # | Legacy 模块 | Legacy 路径（省略前缀） | DSH 取代物 | 取代理由 |
|---|---|---|---|---|
| D1 | AgentLoop | `engine/core/AgentLoop.ts`（1683 行） | `packages/core/agent-loop` | DSH 产品脊柱；插件不得改 loop |
| D2 | HookBus | `engine/core/HookBus.ts` | Cordis 事件 + `tools/*` waterfall | 原生等价 |
| D3 | RateLimiter（LLM 并发） | `engine/core/RateLimiter.ts` | LLM adapter/DSH 运行时语义 | 通用 LLM 基础设施 |
| D4 | Provider 抽象 | `engine/providers/BaseProvider.ts`、`ProviderFactory.ts` | `dsh-llm` LlmAdapter seam | |
| D5 | OpenAICompatProvider | `engine/providers/OpenAICompatProvider.ts` + `SSEParser.ts` | `dsh-llm` providers / `registerAdapter` | |
| D6 | ContextEngine（压缩） | `engine/context/ContextEngine.ts` | `ctx.compaction` seam + `dsh-compaction-basic` | |
| D7 | ToolRegistry/Dispatcher | `engine/tools/ToolRegistry.ts`、`ToolDispatcher.ts`、`ArgsValidator.ts`、`ToolPresenter.ts` | `ctx.tools` 执行管线 + defineTool + DSH tool UI cards | |
| D8 | HITL/Approval | `engine/hitl/**` | `interaction/` + `ctx.approval` + `tools/pre-execute` ask | |
| D9 | Goal runtime | `engine/goal/**` | `ctx.goals` + goal-round-driver | |
| D10 | Skills runtime | `engine/skills/**`（SkillRegistry 等） | `skill/` registry + section 注入（内容本身按 CONVERT_TO_SKILL 另迁） | |
| D11 | MCP runtime | `engine/mcp/**` | 一 MCP server 一 plugin 模式 | |
| D12 | Multiagent runtime | `engine/multiagent/**` | `ctx.subagents` + subagent providers | |
| D13 | Workflow 引擎 | `engine/workflow/**` | `ctx.workflowEngine` + worker-thread engine + `workflow` 工具 | |
| D14 | Chat/Session 持久化 | `engine/persistence/**` 中 agent_events/messages/sessions 表与 PersistenceStore 对应层 | `session/` JSONL + projection | 领域表见 DATA_MIGRATION_PLAN |
| D15 | Settings/Credentials 存储 | `electron/SecureStorage*`、settings 处理 | `settings/` + `credentials/` | |
| D16 | Provider Profiles（凭据管理） | `electron/ProviderProfileStore.ts`、`provider-profiles.v1.json` 机制 | `credentials/` | 连接级参数（timeout/retries）改由插件 config 承载 |
| D17 | Electron 主进程壳 | `electron/main.ts`（1.4 万行）及全部 IPC 服务 | DSH Web/Desktop + 插件工具协议 | |
| D18 | Electron 加载器/窗口/更新 | `electron/preload.ts`、窗口、autoUpdater 等 | DSH 启动器 | |
| D19 | Chat UI | `src/pages/ChatPage.tsx`（4554 行） | DSH Web Client Chat | |
| D20 | Workspace UI（科研/选题/成果/投稿页） | `src/pages/**`、`src/personalization/**`（页面部分） | DSH Workspace + 必要时 ui-* 插件（Phase 23 评估） | |
| D21 | 模型设置 UI | 设置页模型连接表单（`src/components/ProviderProfilesSection.tsx` 等） | DSH Settings/Models | |
| D22 | Scenario 运行引擎 | `ScenarioWorkflowService.ts`（1598 行）、`engine/workflow` | DSH Workflow/Goal/Plan 组合 | 方法学内容转 Scenario Definition |
| D23 | 事件执行桥 | `electron/AgentExecutionEventBridge.ts` | `agent/assistant-stream` + `session/event` | |
| D24 | Conversation 呈现层 | `src/conversation/**`、`src/presentation/StreamingMarkdown.tsx`（本次 P0 产物） | DSH ConversationNodeDefinition + keyed renderer | P0 重构成果随旧壳退役；增量解析思想如需可再参考 |
| D25 | Mail/IM 域 | `engine/mail/**`、`engine/im/**` | 暂无对应（DEFER，科研闭环非核心） | 第一版不迁移 |
| D26 | 免费模型扫描 UI/服务 | `FreeModelCenter` 相关 | 不迁移 | 运营性功能，模型配置由 DSH Settings 承载 |
| D27 | 构建产物与运行时 | `dist*`、`release*`、`node_modules`、`logs`、`genoffice-userdata` | 不迁移 | 未复制入 legacy 副本 |

## 明确不淘汰的对照

科研领域资产（Evidence、Literature providers、Funding 解析、Artifact 域、期刊目录、方法学知识、fixture 与纯函数）**不在本清单**——见 REUSE_LIST.md。
