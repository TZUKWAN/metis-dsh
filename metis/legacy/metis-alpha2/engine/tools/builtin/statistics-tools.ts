/**
 * statistics-tools — 数据分析 AI 工具（T21，T6 铁律执行面）。
 *
 * run_statistics：AI 只写"命令"，数字全部由本地确定性引擎计算并返回
 * 带溯源的 ComputedFact —— 引擎先跑出厂校验（Anscombe 已知解）再执行。
 * deidentify_text：访谈/资料脱敏（T23）。
 */

import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';
import { parseCsv, numericColumn } from '../../research/CsvTable.js';
import { describe as describeStats, crosstab, ols, runBuiltInChecks, describeToFacts, olsToFacts } from '../../research/StatisticsEngine.js';
import { deidentifyText } from '../../research/TextDeidentifier.js';

export const STATISTICS_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'run_statistics',
    description: 'Run LOCAL deterministic statistics (T6 rule: numbers never come from the model). Commands: describe (one numeric column), crosstab (two categorical columns), ols (outcome + predictors). Returns results WITH provenance-carrying computed facts — cite these facts (never hand-write numbers).',
    parameters: {
      type: 'object',
      properties: {
        csv: { type: 'string', description: 'The dataset as CSV/TSV text (with header row).' },
        command: { type: 'string', description: 'describe | crosstab | ols' },
        column: { type: 'string', description: 'describe: the numeric column name.' },
        varA: { type: 'string', description: 'crosstab: row variable.' },
        varB: { type: 'string', description: 'crosstab: column variable.' },
        outcome: { type: 'string', description: 'ols: outcome (y) column.' },
        predictors: { type: 'array', items: { type: 'string' }, description: 'ols: predictor (X) column names.' },
        labelPrefix: { type: 'string', description: 'Label prefix for computed facts (e.g. "模型1").' },
      },
      required: ['csv', 'command'],
    },
  },
  {
    name: 'deidentify_text',
    description: 'Deidentify qualitative material (T23 ethics): masks phone numbers, ID numbers, emails, and user-supplied sensitive terms in interview/field text. Use before storing or analyzing raw transcripts.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        extraTerms: { type: 'array', items: { type: 'string' }, description: 'Additional terms (names, places, orgs) to mask.' },
      },
      required: ['text'],
    },
  },
];

export function getStatisticsToolHandlers(): Map<string, ToolHandler> {
  const runStatistics: ToolHandler = async (args) => {
    // 出厂校验先行：引擎自身必须先通过已知解检验。
    const selfCheck = runBuiltInChecks();
    if (!selfCheck.ok) {
      return JSON.stringify({ ok: false, error: 'engine_self_check_failed', failures: selfCheck.failures });
    }
    const csv = String(args.csv ?? '');
    const command = String(args.command ?? '');
    if (!csv.trim()) return 'Error: csv is required.';
    const table = parseCsv(csv);
    if (table.rows.length === 0) return 'Error: no data rows parsed.';
    const labelPrefix = typeof args.labelPrefix === 'string' && args.labelPrefix.trim() ? args.labelPrefix.trim() : command;

    if (command === 'describe') {
      const column = String(args.column ?? '');
      if (!table.numericColumns[column]) {
        return `Error: column '${column}' is not numeric. Numeric columns: ${Object.entries(table.numericColumns).filter(([, ok]) => ok).map(([name]) => name).join(', ') || '(none)'}.`;
      }
      const result = describeStats(numericColumn(table, column));
      return JSON.stringify({ ok: true, command, column, result, facts: describeToFacts(labelPrefix, result) });
    }

    if (command === 'crosstab') {
      const varA = String(args.varA ?? '');
      const varB = String(args.varB ?? '');
      if (!varA || !varB || !table.columns.includes(varA) || !table.columns.includes(varB)) {
        return `Error: varA/varB must be existing columns. Columns: ${table.columns.join(', ')}`;
      }
      const result = crosstab(table.rows, varA, varB);
      return JSON.stringify({
        ok: true,
        command,
        result,
        note: result.minExpected < 5 ? '注意：存在期望频数 <5 的单元格，卡方检验结果需谨慎解读（建议合并类别或用 Fisher 精确检验）。' : null,
      });
    }

    if (command === 'ols') {
      const outcome = String(args.outcome ?? '');
      const predictors = Array.isArray(args.predictors) ? (args.predictors as unknown[]).filter((name): name is string => typeof name === 'string') : [];
      if (!table.numericColumns[outcome]) return `Error: outcome '${outcome}' must be numeric.`;
      for (const predictor of predictors) {
        if (!table.numericColumns[predictor]) return `Error: predictor '${predictor}' must be numeric.`;
      }
      if (predictors.length === 0) return 'Error: predictors required.';
      const X = table.rows.map((row) => predictors.map((name) => Number(row[name])));
      const y = numericColumn(table, outcome);
      if (y.length !== X.length) {
        // 有缺失的行已被 numericColumn 过滤 —— 严格模式：先对齐。
        const validRows = table.rows.filter((row) => predictors.every((name) => typeof row[name] === 'number'));
        const alignedY = validRows.map((row) => Number(row[outcome])).filter((value) => Number.isFinite(value));
        if (alignedY.length !== validRows.length) {
          return 'Error: outcome contains missing values alongside complete predictors; clean the data first.';
        }
      }
      const result = ols(X, y);
      if (!result.verified) {
        return JSON.stringify({ ok: false, error: 'dual_channel_mismatch', result });
      }
      return JSON.stringify({ ok: true, command, outcome, predictors, result, facts: olsToFacts(labelPrefix, predictors, result) });
    }

    return `Error: unknown command '${command}'. Use describe | crosstab | ols.`;
  };

  const deidentify: ToolHandler = async (args) => {
    const text = String(args.text ?? '');
    const extraTerms = Array.isArray(args.extraTerms) ? (args.extraTerms as unknown[]).filter((term): term is string => typeof term === 'string') : [];
    const result = deidentifyText(text, extraTerms);
    return JSON.stringify(result);
  };

  return new Map<string, ToolHandler>([
    ['run_statistics', runStatistics],
    ['deidentify_text', deidentify],
  ]);
}
