# RC GAP AUDIT — METIS on DSH 工程交付收口审计

> 生成原则：以源码与本轮真实验证记录为唯一事实来源，不信任任何历史报告。
> 优先级仅 P0 / P1 / P2。本轮结束条件：P0 = 0，核心科研闭环相关 P1 = 0。

| ID | Area | Current Reality | Claimed Status | Actual Verification Level | Gap | Priority | Fix | Acceptance |
|---|---|---|---|---|---|---|---|---|
| G01 | Git 血缘 | 本地 master 已修复为 official baseline d347e70390 → METIS commits；远端 TZUKWAN/metis-dsh master 仍是错误 root commit a52d31d | 本地已修 | 本地 merge-base 验证 PASS；fresh-clone guard PASS | 远端仍是坏历史；用户指令已明确要求推送并允许先备份再 force | **P0** | 备份旧远端 master 为 backup 分支 → force-with-lease 推送正确历史 | `git merge-base HEAD d347e70390` 于远端 clone 中成立；远端 diff baseline 不含 METIS 业务改动 |
| G02 | Upstream guard 负向测试 | 已验证：mode 变化 FAIL；metis/** 合法修改 PASS；fresh clone PASS | 已验证 | RUNTIME_E2E_VERIFIED | 缺「新增 DSH 文件 → FAIL」「删除 DSH 文件 → FAIL」两个负向用例 | **P0** | 在 guard 自测中补两组负向用例并真实执行 | 5 组负向用例全部按预期 FAIL/PASS |
| G03 | Funding 持久化 | `plugins/funding` 仍将模板登记写入 `metis-data/funding-templates.json`（JSON）；schema 中 `funding_templates`/`funding_projects` 表已建但无生产写入 | 旧报告称“4 工具完成” | PLUGIN_INTEGRATION_VERIFIED（执行矩阵真实跑通，但存储为 JSON） | 违反统一持久化原则；无版本表/无草稿/无材料缺口 | **P0** | funding 迁移到 MetisDataStore（v2 迁移），新增 material_gap / section_draft 工具 | funding 工具经真实管线执行后数据在 metis.db 可查、重启恢复 |
| G04 | Submission 持久化 | `submission_cases` 等表已建但零生产写入；只有 journal_search / journal_targeting_match | 旧报告称“投稿契约迁移” | UNIT_VERIFIED（契约 zod schema 单测级） | 缺 journal_get/verify/requirements、submission_case_* 工具与持久化 | **P1** | Submission 持久化 + 最小完整工具集（case create/get/update、journal verify/requirements、artifact match、gap check） | 真实管线执行矩阵覆盖新工具；重启后 case 恢复 |
| G05 | Claim-level Evidence | 已有 evidence_claims / claim_evidence_links 表与 create/link/list 工具；但 claim 无 claimType/status、无 excerpts/locator、link 无 relation 语义约束、无 artifact_evidence_check | 旧报告称“证据链完成” | RUNTIME_E2E_VERIFIED（链路真）但深度不足 | 与指令十八~二十三差距：claimType、excerpt/locator、confidence、覆盖率检查、引用硬边界 | **P1** | schema v2 迁移扩展 claim 字段 + evidence_excerpts 生产化 + artifact_evidence_check 工具 + 引用门 | L4 E2E 后 artifact 的核心 claim 有 evidence 覆盖率报告 |
| G06 | Artifact 加固 | 版本链 append-only 已验证；但版本无内容 hash、无 parentVersion、无 artifact_compare、无 finalize | 旧报告称“版本链可追溯” | RUNTIME_E2E_VERIFIED | hash 缺失导致外部篡改文件无法发现；无对比工具 | **P1** | 版本记录 sha256 hash；新增 artifact_compare；可选 finalize 状态 | 篡改文件后 hash 校验能发现；compare 输出两版本差异 |
| G07 | Migration 系统 | `MetisDataStore.migrate()` 仅 v1 初始化（PRAGMA user_version）；无增量迁移框架 | 旧报告称“schema v1” | UNIT_VERIFIED | 指令八要求 schema_migrations + 版本化迁移 + 失败不静默 | **P1** | 建立 migrations 列表 + 事务化 apply + v2（funding/submission/claim 扩展）作为第一个真实增量迁移 | 空库初始化 PASS；v1→v2 升级 PASS；坏库 fail-loud |
| G08 | Tool Input Contract | literature_save 已做边界 normalize；其余工具参差 | 旧文档无该文档 | — | 缺统一契约文档 + 全工具 robustness 矩阵（string/object/null/极端值） | **P1** | 编写 docs/TOOL_INPUT_CONTRACT.md + 每工具 robustness 单测 | 24 工具 × 关键畸形输入矩阵全绿（按语义允许或拒绝） |
| G09 | Tool Error Contract | throw 与 {ok:false} 混用；错误无稳定 code | 旧文档无 | — | 指令十三要求统一错误语义 | **P1** | 定义 METIS 错误对象（code/message/retryable），领域错误统一映射 | 工具错误输出形态一致且有 code |
| G10 | AbortSignal | literature providers 已接 exec.signal；funding 文件 I/O、journal_search fetch、submission 未接 | 旧文档称“全部支持取消” | UNIT_VERIFIED（仅 literature） | 指令十四要求全部 I/O 遵守取消 | **P1** | journal_search/funding 文件读写补 signal 或等价快速路径 | 取消后不悬挂 |
| G11 | 并发隔离 | 已有 unit 级 session/workspace 隔离测试；缺“两 workspace 两会话同时运行”的并发集成 | 旧报告称隔离已验证 | UNIT_VERIFIED | 指令四十七 | **P1** | 新增并发隔离集成测试（双 agent 交错工具调用，断言零串扰） | 并发测试 PASS |
| G12 | 长程 Golden Run + compaction | L4 E2E 已达 30+ tool calls 真实模型；无 restart/resume 与 compaction 联合长程 | 旧报告称 E2E 完成 | AGENT_E2E_VERIFIED（短程） | 指令四十四/四十五：一次长任务含 steering + restart + 续跑 + 压缩路径 | **P1** | golden-run 脚本：多轮检索→综述 v1→steering→v2→重启→继续 | 全程数据零丢失 |
| G13 | Research Eval Suite | 不存在 metis/evals | 无 | NOT_STARTED | 指令三十四~四十三要求 8 个真实哲社科任务 | **P1** | 建 evals 框架 + 8 任务定义 + 结构化评分（真实模型凭据可用时执行；否则 BLOCKED_EXTERNAL 标注） | evals 可执行并产出结构化报告 |
| G14 | 文档集 | ARCHITECTURE/ARTIFACT/SCENARIO/LITERATURE/PLUGIN_STANDARD/EXTERNAL_BLOCKERS 已真实化；缺 README（用户向）、INSTALLATION、UPGRADE_DSH、DATA_MODEL、EVIDENCE_MODEL、TOOL_INPUT_CONTRACT、TESTING、RESEARCH_EVALS、RELEASE_CHECKLIST、KNOWN_LIMITATIONS | 旧文档部分失实已修 | — | 指令六十一~六十三 | **P1** | 按清单补齐，README 面向真实用户 | 新用户按文档可从零安装使用 |
| G15 | Suite 包 | 无 dsh-metis-research-suite | 无 | NOT_STARTED | 指令五十四 | **P2** | 纯组合 bundle 包（依赖 10 插件） | `dsh plugin add suite` 一次装齐 |
| G16 | CI | 无 | 无 | NOT_STARTED | 指令五十九/六十 | **P2** | GitHub Actions：typecheck/unit/guard/build/pack（无秘密）；真实模型 E2E 标记为 manual | CI 绿 |
| G17 | Release 版本 | 插件 0.1.0；无统一 release 标记 | 无 | — | 指令六十四 | **P2** | 打 tag v0.1.0-rc + RELEASE_CHECKLIST | tag 与 checklist 存在 |
| G18 | ENGINEERING_STATUS schema | 已机器生成 10 检查；缺 researchEvals/longRun/persistence/migration 分区 | 旧状态无 | — | 指令五十六 | **P2** | 生成器输出扩展为分区结构 | 字段齐全且来自真实命令 |
| G19 | 多模型健壮性 | 仅 cloudlob/qwen 一条真实路由 | — | AGENT_E2E_VERIFIED（单模型） | 指令四十六要求第二模型；无第二凭据 | P2/BLOCKED_EXTERNAL | 记录阻塞；边界层 normalize 已按模型无关设计 | 获得第二凭据后跑同一路径 |
| G20 | Scenario×Goal 规则文档 | 已实现：无 Goal→创建；有未完成 Goal→拒绝并返回现有 Goal；completed→可替换 | 代码已实现 | RUNTIME_E2E_VERIFIED | 指令十六要求规则明确记录 | **P2** | 写入 SCENARIO.md | 文档与行为一致 |
| G21 | 插件生命周期 reload | ctx.effect 清理连接已实现并被 dispose 路径真实执行（L2/L4）；无显式 unload/reload 集成用例 | — | RUNTIME_E2E_VERIFIED（dispose 路径） | 指令五十一 | **P2** | 复用 L2 脚本加一轮 dispose→reboot 断言（已有）+ loader reload 冒烟 | 无句柄泄漏症状 |

## 当前完成条件对照（指令七十）

| 条件 | 状态 |
|---|---|
| DSH untouched fresh-clone PASS | ✅ |
| Git upstream 血缘正确（本地） | ✅（远端推送 = G01） |
| ResearchProject/Literature/Evidence/Scenario/Artifact 持久化 + 恢复 | ✅ |
| Scenario session 隔离 | ✅ |
| Funding persistence | ❌ G03 |
| Submission persistence | ❌ G04 |
| Claim-level evidence 第一版 | ❌ G05 |
| Tool contract 全量审计 | ❌ G08/G09/G10 |
| clean install / runtime E2E / real agent E2E | ✅ |
| long-run + restart/resume + compaction | ⚠️ G12 |
| 多工作区隔离（并发） | ⚠️ G11 |
| 8 个 Research Eval | ❌ G13 |
| Final Audit / Golden Path | ❌ 待全部完成后执行 |
