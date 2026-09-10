/**
 * LiteratureSearchService — 真实网络集成验证（live）。
 *
 * 默认跳过；设置 METIS_LIVE_LITERATURE=1 后运行：
 *   METIS_LIVE_LITERATURE=1 node node_modules/vitest/vitest.mjs run tests/electron/LiteratureSearchService.live.test.ts
 *
 * 验证 NCPSSD 与 OpenAlex 的真实接口连通性、参数映射与核心过滤结果。
 */

import { describe, expect, it } from 'vitest';
import { LiteratureSearchService } from '../../electron/LiteratureSearchService.js';

const live = process.env.METIS_LIVE_LITERATURE === '1';

describe.skipIf(!live)('LiteratureSearchService — 真实网络', () => {
  it('NCPSSD 返回真实中文核心期刊文献', async () => {
    const service = new LiteratureSearchService();
    const response = await service.search({ query: '乡村振兴', sources: ['ncpssd'], pageSize: 10, coreOnly: true });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    console.log('[live ncpssd] total =', response.total, 'rows =', response.results.length, 'warnings =', response.warnings);
    for (const item of response.results.slice(0, 3)) {
      console.log('[live ncpssd]', item.year, item.venue, '—', item.title, '| core =', item.core);
    }
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results.every((item) => item.core)).toBe(true);
    expect(response.results.every((item) => item.title.length > 0)).toBe(true);
  }, 60_000);

  it('OpenAlex 返回真实 SCI/SSCI 英文文献', async () => {
    const service = new LiteratureSearchService();
    const response = await service.search({ query: 'social inequality', sources: ['openalex'], pageSize: 10, coreOnly: true });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    console.log('[live openalex] total =', response.total, 'rows =', response.results.length, 'warnings =', response.warnings);
    for (const item of response.results.slice(0, 3)) {
      console.log('[live openalex]', item.year, item.venue, '—', item.title, '| core =', item.core);
    }
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results.every((item) => item.core)).toBe(true);
  }, 60_000);
});
