import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Paperclip, Square } from 'lucide-react';
import { AssistantTurn, UserTurn } from './ConversationTurns';
import type { ConversationMessage, ConversationTarget } from './types';
import type { ConversationTurnProps } from './ConversationTurns';
import { targetLabel } from './types';
import './conversation.css';

/**
 * 统一 Composer（T2）：所有非 Office 对话共享。
 * Enter 发送 / Shift+Enter 换行 / Esc 停止；运行时 ↑→■ 真 Stop；
 * Target Chip 显示当前对话目标；次要能力收进 ···。
 */

export interface ConversationComposerProps {
  locale?: 'zh' | 'en';
  disabled?: boolean;
  streaming?: boolean;
  target?: ConversationTarget | null;
  placeholder?: string;
  /** 附件按钮回调（无则不显示）。 */
  onAttach?: () => void;
  onSend: (text: string, target: ConversationTarget | null) => void;
  onStop?: () => void;
  onClearTarget?: () => void;
  composerExtra?: React.ReactNode;
}

export function useConversationScroll() {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const rafRef = useRef(0);

  const onScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance > 96) {
      followRef.current = false;
      setShowJump(true);
    } else if (distance < 40) {
      followRef.current = true;
      setShowJump(false);
    }
  }, []);

  /** 流式增长帧调用：仅在 follow 模式下贴底（非每 token scrollIntoView）。 */
  const pinToBottom = useCallback(() => {
    if (!followRef.current) return;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = viewportRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    followRef.current = true;
    setShowJump(false);
  }, []);

  return { viewportRef, onScroll, pinToBottom, scrollToBottom, showJump, followRef };
}

export function ConversationComposer({
  locale = 'zh',
  disabled,
  streaming,
  target,
  placeholder,
  onAttach,
  onSend,
  onStop,
  onClearTarget,
  composerExtra,
}: ConversationComposerProps) {
  const [draft, setDraft] = useState('');
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const zh = locale === 'zh';

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled || streaming) return;
    onSend(text, target ?? null);
    setDraft('');
    if (areaRef.current) areaRef.current.style.height = 'auto';
  };

  return (
    <div className="conv-composer" data-testid="conversation-composer">
      {target && (
        <div className="conv-composer__target" role="status">
          <span>{zh ? '针对' : 'Target'}: {targetLabel(target)}</span>
          <button type="button" onClick={onClearTarget} aria-label={zh ? '清除对话目标' : 'Clear target'}>×</button>
        </div>
      )}
      <div className="conv-composer__row">
        <textarea
          ref={areaRef}
          rows={1}
          value={draft}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            const el = event.target as HTMLTextAreaElement;
            el.style.height = 'auto';
            el.style.height = `${Math.min(160, el.scrollHeight)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (streaming) { onStop?.(); return; }
              submit();
            }
            if (event.key === 'Escape' && target) {
              event.preventDefault();
              onClearTarget?.();
            }
          }}
          placeholder={placeholder ?? (zh ? '输入消息…' : 'Type a message…')}
          aria-label={zh ? '对话输入框' : 'Message composer'}
          data-testid="conversation-composer-input"
        />
        {onAttach && (
          <button type="button" className="conv-composer__icon" onClick={onAttach} aria-label={zh ? '添加附件' : 'Attach'} disabled={disabled || streaming}>
            <Paperclip size={15} />
          </button>
        )}
        <button
          type="button"
          className="conv-composer__send"
          onClick={() => (streaming ? onStop?.() : submit())}
          disabled={disabled && !streaming}
          aria-label={streaming ? (zh ? '停止生成' : 'Stop') : (zh ? '发送' : 'Send')}
          data-testid="conversation-composer-send"
        >
          {streaming ? <Square size={14} /> : <ArrowUp size={16} />}
        </button>
      </div>
      {composerExtra && <div className="conv-composer__extra">{composerExtra}</div>}
    </div>
  );
}

/** 消息列表 + 视口 + 回到底部（与 Composer 组成 ConversationShell 的主体）。 */
export function ConversationMessageList({
  messages,
  locale = 'zh',
  streamingId,
  assistantActions,
  onStepTarget,
  emptyState,
}: {
  messages: ConversationMessage[];
  locale?: 'zh' | 'en';
  /** 处于流式中的消息 id（驱动自动跟随）。 */
  streamingId?: string | null;
  assistantActions?: (message: ConversationMessage) => ConversationTurnProps['actions'];
  onStepTarget?: (target: ConversationTarget) => void;
  emptyState?: React.ReactNode;
}) {
  const { viewportRef, onScroll, pinToBottom, scrollToBottom, showJump } = useConversationScroll();

  useEffect(() => {
    if (streamingId) pinToBottom();
  }, [messages, streamingId, pinToBottom]);

  return (
    <div className="conv-viewport-wrap" style={{ position: 'relative', minHeight: 0, flex: 1 }}>
      <div ref={viewportRef} className="conv-viewport" onScroll={onScroll} data-testid="conversation-viewport">
        <div className="conv-stream">
          {messages.length === 0 && emptyState}
          {messages.map((message) => (
            message.role === 'user'
              ? <UserTurn key={message.id} message={message} locale={locale} />
              : <AssistantTurn
                  key={message.id}
                  message={message}
                  locale={locale}
                  actions={assistantActions?.(message)}
                  onStepTarget={onStepTarget}
                />
          ))}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          className="conv-jump-latest"
          onClick={() => scrollToBottom()}
          aria-label={locale === 'zh' ? '回到最新' : 'Jump to latest'}
        >
          <ArrowDown size={13} /> {locale === 'zh' ? '回到最新' : 'Latest'}
        </button>
      )}
    </div>
  );
}

/** 供各业务面把自有消息数组映射为统一 Turn 序列的辅助（memo 友好）。 */
export function useConversationMessages(raw: ConversationMessage[]) {
  return useMemo(() => raw, [raw]);
}
