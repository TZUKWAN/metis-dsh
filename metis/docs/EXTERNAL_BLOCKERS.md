# 外部阻塞项

本文件只记录无法由本仓库代码、测试夹具或公共 Provider 解决的外部依赖。出现某个阻塞项不代表其他工程 Gate 已通过，也不应阻断不依赖该项的测试和开发。

## BLOCKED_EXTERNAL: DEEPSEEK_API_KEY

- **影响范围**：Level 4 Real Agent E2E。
- **未受影响的范围**：Unit Test、真实 Cordis Loader Integration、DSH Runtime E2E、公开 Crossref/OpenAlex/NCPSSD Provider 验证、持久化、重启恢复、build、pack、clean-install。
- **必须验证的真实链路**：以自然语言任务触发 DSH Agent 自主调用 METIS 工具，完成 ResearchProject → 多 Provider Literature → Evidence → Artifact，并在 DSH 重启后继续。
- **当前状态**：`BLOCKED_EXTERNAL`。当前环境未配置该凭据，因此不得将 Real Agent E2E 标为 PASS。
- **解除条件**：在 DSH 的正式凭据配置中提供可用的 DeepSeek API Key 后，运行仓库中记录的 Real Agent E2E；测试代码不得代替模型人工编排工具调用。


## 已解除（原 BLOCKED_EXTERNAL: DEEPSEEK_API_KEY）

- Real Agent E2E 不再依赖 DeepSeek 官方凭据：DSH 的多 provider 适配器（llm-pi-ai）支持任意
  OpenAI 兼容端点。`metis/scripts/verify-real-agent.ts` 通过环境变量 `CLOUDLOB_API_KEY`
  在运行时注入用户提供的端点与密钥（密钥不落盘、不入库），已真实跑通模型自主调用
  METIS 工具的全链路（7/7 checks PASS）。
- 若要改回 DeepSeek 官方路由，配置 `llm-deepseek` + `DEEPSEEK_API_KEY` 即可，插件层无需改动。
