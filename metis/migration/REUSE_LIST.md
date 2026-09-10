# REUSE_LIST — 旧 METIS 科研领域资产复用清单（Gate B）

> 每项：源路径（`metis/legacy/metis-alpha2` 相对）→ 目标插件 → 迁移方式。
> 复用方式枚举：**可直接复用**（纯函数/纯数据，无旧框架依赖）/ **需解耦后复用**（剥离旧 IPC/Runtime 依赖）/ **仅参考逻辑**（重写实现，保留领域知识）/ 不复用实现。
> 路径前缀省略 `metis/legacy/metis-alpha2/`。

## R1. Evidence 域（→ 插件 evidence）

| 源路径 | 内容 | 方式 | 备注 |
|---|---|---|---|
| `engine/evidence/EvidenceLedger.ts` (+test) | 证据台账核心 | 需解耦后复用 | 剥离旧 store 注入，改接插件持久化 |
| `engine/evidence/ProvenanceChain.ts` | 溯源链 | 需解耦后复用 | |
| `engine/evidence/ClaimVerifier.ts` | 主张-证据校验 | 需解耦后复用 | 规格十四的核心 |
| `engine/evidence/ReferenceValidator.ts` | 引用核验 | 需解耦后复用 | 与 literature 域共享 |
| `engine/evidence/AuditTrail.ts` / `IntegrityReporter.ts` / `ReproducibilityTracker.ts` / `SelfDeceptionGuard.ts` | 审计/完整性/复现/自欺防护 | 仅参考逻辑 | 按 DSH 插件形态重写接口 |
| `engine/sources/ClaimGraph.ts` (+test) | 主张图谱 | 需解耦后复用 | |
| `engine/sources/EvidenceAnchor.ts` (+test) | 证据锚点 | 需解耦后复用 | |

## R2. Literature 域（→ literature 核心 + 各 provider）

| 源路径 | 内容 | 方式 | 备注 |
|---|---|---|---|
| `engine/literature/CoreJournalLists.ts` | 核心期刊名录数据 | 可直接复用 | 纯数据 |
| `engine/tools/builtin/academic-tools.ts`（3778 行） | arxiv_search/crossref_lookup/openalex_lookup/import_by_doi/search_papers/fulltext_search 等 26+ 工具与 handler | 需解耦后复用 | **拆分**：HTTP fetch+解析逻辑进各 provider；工具 schema 定义转 defineTool；旧 ToolHandler 签名弃用 |
| `engine/tools/builtin/academic-tools.ts` 内 arXiv API 调用（`export.arxiv.org/api/query` 解析） | arXiv 客户端 | 需解耦后复用 | fetch+XML 解析为纯逻辑 |
| `tests/fixtures`（网络响应/解析 fixture） | provider 测试数据 | 可直接复用 | 随 provider 迁移 |
| `engine/tools/builtin/parse_bibtex/bibtex_audit/format_citation` 相关 | BibTeX/引文格式 | 需解耦后复用 | → literature shared 或独立 shared 库 |

## R3. Submission 域（→ submission，Phase 21）

| 源路径 | 内容 | 方式 | 备注 |
|---|---|---|---|
| `engine/submission/JournalTargeting.ts` | 期刊定位逻辑（含 NCPSSD/核心标记引用） | 需解耦后复用 | |
| `engine/submission/JournalProfileContract.ts` | 期刊画像契约 | 仅参考逻辑 | 按新 domain schema 重定 |
| `engine/submission/portalAdapters.ts` | 门户适配 | 仅参考逻辑 | 旧 WebContentsView 耦合，重写为 fetch+parser |
| `engine/submission/Submission*Contract.ts`（5 个契约文件） | 投稿域契约 | 需解耦后复用 | 领域 schema 保留语义 |
| `engine/research/JournalCatalog.ts` | 期刊目录（LetPub/万维引用处） | 需解耦后复用 | |
| `engine/tools/builtin/journal-catalog-tools.ts` | 期刊目录工具 | 需解耦后复用 | schema 转 defineTool |

## R4. Funding 域（→ funding，Phase 20）

| 源路径 | 内容 | 方式 | 备注 |
|---|---|---|---|
| `electron/FundingTemplateService.ts` | 模板解析/章节树/限字数核心 | 需解耦后复用 | 剥离 Electron IPC |
| `electron/FundingTemplateRepository.ts` | 模板仓储 | 仅参考逻辑 | 持久化按新存储设计 |
| `electron/FundingTemplateToolService.ts` | 模板工具服务 | 需解耦后复用 | 工具面转 defineTool |
| `electron/FundingTemplateObservationAdapter.ts` | 观测适配 | 仅参考逻辑 | Evidence 对接点 |
| `electron/FundingTemplateIpcService.ts` / `RuntimeProjection.ts` | IPC/投影 | 不复用实现 | DSH 工具协议取代 |

## R5. Artifact / Outcomes 域（→ artifact，Phase 18）

| 源路径 | 内容 | 方式 | 备注 |
|---|---|---|---|
| `engine/artifacts/**` | 成果域模型/版本 | 需解耦后复用 | 文件本体走 DSH Files |
| `engine/outcomes/**` | 成果运行时 | 需解耦后复用 | 剥离 Electron |
| `engine/export/**` | 导出逻辑 | 需解耦后复用 | |

## R6. Scenario 方法学（→ scenario，Phase 17）

| 源路径 | 内容 | 方式 | 备注 |
|---|---|---|---|
| personalization 场景定义（科研方法学 prompts/workflows） | 方法学知识 | 仅参考逻辑 | 重写为 Scenario Definition（instructions/requiredTools/outputContract） |
| `engine/manifest/**` | 场景清单契约 | 仅参考逻辑 | |

## R7. 科研工具其余（→ 对应插件，逐个判定迁移顺序）

| 源路径 | 内容 | 方式 | 备注 |
|---|---|---|---|
| `engine/tools/builtin/statistics-tools.ts` | 统计工具 | 需解耦后复用 | 规格十一（真实执行分析） |
| `engine/tools/builtin/research-tools.ts` / `research-coding-tools.ts` / `research-network-tools.ts` | 研究工具组 | 需解耦后复用 | |
| `engine/tools/builtin/writing-tools.ts` | 写作工具 | 需解耦后复用 | 规格十七（论证链写作） |
| `engine/tools/builtin/evidence-tools.ts` | 证据工具 | 需解耦后复用 | → evidence 插件 |
| `engine/tools/builtin/search-tools.ts` / `web-tools.ts` | 搜索/网页 | DROP_DSH_NATIVE（DSH web capability）+ 领域过滤保留评估 | |

## R8. 数据（→ Phase 04 DATA_MIGRATION_PLAN 详化）

| 源 | 内容 | 方式 |
|---|---|---|
| `engine/persistence/schema.ts` + SQLite 迁移 | 领域表结构 | 仅参考逻辑（Phase 04 决定存储形态） |
| 运行时 DB（`%APPDATA%/metis-workbench/metis-data/metis.db`） | 真实科研数据 | Phase 25 迁移工具（dry-run/备份/幂等） |
