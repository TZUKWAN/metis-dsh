# Conversation stress fixtures (Task 5 §14)

确定性生成的量级 fixture，供 `tests/conversation/ConversationStress.test.tsx`
消费。文件名：`*.stress.json`。

```json
{
  "name": "10k-text-deltas",      // 场景名（唯一）
  "textDeltas": 10000,            // 文本增量次数（0 = 无文本流）
  "reasoningDeltas": 100000,      // 推理增量次数（0 = 无推理流）
  "textChunk": "字",              // 每个文本增量追加的内容
  "reasoningChunk": "思",         // 每个推理增量追加的内容
  "markdown": false,              // chunk 内容是否为 markdown 文档片段
  "stopAtDelta": null,            // 在第 N 个增量处触发真实停止交互（null = 不停）
  "expectFinalAnswer": "..."      // 流结束后 authoritative 答案（resolve 时给）
}
```

这些文件是任务 5 生成的【临时确定性替身】，等待 Conversation AGENT 的
deterministic fixture 交付后整体替换；消费端只依赖上述 JSON 契约。
