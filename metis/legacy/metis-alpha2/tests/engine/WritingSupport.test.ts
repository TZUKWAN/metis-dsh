/**
 * 写作支持引擎（T18/T19）：CitationFormatter、AigcReport。
 */

import { describe, expect, it } from 'vitest';
import {
  formatBibliographyEntry,
  formatCitationBundle,
  switchCitationStyle,
} from '../../engine/research/CitationFormatter.js';
import { buildAigcReport } from '../../engine/research/AigcReport.js';

const zhSource = {
  id: 'p1',
  title: '乡村振兴背景下的基层治理创新',
  authors: ['张伟', '李明'],
  year: 2024,
  venue: '社会学研究',
  volume: '39',
  issue: '2',
  pages: '45-67',
};

const enSource = {
  id: 'p2',
  title: 'Social capital and local governance',
  authors: ['Putnam Robert', 'Leonardi Raffaella'],
  year: 2021,
  venue: 'American Journal of Sociology',
  volume: '126',
  issue: '4',
  pages: '1010-1054',
  doi: '10.1086/xxx',
};

describe('CitationFormatter（T18）', () => {
  it('GB/T 7714 中文著录', () => {
    const entry = formatBibliographyEntry(zhSource, 'gbt7714');
    expect(entry).toContain('张伟，李明');
    expect(entry).toContain('社会学研究');
    expect(entry).toContain('2024');
    expect(entry).toContain('[J]');
    expect(entry).toContain('45-67');
  });

  it('APA 7 英文著录（作者缩写 + DOI）', () => {
    const entry = formatBibliographyEntry(enSource, 'apa7');
    expect(entry).toContain('Putnam, R.');
    expect(entry).toContain('(2021)');
    expect(entry).toContain('https://doi.org/10.1086/xxx');
  });

  it('Chicago 著录用引号标题', () => {
    const entry = formatBibliographyEntry(enSource, 'chicago');
    expect(entry).toContain('"Social capital and local governance."');
  });

  it('文中引注与文末著录成对', () => {
    const bundle = formatCitationBundle([zhSource, enSource], 'gbt7714');
    expect(bundle.inText).toEqual(['[1]', '[2]']);
    expect(bundle.bibliography).toHaveLength(2);
    const apa = formatCitationBundle([enSource], 'apa7');
    expect(apa.inText[0]).toContain('(Putnam, 2021)');
  });

  it('体例一键切换', () => {
    const switched = switchCitationStyle([zhSource], 'gbt7714', 'apa7');
    expect(switched.style).toBe('apa7');
    expect(switched.bibliography[0]).toContain('(2024)');
  });
});

describe('AigcReport（T19）', () => {
  it('把账本操作归类为 AIGC 声明条目并生成中文摘要', () => {
    const report = buildAigcReport({
      projectId: 'p-1',
      artifactId: 'a-1',
      ledgerRows: [
        { operation: 'search', committedAt: 1 },
        { operation: 'list_sources', committedAt: 2 },
        { operation: 'read_pdf', committedAt: 3 },
        { operation: 'artifact.save', committedAt: 4 },
      ],
      artifactVersionCount: 3,
    });
    expect(report.totalOperations).toBe(4);
    const labels = report.operations.map((stat) => stat.operation);
    expect(labels).toContain('文献检索与全文查阅');
    expect(labels).toContain('文件读取与全文抽取');
    expect(labels).toContain('成果起草与迭代');
    expect(report.summaryText).toContain('4 次');
    expect(report.summaryText).toContain('3 个版本');
    expect(report.summaryText).toContain('文责由作者承担');
  });

  it('空账本产出零参与报告', () => {
    const report = buildAigcReport({ projectId: null, artifactId: null, ledgerRows: [], artifactVersionCount: null });
    expect(report.totalOperations).toBe(0);
    expect(report.summaryText).toContain('0 次');
  });
});
