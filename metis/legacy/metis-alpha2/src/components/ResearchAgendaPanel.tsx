/**
 * ResearchAgendaPanel — 研究议程仪表盘（自主改造 C）。
 *
 * 卡片网格呈现队列：自主新项目条目（AI 生成）与既有项目条目混排；
 * 状态色（排队灰/执行蓝）、运行进度（已运行/上限）、排序与移除。
 * 护栏由主进程强制执行。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import { showToast } from '../lib/toast';
import './ResearchAgendaPanel.css';

interface AgendaEntryView {
  projectId: string;
  title: string;
  runsCompleted: number;
  maxRuns: number;
  enqueuedAt: number;
  autonomous?: boolean;
  goalPrompt?: string;
}

interface AgendaStateView {
  queue: AgendaEntryView[];
  autoContinue: boolean;
  cooldownMs: number;
}

export default function ResearchAgendaPanel({ onAdvance }: { onAdvance?: (goalPrompt: string, autonomous: boolean, projectId: string | null, title: string) => void }) {
  const { t } = useTranslation();
  const projects = useResearchWorkspaceStore((s) => s.projects);
  const activeProjectId = useResearchWorkspaceStore((s) => s.activeProjectId);
  const running = useResearchWorkspaceStore((s) => s.snapshot !== null);
  const [state, setState] = useState<AgendaStateView | null>(null);
  const [maxRuns, setMaxRuns] = useState(2);

  const reload = useCallback(async () => {
    const next = await window.metis?.getAgendaState?.();
    if (next) setState(next as AgendaStateView);
  }, []);

  useEffect(() => {
    let alive = true;
    void window.metis?.getAgendaState?.().then((next) => {
      if (alive && next) setState(next as AgendaStateView);
    });
    const timer = setInterval(() => { void reload(); }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [reload]);

  const queueFromActive = useCallback(() => {
    const project = projects.find((p) => p.id === activeProjectId);
    if (project) {
      void window.metis?.enqueueAgenda?.({ projectId: project.id, title: project.title, maxRuns }).then((result) => {
        if (result && 'error' in result) {
          showToast({ kind: 'error', text: t(`agenda.error_${result.error}`) });
        } else {
          showToast({ kind: 'success', text: t('agenda.enqueued', { title: project.title }) });
        }
        void reload();
      });
    }
  }, [projects, activeProjectId, maxRuns, t, reload]);

  const toggleAuto = useCallback(async (enabled: boolean) => {
    await window.metis?.setAgendaAutoContinue?.(enabled);
    void reload();
  }, [reload]);

  const advance = useCallback(() => {
    void window.metis?.decideAgendaNext?.().then((decision) => {
      showToast({ kind: 'info', text: decision.note });
      const head = state?.queue[0];
      if (decision.action === 'run_next' && head) {
        onAdvance?.(head.goalPrompt ?? '', head.autonomous === true, head.projectId, head.title);
      }
      void reload();
    });
  }, [state, onAdvance, reload]);

  const queue = state?.queue ?? [];

  return (
    <section className="agenda-panel agenda-panel--dashboard" data-testid="agenda-panel" aria-label={t('agenda.title')}>
      <header className="agenda-panel__header">
        <h2>{t('agenda.title')}<span className="agenda-panel__count">{queue.length}</span></h2>
        <div className="agenda-panel__header-actions">
          <label className="library-search__check">
            <input type="checkbox" checked={state?.autoContinue ?? true} onChange={(e) => void toggleAuto(e.target.checked)} data-testid="agenda-auto-toggle" />
            {t('agenda.autoContinue')}
          </label>
          <label className="agenda-panel__runs">
            {t('agenda.maxRuns')}
            <input type="number" min={1} max={5} value={maxRuns} onChange={(e) => setMaxRuns(Math.min(5, Math.max(1, Number(e.target.value) || 2)))} data-testid="agenda-max-runs" />
          </label>
          <button type="button" className="btn-sm btn-secondary" disabled={!activeProjectId} onClick={queueFromActive} data-testid="agenda-enqueue-active">
            {t('agenda.enqueueActive')}
          </button>
          {queue.length > 0 && (
            <button type="button" className="btn-primary btn-sm" onClick={advance} data-testid="agenda-advance">
              {t('agenda.advanceNow')}
            </button>
          )}
        </div>
      </header>

      {queue.length === 0 ? (
        <p className="agenda-panel__empty">{t('agenda.emptySetup')}</p>
      ) : (
        <div className="agenda-dashboard" data-testid="agenda-dashboard">
          {queue.map((entry, index) => {
            const progress = Math.min(100, Math.round((entry.runsCompleted / entry.maxRuns) * 100));
            const isHead = index === 0;
            return (
              <article
                key={entry.projectId}
                className={`agenda-card ${isHead ? 'agenda-card--head' : ''} ${entry.autonomous ? 'agenda-card--auto' : ''}`}
                data-testid="agenda-card"
              >
                <div className="agenda-card__top">
                  <span className="agenda-card__index">{index + 1}</span>
                  {entry.autonomous && <span className="agenda-card__badge">{t('agenda.autoBadge')}</span>}
                  {isHead && <span className="agenda-card__badge agenda-card__badge--head">{t('agenda.nextUp')}</span>}
                </div>
                <h3 className="agenda-card__title" title={entry.title}>{entry.title}</h3>
                {entry.goalPrompt && (
                  <p className="agenda-card__question">{extractQuestion(entry.goalPrompt)}</p>
                )}
                <div className="agenda-card__progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ width: `${Math.max(progress, 4)}%` }} />
                </div>
                <div className="agenda-card__meta">
                  <span>{t('agenda.runsMeta', { done: entry.runsCompleted, max: entry.maxRuns })}</span>
                  {running && isHead && <span className="agenda-card__running">{t('agenda.executing')}</span>}
                </div>
                <div className="agenda-card__actions">
                  <button type="button" className="btn-sm btn-secondary" disabled={index === 0} onClick={() => void window.metis?.moveAgenda?.(entry.projectId, 'up').then(() => reload())} aria-label={t('agenda.moveUp')}>↑</button>
                  <button type="button" className="btn-sm btn-secondary" disabled={index === queue.length - 1} onClick={() => void window.metis?.moveAgenda?.(entry.projectId, 'down').then(() => reload())} aria-label={t('agenda.moveDown')}>↓</button>
                  <button type="button" className="btn-sm btn-secondary" onClick={() => void window.metis?.removeAgenda?.(entry.projectId).then(() => reload())} data-testid="agenda-remove">{t('library.actionDelete')}</button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <p className="agenda-panel__safety">{t('agenda.safetyNote')}</p>
    </section>
  );
}

function extractQuestion(goalPrompt: string): string {
  const match = goalPrompt.match(/研究问题：(.+)/u);
  return match ? match[1]!.slice(0, 80) : goalPrompt.slice(0, 80);
}
