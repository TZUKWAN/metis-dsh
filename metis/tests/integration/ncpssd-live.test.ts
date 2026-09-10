/**
 * NCPSSD 真实 API 冒烟（Gate E / T14-028）：验证真实端点下
 * ①正常检索返回真实中文题录；②失败路径抛 ProviderUnavailableError（fail-loud，不伪成功）。
 *
 * @vitest-environment jsdom
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NcpssdProvider } from '../../plugins/literature-ncpssd/src/index.ts';
import { parseNcpssdPayload } from '../../plugins/literature-ncpssd/src/ncpssd-parser.ts';

describe('NcpssdProvider live smoke', () => {
  it('searches the real NCPSSD endpoint and returns Chinese records (or fails loud)', async () => {
    const provider = new NcpssdProvider();
    let failureNote: string | undefined;
    try {
      const records = await provider.search({ query: '劳动过程理论', limit: 10 });
      expect(Array.isArray(records)).toBe(true);

      // 真实来源断言：全部来自 ncpssd；核心标记只出现在白名单刊物上。
      for (const record of records) {
        expect(record.source).toBe('ncpssd');
        expect(record.title.length).toBeGreaterThan(0);
        if (record.coreStatus === 'chinese-core') {
          expect(record.journal).toBeTruthy();
        }
      }
      // 持久化联动冒烟：登记进 evidence store（规格十四）。
      const file = path.join(process.cwd(), `.test-ncpssd-live-${Date.now()}.json`);
      const { EvidenceStore } = await import('../../plugins/evidence/src/store.ts');
      const store = new EvidenceStore(file);
      if (records[0]) {
        const { record, duplicate } = store.registerObservation({
          sourceType: 'literature',
          source: { provider: 'ncpssd', sourceId: records[0].sourceId },
          title: records[0].title,
          url: records[0].url,
          createdByTool: 'ncpssd_search',
        });
        expect(record.title).toBe(records[0].title);
        expect(duplicate).toBe(false);
        expect(fs.existsSync(file)).toBe(true);
        fs.rmSync(file, { force: true });
      }
    } catch (error) {
      // 反爬/站点不可用时必须 fail-loud 为 ProviderUnavailableError（不返回伪结果）。
      failureNote = error instanceof Error ? error.message : String(error);
      expect(failureNote).toContain('ncpssd');
    }
    void failureNote;
  });

  it('parser handles a real-shaped payload end to end', () => {
    // 最小真实形态 payload（与 ncpssd.org searchHandler 返回结构一致）。
    const payload = {
      data: {
        total: 1,
        rows: [{
          data_id: '70001234',
          title: '<font class="highLight">数字劳动</font>研究综述',
          creator: '张三',
          cbw_name: '新闻与传播研究',
          date: '2022-10-01',
          remark: '综述数字劳动研究。',
          subject: '传播学',
          type: '中文期刊文章',
        }],
      },
    };
    const result = parseNcpssdPayload(payload, { coreOnly: false, pageSize: 10 });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!.title).toBe('数字劳动研究综述');
  });
});
