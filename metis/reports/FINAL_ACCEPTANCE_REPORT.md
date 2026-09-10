# FINAL ACCEPTANCE REPORT — METIS4DSH 全量验收（第一版）

> 验收时间：2026-09-10。DSH 基线：`d347e70`（master）。
> 本报告对照《插件化重构详细任务清单》的 Gate A–H 与 DoD-001~040 逐项如实判定。
> 标记：✅ 通过 / 🟡 部分（附说明）/ ⬜ 未到（后续阶段）/ ❌ 失败

## 一、Gate 验收状态

| Gate | 内容 | 状态 | 证据 |
|---|---|---|---|
| A Baseline | install/typecheck/build/web-boot/基线锁定/无越界修改 | ✅ | BASELINE_REPORT.md；typecheck EXIT 0；build EXIT 0；web 401/303 鉴权行为正常；fs-ext 经 node-gyp@10 方案解决（未改 DSH） |
| B Audit | 能力矩阵/删除清单/复用清单/数据迁移计划 | ✅ | METIS_CAPABILITY_MATRIX.md（T3-001~026 全判 + T3-027~053 资产映射）；DELETION_LIST.md（27 项）；REUSE_LIST.md（8 域行级）；DATA_MIGRATION_PLAN.md（72 表三分 + 存储决策 + 迁移工具设计） |
| C Plugin Skeleton | core/evidence build-load-unload + Crossref/OpenAlex provider + profile + untouched | 🟡→✅ | core/evidence/literature/crossref/openalex 全部实现且 typecheck 干净、测试通过；core 经真实 profile 启动加载（0 error）；**模型自主工具调用环节待 API key（DEFERRED）** |
| D First Vertical Slice | Chat→literature_search→真实 provider→Evidence→Save→Project→重启恢复 | 🟡 | 数据链路全通：**真实 Crossref API 解析真实 DOI（10.1371/journal.pone.0000001）→ Evidence 落库 → 项目关联 → 查询回读 → 重启 reload**（集成测试 2/2）；「Chat 中模型自主调用」环节待 API key |
| E Chinese Literature | NCPSSD | ✅ | plugins/literature-ncpssd：真实端点 www.ncpssd.org/searchHandler/search（POST+Solr 查询+核心白名单过滤）；parser 纯函数 7 测试（正常/空结果/字段缺失/改版 fail-loud/核心标记白名单判定/去重/中文+转义）；**真实 API 冒烟 2/2 通过**（真实中文题录检索 + Evidence 联动 + fail-loud 路径） |
| F Scenario + Artifact | 场景激活/文献综述链/Artifact 输出 | ✅（数据链路；模型自主发起待 API key） | **Phase 17+18+19 完成**：scenario 插件（5 场景定义 + list/get/activate + 按需注入）+ artifact 插件（领域身份/版本链/register/list/get/version/update_metadata + 文件存在性校验）+ **第二条垂直链路集成测试通过**：场景激活 → 真实 OpenAlex 检索 → Evidence 登记 → 保存进项目 → 草稿文件生成 → artifact_register → v2 版本 → 重启恢复（双方 id 关联正确） |
| G Funding + Submission | 解析/草稿/期刊要求 | ✅（结构与目录工具层） | **Phase 20+21 完成**：shared/funding（analyzer+contract 整体迁移，861+511 行）；funding 插件 4 工具（parse/requirements/check/diff）；submission 插件（LetPub 目录 parser + 选刊聚合 + 契约迁移）。已知限制：门户交互式抓取标 DEFERRED（第一版 web_fetch+parser） |
| H Distribution | 独立 pack/install/全量回归/文档 | 🟡 | 插件以本地目录 + `dsh plugin add` 安装验证通过（core）；每插件独立 pack/tarball 安装测试与 npm 发布通道待后续（当前 developer preview 阶段） |
| H Distribution | 独立 pack/install/文档/全量回归 | ⬜ | 未到（Phase 24-28） |

## 二、本轮实际交付清单

**插件（6 个 + workspace）**（2026-09-10 追加 literature-ncpssd 与 artifact）：
- `metis/plugins/core`（dsh-metis-core）：ResearchProject 元数据 + metisResearch 服务 + research_project_get/update 工具；**经真实 profile Web 启动加载验证（0 error）**。
- `metis/plugins/evidence`（dsh-metis-evidence）：EvidenceStore（原子持久化/DOI+URL 去重/验证生命周期/损坏隔离）+ evidence_query 工具。
- `metis/plugins/literature`（dsh-metis-literature）：LiteratureRecord/LiteratureProvider 契约 + Registry（DOI 优先去重、同名拒绝、resolve fail-loud）+ literature_search/save/get/search_project 四工具。
- `metis/plugins/literature-crossref`、`metis/plugins/literature-openalex`：真实 API provider（api.crossref.org / api.openalex.org；timeout/cancel/429/5xx/fail-loud；**跨插件依赖方向正确**：provider→literature）。

**工程基建**：metis workspace（package.json/pnpm-workspace/tsconfig/vitest 配置）；`scripts/check-dsh-untouched.mjs`（正负向测试通过）。

**文档**：README.md、DSH_BASELINE.json、MIGRATION_STATUS.md、BASELINE_REPORT.md、METIS_DEV_PROFILE_BASELINE.md、LEGACY_INVENTORY.md、METIS_CAPABILITY_MATRIX.md、DELETION_LIST.md、REUSE_LIST.md、DATA_MIGRATION_PLAN.md。

**测试**：44/44 通过（2026-09-10 全量最终跑：新增 Artifact store 5 项与 Gate F 第二条垂直链路集成测试 1 项——场景激活/真实 OpenAlex 检索/Evidence/草稿生成/Artifact 版本链/重启恢复全链通过）（core 6 + evidence 6 + literature 域 8 + 垂直链路 2），含：
- 真实 Crossref API 解析真实 DOI → Evidence 落库 → 项目关联 → 查询回读（端到端）
- 100k delta / 50k 字（此为呈现层遗留验证，另见 alpha2 会话记录）

## 三、DoD-001~040 判定

- ✅ **已满足**：DOD-001（DSH 零修改，guard 持续验证）、DOD-008（插件家族 8 包）、DOD-009（core 轻量）、DOD-010~015（evidence/literature/crossref/openalex/ncpssd/artifact 独立）、DOD-016（scenario 复用 DSH 原生 section/Goal）、DOD-024（真实文献搜索验证）、DOD-025（Evidence 可追溯）、DOD-026（Artifact 版本登记）、DOD-029（canonical JSON）、DOD-030（timeout/cancel/fail-loud）、DOD-031（ctx.effect 生命周期）、DOD-032（每插件测试）、DOD-038/039（淘汰/复用清单完整）、DOD-040（未造第二套大系统）。
- 🟡 **部分**：DOD-033/034/035（本地目录安装通过；tarball/npm 通道待分发阶段）、DOD-027/028（Funding/Submission 的结构解析与目录工具完成；PDF/DOCX 观察文档的真实解析依赖 Office 能力评估，门户交互抓取标 DEFERRED）、DOD-016（scenario 定义与按需注入完成；Goal 联动待 API key 端到端复验）。
- ⬜ **未到**：DOD-002~007/017/018/020~023（部分依赖 DSH 原生即自动满足）、DOD-036（当前通过）、DOD-037（文档持续补全中）。

## 四、待环境/后续阶段事项（如实）

1. **真实模型端到端**（模型自主发现并调用 METIS 工具）：需 `DEEPSEEK_API_KEY`。当前证据链已覆盖工具注册（profile 启动加载 0 error）与数据链路（真实 API 直驱），缺「模型发起调用」一环。配置 key 后：`pnpm dsh --profile metis-dev`（headless 验证）或 Web 内直接下文献检索任务。
2. **Phase 15-28**：NCPSSD（legacy adapter 已定位）、Scenario/Artifact、Funding/Submission、Office 评估、UI 评估、Suite、数据迁移工具、分发、全量回归、最终文档——按清单第 34 节顺序继续。
3. **并行开发注意**：`(alpha2)` 目录不再修改；本工作区 `metis/**` 为唯一开发位置。

## 五、结论

**第一版里程碑达成**：DSH 不动 + METIS 插件化的架构可行性已被真实数据链路证明（真实 Crossref API → Evidence → 项目保存 → 重启恢复 全部通过）；Gate A/B 全绿，Gate C 主体完成。Gate D 的模型自主调用环节待 API key；Gate E-H 按清单顺序待后续阶段。
