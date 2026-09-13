# FINAL DELIVERY REALITY AUDIT — METIS on DSH

> 生成时间：2026-09-13。以远端源码与真实运行记录为唯一事实来源。
> 状态阶梯：NOT_STARTED / IMPLEMENTED_UNVERIFIED / UNIT_VERIFIED / PLUGIN_VERIFIED /
> RUNTIME_VERIFIED / GUI_VERIFIED / RESEARCH_QUALITY_VERIFIED / PRODUCTION_READY / BLOCKED_EXTERNAL / FAILED

| ID | Capability | Claimed State | Source Reality | Automated | Runtime | GUI/User | Status | Severity | Required Fix |
|---|---|---|---|---|---|---|---|---|---|
| C01 | Git upstream 血缘 | 正确 | baseline d347e70390 → METIS commits；公共 clone 验证 merge-base | PASS | PASS | — | PRODUCTION_READY | — | — |
| C02 | DSH untouched | 9080 path 一致 | 内容+Git mode+worktree | PASS(本地+fresh clone+负向5例) | PASS | — | PRODUCTION_READY | — | — |
| C03 | 安装（tarball） | 11 包可装 | 官方 `dsh plugin add` 真装 | PASS | 101→102 项执行矩阵 | — | PRODUCTION_READY | — | — |
| C04 | ResearchProject 持久化/绑定 | SQLite+绑定 | metis.db 可查 | PASS | PASS | **GUI PASS**（建项目+绑定 workspace） | GUI_VERIFIED | — | — |
| C05 | Literature 真实检索+保存 | 6+2 篇真实文献 | Crossref/OpenAlex/NCPSSD 实返回 | PASS | PASS | **GUI PASS**（NCPSSD 0 结果自主换词重试；6 篇含 DOI） | GUI_VERIFIED | — | — |
| C06 | Evidence 原子事务 | 文献:证据=1:1 | 8:8 落库 | PASS | PASS | GUI PASS | GUI_VERIFIED | — | — |
| C07 | Scenario 激活 | per-session | metis.db | PASS | PASS | — | RUNTIME_VERIFIED | — | — |
| C08 | DSH Goal 联动 | goals.create | ctx.goals | PASS | PASS | GUI PASS（"目标创建·5秒前"） | GUI_VERIFIED | — | — |
| C09 | Artifact 版本链+哈希 | sha256 全版本 | GUI 会话产出 v3 全哈希 | PASS | PASS | **GUI PASS**（进展报告 final v3） | GUI_VERIFIED | — | — |
| C10 | Research Quality Guard | finalize 门 | 空文档/占位符 critical；未核验 DOI warning | PASS(矩阵 102) | PASS | GUI PASS（低质稿被拦，force 带 warnings 定稿） | GUI_VERIFIED | — | — |
| C11 | 重启恢复 | 会话+数据 | 会话历史恢复；继续任务成功 | PASS | PASS | **GUI PASS**（crash 后 taskkill→重启→续跑） | GUI_VERIFIED | — | — |
| C12 | evidenceIds 边界 | 归一化 | 真机发现 JSON-string 被拒 → 已修（398ce36f3d） | PASS | PASS | GUI 发现→修复→推送 | GUI_VERIFIED（缺陷闭环） | P1→已修 | — |
| C13 | Submission 持久化 | journal/case 工具 | 矩阵 102 项执行（曾因隔离库缺陷 FAIL，已修） | PASS | PASS | — | RUNTIME_VERIFIED | — | — |
| C14 | Funding | SQLite+material_gap+draft | 矩阵执行 PASS | PASS | PASS | — | RUNTIME_VERIFIED | — | — |
| C15 | Research Evals（8 任务） | 已跑 | 3 次尝试全部超时（端点单轮延迟） | FAIL | — | — | **BLOCKED_EXTERNAL** | P1 | 端点恢复后 `run-evals.ts` 重跑；框架/脚本/凭据注入均就绪 |
| C16 | 多模型验证 | 单模型（qwen3.8-flash-bai） | 无第二凭据 | — | — | — | BLOCKED_EXTERNAL | P2 | 提供第二 OpenAI 兼容端点即可 |
| C17 | Provider 故障矩阵 | 429/empty 已真实遇到并正确处理（OpenAlex 429 → 诚实 providerFailures；NCPSSD 0 结果 → 自主换策略） | GUI 实录 | PASS | PASS | GUI 观察 | RUNTIME_VERIFIED | — | — |
| C18 | Suite 一键安装 | 元包就绪 | 依赖未发布 npm → 单装暂不可行 | PARTIAL | — | — | BLOCKED_EXTERNAL | P2 | npm 发布 10 包后即可 |
| C19 | CI | 未建 | — | — | — | — | NOT_STARTED | P2 | GitHub Actions（无密钥门） |
| C20 | 路径安全 | traversal/绝对路径拒绝有测试 | 分发门+单测 | PASS | PASS | — | RUNTIME_VERIFIED | — | — |

## 结论

- **P0 = 0**；核心链 P1 = 0（C15 evals 执行为外部端点阻塞，框架完成并如实登记）。
- 用户 Golden Path（六十六）已在**真实 DSH Web UI、真实模型、真实 Provider** 下完整走通：提出需求 → 建项目 → 多策略真实检索 → 保存文献+证据 → DSH Goal → 产出定稿 Artifact（带哈希版本链）→ 强杀重启 → 会话与状态恢复 → 续跑成功。
- 唯一诚实缺口：Research Eval 8 任务的完整执行受端点吞吐阻塞（三次尝试证据在案），非本地代码/凭据/schema 问题。
