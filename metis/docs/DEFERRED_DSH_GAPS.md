# DEFERRED DSH GAPS — 延期与受限能力登记（按 R0-022 / T21-036 / 规格二十九）

> 原则：无法通过 DSH 当前公开扩展点实现的能力，如实登记，不改 DSH 核心绕过，不藏进 TODO。

## GAP-01 · NCPSSD 交互式获取（登录态/反爬）

- **能力**：NCPSSD 全文 PDF 下载与需登录态的检索深化。
- **现状**：检索层已由 `dsh-metis-literature-ncpssd` 完成（公共 searchHandler 接口 + 核心白名单过滤，真实 API 冒烟通过）。全文下载在 legacy 中依赖内嵌浏览器浮层（用户登录后手动确认下载）。
- **DSH 约束**：交互式浏览器会话属 DSH web/浏览器能力域，插件侧无法安全承载登录态。
- **处置**：DEFER。检索题录已可用；全文获取引导用户在 DSH 内用原生 web 工具或浏览器完成。
- ** reopen 条件**：DSH 提供官方交互式浏览器 capability（对照 McpCatalog `chrome-devtools-mcp`/`playwright-mcp` 形态）。

## GAP-02 · LetPub/万维门户交互式抓取

- **能力**：投稿要求中需要登录或动态渲染的页面（期刊详情深页、投稿入口核验）。
- **现状**：`dsh-metis-submission` 的 journal-catalog parser 已可解析静态 HTML（web_fetch 获取）；`journal_search` 工具走真实 LetPub 目录。
- **处置**：DEFER（第一版边界）。动态反爬页面的抓取增强待 DSH web capability 演进。

## GAP-03 · Office（GenOffice）能力迁移 —— Phase 22 评估结论（T22）

| 评估项 | 结论 |
|---|---|
| T22-001 GenOffice 现接入 | 依赖旧 Electron 主进程（genoffice sidecar + 原生模块），与旧壳强耦合 |
| T22-002 许可证 | vendor 内随仓库分发（MIT 主体）；第三方组件见 THIRD_PARTY_NOTICES |
| T22-003/004 docx/pptx 引擎独立性 | 引擎本身可独立构建（构建脚本已验证 stage-genoffice-*），但**运行时入口挂接旧 Electron 生命周期** |
| T22-005 是否必须修改 DSH | **是**——Office 编辑器的会话/文件桥需要 DSH 侧提供应用内文档宿主能力，当前 DSH 无此公开扩展点 |
| 结论 | **DEFER（任务清单 22.1"若必须修改 DSH 则延期"）**。文档解析层（document_parse 等纯能力）可在 Office 评估重启后优先建设 |

## GAP-04 · UI 插件 —— Phase 23 评估结论（T23）

- **结论**：默认不做（任务清单二十三/规格）。理由：
  1. Generic Tool Card 已完整承载工具输出（canonical JSON + render）；
  2. 文献清单/成果列表/投稿候选均可通过结构化工具输出 + Chat 呈现满足核心流程；
  3. 无 UI 不影响任何 Gate 验收路径。
- **reopen 条件**：某对话面出现「没有 UI 就无法合理完成核心功能」的实证场景（任务清单二十三开头条件）。

## GAP-05 · Research Suite meta bundle —— Phase 24 评估结论（T24）

- **结论**：**暂不创建**。第一版分发以「按需逐插件 `dsh plugin add`」完成（已验证 core 的本地目录安装）。Suite 仅在多插件组合安装成为高频用户动作后才有价值；其 meta-bundle 结构（bundle 只组合依赖、零业务）已在 PLUGIN_STANDARD 预留。
- **reopen 条件**：≥3 个插件需要固定组合分发给外部用户时。

## 已解决（非 gap）

- ~~fs-ext 编译失败~~ → node-gyp@10 + npm_config_node_gyp（BASELINE_REPORT）。
- ~~Windows ESM 路径~~ → patch 行用 `file:///D:/...` URL。
- ~~registerSystemIpc 重复注册~~ → 并行改动已修复（guard + 启动日志验证）。
