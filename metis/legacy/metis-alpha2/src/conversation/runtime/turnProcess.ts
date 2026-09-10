/**
 * Turn Process 投影与折叠（2026-09-05 Conversation Streaming P0，Phase 5）。
 *
 * 对应 DeepSeek Harness turn-process.ts 的本质（按 METIS 事件最小化）：
 * 一个 User Turn 的 Reasoning / Tool Call / Tool Result / 中间状态构成
 * 「过程」+「最终回答」，而不是几十张平级卡片。
 * - 运行中：过程以轻量事件流可见（行，不是大圆角卡片，规格二十八）；
 * - 完成后：默认折叠为一行摘要（「已思考 · N 次工具调用」规格二十九），
 *   用户可展开；折叠是展示层显隐，不改变节点结构。
 */

export interface TurnProcessEntry {
  id: string;
  kind: 'tool' | 'reasoning' | 'status' | 'error';
  label: string;
  detail?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  timestamp?: number;
}

export interface TurnProcessProjection {
  running: boolean;
  /** 折叠摘要行（例如「检索 3 次 · 阅读 12 个来源」）。 */
  summary: string;
  toolCallCount: number;
  errorCount: number;
  entries: TurnProcessEntry[];
}

export function projectTurnProcess(entries: TurnProcessEntry[]): TurnProcessProjection {
  const running = entries.some((entry) => entry.status === 'running' || entry.status === 'pending');
  const toolCallCount = entries.filter((entry) => entry.kind === 'tool').length;
  const errorCount = entries.filter((entry) => entry.status === 'failed' || entry.kind === 'error').length;
  const summaryParts: string[] = [];
  if (toolCallCount > 0) summaryParts.push(`${toolCallCount} 次工具调用`);
  if (errorCount > 0) summaryParts.push(`${errorCount} 个错误`);
  if (summaryParts.length === 0 && running) summaryParts.push('进行中');
  return {
    running,
    summary: summaryParts.join(' · ') || '已完成',
    toolCallCount,
    errorCount,
    entries,
  };
}
