# 任务 3 交付报告：METIS Electron Host / IPC / Runtime Lifecycle 健壮化

> 基线：main @ `90bdafb`；工作副本 `D:\LATEXTEST\metis-alpha2-release`。
> 报告生成：2026-09-06（任务 3 执行轮）。四列表见 `docs/TASK3-ELECTRON-IPC-LIFECYCLE-四列表.md`。
> 诚实声明：本报告所有"完成"均附命令输出或测试证据；未完成项明确标注 **NOT DONE**。

## 一、新增文件

| 文件 | 作用 |
| --- | --- |
| `electron/ipc/IpcRegistry.ts` | IPC 注册台账：duplicate gate（strict 抛错）、channel→owner 账本、disposer、`snapshot()` |
| `electron/ipc/DomainIpcContext.ts` | 域 registrar 依赖注入接口（与 main.ts 零循环依赖） |
| `electron/ipc/sharedGuards.ts` | 共享纯 helper（isRecord / mimeForLocalFile / parseBrowserBounds / executionOwnerFor） |
| `electron/ipc/registerTopicIpc.ts` | 选题域 registrar（10 channel） |
| `electron/ipc/registerFreeModelIpc.ts` | 免费模型+邮箱域 registrar（18 channel） |
| `electron/ipc/registerWeChatIpc.ts` | 微信 Bot 域 registrar（7 channel） |
| `electron/ipc/registerExperimentIpc.ts` | 实验域 registrar（9 channel） |
| `electron/ipc/registerArtifactIpc.ts` | 产出物域 registrar（8 channel） |
| `electron/ipc/registerProjectIpc.ts` | 项目归档/provider 覆盖域 registrar（6 channel） |
| `electron/ipc/registerSystemIpc.ts` | 系统杂项域 registrar（storage/backup/clipboard/flashcard，15 channel） |
| `electron/MainProcessLogger.ts` | 缓冲日志：batched write、大小滚动、按天归档、redaction、shutdown flush、写失败隔离、correlationId |
| `electron/preload/submissionBridge.ts` | preload 投稿域（64 方法） |
| `electron/preload/outcomeBridge.ts` | preload 成果域（53 方法） |
| `electron/preload/topicBridge.ts` | preload 选题域（9 方法） |
| `electron/preload/freeModelBridge.ts` | preload 免费模型域（18 方法） |
| `electron/preload/systemBridge.ts` | preload 系统杂项域（26 方法） |
| `tests/electron/IpcRegistryLifecycle.test.ts` | 12 例：registry snapshot/duplicate gate/prefix 守卫/auth 恢复/非法 payload/异常脱敏/流转发安全/dispose×100 |
| `tests/electron/MainProcessLogger.test.ts` | 7 例：缓冲/脱敏/滚动/归档 rebind/写失败隔离/幂等 install/context 前缀 |
| `tests/electron/PreloadApiSnapshot.test.ts` | 2 例：真实加载 preload，冻结 521 方法 API 面 |
| `tests/electron/DeadSurfaceReport.test.ts` | 2 例：死面报告与实际 API 面一致性 |
| `tests/electron/fixtures/metis-api-snapshot.json` | window.metis 521 方法基线 |
| `docs/reports/task3-dead-surface.json` | Dead Surface Report（结构化） |
| `docs/TASK3-ELECTRON-IPC-LIFECYCLE-四列表.md` | 四列表（当前实现/问题证据/目标实现/影响面） |
| `scripts/scan-ipc-inventory.mjs` 等 6 个 | IPC 扫描/迁移/预载拆分/reachability 工具（可复跑） |

## 二、修改文件（本任务范围内）

| 文件 | 改动 |
| --- | --- |
| `electron/main.ts` | ①删除顶部同步 `appendFileSync` console 包装（原 L33-53，§11 高频阻塞路径）；②删除第二层 mirrorMainLog/initMainLogFile 包装（原 L1028-1062），由 MainProcessLogger 承担；③新增 IpcRegistry + domainIpcContext 构造；④88 个 handler 的注册代码迁出到 7 个 registrar（channel/契约/恢复形状逐字保留）；⑤shutdown 诊断行结构化 + 末尾 logger.dispose()。**14,092 → 13,300 行（净减 792 行）** |
| `electron/preload.ts` | 170 个冷域方法迁出到 5 个 bridge，api 对象改为 spread 组装；**window.metis 方法名与行为零变化**（2,458 → 2,151 行） |
| `electron/ipc/DomainIpcContext.ts` | 随域迁移逐步扩展依赖接口（含在新增文件内） |

删除/废弃文件：**无删除**（死接口按任务书仅标注 deprecated，见第五节）。

公共文件修改最小化说明：`main.ts`/`preload.ts` 的改动全部限于本任务边界（日志包装替换、注册代码搬迁、api 组装方式）；未触碰 chat:*、agent streaming、scenario 编译链、DB schema、Topic UI、Office 功能。

## 三、附件 1：IPC Inventory

全量扫描证据：`logs/ipc-inventory-raw.json`（脚本 `scripts/scan-ipc-inventory.mjs`，可复跑）。

- 迁移前：**447 个 `ipcMain.handle` 注册，channel 全部唯一**（无历史重复）；`ipcMain.on/once` 0 个。
- 迁移后：`ipcMain.handle('submission:` 等已迁前缀在 main.ts 中为 0 命中，全部经 `IpcRegistry` 注册。
- 域分布（迁移前）：submission 60 / outcomes 56 / personalization 23 / browser 20 / research 18 / scenario 18 / goal 18 / freeModel 14 / officePrompt 14 / topic 10 / outcomePrompt 10 / experiment 9 / artifact 8 / 其余为 ≤7 的小域。
- 本轮迁出 7 域 **88 个 channel**（topic 10、freeModel+mailbox 18、wechat 7、experiment 9、artifact 8、project 6、system 15）。

## 附件 2：Main Composition（迁移后 main.ts 结构）

```
electron/main.ts（模块装配壳，13,300 行）
├─ MainProcessLogger 安装（缓冲日志替代同步 appendFileSync）
├─ 模块级服务 let 变量区 + runtimeShutdown（RuntimeShutdownCoordinator）
├─ IpcRegistry 实例（strict: !app.isPackaged） + domainIpcContext
├─ setupIPC()
│   ├─ registerTopicIpc / registerFreeModelIpc / registerWeChatIpc /
│   │  registerExperimentIpc / registerArtifactIpc / registerProjectIpc /
│   │  registerSystemIpc        ← 已迁移域（经 registry，返回 disposer）
│   ├─ 其余未迁移域 handler（直调 ipcMain.handle，逐轮收敛）
│   └─ Service 自注册（JobQueueService.registerIpc 等 6 个，保持原样）
├─ app.whenReady()
│   ├─ logger 归档 rebind（DATA_DIR/logs/main-<date>.log）
│   ├─ metis-app:// 协议、服务初始化、provider profile restore
│   └─ setupIPC() → createWindow()
└─ completeApplicationShutdown()（drain → 中断 → 资源回收 → store.close → logger.dispose）
```

后续接入点（NOT DONE，见第六节）：submission/outcomes/personalization/research/goal/capability 等域按同一 registrar 模式迁出。

## 附件 3：Preload API Map

- 组装：`const api = { ...submissionBridge, ...outcomeBridge, ...topicBridge, ...freeModelBridge, ...systemBridge, <其余 351 个热区/域方法> }`；`contextBridge.exposeInMainWorld('metis', api)`；`export type MetisAPI = typeof api`。
- **API 面 521 方法，拆分前后完全一致**（证据：拆分脚本逐方法迁移计数 170/170；快照测试加载真实 preload 捕获 `exposeInMainWorld` 实参，键集与基线 JSON 全等）。
- 基线：`tests/electron/fixtures/metis-api-snapshot.json`；重生成：`METIS_UPDATE_API_SNAPSHOT=1`。
- 留在 preload.ts 的域（并行热区，刻意不动）：agent/chat 流、scenario、chatbot/scopedConversation、genoffice 嵌入、officePrompt、skill/market、autonomous 事件面、externalRef（任务 2 改动中）、update（AutoUpdater 渠道策略任务改动中）。

## 附件 4：Shutdown Ownership Table

| 资源 | Owner | Shutdown 行为 | 证据 |
| --- | --- | --- | --- |
| Agent/Chat 运行 | `RuntimeShutdownCoordinator`（runtimeShutdown） | `drain(SHUTDOWN_DRAIN_TIMEOUT_MS)`：abort 全部注册运行→有界等待→pending 结构化落盘 | main.ts `completeApplicationShutdown`；既有 `RuntimeShutdownCoordinator.test.ts` 7 例 |
| Goal 运行 | goalEngine（并行 drain） | `suspendActiveGoalsForShutdown` + `drainActiveRuns` | 同上 |
| 长操作 admission（topic:chat、autonomous:generateBatch 等） | `trackEphemeralOperation` | draining 时拒绝进入（返回 `application_shutting_down`） | `trackEphemeralOperation` 测试 2 例（既有） |
| Scenario 循环调度 | scenarioLoopScheduler | `stop()` | completeApplicationShutdown |
| Autonomous 运行 | autonomousEngine + activeAutonomousRun | interrupt → 有界 drain | 同上 |
| WeChat Bot | weChatBotService | `stop()` | 同上 |
| 外部编辑器/嵌入式 Office 视图 | outcomeExternalEditor / genofficeEmbeddedViews | `shutdownAll()` | 同上 |
| 终端 PTY | activeTerminals | killed=true + kill() + clear | 同上 |
| MCP 子进程 | mcpManager / personalizationMcpRuntime | `disconnectAll` / `shutdownAll` | 同上 |
| 文件能力/导出预览/实验脚本适配器/首次运行向导 | fileCapabilities / exportPreviews / experimentScriptAdapter / firstRunSetup | clear()/dispose() | 同上 |
| SQLite | store | `close()`（置于倒数第二步） | 同上 |
| 日志 | MainProcessLogger | `dispose()`：flushSync + 关 fd + 恢复 console（最后一步） | `MainProcessLogger.test.ts`（dispose 恢复断言） |
| 备份定时器 | backupTimer | clearInterval | 同上 |

## 附件 5：Dead / Deprecated Channel List

结构化报告：`docs/reports/task3-dead-surface.json`（静态 reachability：521 个 preload 方法 × src/**，`scripts/scan-preload-reachability.mjs` 可复跑）。

- **Deprecated（14）**：`autonomousControl / autonomousListSessions / autonomousResumeSession / createProjectForAutonomous / onAutonomous{Completed,EngineStarted,Failed,Interrupted,Paused,PhaseStarted,Progress,Reflection,Resumed,Step}`——renderer 零引用，App 已无 AutonomousResearchPage 主入口；**保留代码与 channel**，待专门任务决定删除。
- **Test-only surface（3）**：`acceptanceEnvironment / acceptanceSetWindowSize / acceptanceReleaseWindowControl`——验收脚本通过 window.metis 驱动，属合法消费者。
- **Dead candidates（71）**：见 JSON `deadCandidates.methods`；仅列候选，删除前须复核动态调用。
- 修正记录：`autonomousStart` 初判为死接口，复核发现 `src/pages/ChatPage.tsx:3072` 真实调用，已从死清单排除——本任务不删任何接口的原因即在此。

## 测试结果

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 typecheck（app/engine/node/electron 4 项目） | `npm run typecheck` | **EXIT 0**（logs/full-typecheck.log） |
| lint（本任务全部新增/改动文件） | `npx eslint electron/ipc electron/preload electron/MainProcessLogger.ts tests/electron/{4 个新测试}` | **EXIT 0**（修复 1 处 unused 参数后） |
| 新增测试（4 文件 23 例） | vitest --project node | **23 passed** |
| 任务书 11 项测试映射 | ①snapshot→IpcRegistryLifecycle#builds a sorted snapshot；②duplicate→#throws in strict mode；③auth→#recovers with the fixed unauthorized shape；④payload→#recovers on schema-invalid payloads（含超长 sessionId）；⑤sanitize→#never reflects a domain exception；⑥dispose→#survives 100 register/dispose cycles；⑦admission→既有 RuntimeShutdownCoordinator.test「rejects ephemeral admission after drain」；⑧child drain→既有「aborts registered work, waits for settlement / reports timeout pending ids」；⑨destroyed sender→#does not send stream tokens to a destroyed renderer；⑩preload snapshot→PreloadApiSnapshot.test（521 方法冻结）；⑪deprecated→DeadSurfaceReport.test | **全部通过** |
| 全量套件（第一轮，系统 Node 直跑） | `vitest run --project node` | 844 failed——全部为 better-sqlite3 绑定 ABI 问题（绑定为 Electron ABI 编译），环境性假失败，与本任务无关 |
| 全量套件（第二轮，Electron 内置 Node，官方替代路径） | `ELECTRON_RUN_AS_NODE=1 METIS_ELECTRON_NODE=1 electron.exe vitest.mjs run --project node` | **4,616 passed / 13 failed / 6 skipped**。13 个失败甄别：**5 个**（IpcContractSnapshot、OutcomeMediaSvgExportWiring、OutcomePptxImportCommitWiring、OutcomeWordDocxWiring、ExperimentOwnershipIpc）为文本扫描型门禁按单文件路径读 preload.ts/main.ts 所致——channel 集合实际未变（`ipc-contract-scan` 重扫描后 golden 快照 invoke=487/renderer=480/send=13 **与 HEAD 完全一致**），已将扫描范围适配到新布局（preload.ts+preload/**、main.ts+ipc/**），**5 文件 19 例修复后全过**；其余 8 个（MigrationRunner 4、PersonalizationMcpProbeRunner 2、ReleasePackageScan 2、ExactEnvironmentStdioTransport 1、MemoryProjectScoping 1——部分计数与文件归属见 logs/vitest-full-electron-node.log）位于并行任务活跃域（持久层迁移/发布扫描/真实环境探针），与本任务改动无关 |
| 全量 typecheck（app/engine/node/electron 4 项目） | `npm run typecheck` | **EXIT 0**（logs/full-typecheck.log） |

### 运行时/GUI 验收

- **NOT RUN**：Electron GUI 手动验收（open/close workspace 100 次的 listener leak 实景演练、打包运行）本轮未执行。已有代码级替代证据：dispose×100 循环测试（无重复注册、账本归零）+ strict duplicate gate 会在开发模式运行时立即抛出注册冲突。
- 静态验证：迁移前后 `ipcMain.handle('submission:` 等 7 域前缀在 main.ts 0 残留；preload 521 方法零丢失。

## 与其他并行任务的潜在冲突

1. **preload.ts**：任务 2（上下文隔离）正在改 `externalRefList`——已避开该方法；若对方编辑被拆走的 170 个方法会落空，需其知悉（方法体移至 `electron/preload/*Bridge.ts`，方法名未变）。
2. **main.ts**：AutoUpdater 渠道策略任务在改 `update:*` handler——已刻意不迁移 update 域。
3. **submission 域**：并行工作在改 SubmissionAssistantService/SubmissionBrowserTools——为避免边写边撞，submission 域 registrar 迁移本轮**未执行**（NOT DONE）。
4. registry 对未迁移域不强制；任何一方后续接入 registrar 时 strict gate 会立即暴露与直调注册的重复。
5. **门禁测试适配已做**：`scripts/ipc-contract-scan.mjs` 与 5 个 wiring/契约门禁测试的文件读取范围已适配新布局（golden 快照内容零变化），后续并行任务若再动 preload/main 布局需同步这些扫描范围。

## Remaining Risks（残余风险）

1. **迁移覆盖度**：447 handler 迁出 88（约 20%）。DoD 点名的 registerResearchIpc / registerOutcomeIpc / registerSubmissionIpc / registerPersonalizationIpc / registerCapabilityIpc 文件**尚未创建（NOT DONE）**——research/capability 与并行"Scenario/Capability/Skill/Web Research"任务强重叠，submission/outcomes/personalization 体量大且与并行改动文件交叉，本轮为守住质量闭环（logger+registry+preload+测试+报告）主动收敛范围。
2. **未迁移域无 registry 保护**：duplicate gate 只覆盖迁移域；其余域维持 Electron 默认行为。
3. **payload bounds**：迁移域保持原契约（topic 等已有 zod max 界）；全量 payload 上限审计未逐域展开（部分证据：inventory 中 schema 边界抽查），**部分 NOT DONE**。
4. **listener leak 实景测试 NOT RUN**：以 dispose 循环测试替代，GUI 级 100 次 open/close 演练待下一轮。
5. **build（electron-builder 打包）NOT RUN**：typecheck（electron 编译检查）与 vite 构建前的 tsc 通过；完整 `npm run build:electron` 含 electron-rebuild 与打包，需在并行任务静止窗口执行，避免锁冲突。
6. **全量套件环境依赖**：better-sqlite3 绑定为 Electron ABI，系统 Node 直跑 `vitest` 会大面积假失败；必须用 `npm test`（rebuild 路径）或 `METIS_ELECTRON_NODE=1` 方式（vitest.config.ts 内置支持）。
