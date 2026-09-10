/**
 * JobQueue — 通用后台作业队列（T10）。
 *
 * 纯逻辑核心（可单测）：作业按 kind 由注册的 handler 串行执行，
 * 支持进度上报、检查点持久化（崩溃/重启后恢复）、取消、重试。
 * Electron 侧由 JobQueueService 负责落盘与 IPC（见 electron/JobQueueService.ts）。
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobRecord {
  id: string;
  kind: string;
  label: string;
  payload: unknown;
  status: JobStatus;
  /** 0-100。 */
  progress: number;
  progressNote: string;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** handler 保存的断点数据（重启后从断点续跑）。 */
  checkpoint: unknown;
  result: unknown;
}

export interface JobRunContext {
  job: JobRecord;
  /** 汇报进度（0-100）。 */
  reportProgress: (progress: number, note?: string) => void;
  /** 持久化断点（每步调用，崩溃后从这里继续）。 */
  saveCheckpoint: (data: unknown) => void;
  /** 取消请求为真时 handler 应尽快退出并抛出 JobCancelledError。 */
  isCancelled: () => boolean;
}

export class JobCancelledError extends Error {
  constructor() {
    super('job_cancelled');
    this.name = 'JobCancelledError';
  }
}

export interface JobHandler {
  kind: string;
  run: (ctx: JobRunContext) => Promise<unknown>;
}

export interface JobQueueEvents {
  /** 任何作业状态/进度变化时触发（用于持久化与推送）。 */
  onChanged: (jobs: readonly JobRecord[]) => void;
}

let idCounter = 0;
function makeJobId(): string {
  idCounter += 1;
  return `job-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export class JobQueue {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly jobs: JobRecord[] = [];
  private readonly cancelled = new Set<string>();
  private readonly events: JobQueueEvents;
  private running = false;
  /** 恢复模式：从磁盘装载的 running 作业重新入队。 */
  restoredIds = new Set<string>();

  constructor(events: JobQueueEvents) {
    this.events = events;
  }

  registerHandler(handler: JobHandler): void {
    this.handlers.set(handler.kind, handler);
  }

  /** 装载持久化的作业（App 启动时）：未完成的重新排队，恢复断点。 */
  restore(records: JobRecord[]): void {
    for (const record of records) {
      if (record.status === 'running' || record.status === 'queued') {
        this.restoredIds.add(record.id);
        this.jobs.push({ ...record, status: 'queued', error: null });
      } else {
        this.jobs.push({ ...record });
      }
    }
    this.emit();
    void this.tick();
  }

  enqueue(kind: string, label: string, payload: unknown): JobRecord | null {
    if (!this.handlers.has(kind)) return null;
    const job: JobRecord = {
      id: makeJobId(),
      kind,
      label,
      payload,
      status: 'queued',
      progress: 0,
      progressNote: '',
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      checkpoint: null,
      result: null,
    };
    this.jobs.push(job);
    this.emit();
    void this.tick();
    return job;
  }

  cancel(jobId: string): void {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return;
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      this.emit();
    } else if (job.status === 'running') {
      this.cancelled.add(job.id);
    }
  }

  retry(jobId: string): void {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job || (job.status !== 'failed' && job.status !== 'cancelled')) return;
    job.status = 'queued';
    job.progress = 0;
    job.error = null;
    job.finishedAt = null;
    this.emit();
    void this.tick();
  }

  list(): readonly JobRecord[] {
    return this.jobs;
  }

  /** 未完成作业数（顶栏指示用）。 */
  pendingCount(): number {
    return this.jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
  }

  private emit(): void {
    this.events.onChanged(this.jobs);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.jobs.find((j) => j.status === 'queued');
        if (!job) break;
        const handler = this.handlers.get(job.kind);
        if (!handler) {
          job.status = 'failed';
          job.error = `no_handler:${job.kind}`;
          job.finishedAt = Date.now();
          this.emit();
          continue;
        }
        job.status = 'running';
        job.startedAt = Date.now();
        this.emit();
        try {
          const ctx: JobRunContext = {
            job,
            reportProgress: (progress, note) => {
              job.progress = Math.max(0, Math.min(100, progress));
              if (note) job.progressNote = note;
              this.emit();
            },
            saveCheckpoint: (data) => {
              job.checkpoint = data;
              this.emit();
            },
            isCancelled: () => this.cancelled.has(job.id),
          };
          const result = await handler.run(ctx);
          if (this.cancelled.has(job.id)) {
            job.status = 'cancelled';
          } else {
            job.status = 'done';
            job.progress = 100;
            job.result = result ?? null;
          }
        } catch (error) {
          if (error instanceof JobCancelledError || this.cancelled.has(job.id)) {
            job.status = 'cancelled';
          } else {
            job.status = 'failed';
            job.error = String((error as Error)?.message ?? error).slice(0, 300);
          }
        } finally {
          this.cancelled.delete(job.id);
          job.finishedAt = Date.now();
          this.emit();
        }
      }
    } finally {
      this.running = false;
    }
  }
}
