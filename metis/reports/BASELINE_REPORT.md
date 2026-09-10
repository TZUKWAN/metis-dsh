# BASELINE REPORT — METIS4DSH / DeepSeek Harness

> 生成：2026-09-09；对应任务 T1-031~T1-045

| 项 | 值 |
|---|---|
| DSH commit | `d347e703908d0406b7a7ef80e3a0e594d86b2215`（master） |
| Node | v25.6.0 |
| pnpm | 11.7.0（与根 package.json `packageManager` 一致） |
| install | 首次失败：`fs-ext@2.1.1` node-gyp v12 编译错误（LNK1181 `win_delay_load_hook.obj` 缺失——node-gyp 12 对老式 binding.gyp 的 MSVC 工程生成缺陷；Node 25 无 prebuilt 回落源码编译）。**处置**：全局安装 node-gyp@10.3.1，经 `npm_config_node_gyp` 环境变量指定（未修改 DSH 任何文件，符合 T1-035）。重跑 `pnpm install`（依赖树完成）+ `pnpm rebuild fs-ext`（重编译）→ `fs_ext.node` 生成成功。 |
| typecheck | **通过（EXIT 0）**——`pnpm run typecheck`（host + client 两个聚合程序） |
| build | **通过（EXIT 0）**——`pnpm run build`（tsc -b host/client + tsdown 产物） |
| web boot | **通过**——`pnpm dsh web --no-open` 启动；`http://127.0.0.1:3080/` 无 token 返回 401（鉴权入口），带 token 返回 303（进入应用界面）；启动日志打印带 token URL。无 DEEPSEEK_API_KEY，模型调用未测（T1-041 允许）。验证后进程已停止。 |
| 已知 warning | ① `@anthropic-ai/claude-agent-sdk-win32-x64`、`@openai/codex-win32-x64` 下载曾重试（网络 error 23）最终完成——均为 hooks/subagent 桥的可选平台二进制，不在 METIS 依赖链上。② `native/landlock-run` linux 平台包 "Unsupported platform" 警告——Windows 上属预期。 |

## Gate A 结论：**通过**

- install ✔ / typecheck ✔ / build ✔ / 原生 Web 可启动 ✔ / baseline commit 已记录 ✔ / `metis/**` 之外无修改 ✔

## git 状态检查（T1-044/045）

- 基线时 `git status --short`：clean ✔
- 导入 `metis/**` 后：仅新增 `metis/**`（计划内）。

## fs-ext 背景说明

`fs-ext` 是 `packages/session/session-persistence-jsonl` 的依赖（session 写锁 flock/LockFileEx），pnpm-workspace.yaml `onlyBuiltDependencies` 已显式允许其构建——属于 DSH 必需的原生模块，必须编译成功，不可跳过。
