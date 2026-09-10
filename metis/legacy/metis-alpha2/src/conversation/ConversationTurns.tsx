import { memo } from 'react';
import { AlertTriangle, Check, ChevronDown, LoaderCircle } from 'lucide-react';
import { SafeMarkdown } from '../presentation/SafeMarkdown';
import type {
  ArtifactPart,
  CitationPart,
  ConversationMessage,
  ConversationPart,
  ConversationTarget,
  ErrorPart,
  ReasoningPart,
  ScenarioStepPart,
  StatusPart,
  ToolPart,
} from './types';
import './conversation.css';

/**
 * 统一消息渲染（T2）：
 * Assistant 正文直接生长在阅读流中——无 Card/Border/Shadow/Avatar；
 * User 保留克制 Bubble；Tool/Reasoning/Step 默认折叠一行；
 * 所有业务面共享（ChatPage/Scenario/Topic/Submission/Outcome）。
 */

export interface AssistantTurnAction {
  label: string;
  onSelect: () => void;
}

export interface ConversationTurnProps {
  locale: 'zh' | 'en';
  /** Step 三操作/复制/重新生成等 hover 动作（Assistant）。 */
  actions?: AssistantTurnAction[];
  /** Step Target 操作回调（ScenarioStepPart 用）。 */
  onStepTarget?: (target: ConversationTarget) => void;
}

const zh = (locale: 'zh' | 'en', zhText: string, enText: string) => (locale === 'zh' ? zhText : enText);

// ─── Parts ───────────────────────────────────────────────────────

const TextPartView = memo(function TextPartView({ text }: { text: string }) {
  return <SafeMarkdown content={text} locale="zh" />;
});

const ReasoningPartView = memo(function ReasoningPartView({ part }: { part: ReasoningPart }) {
  return (
    <details className="conv-disclosure conv-reasoning">
      <summary>
        <ChevronDown size={13} aria-hidden />
        <span>{part.status === 'running' ? zh('zh', '思考中', 'Thinking') : zh('zh', '思考过程', 'Reasoning')}</span>
        {part.status === 'running' && <LoaderCircle size={12} className="conv-spin" aria-hidden />}
      </summary>
      <div className="conv-disclosure__body">{part.summary}</div>
    </details>
  );
});

const ToolPartView = memo(function ToolPartView({ part }: { part: ToolPart }) {
  const icon = part.status === 'completed'
    ? <Check size={13} className="conv-tool__ok" aria-hidden />
    : part.status === 'failed'
      ? <AlertTriangle size={13} className="conv-tool__fail" aria-hidden />
      : <LoaderCircle size={13} className="conv-spin" aria-hidden />;
  return (
    <details className="conv-disclosure conv-tool">
      <summary>
        {icon}
        <span>{part.label}</span>
        {part.summary && <span className="conv-tool__summary">{part.summary}</span>}
        {part.completedAt && part.startedAt && (
          <span className="conv-tool__duration">{((part.completedAt - part.startedAt) / 1000).toFixed(1)}s</span>
        )}
      </summary>
      <div className="conv-disclosure__body">
        {part.summary ?? zh('zh', '（无详情）', '(no details)')}
      </div>
    </details>
  );
});

const CitationPartView = memo(function CitationPartView({ part }: { part: CitationPart }) {
  if (part.citations.length === 0) return null;
  return (
    <div className="conv-citations">
      {part.citations.map((citation, index) => (
        <a
          key={`${index}-${citation.url ?? citation.title ?? ''}`}
          className="conv-citation-chip"
          href={citation.url ? /^https?:\/\//iu.test(citation.url) ? citation.url : undefined : undefined}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => { if (!citation.url) event.preventDefault(); }}
          title={citation.title ?? citation.label ?? citation.url}
        >
          [{index + 1}] {citation.title ?? citation.label ?? citation.url}
        </a>
      ))}
    </div>
  );
});

const StatusPartView = memo(function StatusPartView({ part }: { part: StatusPart }) {
  return <div className={`conv-status conv-status--${part.tone ?? 'info'}`}>{part.text}</div>;
});

const ErrorPartView = memo(function ErrorPartView({ part }: { part: ErrorPart }) {
  return (
    <div className="conv-error" role="alert">
      <div className="conv-error__head">
        <AlertTriangle size={14} aria-hidden />
        <span>{part.message}</span>
      </div>
      {part.technical && (
        <details className="conv-disclosure">
          <summary>{zh('zh', '技术详情', 'Technical details')}</summary>
          <div className="conv-disclosure__body conv-error__tech">{part.technical}</div>
        </details>
      )}
    </div>
  );
});

const ArtifactPartView = memo(function ArtifactPartView({ part }: { part: ArtifactPart }) {
  return (
    <div className="conv-artifact">
      <Check size={13} className="conv-tool__ok" aria-hidden />
      <span>{zh('zh', '已生成成果', 'Artifact generated')}</span>
      <strong>{part.title}</strong>
      <span className="conv-artifact__type">{part.artifactType}</span>
    </div>
  );
});

/** Step 三操作语义（文档三十四节）：提出意见≠修改≠重做。 */
const ScenarioStepPartView = memo(function ScenarioStepPartView({
  part,
  onStepTarget,
}: {
  part: ScenarioStepPart;
  locale: 'zh' | 'en';
  onStepTarget?: (target: ConversationTarget) => void;
}) {
  const icon = part.status === 'completed'
    ? <Check size={13} className="conv-tool__ok" aria-hidden />
    : part.status === 'failed'
      ? <AlertTriangle size={13} className="conv-tool__fail" aria-hidden />
      : part.status === 'stale'
        ? <AlertTriangle size={13} className="conv-tool__stale" aria-hidden />
        : <LoaderCircle size={13} className="conv-spin" aria-hidden />;
  const statusLabel = part.status === 'stale'
    ? zh('zh', '结果可能已过时', 'stale')
    : part.status;
  const stepTarget: ConversationTarget = { type: 'scenario_step', runId: part.runId, stepId: part.stepId, revision: part.revision, title: part.title };
  return (
    <div className={`conv-step conv-step--${part.status}`}>
      <div className="conv-step__head">
        {icon}
        <strong>{part.title}</strong>
        <span className="conv-step__meta">
          {statusLabel}
          {part.durationMs ? ` · ${(part.durationMs / 1000).toFixed(0)}s` : ''}
          {part.sourceCount ? ` · ${zh('zh', `${part.sourceCount} 个来源`, `${part.sourceCount} sources`)}` : ''}
          {part.artifactCount ? ` · ${zh('zh', `${part.artifactCount} 项产出`, `${part.artifactCount} artifacts`)}` : ''}
        </span>
      </div>
      {part.brief && <div className="conv-step__brief">{part.brief}</div>}
      {part.status === 'completed' && onStepTarget && (
        <div className="conv-step__actions">
          <button type="button" onClick={() => onStepTarget(stepTarget)}>{zh('zh', '提出意见', 'Comment')}</button>
          <button type="button" onClick={() => onStepTarget(stepTarget)}>{zh('zh', '修改这步', 'Revise')}</button>
          <button type="button" onClick={() => onStepTarget(stepTarget)}>{zh('zh', '重做', 'Redo')}</button>
        </div>
      )}
    </div>
  );
});

function PartView({ part, locale, onStepTarget }: { part: ConversationPart; locale: 'zh' | 'en'; onStepTarget?: ConversationTurnProps['onStepTarget'] }) {
  switch (part.type) {
    case 'text': return <TextPartView text={part.text} />;
    case 'reasoning': return <ReasoningPartView part={part} />;
    case 'tool': return <ToolPartView part={part} />;
    case 'citation': return <CitationPartView part={part} />;
    case 'scenario_step': return <ScenarioStepPartView part={part} locale={locale} onStepTarget={onStepTarget} />;
    case 'artifact': return <ArtifactPartView part={part} />;
    case 'status': return <StatusPartView part={part} />;
    case 'error': return <ErrorPartView part={part} />;
  }
}

// ─── Turns ───────────────────────────────────────────────────────

export const AssistantTurn = memo(function AssistantTurn({
  message,
  locale = 'zh',
  actions,
  onStepTarget,
}: {
  message: ConversationMessage;
  locale?: 'zh' | 'en';
  actions?: AssistantTurnAction[];
  onStepTarget?: ConversationTurnProps['onStepTarget'];
}) {
  const streaming = message.status === 'streaming';
  return (
    <article className="conv-assistant" data-status={message.status ?? 'completed'}>
      <div className="conv-assistant__body">
        {message.parts.map((part, index) => <PartView key={index} part={part} locale={locale} onStepTarget={onStepTarget} />)}
        {streaming && <span className="conv-caret" aria-hidden>▌</span>}
      </div>
      {!streaming && actions && actions.length > 0 && (
        <div className="conv-assistant__actions">
          {actions.map((action) => (
            <button key={action.label} type="button" onClick={action.onSelect}>{action.label}</button>
          ))}
        </div>
      )}
    </article>
  );
});

export const UserTurn = memo(function UserTurn({ message, locale = 'zh' }: { message: ConversationMessage; locale?: 'zh' | 'en' }) {
  const text = message.parts
    .filter((part): part is Extract<ConversationPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  return (
    <article className="conv-user">
      <div className="conv-user__bubble">{text}</div>
    </article>
  );
});

export type { ConversationMessage, ConversationTarget } from './types';
