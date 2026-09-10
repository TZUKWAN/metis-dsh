/**
 * dsh-metis-submission 单元测试（Phase 21 / T21-001~005、T21-019）。
 * 覆盖：选刊聚合（白名单层级标注）与目录 HTML parser 的纯逻辑。
 */

import { describe, expect, it } from 'vitest';
import {
  decodeHtmlEntities,
  htmlToText,
  parseLetPubFieldOptions,
} from '../src/journal-catalog.ts';
import { aggregateVenueCandidates } from '../src/journal-targeting.ts';

describe('journal catalog parser', () => {
  it('decodes HTML entities and strips tags to plain text', () => {
    expect(decodeHtmlEntities('&amp;')).toBe('&');
    expect(htmlToText('<p>社会学 <b>期刊</b></p>')).toBe('社会学 期刊');
  });

  it('parses subject field options with dedupe by id', () => {
    const html = [
      '<a href="list?fieldtag=42&firstletter=">社会学</a>',
      '<a href="list?fieldtag=42&firstletter=">社会学</a>',
      '<a href="list?fieldtag=7&firstletter=">政治学</a>',
    ].join('');
    const options = parseLetPubFieldOptions(html);
    expect(options).toEqual([
      { id: '42', name: '社会学' },
      { id: '7', name: '政治学' },
    ]);
  });
});

describe('journal targeting aggregation', () => {
  it('aggregates venue candidates from topic-related papers with whitelist core flags', () => {
    const candidates = aggregateVenueCandidates({
      papers: [
        { title: 'AI 与劳动过程', venue: '社会学研究', year: 2023 },
        { title: 'AI 与劳动过程（续）', venue: '社会学研究', year: 2024 },
        { title: '数字劳动研究', venue: '新闻与传播研究', year: 2024 },
      ],
      criteria: { categories: ['cssci'], language: 'zh', notes: '' },
      currentYear: 2024,
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.name).toBe('社会学研究');
    expect(candidates.every((candidate) => ['社会学研究', '新闻与传播研究'].includes(candidate.name))).toBe(true);
    // 核心层级标注只来自白名单（isChineseCoreJournal），不来自模型推断。
    expect(candidates[0]!.verifiedTiers.length).toBeGreaterThan(0);
  });

  it('does not invent impact factors or acceptance rates', () => {
    const candidates = aggregateVenueCandidates({
      papers: [{ title: 'X', venue: '社会学研究', year: 2024 }],
      criteria: { categories: ['cssci'], language: 'any', notes: '' },
      currentYear: 2024,
    });
    const json = JSON.stringify(candidates);
    expect(json).not.toContain('impact');
    expect(json).not.toContain('acceptance');
    expect(json).not.toContain('if=');
  });
});
