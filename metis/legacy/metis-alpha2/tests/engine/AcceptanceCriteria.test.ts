/**
 * Tests for AcceptanceCriteria (O6): objective step-completion gates.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateAcceptanceCriteria,
  hasAcceptanceCriteria,
  type AcceptanceCriterion,
} from '../../engine/workflow/AcceptanceCriteria.js';

describe('evaluateAcceptanceCriteria', () => {
  it('passes when no criteria are defined (falls back to caller heuristic)', () => {
    expect(evaluateAcceptanceCriteria('anything', undefined).passed).toBe(true);
    expect(evaluateAcceptanceCriteria('anything', []).passed).toBe(true);
  });

  it('minLength enforces a character floor', () => {
    const criteria: AcceptanceCriterion[] = [{ kind: 'minLength', value: '10' }];
    expect(evaluateAcceptanceCriteria('this is long enough', criteria).passed).toBe(true);
    const fail = evaluateAcceptanceCriteria('short', criteria);
    expect(fail.passed).toBe(false);
    expect(fail.failures.length).toBeGreaterThan(0);
  });

  it('minLength treats malformed numeric value as pass (no false block)', () => {
    const criteria: AcceptanceCriterion[] = [{ kind: 'minLength', value: 'not-a-number' }];
    expect(evaluateAcceptanceCriteria('anything', criteria).passed).toBe(true);
  });

  it('contains requires a literal substring (case-insensitive)', () => {
    const criteria: AcceptanceCriterion[] = [{ kind: 'contains', value: 'Transformer' }];
    expect(evaluateAcceptanceCriteria('the transformer model', criteria).passed).toBe(true);
    expect(evaluateAcceptanceCriteria('the model', criteria).passed).toBe(false);
  });

  it('notContains blocks a forbidden substring (refusal marker)', () => {
    const criteria: AcceptanceCriterion[] = [{ kind: 'notContains', value: '我无法' }];
    expect(evaluateAcceptanceCriteria('我无法访问网络', criteria).passed).toBe(false);
    expect(evaluateAcceptanceCriteria('分析结果如下', criteria).passed).toBe(true);
  });

  it('regex requires a match', () => {
    const criteria: AcceptanceCriterion[] = [{ kind: 'regex', value: '10\\.\\d{4,9}/.+' }];
    expect(evaluateAcceptanceCriteria('see 10.1000/xyz for details', criteria).passed).toBe(true);
    expect(evaluateAcceptanceCriteria('no doi here', criteria).passed).toBe(false);
  });

  it('regex treats an invalid pattern as pass (no false block)', () => {
    const criteria: AcceptanceCriterion[] = [{ kind: 'regex', value: '([invalid' }];
    expect(evaluateAcceptanceCriteria('anything', criteria).passed).toBe(true);
  });

  it('fails fast on the first failing criterion among several', () => {
    const criteria: AcceptanceCriterion[] = [
      { kind: 'minLength', value: '5' },
      { kind: 'contains', value: 'missing-keyword' },
    ];
    const result = evaluateAcceptanceCriteria('long enough text', criteria);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('missing-keyword'))).toBe(true);
  });
});

describe('hasAcceptanceCriteria', () => {
  it('is true only for a non-empty criteria list', () => {
    expect(hasAcceptanceCriteria(undefined)).toBe(false);
    expect(hasAcceptanceCriteria([])).toBe(false);
    expect(hasAcceptanceCriteria([{ kind: 'minLength', value: '1' }])).toBe(true);
  });
});
