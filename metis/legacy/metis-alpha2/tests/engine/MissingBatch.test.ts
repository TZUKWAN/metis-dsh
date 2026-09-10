/**
 * 本轮补缺（T28/T30/白名单导入）：笔记类型化工具、评估评分器、ISSN 扩展。
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { getNotesToolHandlers } from '../../engine/tools/builtin/notes-tools.js';
import { scoreEvalAnswers } from '../../engine/evals/ResearchEvalSuite.js';
import { extendSciSsciIssns, isSciSsciIssn } from '../../engine/literature/CoreJournalLists.js';
import { setSharedStore } from '../../engine/persistence/PersistenceStore.js';

describe('notes-tools（T28）', () => {
  const saved: unknown[] = [];

  beforeEach(() => {
    setSharedStore({
      saveNote: (note: unknown) => { saved.push(note); },
      raw: { prepare: () => ({ all: () => [] }) },
    } as never);
  });

  afterEach(() => {
    setSharedStore(null);
    saved.length = 0;
  });

  it('文献卡强制 linkedPaperIds，其他类型可空', async () => {
    const handlers = getNotesToolHandlers();
    const create = handlers.get('create_typed_note')!;
    const rejected = await create(
      { type: 'literature', title: '无挂载文献卡', content: 'x'.repeat(20) },
      { projectId: 'p-1' },
    );
    expect(String(rejected)).toContain('linkedPaperIds');
    // 方法卡无需挂文献。
    const ok = await create({ type: 'method', title: '访谈提纲法', content: '步骤说明' }, { projectId: 'p-1' });
    expect(String(ok)).toContain('"ok":true');
  });

  it('无效类型与空标题拒绝', async () => {
    const handlers = getNotesToolHandlers();
    const create = handlers.get('create_typed_note')!;
    expect(String(await create({ type: 'bogus', title: 't', content: 'c' }, { projectId: 'p-1' }))).toContain('Error');
    expect(String(await create({ type: 'insight', title: '', content: 'c' }, { projectId: 'p-1' }))).toContain('Error');
  });

  it('无项目上下文拒绝（类型化笔记必须挂项目）', async () => {
    const handlers = getNotesToolHandlers();
    const create = handlers.get('create_typed_note')!;
    expect(String(await create({ type: 'insight', title: 't', content: 'c' }, {}))).toContain('active research project');
  });
});

describe('ResearchEvalSuite 评分器（T30）', () => {
  it('结构完整的综述回答通过全部规则', () => {
    const answer = [
      '1. 数字基础设施重塑县域治理结构（赵明, 2022）',
      '2. 平台经济下沉与基层权力重组（李华, 2021）',
      '3. 数据要素确权对公共服务的增益（陈晨, 2023）',
      '4. 治理数字化转型的绩效争议（王芳, 2020）',
      '5. 县域数字治理的伦理边界（周涛, 2022）',
    ].join('\n');
    const verdict = scoreEvalAnswers({ 'review-structure': answer });
    const result = verdict.results.find((item) => item.taskId === 'review-structure')!;
    expect(result.passed).toBe(true);
  });

  it('编码建议三要素齐全即通过', () => {
    const answer = '资金截留｜基层财政资源在传递中被上级占用｜原文摘录："上面的资金到了镇里就被截留"';
    const verdict = scoreEvalAnswers({ 'coding-suggestion': answer });
    expect(verdict.results.find((item) => item.taskId === 'coding-suggestion')!.passed).toBe(true);
  });

  it('审稿响应不编造数字且说明动作即通过', () => {
    const answer = '已逐行核对表3与原始数据，将统一样本量口径并更正正文表述。';
    const verdict = scoreEvalAnswers({ 'revision-response': answer });
    expect(verdict.results.find((item) => item.taskId === 'revision-response')!.passed).toBe(true);
  });

  it('编造数字的响应被拦截', () => {
    const answer = '样本量应为 123456 人，我已全部修正。';
    const verdict = scoreEvalAnswers({ 'revision-response': answer });
    expect(verdict.results.find((item) => item.taskId === 'revision-response')!.passed).toBe(false);
  });
});

describe('ISSN 白名单扩展（T1 导入路径）', () => {
  it('有效 ISSN 加入白名单，非法输入被过滤', () => {
    const before = isSciSsciIssn('2095-8760');
    const added = extendSciSsciIssns(['2095-8760', 'not-an-issn', '1234-567X', '']);
    expect(added).toBeGreaterThanOrEqual(2);
    expect(isSciSsciIssn('2095-8760')).toBe(true);
    expect(isSciSsciIssn('20958760')).toBe(true); // 连字符不敏感
    void before;
  });

  it('重复扩展不重复计数', () => {
    const added = extendSciSsciIssns(['0003-1224']); // 已在内置名单
    expect(added).toBe(0);
  });
});
