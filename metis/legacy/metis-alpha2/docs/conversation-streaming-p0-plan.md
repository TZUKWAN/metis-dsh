# METIS Conversation Streaming P0 重构：审计与实施方案

> 2026-09-05 立项。参考实现：DeepSeek Harness（github.com/deepseek-ai/deepseek-harness，MIT，v0.1.0-rc.5），本地克隆于 `D:\LATEXTEST\deepseek-harness`。
> 本文档由两份逐行代码审计综合而成：METIS 现状审计（12 问全有代码证据）与 DSH 架构审计（A–H 全有代码证据）。审计明细见会话记录，本文档固化结论与实施计划。

## 一、METIS 现状架构地图（Current Architecture Map）

链路：`Provider SSE → SSEParser(SSEParser.ts:172) → StreamChunk(types.ts:83) → AgentLoop model.stream_chunk hook(AgentLoop.ts:1373) → main.ts forwardModelStream(7840) → chat:stream-chunk IPC → ChatPage.tsx rAF batch(2396-2487) → 全量 messages 数组替换 → StreamingMarkdown → React DOM`

对规格 16 问的回答（摘要）：
1. chunk 产生于 engine 进程 `completeStream`（每条 SSE data 行一个 chunk）；tool-call delta 在 SSEParser 内就地累积，yield 的是半成品全量而非增量。
2. chunk 不丢（IPC + rAF 累积），但 toolCalls 不进流通道，走 agent_events 执行事件通道。
3. content/reasoning 分开字段传输。
4. Renderer 唯一消费者 ChatPage.tsx:2396-2487。
5. 有 rAF batching，但 flush 时 **map 重建整个 messages 数组**，所有 memo 项每帧跑 props diff。
6. streaming 与 settled 是同一 React identity（id/key 不变），但靠 index 定位 + 对象浅替换 + 字节比较去重三件套凑出，无 stable node 抽象。
7. StreamingMarkdown 每帧对全文跑 transform 正则 + remark 全文 parse 再按块 memo（StreamingMarkdown.tsx:52-76）——"React Render Incremental" 而非 "Markdown Parse Incremental"。
8. 工具事件经 AgentExecutionEventBridge → agent:execution-event → run.parts → AgentActivityTimeline；存在 ToolCallCard 卡片与 ConversationTurns 折叠行两套并存。
9. reasoning 是整段字符串 + `<details>` + 纯文本。
10. 四条独立流通道：chat(rAF)、topic(直接 setState)、scenario(尾部 400 字截断)、submission(无流式)；src/conversation 统一层（ConversationTurns/ConversationShell）已建但 ChatPage 未接入。
11. 持久化粒度 = 每回合一条完整 assistant 消息（ChatTurnService.ts:235），流式中间态零持久化。
12. ChatPage.tsx 4554 行、约 40 个 state，六合一上帝组件。

## 二、DeepSeek Harness 架构审计（本质提炼）

分层：持久层（每 attempt 一条结算）→ 瞬态层（start/chunk/end 帧 + 分数 seq + 结算暂存 + rebaseline）→ 组装层（纯状态机 + publication 声明）→ 发布层（rAF×3 单飞合并）→ 视图层（order 订阅 + per-key source + 单实例三态渲染 + 增量 Markdown）。

五条不变量（必须移植）：
1. **瞬态/持久分离**：live token 不占持久标识空间；持久结算在 end 帧到达时一次性 swap 发布（防双渲染）；不变量破坏即 rebaseline 重同步。
2. **同一节点身份贯穿 running/settled/interrupted**：`turn:step` 身份 + 单一纯函数 updateChunk；渲染器一个，状态差异是 props。
3. **发布节奏三态**：none / animation-frame / immediate；rAF 嵌套跨 3 个 paint 单飞合并（`frame !== undefined` 即丢弃）；结构性事件（工具/结算/中断）immediate 抢占。
4. **每 key 独立订阅 + 脏键白名单**：列表 memo 只依赖稳定 key 顺序数组；节点值经 per-key useSyncExternalStore 订阅；快照恒等则不通知。
5. **滚动所有权**：程序化写入台账 vs 几何偏差判定读者输入；followSig 变化 + atBottom 才跟随；瞬时 scrollTop 赋值（禁 smooth）；prepend 语义行锚补偿；ResizeObserver 驱动。

强推荐：增量 Markdown（冻结除尾 2 块外全部、从解析器自身 end offset 切尾、绝对源偏移作 key、缓存 React 元素、settled 全文自愈）；Turn 折叠为区间规格 + wrapper hidden（不 unmount）。

可不搬：branded LlmAttemptId、v2 wire 格式、分数 seq 具体公式、合成 seq 偏移表、subagent 计数、未闭合 fence 二级前沿（第一版可退化为未闭合期间整体重解析）。

## 三、DSH → METIS 映射表

| DSH | METIS 现状 | METIS 目标 | 职责 |
|---|---|---|---|
| ClientAssistantStream（assistant-stream.ts） | ChatPage streamBatchRef 字符串拼接 | AssistantStreamAccumulator（attemptId + 结算暂存 + settle swap） | 实时流折叠 |
| BoundConversation.publish（assembly.ts） | ChatPage rAF flush → 全量 setMessages | ConversationPublicationScheduler（none/frame/immediate，rAF×3 单飞） | 发布节奏 |
| assistant Definition（conversation-nodes/assistant.ts） | 无（单 content 字符串 + index 定位） | AssistantNode 状态机（turn:step 身份，纯函数 updateChunk） | 节点状态折叠 |
| ChatNodeSeat + chat-snapshot-builder | messages 数组 + memo | ConversationNodeSeat + per-key source（useSyncExternalStore + dirtyKeys） | 稳定节点订阅 |
| IncrementalMarkdownParser（incremental.ts） | StreamingMarkdown 每帧全文 remark parse | IncrementalMarkdownParser（frozen prefix + tail parse + offset key） | 增量 Markdown |
| turn-process.ts | run.parts 时间线（不折叠） | TurnProcessSpec（processStart→answerAnchor 区间 + hidden 折叠） | 过程折叠 |
| ChatView follow ledger | useFollowScroll ledger（基本达标） | 保留并接 ResizeObserver 内容高度信号 | 滚动所有权 |
| chat:stream-chunk IPC | 已有（content/reasoning/isFinished） | 保留为兼容 facade，内部转 AssistantStreamFrame | IPC 兼容 |

## 四、分期实施计划

- **Phase 1 Conversation Core（纯新增，零风险）**：`src/conversation/` 下新增 contract（AssistantStreamFrame、ConversationNodeContract）、runtime（AssistantStreamAccumulator、ConversationPublicationScheduler）、store（conversationStore：per-key source + dirtyKeys 发布）。配单元测试（含 100k chunk 压测、byte-identical 断言、发布次数上界断言）。
- **Phase 2 ChatPage 接新 Store**：chat:stream-chunk → Adapter → Accumulator；流式状态从 ChatPage 抽到 store。旧路径保留 flag 切换。
- **Phase 3 Assistant Streaming 切换**：ConversationNodeSeat + AssistantNodeView（单实例三态）。
- **Phase 4 IncrementalMarkdown**：移植 incremental.ts 思想，settled 全文自愈；Code fence/math/table 策略落地。
- **Phase 5 Turn Process / Tool Node**：TurnProcessSpec 区间 + compact row 工具呈现 + 结算折叠。
- **Phase 6 Scroll**：useFollowScroll 接 ResizeObserver 内容高度信号 + prepend 锚。
- **Phase 7 其他 Workspace 迁移**：Topic（去掉独立 streamTail）、Scenario Builder（去掉 400 字截断）、Submission 接统一框架；Scenario Workflow 长任务保持 Execution Run + Step Summary 分层不塞 raw token。
- **Phase 8 清理**：废弃路径删除、Before/After 基准对照、真实 provider GUI 验收（短答/长 Markdown/reasoning/web search/多工具/Stop/Retry/重开会话）。

## 五、验收基线（DoD 摘要）

- 100k chunk：接收全量、累积 byte-identical、publication 次数受 cadence 上界控制、无秒级主线程冻结。
- 50k 字 Markdown：totalParsedSourceChars ≈ O(final length)，无平方增长。
- DOM identity：已完成段落跨帧 `=== sameNode`；settled 不 remount。
- 滚动：跟随/释放/回底/prepend 锚四场景通过。
- 全部对话界面（Project/Topic/Scenario Builder/Submission）统一框架；Office 除外。
- typecheck / lint / vitest / build 全绿；真实模型 GUI 测试记录在案。

## 六、执行记录

- 2026-09-05：立项；DSH 克隆与双审计完成；本文档落盘。修复任务（模型请求挂死）同日完成：RateLimiter 取消、model.waiting 心跳、run 终态落库、30 分钟 run 总预算、启动日志如实化——全部有单测与端到端实证（run chat-87ecb15d 8 秒 completed、model.waiting 15s 已持久化）。
- 2026-09-06：Phase 1–7 实施完成。
  - Phase 1（Core）：`src/conversation/contract/AssistantStreamContract.ts`、`runtime/AssistantStreamAccumulator.ts`、`runtime/ConversationPublicationScheduler.ts`（rAF×3 单飞 + immediate 抢占 + publishedCount/coalescedCount 指标）、`store/conversationNodeStore.ts`（per-key source + 脏键白名单 + 引用恒等跳过）。
  - Phase 2：`runtime/ConversationController.ts`（attempt 身份 + dense index + settle swap + resync 进程内自愈）、`runtime/chatStreamAdapter.ts`（旧 IPC 兼容 facade）、ChatPage 流式状态机已切换为 controller 驱动（真实启用，非 flag 搁置）。
  - Phase 3：`components/ConversationNodeSeat.tsx`（useSyncExternalStore per-key 订阅 + LiveAssistantNode）。
  - Phase 4：`markdown/IncrementalMarkdownParser.ts`（冻结前缀 + 尾部解析 + 绝对偏移 key + 非 append 重置）；`presentation/StreamingMarkdown.tsx` 原位升级为真增量 parse（props 兼容零改动接入，冻结块元素缓存，frozen+tail 单数组输出防跨槽 remount）。
  - Phase 5：`runtime/turnProcess.ts` 投影 + `components/TurnProcessDisclosure.tsx`（运行中轻量事件流、完成后折叠摘要）。
  - Phase 6：滚动沿用 useFollowScroll ledger 方案（审计确认已达目标形态），ConversationShell 保留给后续全面接管。
  - Phase 7：TopicWorkspacePage 接入 StreamingMarkdown（移除 400 字截断，保留 20k 内存上限）；Scenario Builder 保留轻量尾部形态（刘总 2026-08-30 决策：长任务 raw token 不进聊天）；Submission 本无流式。
  - Phase 8：验收测试 46/46 绿（含 100k delta byte-identical、发布上界不变式、50k 字 O(n) 解析、DOM identity sameNode、20 工具调用投影）；ChatPage 存量 28/28 绿；typecheck 三项目干净；构建成功；GUI 冒烟通过（真实 OPENROUTER 模型：run chat-10e17595 6 秒 completed + agent.completed 终态落库 + model.waiting 15s/30s/45s 心跳实时可见）。
  - 并行开发修复：electron/main.ts 中 registerSystemIpc 被并行改动复制到 4 处导致 IPC duplicate 启动崩溃——保留首处、移除 3 处冗余。
- 残余事项：(1) OPENROUTER :free 模型偶发挂起依赖上游，心跳+总预算已使其可观测、有界；(2) 设置页尚无超时/重试编辑字段（profile 文件有 HMAC 校验不可手改）；(3) Scenario Builder 完整 controller 统一未做（保留产品形态，接入点已就绪）。
- 2026-09-06（遗留清理完成）：
  - **Scenario Builder 统一接入**：ScenarioConfigurationAssistant 移除 400/220 字双重截断——content 完整累积（20k 内存上限）经 StreamingMarkdown 增量渲染；reasoning 完整累积（8k 上限）以 details 折叠展示（轻量形态保留，默认收起）。测试 `ScenarioAssistantStreaming.test.tsx` 验证超 220 字内容完整渲染与 reasoning 折叠展开。
  - **设置页超时/重试字段**：`ProviderProfileSummarySchema` 与 store `#summary` 回显 timeout/maxRetries；`ProviderProfilesSection` 表单新增「请求超时（毫秒）/失败重试次数」输入（默认 600000ms/2 次，回填当前值），保存经 ProviderProfileSaveRequest 透传 → ProviderProfileStore.save 重算 HMAC 落盘。测试 `ProviderProfilesSection.test.tsx` 覆盖回填、缺省回落与透传。
  - 验收：typecheck 全项目 0 错误；相关 vitest 68/68 绿；build 成功。
