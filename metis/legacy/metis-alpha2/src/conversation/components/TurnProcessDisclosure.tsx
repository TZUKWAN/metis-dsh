/**
 * TurnProcessDisclosure（2026-09-05 Conversation Streaming P0，Phase 5）。
 * 运行中：轻量过程事件流（行式，非卡片墙）；完成后：默认折叠为一行摘要，
 * 用户可展开回看。显隐通过 details 原生语义实现，不 unmount 行渲染器。
 */

import { memo } from 'react';
import { projectTurnProcess, type TurnProcessEntry } from '../runtime/turnProcess.js';

export interface TurnProcessDisclosureProps {
  entries: TurnProcessEntry[];
  /** Turn 是否已结束（结束后才允许折叠，规格六十二：过程折叠只在完成后执行）。 */
  settled: boolean;
  defaultOpen?: boolean;
}

const STATUS_MARK: Record<TurnProcessEntry['status'], string> = {
  pending: '○',
  running: '◐',
  completed: '✓',
  failed: '✕',
};

export const TurnProcessDisclosure = memo(function TurnProcessDisclosure({
  entries,
  settled,
  defaultOpen = false,
}: TurnProcessDisclosureProps) {
  const projection = projectTurnProcess(entries);
  const open = settled ? defaultOpen : true;

  if (entries.length === 0) return null;

  return (
    <details className="conversation-turn-process" data-running={projection.running} open={open}>
      <summary className="conversation-turn-process-summary">
        {projection.running ? '正在工作…' : projection.summary}
      </summary>
      <div className="conversation-turn-process-rows">
        {projection.entries.map((entry) => (
          <div key={entry.id} className="conversation-turn-process-row" data-status={entry.status}>
            <span aria-hidden="true">{STATUS_MARK[entry.status]}</span>
            <span>{entry.label}</span>
            {entry.detail ? <span className="conversation-turn-process-detail">{entry.detail}</span> : null}
          </div>
        ))}
      </div>
    </details>
  );
});
