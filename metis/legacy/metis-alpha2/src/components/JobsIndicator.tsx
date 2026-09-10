/**
 * JobsIndicator — 后台作业进度指示（T10）。
 *
 * 顶栏/资料区共用：显示运行中/排队作业数，点击展开最近作业列表
 * （进度、状态、取消/重试）。作业数据来自主进程 JobQueueService 推送。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../i18n';
import { showToast } from '../lib/toast';
import './JobsIndicator.css';

interface JobView {
  id: string;
  kind: string;
  label: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: number;
  progressNote: string;
  error: string | null;
  finishedAt: number | null;
}

export default function JobsIndicator() {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [open, setOpen] = useState(false);
  const loadedRef = useRef(false);
  const seenRef = useRef<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);

  // P2-22：面板打开时支持 Esc 与点击外部关闭。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: MouseEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    const metis = window.metis;
    if (!metis?.onJobsChanged) return;
    const off = metis.onJobsChanged((next) => {
      loadedRef.current = true;
      // L4：作业从进行中转为完成/失败时弹 toast（跳过启动装载的首次快照）。
      if (seenRef.current.size > 0) {
        for (const job of next as JobView[]) {
          if (seenRef.current.has(job.id)) continue;
          seenRef.current.add(job.id);
          if (job.status === 'done') {
            showToast({ kind: 'success', text: t('jobs.toastDone', { label: job.label }) });
          } else if (job.status === 'failed') {
            showToast({ kind: 'error', text: t('jobs.toastFailed', { label: job.label }), durationMs: 10000 });
          }
        }
      } else {
        for (const job of next as JobView[]) seenRef.current.add(job.id);
      }
      setJobs(next as JobView[]);
    });
    void metis.listJobs?.().then((list) => {
      if (list && !loadedRef.current) setJobs(list as JobView[]);
    });
    return () => { off?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pending = jobs.filter((job) => job.status === 'queued' || job.status === 'running');
  if (pending.length === 0 && !open) return null;
  const running = pending.find((job) => job.status === 'running');

  return (
    <div className="jobs-indicator" data-testid="jobs-indicator" ref={rootRef}>
      <button
        type="button"
        className="jobs-indicator__trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        data-testid="jobs-indicator-trigger"
      >
        <span className={`jobs-indicator__dot${running ? ' jobs-indicator__dot--running' : ''}`} aria-hidden="true" />
        {running
          ? t('jobs.runningCount', { count: pending.length })
          : t('jobs.pendingCount', { count: pending.length })}
      </button>
      {open && (
        <div className="jobs-indicator__panel" data-testid="jobs-panel">
          <ul className="jobs-indicator__list">
            {jobs.slice(-12).reverse().map((job) => (
              <li key={job.id} className={`jobs-indicator__item jobs-indicator__item--${job.status}`}>
                <div className="jobs-indicator__row">
                  <span className="jobs-indicator__label" title={job.label}>{job.label}</span>
                  <span className="jobs-indicator__status">{t(`jobs.status_${job.status}`)}</span>
                  {(job.status === 'running' || job.status === 'queued') && (
                    <button
                      type="button"
                      className="btn-sm btn-secondary"
                      onClick={() => void window.metis?.cancelJob?.(job.id)}
                      data-testid="jobs-cancel"
                    >
                      {t('jobs.cancel')}
                    </button>
                  )}
                  {job.status === 'failed' && (
                    <button
                      type="button"
                      className="btn-sm btn-secondary"
                      onClick={() => void window.metis?.retryJob?.(job.id)}
                      data-testid="jobs-retry"
                    >
                      {t('jobs.retry')}
                    </button>
                  )}
                </div>
                {(job.status === 'running' || job.status === 'queued') && (
                  <div className="jobs-indicator__progress" role="progressbar" aria-valuenow={job.progress} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: `${job.progress}%` }} />
                  </div>
                )}
                {job.status === 'failed' && job.error && (
                  <div className="jobs-indicator__error">{job.error.slice(0, 160)}</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
