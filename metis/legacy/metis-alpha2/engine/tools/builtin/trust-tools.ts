/**
 * trust-tools — 可信度核查 AI 工具（T7/T8/T9）。
 *
 * 让"算得对、方法是合适的、过程是诚实的"成为对话与自主科研可调用的
 * 确定性核查：全部规则引擎实现，零模型调用、零 token。
 *   - verify_numbers：文本数字 vs 计算事实（DataTruth）
 *   - check_method_fit：统计方法适切性门 + 替代建议
 *   - audit_behaviors：声称行为 vs 副作用账本（行为审计）
 */

import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';
import { sharedStore } from '../../persistence/PersistenceStore.js';
import { makeComputedFact } from '../../research/ComputedFact.js';
import { checkNumberConsistency } from '../../research/NumberConsistencyChecker.js';
import { checkMethod, suggestAlternatives, type StatisticalMethodId, type MethodContext } from '../../research/MethodGate.js';
import { auditClaims, extractClaimedBehaviors } from '../../research/ClaimAudit.js';

export const TRUST_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'verify_numbers',
    description: 'Verify every numeric claim in a draft text against registered computed facts (DataTruth). Returns matched/mismatched/unverifiable per number. Use BEFORE presenting any numbers to the user; mismatched numbers must be corrected or removed.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The draft text containing numeric claims.' },
        facts: {
          type: 'array',
          description: 'Computed facts to check against: [{label, value, unit}] (unit: %/p/系数/个).',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              value: { type: 'number' },
              unit: { type: 'string' },
            },
            required: ['label', 'value', 'unit'],
          },
        },
      },
      required: ['text', 'facts'],
    },
  },
  {
    name: 'check_method_fit',
    description: 'Method gate: check whether a statistical method fits the study context BEFORE running it (sample size, outcome type, endogeneity, parallel trends, missing ratio). Returns warnings and suggested alternatives. Always call this before choosing ols/logistic/did/iv/rd/sem/panel.',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'ols|logistic|did|iv|rd|sem|panel|grounded_coding' },
        sampleSize: { type: 'number' },
        outcomeType: { type: 'string', description: 'continuous|binary|ordinal|count' },
        endogeneitySuspected: { type: 'boolean' },
        hasInstrument: { type: 'boolean' },
        parallelTrendTested: { type: 'boolean' },
        missingRatio: { type: 'number' },
        secondCoderAvailable: { type: 'boolean' },
      },
      required: ['method'],
    },
  },
  {
    name: 'audit_behaviors',
    description: 'Behavior audit: compare claimed behaviors in a statement (e.g. "检索了30篇文献") against the actual side-effect ledger of tool operations. Call before claiming what you did; overclaimed/unsupported claims must be corrected.',
    parameters: {
      type: 'object',
      properties: {
        claimText: { type: 'string', description: 'Your statement about what you did (Chinese or English).' },
        projectId: { type: 'string', description: 'Optional project scope for the ledger aggregation.' },
      },
      required: ['claimText'],
    },
  },
];

export function getTrustToolHandlers(): Map<string, ToolHandler> {
  const verifyNumbers: ToolHandler = async (args) => {
    const text = String(args.text ?? '');
    const rawFacts = Array.isArray(args.facts) ? args.facts : [];
    const facts = rawFacts
      .filter((item): item is { label: string; value: number; unit: string } => {
        const candidate = item as { label?: unknown; value?: unknown; unit?: unknown };
        return typeof candidate?.label === 'string' && typeof candidate?.value === 'number' && typeof candidate?.unit === 'string';
      })
      .map((item) => makeComputedFact({
        label: item.label,
        value: item.value,
        unit: item.unit,
        source: { kind: 'statistics', engine: 'verify_numbers/1', dataFingerprint: 'inline', seed: 0, runId: null },
      }));
    const report = checkNumberConsistency(text, facts);
    return JSON.stringify({
      ok: report.ok,
      counts: report.counts,
      verdict: report.ok
        ? '全部数字与计算事实一致或无事实冲突。'
        : '存在与计算事实冲突的数字（mismatch），必须修正后才能写入成果。',
      declarations: report.declarations.map((d) => ({
        number: d.raw,
        status: d.status,
        context: d.context.trim().slice(0, 80),
        matchedFactId: d.matchedFactId,
      })),
    });
  };

  const checkMethodFit: ToolHandler = async (args) => {
    const method = String(args.method ?? '').trim() as StatisticalMethodId;
    const context: MethodContext = {
      sampleSize: typeof args.sampleSize === 'number' ? args.sampleSize : undefined,
      outcomeType: args.outcomeType === 'continuous' || args.outcomeType === 'binary' || args.outcomeType === 'ordinal' || args.outcomeType === 'count'
        ? args.outcomeType
        : undefined,
      endogeneitySuspected: args.endogeneitySuspected === true,
      hasInstrument: args.hasInstrument === true,
      parallelTrendTested: args.parallelTrendTested === true,
      missingRatio: typeof args.missingRatio === 'number' ? args.missingRatio : undefined,
      secondCoderAvailable: args.secondCoderAvailable === true,
    };
    const result = checkMethod(method, context);
    const alternatives = result.pass ? [] : suggestAlternatives(context);
    return JSON.stringify({
      method: result.method,
      pass: result.pass,
      warnings: result.warnings,
      alternatives,
      advice: result.pass
        ? '方法适切性检查通过，可以继续。'
        : `有 ${result.warnings.length} 项适切性警告；建议改用：${alternatives.join(', ') || '（无自动匹配的替代，需人工设计）'}。`,
    });
  };

  const auditBehaviors: ToolHandler = async (args) => {
    const claimText = String(args.claimText ?? '');
    const projectId = typeof args.projectId === 'string' && args.projectId ? args.projectId : undefined;
    const claims = extractClaimedBehaviors(claimText);
    let ledger: Array<{ operation: string; count: number }> = [];
    try {
      if (sharedStore) {
        const rows = projectId
          ? sharedStore.raw.prepare('SELECT operation, COUNT(*) as c FROM side_effect_ledger WHERE project_id = ? GROUP BY operation').all(projectId) as Array<{ operation: string; c: number }>
          : sharedStore.raw.prepare('SELECT operation, COUNT(*) as c FROM side_effect_ledger GROUP BY operation').all() as Array<{ operation: string; c: number }>;
        ledger = rows.map((row) => ({ operation: row.operation, count: row.c }));
      }
    } catch { /* 账本不可用时输出空对照 */ }
    const result = auditClaims(claims, ledger);
    return JSON.stringify({
      ok: result.ok,
      ledger: ledger,
      claims: result.claims.map((item) => ({
        operation: item.claimed.operation,
        claimedCount: item.claimed.count,
        actualCount: item.actualCount,
        verdict: item.verdict,
        quote: item.claimed.quote,
      })),
      unclaimedOperations: result.unclaimedOperations,
      advice: result.ok
        ? '声称与账本一致。'
        : '存在 overclaimed/unsupported 的行为声称，请改述为与账本一致的事实，或实际执行后再声称。',
    });
  };

  return new Map<string, ToolHandler>([
    ['verify_numbers', verifyNumbers],
    ['check_method_fit', checkMethodFit],
    ['audit_behaviors', auditBehaviors],
  ]);
}
