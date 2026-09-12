# INSTALLATION — 安装指南

## 前置
- Node.js >= 24（自带 node:sqlite）；pnpm >= 9
- 一个 DSH 安装（本仓库 checkout 或 npm 安装版）

## 从本仓库安装（推荐路径）
1. 构建打包：
   ```bash
   cd metis
   pnpm install
   pnpm run build:plugins
   pnpm run pack:plugins
   ```
2. 全量安装到 profile：
   ```bash
   dsh plugin --profile <profile> add dist-tarballs/*.tgz
   ```
   或按需最小安装：`dsh-metis-core`、`dsh-metis-literature` + 任一 provider。

## 配置模型（METIS 不管理凭据）
- DeepSeek 官方：settings.yaml `llm-deepseek:` 段；密钥走 DSH Credential Store 或 `DEEPSEEK_API_KEY`。
- OpenAI 兼容端点（示例）：
  ```yaml
  llm-pi-ai:
    providers:
      my-endpoint:
        displayName: My Endpoint
        api: openai-completions
        baseURL: https://example.com/v1
        apiKeyEnv: MY_ENDPOINT_KEY
        models:
          - id: my-model
            name: My Model
            contextWindow: 262144
            maxTokens: 32768
  ```
  然后把默认模型设为该路由（Web Models 页或 `agent-default-model` 层）。
- **任何密钥不得进入 git / 日志 / ENGINEERING_STATUS**；正式用户使用 DSH Credential Store，环境变量仅用于 CI/E2E。

## 验证安装
```bash
node --import tsx/esm metis/scripts/verify-dsh-dist.ts metis/dist-tarballs/*.tgz
```
（该脚本内部即使用官方 `dsh plugin add` 装入全新 profile 并做 30 工具执行矩阵。）

## 数据在哪里
profile 工作目录下 `metis-data/metis.db`（SQLite；全部科研领域状态）。
