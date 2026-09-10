/**
 * SubmissionTrackerService — 投稿管理（T20）。
 *
 * 投稿状态跟踪（投出/外审/退修/录用/发表/拒稿）+ 退修意见逐条管理：
 * 每条意见可标记"已修改"并附修改说明，全部处理完自动汇总"修改说明信"
 * （投稿退修回信的半成品）。存储：dataDir/submissions.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';

export type SubmissionStatus = 'submitted' | 'under_review' | 'revise' | 'accepted' | 'published' | 'rejected';

export interface ReviewerComment {
  id: string;
  text: string;
  resolved: boolean;
  revisionNote: string;
  createdAt: number;
}

export interface SubmissionRecord {
  id: string;
  projectId: string | null;
  artifactId: string | null;
  title: string;
  journal: string;
  status: SubmissionStatus;
  submittedAt: number;
  updatedAt: number;
  comments: ReviewerComment[];
  notes: string;
}

interface SubmissionStore {
  version: 1;
  submissions: SubmissionRecord[];
}

export const SUBMISSION_STATUS_ORDER: SubmissionStatus[] = [
  'submitted', 'under_review', 'revise', 'accepted', 'published', 'rejected',
];

export class SubmissionTrackerService {
  private readonly filePath: string;
  private store: SubmissionStore;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'submissions.json');
    this.store = this.load();
  }

  private load(): SubmissionStore {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as SubmissionStore;
      if (parsed && Array.isArray(parsed.submissions)) return { version: 1, submissions: parsed.submissions };
    } catch { /* 首次运行 */ }
    return { version: 1, submissions: [] };
  }

  private persist(): void {
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.store, null, 1), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch { /* 尽力而为 */ }
  }

  list(projectId?: string): SubmissionRecord[] {
    const records = projectId
      ? this.store.submissions.filter((record) => record.projectId === projectId)
      : this.store.submissions;
    return [...records].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  create(input: {
    title: string;
    journal: string;
    projectId?: string | null;
    artifactId?: string | null;
    status?: SubmissionStatus;
    notes?: string;
  }): SubmissionRecord | null {
    const title = input.title.trim().slice(0, 300);
    const journal = input.journal.trim().slice(0, 200);
    if (!title || !journal) return null;
    const now = Date.now();
    const record: SubmissionRecord = {
      id: `sub-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      projectId: input.projectId ?? null,
      artifactId: input.artifactId ?? null,
      title,
      journal,
      status: input.status && SUBMISSION_STATUS_ORDER.includes(input.status) ? input.status : 'submitted',
      submittedAt: now,
      updatedAt: now,
      comments: [],
      notes: (input.notes ?? '').slice(0, 2000),
    };
    this.store.submissions.push(record);
    this.persist();
    return record;
  }

  updateStatus(id: string, status: SubmissionStatus): SubmissionRecord | null {
    const record = this.store.submissions.find((item) => item.id === id);
    if (!record || !SUBMISSION_STATUS_ORDER.includes(status)) return null;
    record.status = status;
    record.updatedAt = Date.now();
    this.persist();
    return record;
  }

  addComment(id: string, text: string): SubmissionRecord | null {
    const record = this.store.submissions.find((item) => item.id === id);
    if (!record || !text.trim()) return null;
    record.comments.push({
      id: `cmt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      text: text.trim().slice(0, 2000),
      resolved: false,
      revisionNote: '',
      createdAt: Date.now(),
    });
    record.updatedAt = Date.now();
    this.persist();
    return record;
  }

  resolveComment(id: string, commentId: string, resolved: boolean, revisionNote?: string): SubmissionRecord | null {
    const record = this.store.submissions.find((item) => item.id === id);
    if (!record) return null;
    const comment = record.comments.find((item) => item.id === commentId);
    if (!comment) return null;
    comment.resolved = resolved;
    if (typeof revisionNote === 'string') comment.revisionNote = revisionNote.slice(0, 2000);
    record.updatedAt = Date.now();
    this.persist();
    return record;
  }

  delete(id: string): boolean {
    const before = this.store.submissions.length;
    this.store.submissions = this.store.submissions.filter((item) => item.id !== id);
    const removed = this.store.submissions.length < before;
    if (removed) this.persist();
    return removed;
  }

  /** 修改说明信（退修回信半成品）：逐条"意见 → 修改说明"。 */
  buildResponseLetter(id: string): string | null {
    const record = this.store.submissions.find((item) => item.id === id);
    if (!record) return null;
    const lines: string[] = [
      `《${record.title}》修改说明`,
      `目标期刊：${record.journal}`,
      `意见共 ${record.comments.length} 条，已处理 ${record.comments.filter((c) => c.resolved).length} 条。`,
      '',
    ];
    record.comments.forEach((comment, index) => {
      lines.push(`意见 ${index + 1}：${comment.text}`);
      lines.push(`处理：${comment.resolved ? '已按意见修改。' : '（尚未处理）'}`);
      if (comment.revisionNote) lines.push(`修改说明：${comment.revisionNote}`);
      lines.push('');
    });
    lines.push('以上修改说明基于投稿跟踪记录生成，请核对后随修改稿一并提交。');
    return lines.join('\n');
  }

  registerIpc(): void {
    ipcMain.handle('submissions:list', (_event, rawProjectId: unknown) =>
      this.list(typeof rawProjectId === 'string' && rawProjectId ? rawProjectId : undefined));
    ipcMain.handle('submissions:create', (_event, raw: unknown) => {
      const input = raw as { title?: unknown; journal?: unknown; projectId?: unknown; artifactId?: unknown; status?: unknown; notes?: unknown };
      if (typeof input?.title !== 'string' || typeof input?.journal !== 'string') return null;
      return this.create({
        title: input.title,
        journal: input.journal,
        projectId: typeof input.projectId === 'string' ? input.projectId : null,
        artifactId: typeof input.artifactId === 'string' ? input.artifactId : null,
        status: typeof input.status === 'string' ? input.status as SubmissionStatus : undefined,
        notes: typeof input.notes === 'string' ? input.notes : undefined,
      });
    });
    ipcMain.handle('submissions:updateStatus', (_event, raw: unknown) => {
      const input = raw as { id?: unknown; status?: unknown };
      if (typeof input?.id !== 'string' || typeof input?.status !== 'string') return null;
      return this.updateStatus(input.id, input.status as SubmissionStatus);
    });
    ipcMain.handle('submissions:addComment', (_event, raw: unknown) => {
      const input = raw as { id?: unknown; text?: unknown };
      if (typeof input?.id !== 'string' || typeof input?.text !== 'string') return null;
      return this.addComment(input.id, input.text);
    });
    ipcMain.handle('submissions:resolveComment', (_event, raw: unknown) => {
      const input = raw as { id?: unknown; commentId?: unknown; resolved?: unknown; revisionNote?: unknown };
      if (typeof input?.id !== 'string' || typeof input?.commentId !== 'string' || typeof input?.resolved !== 'boolean') return null;
      return this.resolveComment(input.id, input.commentId, input.resolved, typeof input.revisionNote === 'string' ? input.revisionNote : undefined);
    });
    ipcMain.handle('submissions:delete', (_event, rawId: unknown) => (typeof rawId === 'string' ? this.delete(rawId) : false));
    ipcMain.handle('submissions:responseLetter', (_event, rawId: unknown) => (typeof rawId === 'string' ? this.buildResponseLetter(rawId) : null));
  }
}
