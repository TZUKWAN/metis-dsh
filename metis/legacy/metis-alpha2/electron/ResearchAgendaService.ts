/**
 * ResearchAgendaService — 研究议程队列（T24，含安全设计）。
 *
 * 自主科研"做完一个自动接续下一个"，但设三重护栏：
 *   1. 队列总量上限（默认 8 个项目）；
 *   2. 每项目本轮运行上限（默认 2 次）—— 达到即移出并要求人工重新入队；
 *   3. 接续冷却（默认 60 秒）+ 完成即 toast 通知 —— 每次接续都可见、可停。
 * 存储与决策在主进程（持久化），执行推进由自主科研页驱动（页面在跑才接续，
 * 关闭页面即暂停 —— 无人值守的暗跑被结构性排除）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';

export interface AgendaEntry {
  projectId: string;
  title: string;
  runsCompleted: number;
  maxRuns: number;
  enqueuedAt: number;
  /** 自主新项目：无既有 projectId，执行时创建新项目。 */
  autonomous?: boolean;
  /** 自主条目的选题指令（含约束/画像上下文的完整 goal）。 */
  goalPrompt?: string;
}

export interface AgendaState {
  queue: AgendaEntry[];
  autoContinue: boolean;
  cooldownMs: number;
  /** 上一次接续决策时间（冷却判断用）。 */
  lastAdvanceAt: number | null;
}

export interface AdvanceDecision {
  action: 'run_next' | 'cooldown' | 'queue_empty' | 'project_capped' | 'paused';
  projectId: string | null;
  waitMs?: number;
  note: string;
  /** 自主新项目条目：执行端需先创建项目再运行。 */
  autonomous?: boolean;
  goalPrompt?: string;
  title?: string;
}

const QUEUE_LIMIT = 8;
const DEFAULT_MAX_RUNS = 2;
const DEFAULT_COOLDOWN_MS = 60_000;

export class ResearchAgendaService {
  private readonly filePath: string;
  private state: AgendaState;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'research-agenda.json');
    this.state = this.load();
  }

  private load(): AgendaState {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as AgendaState;
      if (parsed && Array.isArray(parsed.queue)) {
        return {
          queue: parsed.queue.filter((entry) => entry && typeof entry.projectId === 'string'),
          autoContinue: parsed.autoContinue !== false,
          cooldownMs: Math.min(600_000, Math.max(15_000, Number(parsed.cooldownMs) || DEFAULT_COOLDOWN_MS)),
          lastAdvanceAt: typeof parsed.lastAdvanceAt === 'number' ? parsed.lastAdvanceAt : null,
        };
      }
    } catch { /* 首次运行 */ }
    return { queue: [], autoContinue: true, cooldownMs: DEFAULT_COOLDOWN_MS, lastAdvanceAt: null };
  }

  private persist(): void {
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch { /* 尽力而为 */ }
  }

  getState(): AgendaState {
    return { ...this.state, queue: [...this.state.queue] };
  }

  enqueue(projectId: string, title: string, maxRuns = DEFAULT_MAX_RUNS, options?: { autonomous?: boolean; goalPrompt?: string }): AgendaEntry | { error: string } {
    if (this.state.queue.some((entry) => entry.projectId === projectId)) return { error: 'already_queued' };
    if (this.state.queue.length >= QUEUE_LIMIT) return { error: 'queue_full' };
    const capped = Math.min(5, Math.max(1, Math.trunc(maxRuns) || DEFAULT_MAX_RUNS));
    const entry: AgendaEntry = {
      projectId,
      title: title.slice(0, 200),
      runsCompleted: 0,
      maxRuns: capped,
      enqueuedAt: Date.now(),
      ...(options?.autonomous ? { autonomous: true } : {}),
      ...(options?.goalPrompt ? { goalPrompt: options.goalPrompt.slice(0, 12_000) } : {}),
    };
    this.state.queue.push(entry);
    this.persist();
    return entry;
  }

  /** 批量入队自主新项目（选题互不相同，去重防溢出）。返回成功条数。 */
  enqueueAutonomousBatch(entries: Array<{ key: string; title: string; goalPrompt: string }>, maxRuns = 1): number {
    let added = 0;
    for (const item of entries) {
      if (this.state.queue.length >= QUEUE_LIMIT) break;
      if (this.state.queue.some((entry) => entry.projectId === item.key)) continue;
      this.state.queue.push({
        projectId: item.key,
        title: item.title.slice(0, 200),
        runsCompleted: 0,
        maxRuns: Math.min(5, Math.max(1, Math.trunc(maxRuns) || 1)),
        enqueuedAt: Date.now(),
        autonomous: true,
        goalPrompt: item.goalPrompt.slice(0, 12_000),
      });
      added += 1;
    }
    if (added > 0) this.persist();
    return added;
  }

  remove(projectId: string): boolean {
    const before = this.state.queue.length;
    this.state.queue = this.state.queue.filter((entry) => entry.projectId !== projectId);
    const removed = this.state.queue.length < before;
    if (removed) this.persist();
    return removed;
  }

  move(projectId: string, direction: 'up' | 'down'): boolean {
    const index = this.state.queue.findIndex((entry) => entry.projectId === projectId);
    if (index < 0) return false;
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= this.state.queue.length) return false;
    const [entry] = this.state.queue.splice(index, 1);
    this.state.queue.splice(target, 0, entry!);
    this.persist();
    return true;
  }

  setAutoContinue(enabled: boolean): void {
    this.state.autoContinue = enabled !== false;
    this.persist();
  }

  /** 自主科研 run 结束后上报：计数、触顶移出、返回下一步决策。 */
  reportCompletion(projectId: string, success: boolean): AdvanceDecision {
    const entry = this.state.queue.find((item) => item.projectId === projectId);
    if (entry) {
      if (success) entry.runsCompleted += 1;
      if (entry.runsCompleted >= entry.maxRuns) {
        this.state.queue = this.state.queue.filter((item) => item.projectId !== projectId);
        this.persist();
        return { action: 'project_capped', projectId: null, note: `项目「${entry.title}」已达到本轮 ${entry.maxRuns} 次运行上限，已移出议程。` };
      }
    }
    return this.decideNext();
  }

  /** 接续决策（含冷却与开关检查）。 */
  decideNext(): AdvanceDecision {
    if (!this.state.autoContinue) {
      return { action: 'paused', projectId: null, note: '自动接续已关闭。' };
    }
    if (this.state.queue.length === 0) {
      return { action: 'queue_empty', projectId: null, note: '议程队列为空。' };
    }
    const since = this.state.lastAdvanceAt === null ? Number.POSITIVE_INFINITY : Date.now() - this.state.lastAdvanceAt;
    if (since < this.state.cooldownMs) {
      return { action: 'cooldown', projectId: null, waitMs: this.state.cooldownMs - since, note: `接续冷却中，剩余 ${Math.ceil((this.state.cooldownMs - since) / 1000)} 秒。` };
    }
    this.state.lastAdvanceAt = Date.now();
    this.persist();
    const next = this.state.queue[0]!;
    return {
      action: 'run_next',
      projectId: next.projectId,
      note: `接续队列首个项目「${next.title}」（已运行 ${next.runsCompleted}/${next.maxRuns} 次）。`,
      ...(next.autonomous ? { autonomous: true, goalPrompt: next.goalPrompt, title: next.title } : { title: next.title }),
    };
  }

  registerIpc(): void {
    ipcMain.handle('agenda:getState', () => this.getState());
    ipcMain.handle('agenda:enqueue', (_event, raw: unknown) => {
      const input = raw as { projectId?: unknown; title?: unknown; maxRuns?: unknown; autonomous?: unknown; goalPrompt?: unknown };
      if (typeof input?.projectId !== 'string' || typeof input?.title !== 'string') return { error: 'invalid_request' };
      return this.enqueue(
        input.projectId,
        input.title,
        typeof input.maxRuns === 'number' ? input.maxRuns : undefined,
        {
          autonomous: input.autonomous === true,
          goalPrompt: typeof input.goalPrompt === 'string' ? input.goalPrompt : undefined,
        },
      );
    });
    ipcMain.handle('agenda:enqueueBatch', (_event, raw: unknown) => {
      const input = raw as { entries?: unknown; maxRuns?: unknown };
      const entries = Array.isArray(input?.entries)
        ? (input.entries as unknown[])
            .filter((entry): entry is { key: string; title: string; goalPrompt: string } => {
              const candidate = entry as { key?: unknown; title?: unknown; goalPrompt?: unknown };
              return typeof candidate?.key === 'string' && typeof candidate?.title === 'string' && typeof candidate?.goalPrompt === 'string';
            })
            .slice(0, 5)
        : [];
      if (entries.length === 0) return { added: 0 };
      const added = this.enqueueAutonomousBatch(entries, typeof input?.maxRuns === 'number' ? input.maxRuns : 1);
      return { added };
    });
    ipcMain.handle('agenda:remove', (_event, rawId: unknown) => (typeof rawId === 'string' ? this.remove(rawId) : false));
    ipcMain.handle('agenda:move', (_event, raw: unknown) => {
      const input = raw as { projectId?: unknown; direction?: unknown };
      if (typeof input?.projectId !== 'string' || (input.direction !== 'up' && input.direction !== 'down')) return false;
      return this.move(input.projectId, input.direction);
    });
    ipcMain.handle('agenda:setAutoContinue', (_event, raw: unknown) => {
      this.setAutoContinue(raw !== false);
      return this.getState();
    });
    ipcMain.handle('agenda:reportCompletion', (_event, raw: unknown) => {
      const input = raw as { projectId?: unknown; success?: unknown };
      if (typeof input?.projectId !== 'string') return { action: 'queue_empty', projectId: null, note: 'invalid' } as AdvanceDecision;
      return this.reportCompletion(input.projectId, input.success !== false);
    });
    ipcMain.handle('agenda:decideNext', () => this.decideNext());
  }
}
