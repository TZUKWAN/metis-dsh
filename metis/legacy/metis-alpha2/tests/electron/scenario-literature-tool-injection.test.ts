import { describe, expect, it } from 'vitest';
import { isLiteratureSearchStep, LITERATURE_SEARCH_TOOL_IDS } from '../../electron/ScenarioWorkflowService.js';

describe('检索类步骤运行期判定（2026-09-01 刘总报告：老场景文献库空）', () => {
  it('命中英文检索类 stepId（劳动社会学综述场景的真实步骤 ID）', () => {
    expect(isLiteratureSearchStep({ id: 'step-02-search-literature' })).toBe(true);
    expect(isLiteratureSearchStep({ id: 'step-02-02-gather-sources' })).toBe(true);
    expect(isLiteratureSearchStep({ id: 'step-02-03-record-bibliographic-data' })).toBe(true);
    expect(isLiteratureSearchStep({ id: 'step-03-03-build-literature-matrix' })).toBe(true);
  });

  it('命中中文步骤名与目标', () => {
    expect(isLiteratureSearchStep({ id: 'step-3', name: '文献检索与整理' })).toBe(true);
    expect(isLiteratureSearchStep({ id: 'step-4', goal: '检索文献并建立证据库' })).toBe(true);
    expect(isLiteratureSearchStep({ id: 'step-5', prompt: '搜索文献，整理成题录' })).toBe(true);
  });

  it('写作、大纲、范围类步骤不误伤', () => {
    expect(isLiteratureSearchStep({ id: 'step-06-draft-review-paper', name: '撰写综述正文' })).toBe(false);
    expect(isLiteratureSearchStep({ id: 'step-05-design-paper-structure' })).toBe(false);
    expect(isLiteratureSearchStep({ id: 'step-01-define-scope', name: '确定研究范围' })).toBe(false);
    expect(isLiteratureSearchStep({ id: 'step-07', name: '生成最终交付物' })).toBe(false);
  });

  it('注入名单含真实已注册检索工具且含 DOI/URL 语义的核验通道', () => {
    expect(LITERATURE_SEARCH_TOOL_IDS).toContain('search_papers');
    expect(LITERATURE_SEARCH_TOOL_IDS).toContain('crossref_lookup');
    expect(LITERATURE_SEARCH_TOOL_IDS).toContain('journal_directory_search');
    expect(LITERATURE_SEARCH_TOOL_IDS).toContain('ncpssd_search');
  });
});
