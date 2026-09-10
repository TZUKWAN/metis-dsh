import { describe, expect, it } from 'vitest';
import {
  buildVenueMatchQuery,
  extractVenueMatchKeywords,
  filterRelevantPapers,
  outcomeContentToMatchText,
} from '../../electron/SubmissionVenueMatching.js';

describe('SubmissionVenueMatching（2026-09-01 刘总报告：匹配结果与论文无关）', () => {
  const laborText = [
    '本文综合劳动社会学相关理论与平台劳动研究，认为平台化并未使劳动社会学的核心问题失效。',
    '资本—劳动关系、劳动过程控制、劳动力市场分层、劳动风险分配、性别化分工和集体行动，仍然是理解平台劳动的基本维度。',
    '现有研究较为一致地提示，平台不是单纯的技术中介。平台可能参与任务组织、收入形成、绩效评价和劳动者资格管理。',
    '算法管理作为劳动过程控制的新形态，正在重塑平台劳动的自主性与控制之间的张力。',
    'Keywords: platform labor, labor process, algorithm management, labor sociology.',
  ].join('\n');

  it('extracts topical keywords from the paper body, filtering generic and meta words', () => {
    const keywords = extractVenueMatchKeywords(laborText, '劳动社会学文献综述论文写作工作流 交付物');
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords.some((keyword) => keyword.includes('劳动'))).toBe(true);
    expect(keywords.some((keyword) => keyword.includes('平台'))).toBe(true);
    // 元信息与泛词不进关键词
    expect(keywords.join(' ')).not.toContain('交付物');
    expect(keywords.join(' ')).not.toContain('工作流');
  });

  it('builds a bounded query and falls back to the cleaned title without body text', () => {
    const fromBody = buildVenueMatchQuery(laborText, '劳动社会学文献综述论文写作工作流 交付物');
    expect(fromBody.query.length).toBeLessThanOrEqual(200);
    expect(fromBody.query).not.toContain('交付物');
    const fromTitle = buildVenueMatchQuery('', '数字疗法经济学价值实证论文 交付物');
    expect(fromTitle.query).toContain('数字疗法');
    expect(fromTitle.query).not.toContain('交付物');
  });

  it('drops papers with zero topical overlap before venue aggregation', () => {
    const keywords = extractVenueMatchKeywords(laborText, '');
    const papers = [
      { title: 'Platform labor and algorithmic management in the gig economy', year: 2024, venue: 'New Media & Society' },
      { title: '论自动化与机械制造自动化', year: 2024, venue: '机械工程学报' },
      { title: 'Marketing Strategy for Cultural Tourism IP', year: 2025, venue: 'E-Commerce Letters' },
      { title: '平台劳动者的资格管理与收入分层', year: 2023, venue: '社会学研究' },
    ];
    const relevant = filterRelevantPapers(papers, keywords);
    const titles = relevant.map((paper) => paper.title);
    expect(titles).toContain('Platform labor and algorithmic management in the gig economy');
    expect(titles).toContain('平台劳动者的资格管理与收入分层');
    expect(titles).not.toContain('Marketing Strategy for Cultural Tourism IP');
    // 机电类论文（无劳动/平台词）被相关性门槛剔除
    expect(titles).not.toContain('论自动化与机械制造自动化');
  });

  it('reads word blocks as match text and ignores other media', () => {
    expect(outcomeContentToMatchText({ type: 'word', blocks: [{ text: '平台劳动' }, { text: '劳动社会学' }] }))
      .toContain('平台劳动');
    expect(outcomeContentToMatchText({ type: 'pdf' })).toBe('');
  });
});
