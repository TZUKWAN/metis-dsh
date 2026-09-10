/**
 * 数据分析配套（T21/T23）：CsvTable、TextDeidentifier、statistics-tools。
 */

import { describe, expect, it } from 'vitest';
import { parseCsv, numericColumn } from '../../engine/research/CsvTable.js';
import { deidentifyText } from '../../engine/research/TextDeidentifier.js';
import { getStatisticsToolHandlers } from '../../engine/tools/builtin/statistics-tools.js';

describe('CsvTable', () => {
  it('解析表头与数值列推断', () => {
    const table = parseCsv('姓名,年龄,城市\n张三,25,北京\n李四,30,上海\n');
    expect(table.columns).toEqual(['姓名', '年龄', '城市']);
    expect(table.rows).toHaveLength(2);
    expect(table.numericColumns['年龄']).toBe(true);
    expect(table.numericColumns['姓名']).toBe(false);
    expect(table.rows[0]!['年龄']).toBe(25);
  });

  it('支持引号字段与制表符分隔', () => {
    const tsv = parseCsv('id\ttext\n1\t"含有, 逗号"\n2\t普通\n');
    expect(tsv.rows[0]!['text']).toBe('含有, 逗号');
    expect(numericColumn(tsv, 'id')).toEqual([1, 2]);
  });

  it('空数据返回空表', () => {
    expect(parseCsv('').rows).toHaveLength(0);
  });
});

describe('TextDeidentifier', () => {
  it('掩码手机号/邮箱/身份证', () => {
    const result = deidentifyText('受访者手机 13812345678，邮箱 a@b.com，证件 11010119900307891X。');
    expect(result.text).not.toContain('13812345678');
    expect(result.text).toContain('[手机号]');
    expect(result.text).toContain('[邮箱]');
    expect(result.text).toContain('[身份证号]');
    expect(result.totalMasked).toBeGreaterThanOrEqual(3);
  });

  it('自定义敏感词全文同一占位', () => {
    const result = deidentifyText('王老师说，王老师所在的研究所资助了项目。', ['王老师', '研究所']);
    expect(result.text).not.toContain('王老师');
    const placeholders = [...result.text.matchAll(/\[敏感信息\d\]/gu)].map((m) => m[0]);
    expect(new Set(placeholders).size).toBe(2);
    expect(result.text.match(/\[敏感信息1\]/gu)!.length).toBe(2); // 同一实体同一占位
  });
});

describe('run_statistics 工具（T6 铁律执行面）', () => {
  const handlers = getStatisticsToolHandlers();
  const run = handlers.get('run_statistics')!;

  const CSV = [
    'x1,x2,y',
    ...Array.from({ length: 15 }, (_, i) => `${i + 1},${(i % 3) + 1},${2 + 3 * (i + 1) - ((i % 3) + 1)}`),
  ].join('\n');

  it('describe 命令返回带溯源 facts', async () => {
    const raw = await run({ csv: CSV, command: 'describe', column: 'y', labelPrefix: '测试' }, { projectId: 'p1' });
    const parsed = JSON.parse(raw as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.n).toBe(15);
    expect(parsed.facts[0].source.engine).toBe('metis-stats/1');
  });

  it('ols 命令通过双通道复核并返回系数事实', async () => {
    const raw = await run({ csv: CSV, command: 'ols', outcome: 'y', predictors: ['x1', 'x2'] }, { projectId: 'p1' });
    const parsed = JSON.parse(raw as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.verified).toBe(true);
    expect(parsed.result.coefficients[1]).toBeCloseTo(3, 6);
    expect(parsed.facts.some((fact: { unit: string }) => fact.unit === 'p')).toBe(true);
  });

  it('非数值列拒绝 describe', async () => {
    const raw = await run({ csv: 'name,score\na,1\nb,2\n', command: 'describe', column: 'name' }, { projectId: 'p1' });
    expect(String(raw)).toContain('not numeric');
  });

  it('未知命令报错', async () => {
    const raw = await run({ csv: CSV, command: 'magic' }, { projectId: 'p1' });
    expect(String(raw)).toContain('unknown command');
  });
});

describe('deidentify_text 工具', () => {
  it('工具入口可用并返回计数', async () => {
    const handlers = getStatisticsToolHandlers();
    const deidentify = handlers.get('deidentify_text')!;
    const raw = await deidentify({ text: '联系 13900001111', extraTerms: ['张三'] }, { projectId: 'p1' });
    const parsed = JSON.parse(raw as string);
    expect(parsed.totalMasked).toBeGreaterThanOrEqual(1);
    expect(parsed.text).toContain('[手机号]');
  });
});
