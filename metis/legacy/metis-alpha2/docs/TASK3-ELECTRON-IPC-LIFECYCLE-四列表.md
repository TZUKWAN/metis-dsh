# 任务 3：Electron Host / IPC / Runtime Lifecycle 健壮化 —— 四列表（当前实现 / 问题证据 / 目标实现 / 影响面）

> 基线：main 分支 commit `90bdafb`（2026-09-05 fetch 后确认 up to date）。
> 工作副本：`D:\LATEXTEST\metis-alpha2-release`。
> 证据生成方式：`scripts/scan-ipc-inventory.mjs` 对 `electron/main.ts` 的真实静态扫描，
> 结果落盘 `logs/ipc-inventory-raw.json`。所有行号均为该基线下的真实行号。

## 1. 总量事实（脚本扫描，非记忆）

| 项 | 值 | 证据 |
| --- | --- | --- |
| electron/main.ts | 14,092 行 / 710,652 字节 | `wc -l` / `ls -la` |
| electron/preload.ts | 2,458 行 / 168,542 字节 | 同上 |
| ipcMain.handle 注册 | **447 个，channel 全部唯一**（无现存重复） | scan-ipc-inventory.mjs |
| ipcMain.on / once | 0 个 | 同上 |
| 事件转发（sender.send 类） | 20 处命中样例（topic:stream-chunk、agent 事件桥等） | 同上 |
| 域分布 Top | submission 60 / outcomes 56 / personalization 23 / browser 20 / research 18 / scenario 18 / goal 18 / freeModel 14 / officePrompt 14 / topic 10 | logs/ipc-inventory-raw.json |
| 同类服务自注册（registerIpc 模式） | JobQueueService / MethodLibraryService / SubmissionTrackerService / LiteratureWatchService / ResearchAgendaService / AutonomousProfileService 等 | main.ts L1079-1100 |

## 2. 四列表

### 2.1 入口层过度集中（main.ts Host）

| 当前实现 | 问题证据 | 目标实现 | 影响面 |
| --- | --- | --- | --- |
| 447 个 `ipcMain.handle` 以裸调用形式散布在 main.ts L1102–L13465；服务以模块级 `let xxx: XxxService \| null = null`（L660-791）持有，`app.whenReady()`（L13077）内初始化；handler 内部判空 | 并行 AGENT 全部挤同一个文件（git 历史多任务同文件冲突）；无注册完整性检测；无法单测 handler 注册 | 新增 `electron/ipc/` 域 registrar：每个域一个 `registerXxxIpc(ctx)`，返回 disposer；main.ts 职责收缩为 create services → register domain IPC → create window → start runtime → shutdown | main.ts 缩行；新文件；未迁移 channel 保持原样（后续任务接入）；不改任何 channel 名/contract |

### 2.2 主进程日志（同步阻塞 + 无滚动）

| 当前实现 | 问题证据 | 目标实现 | 影响面 |
| --- | --- | --- | --- |
| 两层 console 包装串联：① L33-47 把 console.log/warn/error 包成**同步** `fs.appendFileSync(cwd/logs/main-app.log)`（2026-08-25 为 Start-Process 管道缓冲问题加的实时 tail）；② L1028-1050 再包一层镜像到 `DATA_DIR/logs/main-<日期>.log`（stream 写 + 2000 行内存 buffer） | 每条日志走两次链式包装；Agent/Tool/Event 高频路径在 main loop 上同步写盘；main-app.log 无 rotation；DATA_DIR 日志文件名仅在启动时取一次日期，长运行跨天不滚动；无 redaction（provider baseUrl、模型名直接落盘） | 新增 `electron/MainProcessLogger.ts`：buffered write（阈值+定时 flush）、按大小滚动保留 N 份、按天切 DATA_DIR 文件、redaction（api key/token/cookie/authorization）、shutdown flush + process exit flush、写失败计数不影响 app、operationId/correlationId 前缀支持；main.ts 两段包装替换为 `installMainProcessLogger()` | main.ts 顶部两段删除；两个日志目的地（开发 tail + 数据目录归档）行为保留；console 调用方零改动 |

### 2.3 Preload 单体

| 当前实现 | 问题证据 | 目标实现 | 影响面 |
| --- | --- | --- | --- |
| preload.ts 单文件 `const api = { … }` 平铺约 350+ 方法（L381-2454），尾部 `contextBridge.exposeInMainWorld('metis', api)`（L2455） | 域无边界，历史接口与活跃接口混排，审计困难 | 拆分 `electron/preload/{system,topic,research,outcome,submission,personalization,capability,scenario,goal,ai,market,mcp,project,wechat,browser,collab,freeModel,officePrompt,media,autonomous,terminal…}Bridge.ts`，每个 bridge 一个工厂返回方法子集；preload.ts 只做组装 + exposeInMainWorld | window.metis 对 renderer 的 API 面与方法名**完全不变**（快照测试锁定）；preload.ts 变为组装壳 |

### 2.4 注册完整性

| 当前实现 | 问题证据 | 目标实现 | 影响面 |
| --- | --- | --- | --- |
| 直接 `ipcMain.handle(...)`，无 registry；重复注册只会被 Electron 静默叠加（多 listener 轮流应答） | 脚本扫描证实无任何注册簿记；447 channel 无法回答 "who owns this channel" | 新增 `electron/ipc/IpcRegistry.ts`：`handle()` 注册前查 `ipcMain.listenerCount` 与自身账本，strict 模式（dev/test）重复注册抛错；返回 disposer（removeHandler + 账本注销）；`snapshot()` 输出 owner 表供测试断言 | 迁移域全部走 registry；未迁移域保持直调（不强制一次性改造，避免与并行任务冲突）；测试用 snapshot 对账 |

### 2.5 Cancellation Ownership

| 当前实现 | 问题证据 | 目标实现 | 影响面 |
| --- | --- | --- | --- |
| `RuntimeShutdownCoordinator` + `trackEphemeralOperation` 已存在且被 topic:chat（L1110）、autonomous:generateBatch（L1103）等使用 | 任务书要求长操作统一 owner；仍有域自建 Map（如 `pptxImportSessions` L754、`activeTerminals`、`exportPreviews`） | 本轮：审计并输出 Shutdown Ownership Table；自建 Map 保留原有清理语义，登记到表中标注 owner 与 shutdown 行为；不重写各域执行器 | 文档交付为主；行为零变更；风险最低 |

### 2.6 Shutdown 序列

| 当前实现 | 问题证据 | 目标实现 | 影响面 |
| --- | --- | --- | --- |
| `completeApplicationShutdown()`（L14026-14080）：goal suspend → `runtimeShutdown.drain(SHUTDOWN_DRAIN_TIMEOUT_MS)` 并行 goalDrain → backupTimer clearInterval → scenarioLoopScheduler.stop → autonomous interrupt/drain → weChat stop → outcomeExternalEditor.shutdownAll → genofficeEmbeddedViews.shutdownAll → fileCapabilities.clear → activeTerminals kill → executionCapabilities.clear → experimentScriptAdapter.dispose → firstRunSetup.dispose → mcpManager.disconnectAll → personalizationMcpRuntime.shutdownAll → store.close | drain 超时仅 console.warn 一行，pending 列表进了 JSON 但没有结构化落盘 | 在 shutdown 尾部把 `{timedOut, pending}` 结构化写入诊断日志（走 MainProcessLogger）；输出 Shutdown Ownership Table 文档 | 数行改动；无行为变更 |

### 2.7 Dead IPC Surface

| 当前实现 | 问题证据 | 目标实现 | 影响面 |
| --- | --- | --- | --- |
| preload 仍暴露 autonomous 系 API（saveAutonomousProfile / getAutonomousHardRules / generateAutonomousBatch / createProjectForAutonomous 等）；main 有 `autonomous:*` handler 2 个 + autonomousProfile.registerIpc() | App 已不以 AutonomousResearchPage 为主入口 | 对 preload 每个 API 做 renderer 侧 reachability（grep src/）；无 consumer 的列 Dead Candidate，不确定的标 deprecated；产出 Dead Surface Report；**不删代码**（删除留待刘总确认后单独任务） | 仅报告；零代码删除，规避误伤 |

## 3. 并行边界确认

- **不动**：`chat:*`、agent streaming、conversation protocol 相关 channel 与 ChatRuntimeContract；
- **不动**：Topic UI、Office、DB schema、Domain Service 内部实现；
- registrar 迁移只搬「注册与转发」代码，业务 SQL/Prompt/Tool 留在原 Service；
- scenario / agent 相关 handler 中与 Conversation Streaming AGENT 强耦合的部分（`agent:chat`、scenario 编译链）**保留在 main.ts**，通过 registry snapshot 报告为「后续接入点」。

## 4. 验收映射（对任务书 Definition of Done）

| DoD 项 | 本任务落点 |
| --- | --- |
| IPC inventory 完成 | logs/ipc-inventory-raw.json + 最终报告 |
| 非 Conversation handler 大量迁出 main | electron/ipc/* registrar（topic/research/outcome/submission/personalization/capability/system/…） |
| preload 分域且 API 兼容 | electron/preload/*Bridge.ts + 快照测试 |
| privileged IPC 统一 auth/decode/present/recover | 复用 SecureIpc.createSecureIpcHandler；registrar 内沿用 requireRendererMainFrame + Zod safeParse 既有模式 |
| cancellation owner 明确 | Shutdown Ownership Table |
| shutdown 覆盖主要后台资源 | 2.6 表 + pending 结构化落盘 |
| listener leak test | tests/ 下反复 open/close 注册-注销测试 |
| duplicate channel gate | IpcRegistry strict 模式 + 测试 |
| payload limits | 审计表 + 既有 Zod max() 抽查；重大缺口记录 |
| 高频 appendFileSync 日志路径移除 | MainProcessLogger 替换两层包装 |
| log rotation/redaction | MainProcessLogger 内建 |
| dead IPC report | Dead Surface Report |
| typecheck/lint/test/build | 各命令真实运行证据 |
