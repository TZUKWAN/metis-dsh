/**
 * AgentActivityTimeline
 *
 * The conversational surface is intentionally driven by the public
 * AgentResponse event contract. It does not invent "thinking" narration:
 * lifecycle, action and progress rows are rendered only when the runtime
 * returned them, while the compact header represents the actual request
 * status owned by ChatPage.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AgentResponse } from '../../engine/runtime/ChatRuntimeContract.js';
import {
  normalizeAssistantEvent,
  reduceAssistantMessagePartsBatch,
  type AssistantMessageParts,
  type AssistantToolPart,
} from '../lib/assistantMessagePartsReducer';
import { presentExecutionAction } from '../presentation/executionPresentation';

export type AgentActivityStatus = AgentResponse['status'] | 'running';
export type AgentActivityEvent = AgentResponse['events'][number] & { replayed?: boolean };

type TimelineItem =
  | { kind: 'event'; event: AgentActivityEvent }
  | { kind: 'tool'; tool: AssistantToolPart };

export interface AgentActivityTimelineProps {
  status: AgentActivityStatus;
  events?: AgentActivityEvent[];
  parts?: AssistantMessageParts;
  startedAt?: number;
  durationMs?: number;
  locale: 'zh' | 'en';
  historyIncomplete?: boolean;
  /** Runtime hook identifiers belong in diagnostics, never in the normal conversation. */
  diagnosticMode?: boolean;
  /** Use when the request has reached the runtime but no public event exists yet. */
  pendingLabel?: string;
}

function formatElapsed(milliseconds: number | undefined): string | null {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return null;
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function statusLabel(status: AgentActivityStatus, locale: 'zh' | 'en'): string {
  const zh = locale === 'zh';
  switch (status) {
    case 'running': return zh ? '正在执行' : 'Running';
    case 'completed': return zh ? '已完成' : 'Completed';
    case 'interrupted': return zh ? '已中断' : 'Interrupted';
    case 'cancelled': return zh ? '已取消' : 'Cancelled';
    case 'context_exhausted': return zh ? '上下文已耗尽' : 'Context exhausted';
    case 'max_turns_reached': return zh ? '达到回合上限' : 'Turn limit reached';
    case 'error': return zh ? '执行失败' : 'Failed';
    default: return zh ? '运行状态不可用' : 'Run status unavailable';
  }
}

function lifecycleLabel(phase: string, locale: 'zh' | 'en'): string {
  const zh = locale === 'zh';
  const labels: Record<string, string> = zh
    ? {
      started: '运行已启动', running: '运行中', completed: '运行完成',
      interrupted: '运行已中断', failed: '运行失败', cancelled: '运行已取消', unknown: '运行状态不可用',
    }
    : {
      started: 'Run started', running: 'Running', completed: 'Run completed',
      interrupted: 'Run interrupted', failed: 'Run failed', cancelled: 'Run cancelled', unknown: 'Run status unavailable',
    };
  return labels[phase] ?? phase;
}

const INTERNAL_EVENT_SUMMARY = /^(?:agent\.(?:pre_run|post_run|start|complete|completed|interrupted|cancelled|error|failed|blocked|request_rejected|window_renewed|provider_failed)|model\.(?:request|response)|tool\.(?:dispatch_started|dispatched|replayed_from_checkpoint))(?:\b|:)/i;

function isInternalEventSummary(summary: string | undefined): boolean {
  return Boolean(summary && INTERNAL_EVENT_SUMMARY.test(summary.trim()));
}

function eventLabel(
  event: AgentActivityEvent,
  locale: 'zh' | 'en',
  diagnosticMode: boolean,
): string {
  if (event.type === 'lifecycle') {
    return (diagnosticMode || !isInternalEventSummary(event.summary)) && event.summary?.trim()
      ? event.summary.trim()
      : lifecycleLabel(event.phase, locale);
  }
  if (event.type === 'action') {
    return (diagnosticMode || !isInternalEventSummary(event.summary)) && event.summary?.trim()
      ? event.summary.trim()
      : presentExecutionAction(event.action.replace(/^tool:/u, ''), locale);
  }
  if (event.type === 'tool_result') {
    return (diagnosticMode || !isInternalEventSummary(event.summary)) && event.summary?.trim()
      ? event.summary.trim()
      : presentExecutionAction(event.toolName, locale);
  }
  if (event.type === 'progress') {
    if (event.label?.trim()) return event.label;
    return locale === 'zh'
      ? `进度 ${event.completed}/${event.total}`
      : `Progress ${event.completed}/${event.total}`;
  }
  return locale === 'zh' ? '运行事件' : 'Run event';
}

function eventMeta(event: AgentActivityEvent, locale: 'zh' | 'en'): string {
  if (event.type === 'action') {
    return statusLabel(event.status === 'running' ? 'running' : event.status === 'completed' ? 'completed' : event.status === 'failed' ? 'error' : 'unknown', locale);
  }
  if (event.type === 'tool_result') {
    return statusLabel(event.status === 'completed' ? 'completed' : 'error', locale);
  }
  if (event.type === 'progress') return `${event.completed}/${event.total}`;
  return '';
}

function toolLabel(tool: AssistantToolPart, locale: 'zh' | 'en'): string {
  return presentExecutionAction(tool.name, locale);
}

function toolMeta(tool: AssistantToolPart, locale: 'zh' | 'en'): string {
  return statusLabel(tool.status === 'running' ? 'running' : tool.status === 'completed' ? 'completed' : 'error', locale);
}

function reduceTimelineParts(events: AgentActivityEvent[]): AssistantMessageParts {
  return reduceAssistantMessagePartsBatch(events.map((event) => normalizeAssistantEvent(event)));
}

function timelineItems(parts: AssistantMessageParts): TimelineItem[] {
  const toolById = new Map(parts.tools.map((tool) => [tool.toolCallId, tool]));
  const seenTools = new Set<string>();
  const items: TimelineItem[] = [];
  for (const event of parts.run.events) {
    if (event.type === 'tool_result') {
      const tool = toolById.get(event.toolCallId);
      if (!tool || seenTools.has(tool.toolCallId)) continue;
      seenTools.add(tool.toolCallId);
      items.push({ kind: 'tool', tool });
      continue;
    }
    items.push({ kind: 'event', event });
  }
  for (const tool of parts.tools) {
    if (!seenTools.has(tool.toolCallId)) items.push({ kind: 'tool', tool });
  }
  return items;
}

/** A compact, expandable execution record kept within the assistant message. */
export default function AgentActivityTimeline({
  status,
  events = [],
  parts: suppliedParts,
  startedAt,
  durationMs,
  locale,
  diagnosticMode = false,
  pendingLabel,
  historyIncomplete = false,
}: AgentActivityTimelineProps) {
  const [liveDurationMs, setLiveDurationMs] = useState<number | undefined>(undefined);
  const completedLike = status === 'completed';
  const initiallyExpanded = status === 'running' || (!completedLike && events.length > 0);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const parts = useMemo(() => suppliedParts ?? reduceTimelineParts(events), [events, suppliedParts]);
  const items = useMemo(() => timelineItems(parts), [parts]);
  useEffect(() => {
    if (status !== 'running' || !startedAt) return undefined;
    const tick = () => setLiveDurationMs(Date.now() - startedAt);
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [startedAt, status]);

  const elapsed = formatElapsed(status === 'running' ? liveDurationMs : durationMs);
  const running = status === 'running';
  const summary = running
    ? (pendingLabel ?? (locale === 'zh' ? '运行已发起，等待执行事件' : 'Run started; waiting for execution events'))
    : statusLabel(status, locale);
  const retentionLabel = locale === 'zh'
    ? '执行历史已部分裁剪，以下仅显示保留的事件。'
    : 'Execution history is partially pruned; only retained events are shown.';
  const countText = items.length > 0
    ? (locale === 'zh' ? `${items.length} 条运行事件` : `${items.length} run events`)
    : null;

  return (
    <details
      className={`agent-activity-timeline agent-activity-timeline--${status}`}
      data-testid="agent-activity-timeline"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="agent-activity-timeline__summary">
        <span className={`agent-activity-timeline__state agent-activity-timeline__state--${status}`} aria-hidden="true" />
        <span className="agent-activity-timeline__label">{summary}</span>
        {historyIncomplete && (
          <span className="agent-activity-timeline__retention-gap" role="note">{retentionLabel}</span>
        )}
        {countText && <span className="agent-activity-timeline__count">{countText}</span>}
        {elapsed && <span className="agent-activity-timeline__elapsed">{elapsed}</span>}
      </summary>
      {(items.length > 0 || running) && (
        <ol className="agent-activity-timeline__events" data-testid="agent-activity-events">
          {items.map((item, index) => {
            if (item.kind === 'tool') {
              const { tool } = item;
              const hasToolDetail = Boolean(
                tool.arguments.trim() || tool.result?.trim() || tool.error?.trim() || tool.sources.length > 0,
              );
              const rowClass = 'agent-activity-timeline__event agent-activity-timeline__event--tool_result';
              if (hasToolDetail) {
                return (
                  <li className={rowClass} key={`tool-${tool.toolCallId}`}>
                    <details className="agent-tool-result" data-testid="agent-tool-result">
                      <summary className="agent-tool-result__summary">
                        <span className="agent-activity-timeline__event-marker" aria-hidden="true" />
                        <span className="agent-activity-timeline__event-label">{toolLabel(tool, locale)}</span>
                        <span className="agent-activity-timeline__event-meta">{toolMeta(tool, locale)}</span>
                      </summary>
                      <div className="agent-tool-result__body">
                        {diagnosticMode && tool.arguments.trim() && (
                          <pre className="agent-tool-result__arguments">{tool.arguments.trim()}</pre>
                        )}
                        {tool.result?.trim() && <p className="agent-tool-result__detail">{tool.result.trim()}</p>}
                        {tool.error?.trim() && <p className="agent-tool-result__error">{tool.error.trim()}</p>}
                        {tool.sources.length > 0 && (
                          <ul className="agent-tool-result__sources" aria-label={locale === 'zh' ? '工具返回的来源' : 'Tool-returned sources'}>
                            {tool.sources.map((source, sourceIndex) => (
                              <li key={`${source.label}-${source.url ?? sourceIndex}`}>
                                {source.url
                                  ? <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a>
                                  : <span>{source.label}</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </details>
                  </li>
                );
              }
              return (
                <li className={rowClass} key={`tool-${tool.toolCallId}`}>
                  <span className="agent-activity-timeline__event-marker" aria-hidden="true" />
                  <span className="agent-activity-timeline__event-label">{toolLabel(tool, locale)}</span>
                  <span className="agent-activity-timeline__event-meta">{toolMeta(tool, locale)}</span>
                </li>
              );
            }

            const { event } = item;
            const label = eventLabel(event, locale, diagnosticMode);
            const meta = eventMeta(event, locale);
            const rowClass = `agent-activity-timeline__event agent-activity-timeline__event--${event.type}`;
            return (
              <li className={rowClass} key={`${event.type}-${event.timestamp}-${index}`}>
                <span className="agent-activity-timeline__event-marker" aria-hidden="true" />
                <span className="agent-activity-timeline__event-label">{label}</span>
                {meta && <span className="agent-activity-timeline__event-meta">{meta}</span>}
              </li>
            );
          })}
          {running && items.length === 0 && (
            <li className="agent-activity-timeline__event agent-activity-timeline__event--pending">
              <span className="agent-activity-timeline__event-marker" aria-hidden="true" />
              <span className="agent-activity-timeline__event-label">{locale === 'zh' ? '等待运行事件' : 'Waiting for runtime events'}</span>
            </li>
          )}
        </ol>
      )}
    </details>
  );
}
