# METIS Office 引擎替换实施方案
# —— 引入 GenOffice docx/pptx-engine，达成字节级保真与全格式能力

> 制定日期：2026-08-25
> 制定人：ox-alpha（主控）
> 决策依据：刘总 2026-08-25 拍板"从追求最终效果来说建议换"
> 方案状态：P0/P1/P2 代码实现完成；等待另一 AGENT 的 Electron 启动/视觉验收
> 关联实证：`D:\LATEXTEST\tools\genoffice`（fork 副本）、`D:\LATEXTEST\tools\genoffice-verify`（独立测试验证：docx-engine 859 通过/1 跳过、pptx-engine 766 全过）

---

## 0. 目标与效果承诺

### 0.1 北极星目标（最终效果）

| # | 效果承诺 | 现状 | 替换后 |
|---|---|---|---|
| E1 | **导入保真**：含批注/修订/公式/图表/文本框/复杂样式的真实 Word 稿导入 METIS 不丢信息 | 便携子集，子集外特性降级+警告（丢失） | 完整解析为 Block tree（含 RevisionInfo/CommentInfo/FormulaDisplay/ChartDisplay 等全类型），编辑面板可见可改 |
| E2 | **导出保真**：METIS 编辑过的 DOCX 回到 Word 打开，排版与原文档一致 | 全量重生成，存在漂移风险 | **字节保持补丁**：未触碰部分逐字节还原，"Word 察觉不到" |
| E3 | **PPT 能力**：母版/图表/非破坏裁切/文本塑形 | 497 行基础子集 | pptx-engine 1.9 万行引擎全量能力 |
| E4 | **新增 PDF 能力**（可选延伸） | 无 | PDF 真编辑（PDFium）+ 全本地 PDF→Word/PPT 转换 |
| E5 | **METIS 诚信层零回退** | 版本不可变/AI 补丁/来源归因/上下文预算 | 全部保留并作用于新引擎路径 |

### 0.2 非目标（明确不做）

- 不替换 METIS 的成果版本系统（OutcomeRepository）、AI 助手上下文预算、来源归因、诚信链——它们在 codec 之上，原样保留。
- 不引入 GenOffice 的应用壳（apps/*）、Genspark 账号体系（ai-search）、分析遥测。
- 不触碰 `ee/` 目录（企业许可，现为空占位）。
- 不使用 GenOffice 商标与品牌资产。
- P0–P2 期间不替换前端编辑器 UI（Tiptap 迁移列为独立可选阶段 P3，另行批准）。

---

## 1. 范围裁定

### 1.1 引入物（vendored）

| 包 | 版本锚点 | 用途 | 体积实测 |
|---|---|---|---|
| `packages/docx-engine` | genoffice main @ 2026-08-25 (52nd commit) | DOCX 解析（Block tree + docxIndex 锚点）、OOXML 片段生成、**段落级字节补丁保存** | 29 文件 / 17,775 行 |
| `packages/pptx-engine` | 同上 | PPTX 模型/解析/生成 | 40 文件 / 18,917 行 |
| `packages/pptx-render` | 同上 | PPTX 渲染（P2 可选，若仅做导入导出可暂缓） | 13 文件 / 8,701 行 |
| 运行时依赖 | — | fast-xml-parser、jszip、utif2（docx-engine）；pptx-engine 依赖以实测 package.json 为准 | 合计 < 1MB，零 Electron/React 依赖 |

**vendored 位置**：`metis-alpha2-release/vendor/genoffice/`（整目录自管，不追上游浮动；上游更新须走 P4 治理流程）。

**许可合规**：Apache-2.0（与 METIS 同许可）。动作：在 `vendor/genoffice/` 保留上游 LICENSE/NOTICE 原文；在 METIS 根 NOTICE 或第三方声明中追加 GenOffice 及其传递依赖（fast-xml-parser MIT、jszip MIT/Apache、utif2 MIT）。**不触碰 `ee/`**。

### 1.2 被替换物与保留物

| 组件 | 处置 |
|---|---|
| `electron/OutcomeWordDocxService.ts`（407 行） | **重写内部实现**：parse/save 改调 docx-engine；**对外接口签名不变**（`exportDocument/importBuffer/exportManagedDocument/commitImportedMedia`），调用方零改动 |
| `electron/OutcomePptxService.ts`（497 行） | 同上策略，P2 执行 |
| `WordDocumentSchema`（OutcomeRuntimeContract） | **v1 保持为存储契约**；锚点与原包引用写入既有开放 `style/page/theme/props` 记录，旧版本数据永久可读 |
| 前端 WordEditor / 格式面板 | P0–P2 不动；P3 可选演进 |
| 成果 AI 助手（OutcomeAssistantService） | 选区锚点从自有 block id 映射到 docxIndex（§4.4），策略逻辑不动 |
| 20+ 个成果测试文件 | 保留并全部通过（回归护栏）；新增 GenOffice 路径专属测试（§5） |

### 1.2a AI 层归属裁定（刘总 2026-08-25 确认）

**GenOffice 的 AI 三件套一律不引入，AI 层由 METIS 全权负责**：

| GenOffice AI 组件 | 处置 | 理由 |
|---|---|---|
| `agent-core`（通用工具循环，1,014 行） | 不引入 | METIS 自有 AgentLoop 更强（HITL 审批/环路检测/证据账本/预算画像） |
| `ai-provider`（BYOK 供应商抽象） | 不引入 | METIS 自有 ProviderProfileStore + 免费模型发现体系，API 配置走 METIS |
| `ai-search`（Genspark 专有搜索工具） | 不引入 | Genspark 账号/代理绑定，与 METIS 本地优先原则冲突 |
| 文档工具补丁格式（`insert_content` / `replace_blocks` / `insert_image` / `insert_chart` / `edit_chart`，apps/docs/src/main/tools.ts） | **格式借鉴** | 其补丁目标即 Block tree，与桥接层 `wordDocumentEditsToSaveBlocks` 天然同构；METIS AI 的修改指令适配层按此形状产出脏块 |

由此确立：**AI 与工作空间的连接是 METIS 的独有层且全部保留**——成果助手的项目上下文收集（同项目成果/历史版本/工件）、CAS 保护的 Metis.md 读取、来源归因、跨项目阻断、上下文硬预算（6 条/3,200 字/12,000 字）、90K 文档上下文帽，全部继续作用于新引擎路径。GenOffice 引擎只承担"解析/生成/字节保持保存"，模型调用、上下文供给、写回治理全部走 METIS。

---

## 2. 目标架构

```
┌─ 渲染层 WordEditor（P0–P2 不变：结构化编辑投影）──────────────┐
│                                                                │
├─ IPC 契约（OutcomeRuntimeContract，v1 存储契约不变）──────────┤
│                                                                │
├─ 主进程服务层 ────────────────────────────────────────────────┤
│ OutcomeWordDocxService（接口不变）                              │
│   ├─ 路径 A【新·默认】：GenOffice 路径                          │
│   │   importBuffer → docxEngine.parseDocx ──► Block tree        │
│   │        └─► 投影 WordDocument(v1 视图) 给编辑器/存储          │
│   │   exportDocument → 若有 originalArchive：                    │
│   │        docxEngine.saveDocx(脏块补丁, 原包) ⇒ 字节保持输出     │
│   │      否则（AI 新建稿）：docxEngine 全量生成 ⇒ 常规输出        │
│   └─ 路径 B【回退】：现有自研 codec（feature flag 关闭即回退）    │
│                                                                │
├─ vendor/genoffice（docx-engine + pptx-engine + 3 个运行时依赖）┤
└────────────────────────────────────────────────────────────────┘
```

**关键架构决策 D1 —— 原始包锚定（字节保持的前提）**：
字节保持 = "原包 + 脏块补丁"。METIS 成果版本当前只存结构化 JSON（WordDocument），**不存原始 docx 字节**。因此：
- 导入型成果：版本记录新增 `originalArchiveRef`（原始包存入 OutcomeMedia 体系，`application/vnd.openxmlformats-officedocument.wordprocessingml.document`，复用现有 20MB 媒体上限与两阶段提交）；后续导出走"原包+补丁"。
- 非导入型成果（AI 新建/手打）：无原包，走全量生成路径（GenOffice `generate.ts` 能力），效果不低于现状。
- `originalArchiveRef` 为可空字段：老版本数据无此字段 → 自动落路径 B 行为，**向后兼容**。

**关键架构决策 D2 —— 双路径共存与开关**：
`OutcomeWordDocxServiceOptions` / `OutcomePptxServiceOptions` 支持 `engine: 'genoffice' | 'legacy'`，生产默认 GenOffice，环境变量 `METIS_OFFICE_ENGINE=legacy` 可整体回退；单测可显式选择 legacy 保护既有回归断言。两条路径在同一接口签名下并存——**任何时刻可一键回退**。

---

## 3. 分阶段任务拆解

### P0 —— 概念验证与保真基准（完成）

**目标**：在不动 METIS 产品代码的前提下，证明 GenOffice 引擎在 METIS 的真实成果文件上达到 E1/E2。

任务：
- P0.1 建 `tools/genoffice-poc/`：从 METIS 测试夹具与真实成果导出物收集 ≥10 个样本 DOCX（含表格/图片/标题层级/列表；如有批注修订样本一并纳入）。
- P0.2 往返实验 A（保真导入）：每个样本 `parseDocx` → 记录 Block tree 覆盖率（哪些顶层元素被建模、哪些进 passthrough）。
- P0.3 往返实验 B（字节保持）：`parseDocx → 不做任何编辑 → saveDocx`，输出与输入逐字节 diff（zip 条目级比较），统计差异条目数——目标：**零差异或仅 docProps/core.xml 时间戳**。
- P0.4 往返实验 C（编辑补丁）：对每样本做受控编辑（改一段文字/加一段），saveDocx 后用 Word/WPS 人工打开验证 + 与 legacy 路径输出对比排版。
- P0.5 产出《P0 保真报告》（数据落 `tools/genoffice-poc/report.json` + 人工目检记录）。

**实际结果**：4/4 样本解析成功，所有块获得锚点；4/4 parse→无编辑→saveDocx 的 ZIP 条目逐字节零差异；4/4 受控编辑后可重新解析且编辑文本可见。报告：`D:\LATEXTEST\tools\genoffice-poc\P0-REPORT.md`，机器报告：`report.json`。本轮未启动 Electron/WPS，由另一 AGENT 负责产品级验收。

### P1 —— Word 引擎接入（代码完成）

**目标**：OutcomeWordDocxService 双路径落地，genoffice 为默认，E1/E2/E5 达成。

任务：
- P1.1 vendored 落位：`vendor/genoffice/`（docx-engine + pptx-engine 源码 + LICENSE/NOTICE），tsconfig 路径接入，typecheck 工程纳入（第 5 个 tsconfig 或并入现有 node 工程）。
- P1.2 **模型桥接层** `electron/office/genofficeBridge.ts`：
  - `blockTreeToWordDocument(tree): { document: WordDocument; projectionWarnings }`（v1 投影：标题/段落/表格/图片映射到现有 schema；v1 未建模的特性——批注/修订/公式等——**保留在 Block tree 侧**，不丢失，编辑器暂不显示，投影警告列出）；
  - `wordDocumentEditsToSaveBlocks(before, after): SaveBlock[]`（编辑器前后两次 v1 投影 diff → 脏块集合，脏块 id 对应 docxIndex 锚点）。
- P1.3 Service 重写：`importBuffer` = parseDocx + 投影 + `originalArchiveRef` 登记；`exportDocument` = D1 决策分派（原包+补丁 / 全量生成）；`exportManagedDocument`/`commitImportedMedia` 媒体两阶段语义在 GenOffice 路径下等价实现（图片资源经 resolveManagedImage 注入补丁）。
- P1.4 契约兼容：保持 `OUTCOME_RUNTIME_VERSION = 1`；锚点与原包引用写入既有开放记录，不改 strictObject 顶层字段、不改数据库列；旧数据自动走 legacy。
- P1.5 开关与回退：`METIS_OFFICE_ENGINE` 环境变量 + options.engine，legacy 代码路径原样保留。
- P1.6 测试迁移与新增：
  - 现有 `OutcomeWordDocxService.test.ts`、`WordDocumentFormatting.test.ts`、`OutcomeOfficeDowngradeDetails.test.ts` 等全部在双路径下跑通（legacy 断言仅对 legacy 生效的逐条核对）；
  - 新增 `OutcomeWordGenofficePath.test.ts`：导入保真（批注/修订样本不丢）、字节保持导出（P0.3 断言产品化）、补丁导出（受控编辑）、媒体两阶段、originalArchiveRef 兼容（v1 旧数据导入导出）、engine 开关回退。
- P1.7 Electron ABI 冒烟：better-sqlite3 链路照旧；新增 GenOffice 路径在真实 Electron 主进程内的 smoke（jszip/fast-xml-parser 均为纯 JS，预期无 ABI 影响，仍需实证）。

**验证方式**：`npm run test:fast` 全绿 + 新增套件 + Electron smoke + 手工双开对比（WPS/Word 打开 5 个真实成果的导出物）。
**实际结果**：vendored 引擎、桥接层、原包媒体锚定、Word 双路径、legacy 回退开关、P1 测试均已实现；目标 Word 测试 8/8，既有 Word 测试 9/9，四工程 typecheck 通过。Electron 启动/真实 WPS 双开留给另一 AGENT，尚未宣称产品级完成。
**回滚**：`METIS_OFFICE_ENGINE=legacy` 即回退；vendor 目录与 v2 契约字段不影响 legacy 行为。

### P2 —— PPT 引擎接入（代码完成）

任务实际完成：`OutcomePptxService` 双路径、`genofficePptxBridge`（PptDocument ↔ SlideDeck 投影）、原包媒体锚定、GenOffice 文本/几何/样式的脏元素补丁、结构变化回退 legacy；现有 `OutcomePptGenerationService` 不替换，继续以 METIS 严格 PPT Grid patch + OutcomeRepository 不可变版本为 AI 契约。
**实际结果**：目标 PPT 测试 4/4，既有 PPT 测试 7/7，相关媒体/变换测试 36/36；typecheck 通过。未启动 Electron。

### P3 ——（可选，另行批准）编辑器演进至 Tiptap

目标：字节保持工作流的前置是"脏块追踪"，长期看 Tiptap 块编辑器（GenOffice Docs 同款）比 v1 结构化投影更接近 Word 体验，且能直接暴露批注/修订/公式（v1 投影看不到的部分）。
本方案只立项不展开：需单独评估 WordEditor 重写面、Word 格式面板映射、测试迁移量，形成独立方案后报刘总批准。

### P4 —— 上游治理与长期维护

- vendored 快照即事实标准；上游更新须：diff 审查 → 跑其 80+76 测试文件 → 跑 METIS 护栏 → 人工双开对比 → 才可合入。
- 每季度评估一次上游健康度（commit 活跃度、破坏性变更、1.0 进展）；若上游发布 npm 包且 API 稳定，评估从 vendored 切换为版本化依赖。
- PDF 能力（pdf2docx + PDFium）作为 E4 延伸项，P2 后单独立项。

---

## 4. 关键技术设计补充

### 4.3 契约兼容细则（保持 OUTCOME_RUNTIME_VERSION 1）

- 不提升 `OUTCOME_RUNTIME_VERSION`，不改变 strictObject 顶层字段，避免旧版本回滚后无法读取新版本数据。
- DOCX 原包引用写在 `WordDocument.page._originalArchiveMediaId`，GenOffice 块锚点写在块 `style._genofficeAnchor`；PPTX 原包引用写在 `PptDocument.theme._genofficeOriginalArchiveMediaId`，元素锚点写在 `props._genofficeSpIndex`。这些字段位于已有开放 `z.record(z.string(), z.unknown())` 记录中。
- 旧数据缺少上述字段时自动走 legacy/全量生成；新数据由旧代码读取时未知数据位于开放记录，不破坏 strictObject 顶层解析。
- `outcome_versions` 表不改列，零 SQL 迁移；原包字节进入已有 `outcome_media` 表并受项目/成果归属、SHA-256、20MB 上限与文件清理保护。

### 4.4 AI 补丁语义适配

- 成果助手的选区来源标签从自有 block id 改挂 docxIndex 锚点（`当前 Word 选区：<docxIndex> <摘要>`）；
- AI 输出仍为"针对投影的修改指令"，落盘前经 `wordDocumentEditsToSaveBlocks` 转为脏块补丁，经 OutcomeRepository 提交为不可变 AI 版本——**严格补丁语义、取消不落历史、来源归因三项保证原样保留**；
- v1 投影外的特性（批注等）P1 阶段对 AI 不可见（不可破坏），P3 编辑器升级后解锁。

### 4.5 已知限制（如实登记）

- v1 投影期间，批注/修订/公式在编辑器中不可见但**不丢失**（留在 Block tree/原包中，补丁保存后仍在导出物里）——比现状（导入即丢）严格更好；
- 字节保持仅对"有 originalArchiveRef 的导入型成果"成立；AI 新建稿走全量生成；
- GenOffice 上游 API 未承诺稳定：vendored 冻结 + 窄 API 面（仅 parseDocx/saveDocx/生成函数）+ P4 治理对冲。

---

## 5. 测试与验收矩阵

| 层 | 内容 | 门禁 |
|---|---|---|
| 引擎级 | GenOffice 自带 80+76 测试文件（已实测 1,625 全绿） | vendored 合入时必跑 |
| 桥接级 | blockTreeToWordDocument / editsToSaveBlocks 单测（含往返恒等：投影→还原→投影 不变式） | 新增，全绿 |
| 服务级 | 双路径 × {导入,导出,媒体两阶段,版本兼容,开关回退} 矩阵 | 新增 + 既有 20+ 文件全绿 |
| 契约级 | v1/v2 数据互读、OUTCOME_LIMITS 不破坏 | 既有契约测试扩展 |
| 产品级 | Electron smoke + 真实成果 5 例 WPS/Word 人工双开 | 记录截图与结论 |
| 回归 | `npm run test:fast` 全量 + typecheck 四工程 | 每阶段收尾必跑 |

## 6. 风险登记册

| # | 风险 | 概率 | 对冲 |
|---|---|---|---|
| R1 | GenOffice 上游 API 破坏性变更 | 高（年轻项目） | vendored 冻结；窄 API 面；P4 治理流程 |
| R2 | 上游弃坑 | 中 | Apache-2.0 已 fork 自持；代码量 3.7 万行在可自维护范围 |
| R3 | 字节保持在部分畸形样本上失效 | 中 | P0 基准先行；失败样本记录为已知限制；legacy 兜底 |
| R4 | 投影丢特性被误判为"新引擎丢数据" | 中 | 投影警告显式化 + 文档明示"特性保留在原包，编辑器暂不可见" |
| R5 | 媒体两阶段语义在新路径下出现回归 | 中 | P1.3 专项测试 + commitImportedMedia 契约测试 |
| R6 | 工程量超估 | 中 | 双路径开关使每阶段独立可交付、可暂停、可回滚 |

## 7. 里程碑与工作量

| 里程碑 | 内容 | 预估 | 累计效果 |
|---|---|---|---|
| M0 | P0 保真基准报告 | 1 天 | 决策数据 |
| M1 | P1 Word 双路径落地 | 3–4 天 | **E1+E2 达成**（Word 导入导出保真） |
| M2 | P2 PPT 双路径落地 | 2–3 天 | **E3 达成** |
| M3 | （批准后）P3 编辑器 / P4 PDF | 另估 | E4 与编辑体验上限 |

## 8. 完成标准与交付物

- **代码阶段完成标准**：E1–E3 的引擎路径与双路径回退均有目标测试；`npm run typecheck` 通过；Office 相关测试通过；无 Electron 启动。
- **产品阶段完成标准（待另一 AGENT）**：Electron isolated smoke、真实成果导入→编辑→导出、WPS/Word 双开、PPT 视觉检查、全量门禁。
- **交付物清单**：`vendor/genoffice/`、`electron/office/genofficeBridge.ts`、`electron/office/genofficePptxBridge.ts`、双 Service、媒体原包存取、P1/P2 测试、P0 保真报告、本方案文档。
- **本方案文档位置**：`D:\LATEXTEST\metis-alpha2-release\docs\OFFICE_ENGINE_MIGRATION_PLAN.md`（新建，不触碰任何历史状态文档）。
