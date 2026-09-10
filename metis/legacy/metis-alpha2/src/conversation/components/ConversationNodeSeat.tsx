/**
 * Conversation Node 渲染层（2026-09-05 Conversation Streaming P0，Phase 3）。
 *
 * 对应 DeepSeek Harness ChatNodeSeat + AssistantNodeView 的本质：
 * - useConversationNode：per-key 的 useSyncExternalStore 订阅——一条消息流式更新
 *   只重渲染它自己的 Seat，其余消息零工作（配合 store 的脏键白名单发布）；
 * - AssistantNodeView：streaming / settled / interrupted 共用**同一个** memo 渲染实例，
 *   状态差异只是 props（保住增量 Markdown 缓存与 DOM 连续性，规格九/六十九）；
 * - LiveAssistantNode：ConversationController 的节点直连组件（新对话面/迁移用）。
 */

import { memo, useSyncExternalStore, type ReactNode } from 'react';
import type {
  ConversationNodeSource,
} from '../store/conversationNodeStore.js';
import type { AssistantNodeState, ConversationController } from '../runtime/ConversationController.js';
import { StreamingMarkdown } from '../../presentation/StreamingMarkdown';
import type { PresentationLocale } from '../../presentation/executionPresentation';

export function useConversationNode<T>(source: ConversationNodeSource<T>): T | undefined {
  return useSyncExternalStore(source.subscribe, source.get, source.get);
}

export interface ConversationNodeSeatProps<T> {
  source: ConversationNodeSource<T>;
  render: (node: T) => ReactNode;
}

export function ConversationNodeSeat<T>({ source, render }: ConversationNodeSeatProps<T>): ReactNode {
  const node = useConversationNode(source);
  if (node === undefined) return null;
  return <>{render(node)}</>;
}

export interface AssistantNodeViewProps {
  content: string;
  reasoning?: string;
  status: 'streaming' | 'completed' | 'interrupted' | 'failed' | 'abandoned';
  locale: PresentationLocale;
  uiMode?: 'normal' | 'diagnostic';
  onOpenPaper?: (doi: string) => void;
}

/**
 * 单实例三态渲染器：streaming/settled/interrupted 不写三个组件分支，
 * 状态差异只是 props 与轻量标记（规格九十三：数据与呈现分离由调用方保证）。
 */
export const AssistantNodeView = memo(function AssistantNodeView({
  content,
  reasoning,
  status,
  locale,
  uiMode,
  onOpenPaper,
}: AssistantNodeViewProps) {
  if (status === 'abandoned') return null;
  const streaming = status === 'streaming';
  return (
    <div className="conversation-assistant-node" data-status={status}>
      {reasoning ? (
        <details className="chat-reasoning" open={streaming}>
          <summary>{streaming ? '正在思考…' : '已思考'}</summary>
          <div className="chat-reasoning-body">{reasoning}</div>
        </details>
      ) : null}
      <StreamingMarkdown text={content} streaming={streaming} locale={locale} uiMode={uiMode} onOpenPaper={onOpenPaper} />
      {status === 'interrupted' ? (
        <div className="conversation-node-interrupted-marker">已停止</div>
      ) : null}
      {status === 'failed' ? (
        <div className="conversation-node-error-marker">生成中断</div>
      ) : null}
    </div>
  );
});

export interface LiveAssistantNodeProps extends Omit<AssistantNodeViewProps, 'content' | 'reasoning' | 'status'> {
  controller: ConversationController;
  attemptId: string;
}

/** ConversationController 节点的直连 Seat：controller 发布 → 只有本组件重渲染。 */
export function LiveAssistantNode({ controller, attemptId, ...viewProps }: LiveAssistantNodeProps): ReactNode {
  const source = controller.nodeSource(attemptId);
  return (
    <ConversationNodeSeat
      source={source}
      render={(node) => (
        <AssistantNodeView
          content={node.content}
          reasoning={node.reasoning}
          status={node.status}
          locale={viewProps.locale}
          uiMode={viewProps.uiMode}
          onOpenPaper={viewProps.onOpenPaper}
        />
      )}
    />
  );
}
