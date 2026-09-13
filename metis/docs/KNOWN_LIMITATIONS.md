# KNOWN_LIMITATIONS

- **Funding 材料事实**：履历/团队/成果/经费/时间计划等由用户确认（工具输出 needs_user_confirmation），系统不自动核验；
- **NCPSSD**：无 DOI 检索；反爬变化时 fail-loud；
- **LetPub**：静态列表可检索；登录态/动态页 DEFERRED；
- **submission_gap_check**：第一版启发式（要求验证状态 + artifact 元数据键缺失），不自动判定合规；
- **artifact_compare**：LCS 行级 diff，>4M 单元格拒绝；
- **Compaction**：科研状态全部在 SQLite/工具层，对话压缩不影响项目身份（设计不变量）；未强制触发压缩的专项测试；
- **多模型健壮性**：已验证 cloudlob/qwen3.8-flash-bai；第二模型凭据缺失 → BLOCKED_EXTERNAL；
- **Suite 包**：待 npm 发布后提供一键安装（当前为逐 tarball 安装）。

- **Research Evals 全量执行**：8 任务为长程任务（每任务需 15-40 分钟真实模型时间）。cloudlob 端点 2026-09-13 凌晨单轮延迟超过 900 秒，3 次完整尝试均在续驱预算内超时。框架、任务定义、凭据注入、续驱循环均就绪；端点恢复后 `run-evals.ts` 直接重跑。Golden Run（同类型长任务、拆分为 4 轻轮次）已在同端点全绿通过，证明产品主链可用；
- **research-suite 一键安装**：元包就绪，待 10 个功能包发布 npm 后生效；
- **CI**：未建（本地 generate-engineering-status --full 已覆盖同等门禁）。
