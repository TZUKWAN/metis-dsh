/**
 * Acceptance criteria for workflow steps (O6).
 *
 * The completion gate in WorkflowEngine previously relied on the agent's own
 * `finalVerified` boolean plus a refusal-text heuristic. That is an LLM
 * self-assessment and can still mark a step "completed" with a thin or
 * off-topic answer. Acceptance criteria add an OBJECTIVE layer: each criterion
 * is a deterministic check against the step's final text, and the step only
 * counts as accomplished when all of them pass.
 *
 * Criteria are intentionally simple, machine-checkable predicates (not free
 * text) so they cannot be gamed by phrasing. They are inspired by
 * mission-control's `acceptanceCriteria` + mandatory verify step.
 */

export type AcceptanceCriterionKind =
  | 'minLength'   // output must be at least N characters (after trim)
  | 'contains'    // output must contain a literal substring (case-insensitive)
  | 'notContains' // output must NOT contain a substring (e.g. a refusal marker)
  | 'regex';      // output must match a regex

export interface AcceptanceCriterion {
  kind: AcceptanceCriterionKind;
  /** minLength → numeric string; contains/notContains → substring; regex → pattern. */
  value: string;
  /** Optional human-readable note surfaced in failure reasons. */
  description?: string;
}

export interface AcceptanceCheckResult {
  passed: boolean;
  /** Reasons for the first failing criterion (empty when passed). */
  failures: string[];
}

/**
 * Evaluate a list of acceptance criteria against an output string.
 * Returns { passed: true } when all criteria pass (or when none are defined,
 * in which case the caller's existing finalVerified heuristic stays decisive).
 */
export function evaluateAcceptanceCriteria(
  output: string,
  criteria: readonly AcceptanceCriterion[] | undefined,
): AcceptanceCheckResult {
  if (!criteria || criteria.length === 0) {
    return { passed: true, failures: [] };
  }
  const text = output ?? '';
  const failures: string[] = [];

  for (const criterion of criteria) {
    const reason = criterion.description?.trim();
    const label = (reason ? `${reason}` : criterion.kind);
    switch (criterion.kind) {
      case 'minLength': {
        const n = Number.parseInt(criterion.value, 10);
        if (!Number.isFinite(n) || n < 0) {
          // Malformed criterion: treat as pass to avoid blocking on bad config.
          break;
        }
        if (text.trim().length < n) {
          failures.push(`${label}: 输出长度不足 ${n} 字符（实际 ${text.trim().length}）`);
        }
        break;
      }
      case 'contains': {
        const needle = criterion.value.trim().toLowerCase();
        if (needle && !text.toLowerCase().includes(needle)) {
          failures.push(`${label}: 未包含「${criterion.value}」`);
        }
        break;
      }
      case 'notContains': {
        const needle = criterion.value.trim().toLowerCase();
        if (needle && text.toLowerCase().includes(needle)) {
          failures.push(`${label}: 不应包含「${criterion.value}」`);
        }
        break;
      }
      case 'regex': {
        try {
          const re = new RegExp(criterion.value);
          if (!re.test(text)) {
            failures.push(`${label}: 未匹配规则 /${criterion.value}/`);
          }
        } catch {
          // Invalid regex: treat as pass to avoid blocking on bad config.
        }
        break;
      }
      default:
        // Unknown kind: ignore.
        break;
    }
  }

  return { passed: failures.length === 0, failures };
}

/**
 * Convenience: true when a step defines any acceptance criteria.
 * Lets callers decide whether to even run the objective gate.
 */
export function hasAcceptanceCriteria(criteria: readonly AcceptanceCriterion[] | undefined): boolean {
  return Array.isArray(criteria) && criteria.length > 0;
}
