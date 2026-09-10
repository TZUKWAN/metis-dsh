# METIS Reliability Gate（任务 5）

统一入口：`npm run verify:reliability`（Tier 1）。编排脚本：`scripts/reliability-gate.mjs`；清单：`build/reliability-tiers.json`；证据：`logs/reliability-gate-report.json` + `logs/reliability-gate/<check>.log`。

## 分层

| 层 | 命令 | 触发 | 内容 |
|---|---|---|---|
| Tier 1 | `verify:reliability` | 每个 PR / push | typecheck、lint、npm audit、host ABI、合同/Schema/安全 vitest、IPC 快照、更新信任模型、Provider 故障矩阵、线级上下文隔离、Schema/完整性门、Backup 系统验收、健康报告+诊断包隐私 |
| Tier 2 | `verify:reliability:desktop` | 桌面验收（本机/nightly 构建） | layout acceptance（4 表面 × 5 视口 + 截图）、shutdown/relaunch E2E、MCP 泄漏门（vitest）、PTY+GenOffice 泄漏门、Crash/Relaunch harness |
| Tier 3 | `verify:reliability:nightly` | Nightly（GitHub Actions `nightly.yml`，03:00 UTC） | Tier 1 + Tier 2 + 大库/性能基线（`perf-baseline.mjs --check`）、浏览器故障隔离（Electron runtime）、会话压力（fixture 驱动） |
| Tier 4 | `verify:reliability:release` | Tag `v*` / `release.yml` | 完整 Windows release 链（provenance→build→package→SBOM→scan→verify，含 **stable-unsigned 拒绝门**）+ 安装/升级/卸载真机冒烟 |

NOT RUN 语义：前置产物缺失（如未构建）的检查显式标记 `NOT RUN`+原因；required 检查 NOT RUN 会使门禁失败——不允许静默跳过。

## 覆盖场景 → 实现位置

| 场景 | 实现 | 证据 |
|---|---|---|
| Provider 故障矩阵（401/403/404/429/500/502/timeout/中断流/畸形SSE/上下文溢出/取消/密钥不泄漏） | `tests/engine/ProviderFailureMatrix.test.ts`（真实 loopback HTTP） | vitest 输出 |
| 跨项目上下文零泄漏（线级） | `tests/engine/ProviderRequestIsolation.test.ts`（真实 AgentLoop+loopback，抓 HTTP 请求体） | 同上 |
| 老 DB 迁移 + 完整性 | `tests/electron/ReleaseSchemaGate.test.ts`（legacy DDL fixture→管线迁移→quick_check/FK） | 同上 |
| Backup/Restore 系统验收 | `tests/electron/BackupRestoreSystemAcceptance.test.ts` + **修复 BackupService 损坏备份摧毁活库 bug** | 同上 |
| 崩溃标记/孤儿对账/健康报告 | `electron/StartupHealthService.ts`（quick_check/可写性/provider/崩溃标记/孤儿 runs/MCP），IPC `diagnostics:healthReport`，设置→诊断区 UI `SettingsHealthSection` | vitest + `tests/electron/StartupHealthService.test.ts` |
| 诊断包隐私 | `electron/DiagnosticBundleService.ts`（入口白名单+三层脱敏），`DiagnosticBundlePrivacy.test.ts`（真实 ZIP 内容断言不泄漏密钥/vault/聊天/DB） | 同上 |
| IPC 合同快照 | `scripts/ipc-contract-scan.mjs` + `tests/electron/IpcContractSnapshot.test.ts`；新增/删除信道必须 `npm run ipc:snapshot:update` 显式更新 | 金样 diff |
| MCP/PTY/GenOffice 子进程泄漏 | `tests/electron/ChildProcessLeakGate.test.ts`（20 轮真实 MCP stdio + OS 清点）、`scripts/child-process-leak-gate.cjs`（PTY 20 轮 + GenOffice 树杀 + 端口 + 文件锁） | JSON 报告 |
| 崩溃/重启 | `scripts/crash-relaunch-harness.cjs`（真实 taskkill 强杀 3 场景 + 重启断言） | JSON 报告 |
| Layout 视口矩阵 | `scripts/electron-layout-acceptance.py`（1280×800→1920×1080 × 4 表面，no-overflow/关键控件在视口内断言 + PNG 截图） | `logs/layout-acceptance-*/screenshots/` |
| 网络/浏览器故障 | `tests/electron/NetworkBrowserFailure.electron.test.ts`（DNS 拒绝/拒连/重定向环/离线仿真/巨响应/forcefullyCrashRenderer，主窗口存活） | Electron-runtime vitest（`npm run test:electron`） |
| 会话压力 | `tests/conversation/ConversationStress.test.tsx` + `tests/fixtures/conversation-stress/*.stress.json`（10k 文本/100k 推理/长 MD 真实打断） | vitest |
| 性能基线 | `scripts/perf-baseline.mjs` + `tests/scripts/PerfBaselineMeasure.test.ts` + `tests/fixtures/perf/baseline.json`（3×+2s 宽松回归阈值） | JSON 报告 |
| 安装/升级/卸载 | `scripts/install-upgrade-smoke.cjs`（真 NSIS 安装→启动→升级→字节级数据保留→卸载） | JSON 报告 |

## 已知发现（跨域移交）

- **FINDING-IPC-001（高）**：`preload.openReferenceFileDialog` 调用 `dialog:openReferenceFiles`，全仓库无 handler（HEAD 即如此）。场景工作台/个人化中心的"导入参考文件"按钮在运行时必失败。快照门白名单跟踪，修复后白名单自动报错提醒清理。
- **F-CRASH-001（中）**：硬崩溃残留的 `agent_runs.status='running'` 行在重启后无对账（健康报告显示 warning，见 crash harness 报告 findings）。归属持久化域。
- **NOTE**：`StdioTransport.close()` 的最终兜底是 destroy pipes + `unref()`——对不遵守"stdin 关闭即退出"契约的 MCP 服务器，Windows 下竞态可能遗弃子进程（引擎已知取舍，见 StdioTransport.ts 注释）。符合契约的服务器（如官方实现）不受影响。

## 本机运行约束

- better-sqlite3 ABI 141（Node）/145（Electron）共享一套 node_modules：跑 Electron-runtime 套件用 `npm run test:electron`（无需重编译）；默认 vitest 需要 Node ABI（`npm run rebuild:node`）。两者不可并行。
- dist-electron 构建期间锁冲突：本仓库历史上有 EBUSY 先例；构建前确认无残留 electron 进程。
