/**
 * JobQueueService — 主进程作业队列服务（T10 + T2）。
 *
 * - 持久化：队列状态与检查点落 dataDir/job-queue.json，App 重启后恢复未完成作业。
 * - 内置 handler：`pdf_extract`（单篇 PDF 全文抽取）、`pdf_extract_backlog`
 *   （批量回填有 PDF 无全文的文献）。
 * - IPC：jobs:list / jobs:cancel / jobs:retry / jobs:extractBacklog + jobs:changed 推送。
 *
 * 抽取引擎：pdfjs-dist legacy 构建在主进程解析文本（与渲染器同一依赖，零新增包）。
 * 铁律（T6）：全文由确定性代码抽取，不经模型 —— 模型只消费抽取结果。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ipcMain, BrowserWindow } from 'electron';
import { JobQueue, JobCancelledError, type JobRecord, type JobRunContext } from '../engine/runtime/JobQueue.js';
import type { PersistenceStore } from '../engine/persistence/PersistenceStore.js';

interface QueuedPaperPayload {
  paperId: string;
  pdfPath: string;
}

const QUEUE_FILE = 'job-queue.json';
const MAX_COMPLETED_JOBS = 80;

export interface ExtractQuality {
  pages: number;
  characters: number;
  /** 每页平均字符数低于阈值视为可疑（扫描件/图片型 PDF）。 */
  suspicious: boolean;
}

export class JobQueueService {
  readonly queue: JobQueue;
  private readonly dataDir: string;
  private store: PersistenceStore | null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(options: { dataDir: string; store: PersistenceStore | null }) {
    this.dataDir = options.dataDir;
    this.store = options.store;
    this.queue = new JobQueue({
      onChanged: (jobs) => {
        this.schedulePersist(jobs);
        this.broadcast(jobs);
      },
    });
    this.queue.registerHandler({ kind: 'pdf_extract', run: (ctx) => this.runPdfExtract(ctx.job.payload as QueuedPaperPayload, ctx.reportProgress, ctx.isCancelled) });
    this.queue.registerHandler({ kind: 'pdf_extract_backlog', run: (ctx) => this.runBacklog(ctx) });
    this.restoreFromDisk();
  }

  /** PersistenceStore 在 App 启动流程中延迟创建，就绪后注入。 */
  attachStore(store: PersistenceStore): void {
    this.store = store;
  }

  // ─── 持久化 ────────────────────────────────────────────────

  private queueFilePath(): string {
    return path.join(this.dataDir, QUEUE_FILE);
  }

  private schedulePersist(jobs: readonly JobRecord[]): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        const trimmed = [...jobs];
        // 完成作业只保留最近 MAX_COMPLETED_JOBS 条，未完成的全保留。
        const completed = trimmed.filter((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled');
        const active = trimmed.filter((j) => j.status === 'queued' || j.status === 'running');
        const keep = [...active, ...completed.slice(-MAX_COMPLETED_JOBS)];
        fs.writeFileSync(this.queueFilePath(), JSON.stringify({ version: 1, jobs: keep }, null, 1), 'utf8');
      } catch { /* 队列持久化为尽力而为 */ }
    }, 400);
  }

  private restoreFromDisk(): void {
    try {
      const raw = fs.readFileSync(this.queueFilePath(), 'utf8');
      const parsed = JSON.parse(raw) as { jobs?: JobRecord[] };
      if (Array.isArray(parsed.jobs)) {
        this.queue.restore(parsed.jobs.filter((job) => job && typeof job.id === 'string' && typeof job.kind === 'string'));
      }
    } catch { /* 无持久化文件（首次运行）属正常 */ }
  }

  private broadcast(jobs: readonly JobRecord[]): void {
    // 发送到所有渲染器；无窗口时静默（持久化仍然生效）。测试环境下
    // BrowserWindow.getAllWindows 由注入的 electron mock 提供。
    try {
      const summary = this.presentJobs(jobs);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('jobs:changed', summary);
      }
    } catch { /* electron 不可用（测试环境） */ }
  }

  private presentJobs(jobs: readonly JobRecord[]): Array<Pick<JobRecord, 'id' | 'kind' | 'label' | 'status' | 'progress' | 'progressNote' | 'error'> & { finishedAt: number | null }> {
    const visible = jobs.filter((job) => job.status !== 'done' || Date.now() - (job.finishedAt ?? 0) < 30 * 60_000);
    return visible.slice(-40).map((job) => ({
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      progress: job.progress,
      progressNote: job.progressNote,
      error: job.error,
      finishedAt: job.finishedAt,
    }));
  }

  // ─── PDF 全文抽取（T2）────────────────────────────────────

  /** 抽取单篇 PDF 文本（确定性，含质量检查）。供 handler 与测试直接调用。 */
  async extractPdfText(pdfPath: string): Promise<{ text: string; quality: ExtractQuality }> {
    const bytes = fs.readFileSync(pdfPath);
    // 动态加载：pdfjs-dist legacy 构建面向 Node（无 worker DOM 依赖）。
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as {
      getDocument: (options: { data: Uint8Array; isEvalSupported: boolean; useSystemFonts: boolean }) => { promise: Promise<{ numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str?: string }> }> }> }> };
    };
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true }).promise;
    const parts: string[] = [];
    const pages = doc.numPages;
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => (typeof item.str === 'string' ? item.str : ''))
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim();
      parts.push(pageText ? `[p${pageNumber}] ${pageText}` : `[p${pageNumber}]`);
    }
    const text = parts.join('\n').slice(0, 400_000);
    const characters = text.replace(/\[p\d+\]/gu, '').replace(/\s/gu, '').length;
    return {
      text,
      quality: {
        pages,
        characters,
        suspicious: pages > 0 && characters / pages < 120,
      },
    };
  }

  private async runPdfExtract(
    payload: QueuedPaperPayload,
    reportProgress: (p: number, note?: string) => void,
    isCancelled: () => boolean,
  ): Promise<{ paperId: string; characters: number; suspicious: boolean }> {
    if (!this.store) throw new Error('persistence_unavailable');
    if (!fs.existsSync(payload.pdfPath)) throw new Error(`pdf_not_found:${payload.pdfPath}`);
    reportProgress(20, '读取 PDF');
    if (isCancelled()) throw new JobCancelledError();
    const { text, quality } = await this.extractPdfText(payload.pdfPath);
    if (isCancelled()) throw new JobCancelledError();
    reportProgress(75, '写回文献全文');
    const paper = this.store.getPapers().find((row) => row.id === payload.paperId);
    if (!paper) throw new Error(`paper_not_found:${payload.paperId}`);
    this.store.savePaper({ ...paper, pdfText: text });
    try {
      this.store.reindexPapersFts();
    } catch { /* FTS 不可用时 LIKE 仍可用 */ }
    return { paperId: payload.paperId, characters: quality.characters, suspicious: quality.suspicious };
  }

  private async runBacklog(ctx: JobRunContext): Promise<{ extracted: number; failed: number }> {
    if (!this.store) throw new Error('persistence_unavailable');
    const targets = this.store.getPapers().filter((row) => row.pdfPath && !row.pdfText);
    const checkpoint = (ctx.job.checkpoint ?? {}) as { doneIds?: string[] };
    const skip = new Set(checkpoint.doneIds ?? []);
    let doneIds = [...skip];
    let extracted = 0;
    let failed = 0;
    for (let index = 0; index < targets.length; index += 1) {
      if (ctx.isCancelled()) throw new JobCancelledError();
      const row = targets[index]!;
      if (skip.has(row.id)) continue;
      ctx.reportProgress(Math.round((index / Math.max(1, targets.length)) * 100), row.title.slice(0, 24));
      try {
        await this.runPdfExtract({ paperId: row.id, pdfPath: row.pdfPath! }, () => {}, ctx.isCancelled);
        extracted += 1;
      } catch (error) {
        if (error instanceof JobCancelledError) throw error;
        failed += 1;
      }
      doneIds = [...doneIds, row.id];
      ctx.saveCheckpoint({ doneIds: doneIds });
    }
    return { extracted, failed };
  }

  /** 下载落盘后调用：为单篇文献入队全文抽取。 */
  enqueueExtract(paperId: string, pdfPath: string): JobRecord | null {
    const paper = this.store?.getPapers().find((row) => row.id === paperId);
    return this.queue.enqueue('pdf_extract', `全文抽取：${paper?.title.slice(0, 30) ?? paperId}`, { paperId, pdfPath });
  }

  /** 批量回填：所有"有 PDF 无全文"的文献。返回入队的作业。 */
  enqueueBacklog(): JobRecord | null {
    const count = this.store?.getPapers().filter((row) => row.pdfPath && !row.pdfText).length ?? 0;
    if (count === 0) return null;
    return this.queue.enqueue('pdf_extract_backlog', `批量抽取全文（${count} 篇）`, {});
  }

  // ─── IPC ───────────────────────────────────────────────────

  registerIpc(): void {
    ipcMain.handle('jobs:list', () => this.presentJobs(this.queue.list()));
    ipcMain.handle('jobs:cancel', (_event, rawId: unknown) => {
      if (typeof rawId === 'string') this.queue.cancel(rawId);
      return { ok: true };
    });
    ipcMain.handle('jobs:retry', (_event, rawId: unknown) => {
      if (typeof rawId === 'string') this.queue.retry(rawId);
      return { ok: true };
    });
    ipcMain.handle('jobs:extractBacklog', () => {
      const job = this.enqueueBacklog();
      return job ? { ok: true, jobId: job.id } : { ok: true, jobId: null };
    });
  }
}
