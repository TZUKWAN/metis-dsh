# DATA_MIGRATION_PLAN — 旧 METIS SQLite → METIS4DSH 插件体系（Phase 04）

> 旧库：`%APPDATA%/metis-workbench/metis-data/metis.db`，72 张表（`engine/persistence/schema.ts`）。
> 原则：T4-026（不为统一强改 KV）、T4-033（不静默丢字段）；存储决策服务于科研关系查询。

## 1. 数据归属分类（T4-001~023）

### 1.1 DSH_OWNED（由 DSH 原生运行时重建，不迁移）

| 表 | 理由 |
|---|---|
| sessions / messages / scoped_conversations / scoped_conversation_messages | DSH Session/Chat JSONL |
| agent_events / agent_runs / checkpoints / tool_results / side_effect_ledger | DSH agent/session runtime 事件账本 |
| workflow_runs / eval_runs | DSH workflow / eval 运行态 |
| mcp_servers | DSH MCP plugin 机制 |
| memory | DSH memory 能力 |

### 1.2 METIS_DOMAIN_OWNED（插件领域数据，Phase 25 迁移）

| 领域 | 表 | 目标插件 |
|---|---|---|
| 科研项目 | projects | core |
| 文献 | papers、paper_project_links、collections、sources、external_references | literature |
| 证据 | evidence、claims、claim_evidence_links、note_codes、context_provenance（领域部分） | evidence |
| 成果 | artifacts、artifact_versions、artifact_inputs、artifact_citations、research_artifacts、outcome_*（categories/versions/changes/templates/default_templates/media） | artifact |
| 期刊/投稿 | journal_profiles、journal_profile_snapshots、journal_requirements、journal_corpus_items、journal_pattern_observations、submission_*（shortlists/series/cases/events/gap_items/optimization_plans/optimization_items/preflight_runs/preflight_checks/packages/package_files/review_rounds/review_comments/correspondence） | submission |
| 选题 | topic_sessions、topic_candidates、topic_messages | scenario（选题场景） |
| 研究过程 | research_runs、research_checkpoints、research_decisions | core/research 工具 |
| 能力源 | capability_vault | 评估后归 evidence/core |

### 1.3 LEGACY_ONLY（不迁移，T28-009~014 同口径扩展）

| 表/项 | 理由 |
|---|---|
| image_generation_settings、outcome_prompt_overrides / outcome_prompt_revisions、office_prompt_profiles / _revisions / _defaults / _outcome_bindings | 旧 Office/绘图 UI 绑定，DSH 形态下无消费者 |
| personalization_*（运行时产物） | 场景定义改走 Scenario Definition 文件 |
| schema_version（旧库自用） | 新库自带版本 |

## 2. 存储技术决策（T4-024~027）

**决策：METIS 领域数据继续使用 SQLite**（better-sqlite3，DSH 生态已在 session-persistence 使用原生模块，先例成立），理由：

1. 领域查询本质是关系型：papers↔projects↔evidence↔claims 多对多链接、submission 全链路状态机（13 张表外键级联）、FTS 全文检索（papers_fts）。
2. 旧 schema 经长期生产验证，字段语义可平移，避免"统一 JSON KV"造成的查询能力退化（T4-026）。
3. DSH `storage-domain` 面向 KV/文档形态，不适合上述关系集；该结论记录为**非 gap**（无需改 DSH）。

**布局与版本（T4-027~029）**：
- 数据库位置：`<DSH_HOME>/metis/metis.db`（metis 插件家族共用的标准数据位置，由 core 插件创建并持有连接）。
- `SCHEMA_VERSION` 起始 `1`（与旧库版本无关，全新建库）；`user_version` pragma 承载。
- migration：`metis/plugins/core/src/migrations/001_init.ts` 起，单调递增；每个 migration 幂等校验表存在性。
- 回滚策略（T4-031）：migration 前自动 `metis.db.bak-<version>-<ts>` 备份（保留最近 3 份）；不提供自动 down，恢复以备份还原为准。
- 生命周期（T9-022）：连接由 core 插件 `ctx.effect()` 打开/关闭。

## 3. Phase 25 迁移工具设计（T28-015~022）

`metis/scripts/migrate-legacy.mjs`：

1. **dry-run** 默认开启（`--apply` 才写库）。
2. 源：`--from <旧 metis.db 路径>`；目标：`<DSH_HOME>/metis/metis.db`。
3. 迁移映射表（§1.2 逐表字段映射，Phase 25 按当期 schema 落地）。
4. 统计：每表 migrated / skipped / conflict 计数，输出 `metis/reports/DATA_MIGRATION_REPORT-<ts>.md`。
5. 冲突处理：DOI/URL 主键去重（evidence/papers）；冲突行写入 `migration_conflicts` 表不丢弃。
6. 备份：写入前自动备份目标库（T4-032）。
7. 幂等：以 `(源表, 源主键)` 记录迁移水位，重复执行跳过已迁行（T28-020）。
8. 明确不迁：§1.3 全部 + 旧 Chat/Agent 运行态（T28-009~014）。

## 4. 风险

| 风险 | 处置 |
|---|---|
| 旧库 schema 与清单漂移 | 迁移工具启动时 `PRAGMA table_info` 实测校验，差异 fail-loud |
| FTS（papers_fts）结构依赖 SQLite 版本 | 新库重建索引而非搬表 |
| 大字段（rawMetadata）超限 | 沿用旧上限（T10-009），迁移时截断记录日志 |
