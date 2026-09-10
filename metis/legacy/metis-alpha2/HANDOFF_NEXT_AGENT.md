# METIS GenOffice Integration Handoff

交接结论：当前任务没有完成，不能直接交付。此前已完成大量实现和局部验证，但最近又修改了发布资源、外部会话生命周期、环境隔离、PPT 快照、Sheets readiness、E2E 和测试配置；这些修改之后没有重新完成一轮最终全量门禁。因此下一 Agent 必须以当前工作树和本文件为准，不能直接采信旧报告。

## 1. 用户目标

在 `D:\LATEXTEST\metis-alpha2-release` 完成 METIS Outcomes 与 GenOffice Docs/Slides/Sheets/PDF 的可靠集成，并执行完整验证：

- Word、PPT、Excel/XLSX、PDF 均可从 METIS 项目成果打开真实 GenOffice 编辑器。
- 外部编辑器真实修改并保存后，可以显式同步回 METIS，生成新的不可变成果版本。
- METIS 保持项目隔离、成果版本、CAS、AI、来源归因、权限和 IPC 校验的唯一权威。
- 脏外部草稿不能被切换、归档、删除或退出流程静默丢弃。
- GenOffice runtime、四个宿主、Sheets sidecar 和运行依赖在发布包中自包含，不依赖开发机外部工作区路径。
- 完成真实重开、导出、失败回滚、冲突、清理、恢复、视觉和全量测试验证。

## 2. 重要边界

- 只修改 `D:\LATEXTEST\metis-alpha2-release`。
- `D:\LATEXTEST\tools\genoffice` 是只读参考/构建输入，不得修改。
- 不得执行 `git reset`、`git clean`、`git checkout --`、递归删除用户文件或覆盖既有 dirty/untracked 改动。
- 当前工作树本来就有大量其他模块的 dirty/untracked 改动。必须保留，不能按自己的任务范围清理整个工作树。
- 没有创建 commit。
- 当前实现路线是独立 GenOffice Electron 外部窗口 + METIS 临时文件会话，不是直接把 GenOffice React/Tiptap renderer 嵌入 METIS。原因是直接导入会引入第二套 Tiptap/ProseMirror 依赖树并破坏类型/运行边界。这个架构偏差必须由下一 Agent 结合当前验收目标确认并在文档中明确，不能把 standalone host 说成 embedded editor。

## 3. 已有实现

### Outcomes 和 Office UI

- `src/pages/OutcomesPage.tsx`
  - 成果树、成果详情、版本面板、AI 助手和 GenOffice 外部编辑入口。
  - Word 操作顺序保持 `保存版本 -> 排版 -> 导出 DOCX -> 投稿 -> 复制`。
  - Word/PPT 本地编辑、选区同步、保存、版本恢复和部分媒体能力已接入。
  - PPT 首帧编辑属性已从异步 `useEffect` 提升为 `useLayoutEffect`，避免首次渲染时 `contenteditable` 缺失。
  - 当前已有外部会话状态查询、切换/归档/删除前的脏状态检查和同步 warning token 保留的部分实现，但最终回归尚未完成。

- `src/components/OfficeRibbon.tsx`
- `src/components/OfficeWordRibbon.tsx`
- `src/components/OfficePptRibbon.tsx`
- `src/components/OfficeWordOperations.ts`
- `src/components/OfficePptOperations.ts`
- `src/components/OfficeRibbon.css`
- `src/components/OutcomeWordFormattingPanel.tsx`
- `src/components/OutcomeWordFormattingPanel.css`

### External editor session

- `electron/OutcomeExternalEditorService.ts`
  - 项目/成果/版本绑定的临时文件会话。
  - SHA-256 dirty 检查。
  - 文件扩展名、文件大小、路径、symlink/junction/reparse 和 scope 校验。
  - session manifest 写入。
  - `stateFor()`、`sessionFor()`、`sessionsFor()`、`closeIfClean()`、`closeFor()`、`shutdownAll()` 已加入。
  - `recoverStale()` 已尝试从 `session.json` rehydrate recent session。
  - `shutdownAll()` 设计为终止子进程但保留 session 文件，供下次启动恢复。

- `electron/OutcomeExternalEditorBridge.ts`
  - DOCX/PPTX/XLSX/XLSM/PDF 类型映射。
  - OOXML/PDF 签名与结构校验。
  - Spreadsheet workbook、sheet、cell、formula 解析。
  - PDF 页数解析和保存文件转 Outcome 文档模型。

- `engine/runtime/OutcomeRuntimeContract.ts`
  - `spreadsheet`、`pdf` Outcome 文档。
  - 外部编辑 open/sync/close/state schema。
  - sync 成功 warning 字段，用于“版本已保存但会话清理失败”。

### GenOffice wrapper 和 runtime

- `electron/genofficeStandaloneWrapper.ts`
  - 规范化 standalone `process.argv`。
  - 等待目标 renderer DOM readiness 后才输出 `METIS_GENOFFICE_READY`。
  - Sheets 通过真实 `menu:action=open` 重试打开文件。
  - PDF-only 兼容 IPC handler。
  - debug 模式下向 renderer 暴露 `window.__metisStandaloneFilePath`，生产默认不暴露。

- `electron/genofficeStandaloneArgs.ts`
- `electron/genofficeStandaloneProtocol.ts`
- `electron/genofficeStandaloneReadiness.ts`
- `electron/genofficeStandaloneCompatibility.ts`
- `electron/genofficeRuntimePaths.ts`
  - packaged 模式目标路径：`process.resourcesPath/genoffice`。
  - dev 模式允许 `METIS_GENOFFICE_ROOT` 或工作区旁的 `tools/genoffice`。
  - `buildGenofficeEnvironment()` 只传递安全系统环境变量，并覆盖 GenOffice user-data、sidecar、关闭云/遥测和显式 debug 标志。

- `scripts/stage-genoffice-runtime.cjs`
  - 复制四个 GenOffice `apps/*/out`。
  - 复制 Sheets sidecar。
  - 复制 GenOffice Electron runtime。
  - 按 package.json 递归复制已知 main-process 依赖。
  - 目标目录：`dist-electron/genoffice`。

- `scripts/stage-genoffice-sidecar.cjs`
  - 复制或通过 Cargo 构建 Sheets `xlsx-sidecar`。
  - 目标目录：`dist-electron/electron/native/xlsx-engine/target/release`。

- `package.json`
  - `build:electron` 已调用 `stage-genoffice-runtime.cjs`。
  - `electron-builder.extraResources` 已配置 `dist-electron/genoffice -> genoffice`。
  - `dist-electron/genoffice` 被排除出 asar，准备作为 extra resource 使用。

### Real E2E and smoke scripts

- `scripts/electron-outcome-genoffice-e2e.cjs`
  - 当前脚本已覆盖真实 METIS BrowserWindow、项目创建、Word/PPT/XLSX/PDF 创建、打开、编辑、宿主保存、METIS 同步 v2。
  - Word 还覆盖并发本地 v3、stale external session CAS 冲突和清理。
  - 使用真实 GenOffice preload API：Docs DOM edit、Slides `slidesApi.editText/save`、Sheets `desktopApi.saveWorkbookEdits`、PDF `pdfApi.insertBlankPage`。
  - 当前 E2E 报告有真实四格式 v2 证据，但脚本仍需要补充重开/导出/再解析和失败路径覆盖。

- `scripts/verify-genoffice-hosts.cjs`
  - 独立 host smoke，验证 Word/PPT/XLSX/PDF 目标 DOM、ready token 和进程树清理。
  - 它本身不注入 METIS 状态，不能单独证明 Outcomes 集成。

- `scripts/run-electron-layout-acceptance.py`
- `scripts/electron-layout-acceptance.py`
  - 当前产品入口 DOM 合约验收，覆盖 Converse、Projects、Outcomes、Scenes。
  - 不等同于完整响应式矩阵、像素回归、SafeMarkdown 全矩阵或原生窗口视觉矩阵。

## 4. 已确认的真实证据

以下证据曾在真实命令中产生，但必须区分是否早于最近源码修改：

- 最近一次完整 `npm test -- --reporter=dot`：`476` 个测试文件通过，`4` 个跳过；`5514` 个测试通过，`6` 个跳过。该命令早于本交接前最后一批发布路径、会话生命周期和 E2E 变更，必须重新执行。
- 最近一次 `npm run typecheck`：通过所有 app、engine、node、Electron TypeScript 项目。之后只修改过少量文件，但仍需最终重跑。
- `npm run rebuild:node`：成功执行过，用于修复 host Node ABI 141 与 better-sqlite3 ABI 145 的冲突。
- `npm run build:electron`：曾成功执行，Vite production build、Electron rebuild 和 sidecar staging 均完成；最近代码变更后必须重新执行。
- `npm exec -- electron scripts/verify-electron-sqlite.cjs`：曾返回 `electron=41.10.3`、`modules=145`、`sqlite=3.53.1`；需要在最终构建后重跑。
- `python -m unittest discover -s tests/scripts -p 'test_*.py'`：曾为 `12/12` 通过；新增 staging 测试是 Vitest，不包含在这个 Python 计数内。
- `tests/electron/OutcomeExternalEditorService.test.ts`：最近 focused 运行曾为 `10/10` 通过。
- 发布 staging 相关 focused 运行曾为 `4/4` 或 `8/8` 通过，具体以最新重跑为准。
- `tests/electron/OutcomePptxMediaIntegration.test.ts`、readiness、service focused 组合曾为 `30/30` 通过，且 host Node ABI 已重建。
- `test-results/outcome-genoffice-e2e.json` 最近报告为 `status: passed`，steps 包含：
  - `word-edit-sync` v2。
  - `cas-conflict-cleanup`，错误码 `external_editor_version_conflict`。
  - `ppt-edit-sync` v2。
  - `spreadsheet-edit-sync` v2，`Sheet1!A1` 写入 `METIS_REAL_GENOFFICE_XLSX_EDIT`。
  - `pdf-edit-sync` v2，页数从 1 变为 2。
  - `childExited: true`、`profileRemoved: true`。
  - 该报告早于本交接前最后的源码修改，不能代替最终 E2E。
- `test-results/genoffice-hosts-final.json` 曾报告四宿主 smoke `status: passed`，全部 `targetReady: true`、`rootRemaining: false`。它使用工作区外 `D:\LATEXTEST\tools\genoffice`，不是 packaged runtime 验证。
- 布局 DOM 验收曾报告 `status: passed`，但只覆盖当前 DOM contract，不能声称完整视觉验收。
- `npm run acceptance:commercial` 最近返回 `overallStatus: pending`，不是通过。

## 5. 当前已知未完成问题

### P0/P1，必须优先处理

- 发布包自包含尚未被实际 `electron-builder --dir`/安装目录启动验证。需要确认 `resources/genoffice` 内四个 host、Electron executable、preload/renderer、Sheets sidecar 和全部依赖都存在，并从打包目录启动至少一个真实 host。
- 当前 `electron/main.ts` 的 `outcomes:archive` 和 `outcomes:delete` handler 必须复核是否已经使用 `outcomeExternalEditor.closeFor()`。当前最近读取版本仍可能是直接 repository archive/delete 的旧路径，不能假设删除联动已生效。
- 当前 `completeApplicationShutdown()` 必须复核是否使用 `outcomeExternalEditor.shutdownAll()` 而不是 `discardAll()`。`discardAll()` 会删除会话目录，可能丢失未同步外部草稿。
- `OutcomesPage.tsx` 的切换、归档、永久删除和组件生命周期逻辑刚被多次修改。必须重新跑前端测试并确认：dirty session 被阻止、clean session 可关闭、close 失败 token 保留、重启后恢复 session 可显示。
- 最新 scoped ESLint 曾报告 `src/pages/OutcomesPage.tsx` 的 external-editor state effect 缺少 `selectedForProject` 依赖 warning。当前目标是零 error、零 warning，需修复后重新 lint。
- `OutcomeExternalEditorService.recoverStale()` 只能恢复元数据，无法恢复原 launcher 的 `close` callback；目前依赖 manifest PID 终止。必须审计 PID reuse、进程归属、死亡但未过期目录和恢复后显式关闭语义。
- 关闭失败时服务应保留 session、文件和 token；同步成功 warning 时 Renderer 不得执行 `setExternalEditorSession(null)`。必须用回归验证，而不是只读代码。

### 其他高风险项

- PPT 媒体提交必须使用同步读取到的同一份 `opened.bytes`，不能 `read()` 后又从 session file path 二次读取，否则存在 TOCTOU。当前 `OutcomePptxService.commitImportedMediaBuffer()` 已存在，但主进程所有调用点必须逐一核对。
- Sheets readiness 必须等待真实完整加载状态。旧逻辑匹配“正在流式加载”是错误的；当前表达式已尝试匹配“工作簿已完整加载/Workbook fully loaded”等文案，必须在真实宿主上验证中文 locale、英文 locale 和加载失败路径。
- XLSX `parseSpreadsheetWorkbook()` 直接使用 JSZip，当前只限制压缩文件物理大小，仍需增加 entry 数量、单 entry 解压大小、总解压大小、压缩比、XML 字节和 shared strings 预算，防止压缩炸弹阻塞主进程。
- GenOffice 子进程环境已改为安全白名单，但必须确认 Windows 环境变量大小写、`Path`、`SystemRoot`、`TEMP`、`USERPROFILE` 和 sidecar 启动都正常；不得把 `OPENAI_*`、`API_KEY`、`SECRET`、`TOKEN`、`PASSWORD` 等传入。
- remote debugging 只能在显式 `METIS_GENOFFICE_DEBUG=1` 且端口合法时启用；生产默认不能开启 CDP，也不能注入真实文件路径。
- 当前 GenOffice 是 standalone 外部窗口，不是嵌入式 GenOffice React editor。必须根据用户最终验收标准决定是否接受此架构；如果不接受，需重新设计而不是在交付说明中模糊描述。

### 验证证据问题

- `test-results/outcome-genoffice-e2e.json`、`test-results/genoffice-hosts-final.json` 和早期布局报告均可能早于最近源码变化，必须重新生成最终版本报告。
- `scripts/generate-commercial-acceptance.mjs` 只扫描若干固定历史报告路径，当前不会自动识别新的四格式 E2E、host smoke、layout 报告，因此 `overallStatus` 仍为 `pending`。需要扩展聚合器或明确把不可执行的历史域标为 blocked/cancelled_gate，并保留真实证据边界。
- 计划文件要求真实重开、导出、失败回滚和视觉检查。当前四格式 E2E 已有打开/编辑/保存/同步，但未完整覆盖四格式重开/导出/再解析、dirty 关闭、删除清理和 packaged 安装目录。
- 没有完成计划要求的 Word/PPT 多宽度、多主题截图和逐块视觉检查；当前布局脚本主要是 DOM 合约验收。
- 商业验收中的 Agent、Goal、Scenario、Outcomes、Word、PPT、Desktop 旧域仍可能 pending；不能用新的外部编辑 E2E 把这些历史域自动推断为通过。

## 6. Kimi 协作状态

- 当前会话曾执行新鲜 Kimi health check。
- 真实结果：`kimi` 可解析、版本和 doctor 通过，但 `permission_mode=auto` 而非要求的 `yolo`，且 ping 失败。
- 因此本轮没有真实 dispatch Kimi，不能声称已获得 Kimi 审查或执行结果。
- `C:\Users\lauze\.claude\kimi_session_state.json` 是旧状态文件，内容显示 2026-06-27、version 0.20.1、yolo；它与新鲜 health check 冲突，不能作为当前可用性证据。

## 7. 下一 Agent 建议执行顺序

1. 先读取本文件、`CLAUDE_STATE.md`、当前 `git diff`、`git status` 和最新报告；不要重置工作树。
2. 运行 `npm run typecheck`、相关 focused tests 和 scoped eslint，先修当前编译错误、测试失败和 warning。
3. 运行 `npm run rebuild:node`，确认 host Node 原生模块可用。
4. 运行 `node scripts/stage-genoffice-runtime.cjs`，检查 `dist-electron/genoffice` 四个 host、Electron runtime、sidecar、依赖和无外部 symlink。
5. 运行 `npm run build:electron`，再执行实际 `electron-builder --dir`，检查最终安装目录的 `resources/genoffice` 内容。
6. 从打包目录启动一个 Word、PPT、Sheets、PDF host，确认 packaged root 不依赖 `D:\LATEXTEST\tools\genoffice`，并记录新的 smoke 报告。
7. 修复 `main.ts` 的 archive/delete/shutdown 生命周期，使直接 IPC、页面切换和应用退出都遵守 dirty session 保护与恢复语义。
8. 补并验证 `OutcomeExternalEditorService` 的 PID/manifest 恢复、close 失败重试、dirty close、删除联动、跨项目 scope 和旧 manifest 兼容测试。
9. 逐一检查 PPT 所有 `commitImportedMedia` 调用点，统一使用单一文件快照；增加 XLSX 解压预算及边界测试。
10. 扩展 `scripts/electron-outcome-genoffice-e2e.cjs`：四格式真实修改、保存、METIS v2、关闭、重开、导出/再解析、dirty/clean close、CAS 冲突、媒体回滚和 profile 清理。
11. 重新生成四宿主 smoke、布局/视觉报告、ABI 报告和四格式 E2E 报告；所有报告必须标注命令、源码时间点、profile cleanup、进程 cleanup 和 out-of-scope 范围。
12. 修复 `scripts/generate-commercial-acceptance.mjs` 的证据路径或明确残余域，重新运行 `npm run acceptance:commercial`，不得接受 `pending` 作为总通过。
13. 串行运行最终门禁：
    - `npm run typecheck`
    - `npm run lint`
    - `npm test -- --reporter=dot`
    - `python -m unittest discover -s tests/scripts -p 'test_*.py'`
    - `npm run build:electron`
    - `npm exec -- electron scripts/verify-electron-sqlite.cjs`
    - `node scripts/verify-genoffice-hosts.cjs --report <fresh-report>`
    - `node scripts/electron-outcome-genoffice-e2e.cjs`
    - `python scripts/run-electron-layout-acceptance.py --output-dir <fresh-dir>`
    - `npm run acceptance:commercial`
    - `git diff --check`
14. 最终审计当前源码、测试输出、报告时间、发布目录、进程、端口、临时目录、warning、skip、残余风险和用户既有改动；任何关键项失败都不能宣称完成。

## 8. 关键文件索引

- `electron/main.ts`
- `electron/preload.ts`
- `electron/OutcomeExternalEditorService.ts`
- `electron/OutcomeExternalEditorBridge.ts`
- `electron/OutcomeBlankDocumentFactory.ts`
- `electron/OutcomePptxService.ts`
- `electron/OutcomeWordDocxService.ts`
- `electron/genofficeRuntimePaths.ts`
- `electron/genofficeStandaloneWrapper.ts`
- `electron/genofficeStandaloneReadiness.ts`
- `electron/genofficeStandaloneProtocol.ts`
- `electron/genofficeStandaloneArgs.ts`
- `engine/runtime/OutcomeRuntimeContract.ts`
- `src/pages/OutcomesPage.tsx`
- `scripts/stage-genoffice-runtime.cjs`
- `scripts/stage-genoffice-sidecar.cjs`
- `scripts/electron-outcome-genoffice-e2e.cjs`
- `scripts/verify-genoffice-hosts.cjs`
- `scripts/run-electron-layout-acceptance.py`
- `scripts/generate-commercial-acceptance.mjs`
- `tests/electron/OutcomeExternalEditorService.test.ts`
- `tests/electron/OutcomeExternalEditorBridge.test.ts`
- `tests/electron/OutcomeBlankDocumentFactory.test.ts`
- `tests/electron/OutcomePptxMediaIntegration.test.ts`
- `tests/electron/GenofficeStandaloneReadiness.test.ts`
- `tests/electron/GenofficeStandaloneArgs.test.ts`
- `tests/frontend/OutcomesPage.test.tsx`
- `tests/engine/ExactEnvironmentStdioTransport.test.ts`
- `tests/scripts/stage-genoffice-runtime.test.ts`
- `tests/scripts/package-scripts.test.ts`
- `test-results/outcome-genoffice-e2e.json`
- `test-results/genoffice-hosts-final.json`
- `logs/alpha2-commercial-acceptance-20260826.json`
- `CLAUDE_STATE.md`
- `docs/superpowers/specs/2026-08-26-genoffice-editor-integration-design.md`
- `docs/superpowers/plans/2026-08-26-genoffice-editor-integration.md`

## 9. Do Not Claim Without Fresh Evidence

- Do not say the task is complete because an old E2E JSON says `passed`.
- Do not say the installed package contains GenOffice until an actual packaged-directory check passes.
- Do not say four-format round-trip is complete until the current source has a fresh four-format report.
- Do not say commercial acceptance passed while `overallStatus` is `pending`.
- Do not say Kimi was used unless a fresh health check passes and a real dispatch log exists.
- Do not say visual acceptance passed based only on DOM landmark checks.
