# KNOWN_LIMITATIONS

- **Funding 材料事实**：履历/团队/成果/经费/时间计划等由用户确认（工具输出 needs_user_confirmation），系统不自动核验；
- **NCPSSD**：无 DOI 检索；反爬变化时 fail-loud；
- **LetPub**：静态列表可检索；登录态/动态页 DEFERRED；
- **submission_gap_check**：第一版启发式（要求验证状态 + artifact 元数据键缺失），不自动判定合规；
- **artifact_compare**：LCS 行级 diff，>4M 单元格拒绝；
- **Compaction**：科研状态全部在 SQLite/工具层，对话压缩不影响项目身份（设计不变量）；未强制触发压缩的专项测试；
- **多模型健壮性**：已验证 cloudlob/qwen3.8-flash-bai；第二模型凭据缺失 → BLOCKED_EXTERNAL；
- **Suite 包**：待 npm 发布后提供一键安装（当前为逐 tarball 安装）。
