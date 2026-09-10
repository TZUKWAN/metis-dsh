/**
 * PaperRecordCleaner — 题录确定性清洗（LIT-CLEAN-01，T15）。
 */

import { describe, expect, it } from 'vitest';
import { cleanPaperRecord, cleanPaperRecords } from '../../engine/research/PaperRecordCleaner.js';

describe('PaperRecordCleaner', () => {
  it('剥离标题中的来源站后缀', () => {
    const result = cleanPaperRecord({
      title: '系统理解外国语成为马克思人生斗争武器的四维论析 - 中国知网',
      abstract: '本文从系统论视角……',
    });
    expect(result.title).toBe('系统理解外国语成为马克思人生斗争武器的四维论析');
    expect(result.changes).toContain('title_source_suffix');
    expect(result.abstract).toBe('本文从系统论视角……');
  });

  it('识别误抓的网页导航摘要并清空', () => {
    const result = cleanPaperRecord({
      title: '正常标题',
      abstract: '总库 检索 CNKI AI 出版来源 我的CNKI 充值 会员 文献知网节 如何从系统论视角分析……',
    });
    expect(result.abstract).toBe('');
    expect(result.changes).toContain('abstract_navigator_text');
  });

  it('正常学术摘要不受影响', () => {
    const abstract = '本文利用 2010—2020 年省级面板数据，考察了财政转移支付对基本公共服务均等化的影响。';
    const result = cleanPaperRecord({ title: '财政转移支付与公共服务均等化', abstract });
    expect(result.abstract).toBe(abstract);
    expect(result.changes).toHaveLength(0);
  });

  it('批量清洗只返回发生变化的条目并保留 id', () => {
    const papers = [
      { id: 'a', title: '干净标题', abstract: '正常摘要。' },
      { id: 'b', title: '带后缀标题 - 中国知网', abstract: '正常摘要。' },
      { id: 'c', title: '另一篇', abstract: '首页 登录 注册 下载APP 客户端 总库 检索' },
    ];
    const results = cleanPaperRecords(papers);
    expect(results.map((r) => r.id).sort()).toEqual(['b', 'c']);
    expect(results.find((r) => r.id === 'b')!.cleaned.title).toBe('带后缀标题');
  });

  it('空摘要与短标题不被破坏性修改', () => {
    const result = cleanPaperRecord({ title: '知网', abstract: '' });
    // 标题剥后缀会导致空标题 → 规则应拒绝该次剥离。
    expect(result.title).toBe('知网');
  });
});
