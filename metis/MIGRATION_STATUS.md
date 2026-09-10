> **历史材料**：本文件是分阶段迁移日志，其中「已完成」等表述反映写作时点的局部状态，
> 不代表当前架构（领域状态已迁移至 SQLite，验证体系见 docs/ARCHITECTURE.md）。
> 当前交付状态以 ENGINEERING_STATUS.json 为准。

# MIGRATION_STATUS

```text
Current Phase: PHASE_20_21_DELIVERED（Gate A ✔ / B ✔ / C 主体✔ / D 数据链路✔ / E ✔ / F 数据链路✔ / G 结构与目录工具层✔）；真实模型调用验证 DEFERRED（待 DEEPSEEK_API_KEY）；Gate H（分发打包/全量回归收尾/最终文档）部分完成
Baseline DSH Commit: d347e703908d0406b7a7ef80e3a0e594d86b2215
Last Completed Task: Phase 21 Submission 插件（journal-catalog parser + journal-targeting 选刊聚合 + submission-contract 契约整体迁移 + journal_search/journal_targeting_match 工具）
Completed:
  - Phase 01-02：METIS4DSH 工作区、DSH 基线锁定（clean）、legacy 导入（2980 文件只读）、LEGACY_INVENTORY.md
  - Phase 03（Gate B ✔）：METIS_CAPABILITY_MATRIX.md（T3-001~026 全判 + T3-027~053 资产映射）+ DELETION_LIST.md + REUSE_LIST.md
  - Phase 04：DATA_MIGRATION_PLAN.md（72 表三分；领域数据继续 SQLite；迁移工具设计）
  - Phase 05：metis workspace（独立 pnpm workspace + strict tsconfig + 统一脚本）
  - Phase 06：check-dsh-untouched.mjs 守护脚本（正负向测试通过）
  - Phase 07：metis-dev profile（base + dsh-metis-core）+ METIS_DEV_PROFILE_BASELINE.md
  - Phase 08：docs/PLUGIN_STANDARD.md（基于 core 实测形态）
  - Phase 09：dsh-metis-core（MetisResearch 服务 + research_project_get/update + 6 单测）
  - Phase 10：dsh-metis-evidence（EvidenceStore 原子持久化/DOI 去重/验证生命周期 + 6 单测）
  - Phase 11-13：dsh-metis-literature（Registry/merge/工具）+ literature-crossref + literature-openalex（fail-loud + timeout/cancel + normalize 单测）
  - Phase 14：第一条垂直链路集成测试（真实 Crossref DOI 10.1371/journal.pone.0000001 → Evidence → 保存 → 项目关联 → 回读）
  - Phase 15（Gate E ✔）：dsh-metis-literature-ncpssd（真实 NCPSSD API 冒烟 2/2 + parser 7 测试；CoreJournalLists 白名单迁移）
  - Phase 16：core bounded research context（4k 硬预算 + systemPrompt.section 官方注入 + 3 测试）
  - Phase 17：dsh-metis-scenario（5 方法学场景定义 + scenario_list/get/activate + 按需注入 + 5 测试）
  - Phase 18：dsh-metis-artifact（领域身份/版本链 + 5 工具 + 5 测试）
  - Phase 19：第二条垂直链路集成测试（场景激活 → 真实 OpenAlex 检索 → Evidence → 草稿文件 → artifact_register → v2 → 重启恢复）1/1
  - Phase 20：shared/funding（analyzer 861 行 + contract 511 行整体迁移）+ dsh-metis-funding（parse/requirements/check/diff 4 工具）+ 6 测试
  - Phase 21：dsh-metis-submission（journal-catalog parser 500 行迁移 + journal-targeting 选刊聚合 + submission-contract）+ journal_search/journal_targeting_match 工具
  - 全量验收（每阶段执行）：最终 50/50 测试 + typecheck EXIT 0 + guard OK
In Progress: （无——等待刘总指令或 API key 配置）
Blocked: 真实模型自主工具调用复验依赖 DEEPSEEK_API_KEY（环境 UNSET，外部凭据无法代配）
Current Plugins: dsh-metis-core、dsh-metis-evidence、dsh-metis-literature、dsh-metis-literature-crossref、dsh-metis-literature-openalex、dsh-metis-literature-ncpssd、dsh-metis-scenario、dsh-metis-artifact、dsh-metis-funding、dsh-metis-submission（10 包目录）
Current Tests: 50/50（10 文件）；metis typecheck EXIT 0
Known Failures: （无）
Legacy Modules Dropped: 见 METIS_CAPABILITY_MATRIX.md §1（26 项通用基础设施，绝大多数 DROP_DSH_NATIVE）
Legacy Modules Reused: 见 METIS_CAPABILITY_MATRIX.md §2 与 REUSE_LIST.md（Evidence/Literature/Funding/Submission/Artifact 域资产 + CoreJournalLists 白名单数据 + 期刊目录 parser）
DSH Untouched Check: node scripts/check-dsh-untouched.mjs → OK（持续通过）
Gate H 收尾：tarball 分发测试已完成（9/9 插件 pack 含 cordis.patch.yml + src/index.ts）；剩余唯一外部项：DEEPSEEK_API_KEY 配置后复验模型自主工具调用
```
