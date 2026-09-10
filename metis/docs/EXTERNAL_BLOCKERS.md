# 外部阻塞项

本文件只记录无法由本仓库代码、测试夹具或公共 Provider 解决的外部依赖。出现某个阻塞项不代表其他工程 Gate 已通过，也不应阻断不依赖该项的测试和开发。

## BLOCKED_EXTERNAL: DEEPSEEK_API_KEY

- **影响范围**：Level 4 Real Agent E2E。
- **未受影响的范围**：Unit Test、真实 Cordis Loader Integration、DSH Runtime E2E、公开 Crossref/OpenAlex/NCPSSD Provider 验证、持久化、重启恢复、build、pack、clean-install。
- **必须验证的真实链路**：以自然语言任务触发 DSH Agent 自主调用 METIS 工具，完成 ResearchProject → 多 Provider Literature → Evidence → Artifact，并在 DSH 重启后继续。
- **当前状态**：`BLOCKED_EXTERNAL`。当前环境未配置该凭据，因此不得将 Real Agent E2E 标为 PASS。
- **解除条件**：在 DSH 的正式凭据配置中提供可用的 DeepSeek API Key 后，运行仓库中记录的 Real Agent E2E；测试代码不得代替模型人工编排工具调用。
