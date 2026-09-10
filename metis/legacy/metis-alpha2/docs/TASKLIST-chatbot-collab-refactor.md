# 任务清单：Topic Workspace Chatbot 协作模式重构（2026-09-05 刘总规格书）

## 目标

取消"协同对话"独立一级工作区；第三方 AI 能力整体迁入**选题 Topic Workspace**：用户点「打开 Chatbot」临时进入双栏协作视图（METIS 55–60% + Chatbot 40–45%），Chatbot 顶栏极简（一个 Dropdown 选六家 + 管理入口），双向 Context Bridge 打通（METIS→Chatbot 上下文包；Chatbot→METIS 选区引用），**外部模型内容永不是 Evidence**，只能进 external considerations/hypotheses，且入库必须经人工确认。

## 现状锚点（复用面，不重造 Runtime）

- `electron/CollabService.ts` + `collab:show/hide/setBounds/navigate` IPC：WebContentsView 嵌入、登录态持久化 —— 全复用。
- `src/pages/CollabPage.tsx`：双栏布局、SplitHandle、站点管理与持久化 —— 改造为 Topic 内嵌视图（原文件保留 git 历史，内容重构）。
- `src/conversation/`（ConversationTurns/ConversationShell）：消息流 —— 引用展示复用。
- `src/pages/TopicWorkspacePage.tsx`：选题三栏工作区 —— 挂载"打开 Chatbot"入口。

## 子任务

| # | 任务 | 验证方式 |
|---|------|----------|
| T2 | 退出一级路由：App.tsx 摘除 workspaceMode 'converse' 分支与导航入口；CollabPage 从 App 解耦 | typecheck + 现有导航回归 |
| T3 | 顶栏极简：icon 标签条 → 单 Dropdown（ChatGPT/Claude/DeepSeek/Kimi/豆包/GLM + 管理Chatbot…），管理抽屉保留（增删改站点） | UI 渲染 + 手测 |
| T4 | ExternalModelReference 契约：`{v:1, id, model, url, quotedText, contextDigest, capturedAt, projectId?, sessionId?}` 类型 + schema 校验 + `external_references` 表；渲染徽标「外部参考·非证据」 | 单测（契约校验/非证据断言） |
| T5 | Topic 双栏协作视图：TopicWorkspacePage 内「打开 Chatbot」唤起临时覆盖视图；METIS 侧 55–60%、Chatbot 侧 40–45%（SplitHandle 范围 0.40–0.45，默认 0.42）；关闭即退出嵌入 | 组件测试 + 手测 |
| T6 | METIS→Chatbot Bridge：「发送上下文」按钮 → Context Package（选题会话/候选/项目结构化 Markdown，摘要裁剪）→ 写剪贴板 + collabPaste 自动粘贴；失败时 clipboard fallback 提示 | 单测（包生成确定性）+ 手测 |
| T7 | Chatbot→METIS Bridge：「引用到 METIS」→ collabGetSelection（executeJavaScript 取选区，失败 fallback 读剪贴板）→ **Human Confirmation 确认卡**（模型/URL/引用文本/时间）→ 确认后写 external_references 表 + 以 externalRef part 进 Topic 会话（external considerations 语义） | 单测 + 手测 |
| T8 | 零越界护栏：ExternalModelReference 不进 evidence 链（渲染层徽标 + 数据层独立表 + Prompt 组装不含 external 引用正文除非显式绑定） | 单测断言 |
| T9 | 全量回归：typecheck 四工程 + vitest 分块 + 构建（release4）+ 重启 + 提交推送 + 逐项对照验收 | 命令输出留证 |

## 风险点

1. executeJavaScript 取选区在部分站点（CSP/iframe）可能失败 → 必须 clipboard fallback，且失败要如实提示，不伪造"已引用"。
2. WebContentsView 覆盖层在弹层打开时必须隐藏（既有 collabHide 规则）——Topic 内嵌视图必须接入同一恢复事件，否则遮挡审批弹窗。
3. 双栏比例语义反转（原 0.52 是 Chatbot 侧 52%）——旧持久化键迁移：读到 >0.45 的旧值直接重置 0.42。
4. 不可逆动作（写库/进会话流）一律经确认卡；确认前数据不落任何存储。

## 完成标准

- 顶部导航不再有"协同对话"一级入口；Topic Workspace 内可「打开 Chatbot」→ 双栏协作 → 关闭恢复。
- Dropdown 六家可切换、管理入口可增删改站点，行为与原版等价。
- 上下文包可一键进剪贴板（自动粘贴尽力而为）；选区引用经确认后以「外部参考·非证据」条目出现在 Topic 会话，且落 external_references 表。
- 全部测试/typecheck/构建真实通过，证据留档；无任何占位或伪实现。
