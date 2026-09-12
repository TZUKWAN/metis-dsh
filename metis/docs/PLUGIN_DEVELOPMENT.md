# PLUGIN_DEVELOPMENT

新插件开发遵循 `docs/PLUGIN_STANDARD.md`（descriptor 入口 + Service 构造器注册工具 +
inject 声明 + MetisDataStore 持久化 + defineTool 输出 schema + 统一错误契约 +
TOOL_INPUT_CONTRACT 归一化）。最低测试要求见 PLUGIN_STANDARD §7；
进入分发门矩阵需在 `scripts/verify-dsh-dist.ts` 的 EXPECTED_TOOLS + 执行矩阵登记。
