/**
 * LiteratureWatchService — 文献订阅与新文监控（T25）。
 *
 * 用户订阅关键词 → 定期（默认每 6 小时）用同一检索适配器查新 →
 * 与上次结果对比 → 新文献入库为"待审"（未关联项目、tag=subscribed:new）
 * 并记录增量计数。全部走既有 LiteratureSearchService（NCPSSD/OpenAlex），
 * 只做题录检索，不自动下载（红线）。存储：dataDir/literature-watch.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { LiteratureSearchService } from './LiteratureSearchService.js';
import type { PersistenceStore } from '../engine/persistence/PersistenceStore.js';

export interface WatchSubscription {
  id: string;
  query: string;
  sources: Array<'ncpssd' | 'openalex'>;
  coreOnly: boolean;
  createdAt: number;
  lastCheckedAt: number | null;
  lastNewCount: number;
  /** 上次命中的结果 id 集合（增量对比用）。 */
  seenIds: string[];
}

interface WatchStore {
  version: 1;
  subscriptions: WatchSubscription[];
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_SEEN = 500;

export class LiteratureWatchService {
  private readonly filePath: string;
  private store: WatchStore;
  private readonly searchService = new LiteratureSearchService();
  private storeRef: PersistenceStore | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'literature-watch.json');
    this.store = this.load();
  }

  attachStore(store: PersistenceStore): void {
    this.storeRef = store;
  }

  private load(): WatchStore {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as WatchStore;
      if (parsed && Array.isArray(parsed.subscriptions)) return { version: 1, subscriptions: parsed.subscriptions };
    } catch { /* 首次运行 */ }
    return { version: 1, subscriptions: [] };
  }

  private persist(): void {
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.store, null, 1), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch { /* 尽力而为 */ }
  }

  list(): WatchSubscription[] {
    return [...this.store.subscriptions].sort((a, b) => b.createdAt - a.createdAt);
  }

  addSubscription(query: string, sources: Array<'ncpssd' | 'openalex'> = ['ncpssd', 'openalex'], coreOnly = true): WatchSubscription | null {
    const trimmed = query.trim().slice(0, 120);
    if (!trimmed || this.store.subscriptions.some((sub) => sub.query === trimmed)) return null;
    const subscription: WatchSubscription = {
      id: `watch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      query: trimmed,
      sources: sources.length > 0 ? sources : ['ncpssd', 'openalex'],
      coreOnly,
      createdAt: Date.now(),
      lastCheckedAt: null,
      lastNewCount: 0,
      seenIds: [],
    };
    this.store.subscriptions.push(subscription);
    this.persist();
    return subscription;
  }

  removeSubscription(id: string): boolean {
    const before = this.store.subscriptions.length;
    this.store.subscriptions = this.store.subscriptions.filter((sub) => sub.id !== id);
    const removed = this.store.subscriptions.length < before;
    if (removed) this.persist();
    return removed;
  }

  /** 检查单个订阅：检索 → 增量对比 → 新文献入库为待审。 */
  async checkNow(id: string): Promise<{ ok: boolean; newCount: number; error?: string }> {
    const subscription = this.store.subscriptions.find((sub) => sub.id === id);
    if (!subscription) return { ok: false, newCount: 0, error: 'not_found' };
    const response = await this.searchService.search({
      query: subscription.query,
      sources: subscription.sources,
      page: 1,
      pageSize: 15,
      coreOnly: subscription.coreOnly,
    });
    if (!response.ok) return { ok: false, newCount: 0, error: response.recovery ?? 'search_failed' };
    const seen = new Set(subscription.seenIds);
    const fresh = response.results.filter((item) => !seen.has(item.id));
    const isFirstCheck = subscription.lastCheckedAt === null;
    // 首次检查只记录基线，不入库（避免把历史全量灌进待审）。
    if (!isFirstCheck && this.storeRef && fresh.length > 0) {
      for (const item of fresh) {
        const paperId = `paper-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        this.storeRef.savePaper({
          id: paperId,
          title: item.title,
          authors: item.authors,
          year: item.year,
          venue: item.venue,
          abstract: item.abstract,
          doi: item.doi ?? '',
          arxivId: '',
          pdfUrl: item.pdfUrl ?? item.url ?? '',
          tags: ['subscribed:new'],
          notes: `来自订阅「${subscription.query}」`,
          readStatus: 'unread',
          rating: 0,
          addedAt: Date.now(),
        });
      }
    }
    subscription.seenIds = [...new Set([...response.results.map((item) => item.id), ...subscription.seenIds])].slice(0, MAX_SEEN);
    subscription.lastCheckedAt = Date.now();
    subscription.lastNewCount = isFirstCheck ? 0 : fresh.length;
    this.persist();
    return { ok: true, newCount: subscription.lastNewCount };
  }

  /** 定时巡检：只查到期（超过 CHECK_INTERVAL_MS）的订阅。 */
  async tick(): Promise<void> {
    const now = Date.now();
    for (const subscription of this.store.subscriptions) {
      if (subscription.lastCheckedAt !== null && now - subscription.lastCheckedAt < CHECK_INTERVAL_MS) continue;
      try {
        await this.checkNow(subscription.id);
      } catch { /* 单个订阅失败不影响其他 */ }
    }
  }

  start(): void {
    if (this.timer) return;
    // 启动后 90 秒做首轮巡检（避开启动高峰），此后每小时空转检查到期。
    setTimeout(() => { void this.tick(); }, 90_000);
    this.timer = setInterval(() => { void this.tick(); }, 60 * 60 * 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  registerIpc(): void {
    ipcMain.handle('watch:list', () => this.list());
    ipcMain.handle('watch:add', (_event, raw: unknown) => {
      const input = raw as { query?: unknown; sources?: unknown; coreOnly?: unknown };
      if (typeof input?.query !== 'string') return null;
      const sources = Array.isArray(input.sources)
        ? (input.sources as unknown[]).filter((s): s is 'ncpssd' | 'openalex' => s === 'ncpssd' || s === 'openalex')
        : ['ncpssd' as const, 'openalex' as const];
      return this.addSubscription(input.query, sources, input.coreOnly !== false);
    });
    ipcMain.handle('watch:remove', (_event, rawId: unknown) => (typeof rawId === 'string' ? this.removeSubscription(rawId) : false));
    ipcMain.handle('watch:checkNow', (_event, rawId: unknown) => (typeof rawId === 'string' ? this.checkNow(rawId) : Promise.resolve({ ok: false, newCount: 0, error: 'invalid_id' })));
  }
}
