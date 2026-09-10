/**
 * LiteratureWatchService — 文献订阅查新（T25）。
 *
 * 网络检索用 vi.stubGlobal 模拟 LiteratureSearchService 依赖的 fetch。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiteratureWatchService } from '../../electron/LiteratureWatchService.js';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';

let tmpDir: string;
let store: PersistenceStore;
let service: LiteratureWatchService;
const fetchMock = vi.fn();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-watch-'));
  store = new PersistenceStore(path.join(tmpDir, 'test.db'));
  service = new LiteratureWatchService(tmpDir);
  service.attachStore(store);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function searchPayload(titles: string[]) {
  return {
    result: true,
    code: 200,
    data: {
      total: titles.length,
      rows: titles.map((title, index) => ({
        data_id: `id-${title}-${index}`,
        title,
        creator: '作者',
        cbw_name: '社会学研究',
        date: '2026-01-01',
        remark: '摘要',
        subject: '',
        type: '中文期刊文章',
      })),
    },
  };
}

describe('LiteratureWatchService', () => {
  it('添加订阅（去重）与删除', () => {
    expect(service.addSubscription('乡村治理')).not.toBeNull();
    expect(service.addSubscription('乡村治理')).toBeNull(); // 重复
    expect(service.addSubscription('  ')).toBeNull(); // 空
    const list = service.list();
    expect(list).toHaveLength(1);
    expect(service.removeSubscription(list[0]!.id)).toBe(true);
    expect(service.list()).toHaveLength(0);
  });

  it('首次查新只建基线不入库；第二次出现新文献入库待审', async () => {
    const subscription = service.addSubscription('数字治理')!;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => searchPayload(['文章A', '文章B']),
    });
    const first = await service.checkNow(subscription.id);
    expect(first.ok).toBe(true);
    expect(first.newCount).toBe(0); // 首次基线
    expect(store.getPapers().filter((p) => p.tags.includes('subscribed:new'))).toHaveLength(0);

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => searchPayload(['文章A', '文章B', '文章C']),
    });
    const second = await service.checkNow(subscription.id);
    expect(second.ok).toBe(true);
    expect(second.newCount).toBe(1);
    const pending = store.getPapers().filter((p) => p.tags.includes('subscribed:new'));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.title).toBe('文章C');
  });

  it('检索失败返回错误且不影响订阅', async () => {
    const subscription = service.addSubscription('失败测试')!;
    fetchMock.mockRejectedValue(new Error('network_down'));
    const result = await service.checkNow(subscription.id);
    expect(result.ok).toBe(false);
    expect(service.list()).toHaveLength(1);
  });

  it('订阅与基线持久化（重启恢复）', async () => {
    const subscription = service.addSubscription('持久化')!;
    fetchMock.mockResolvedValue({ ok: true, json: async () => searchPayload(['X', 'Y']) });
    await service.checkNow(subscription.id);
    const reloaded = new LiteratureWatchService(tmpDir);
    const list = reloaded.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.seenIds.length).toBe(2);
    expect(list[0]!.lastCheckedAt).not.toBeNull();
  });
});
