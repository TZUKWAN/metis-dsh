/**
 * ClaimAudit — 行为审计（T9）。
 *
 * AI 声称的行为 vs 副作用账本（side_effect_ledger）的实际记录对照。
 * 防行为层面造假：声称"检索了 30 篇"实际只调用过 5 次、声称"阅读全文"
 * 实际没有任何全文读取操作。确定性规则，零模型调用。
 */

export interface ClaimedBehavior {
  /** 声称的操作名（与 ledger.operation 对齐，如 search/list_sources/read_pdf）。 */
  operation: string;
  /** 声称的次数（未声称具体次数时为 null）。 */
  count: number | null;
  /** 原文声明片段（呈现用）。 */
  quote: string;
}

export interface LedgerFact {
  operation: string;
  count: number;
}

export interface ClaimAuditResult {
  claims: Array<{
    claimed: ClaimedBehavior;
    actualCount: number;
    verdict: 'supported' | 'overclaimed' | 'unsupported';
  }>;
  /** 账本中有、但 AI 未声称的操作（提示可能遗漏交代）。 */
  unclaimedOperations: Array<{ operation: string; count: number }>;
  ok: boolean;
}

/** 从自由文本抽取行为声明："检索了 30 篇文献"、"调用了 5 次工具"、"阅读了全文"。 */
export function extractClaimedBehaviors(text: string): ClaimedBehavior[] {
  const claims: ClaimedBehavior[] = [];
  const patterns: Array<{ re: RegExp; operation: string }> = [
    { re: /(检索|搜索|查找|检索并导入)了?\s*(?:约\s*)?(\d+)\s*(?:篇|条|个)/u, operation: 'search' },
    { re: /(阅读|读)\s*(?:了\s*)?(?:全部|所有)?(?:\d+\s*篇)?\s*(?:的?\s*)?全文/u, operation: 'read_pdf' },
    { re: /调用(?:了)?\s*(?:项目资料|资料|检索|全文)\s*工具\s*(\d+)?\s*次?/u, operation: 'list_sources' },
    { re: /(调用|执行)(?:了)?\s*(\d+)\s*(?:次|个)\s*工具/u, operation: 'tool_call' },
  ];
  for (const { re, operation } of patterns) {
    for (const match of text.matchAll(new RegExp(re.source, 'gu'))) {
      const raw = match[0]!;
      const countGroup = [...match].slice(1).find((group) => typeof group === 'string' && /^\d+$/u.test(group));
      claims.push({
        operation,
        count: countGroup ? Number(countGroup) : null,
        quote: raw.slice(0, 60),
      });
    }
  }
  // 去重（同一声明被多个模式命中时保留首个）。
  const seen = new Set<string>();
  return claims.filter((claim) => {
    const key = `${claim.operation}:${claim.quote}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function auditClaims(claims: ClaimedBehavior[], ledger: LedgerFact[]): ClaimAuditResult {
  const byOperation = new Map(ledger.map((fact) => [fact.operation, fact.count]));
  const claimedOps = new Set<string>();
  const results = claims.map((claimed) => {
    claimedOps.add(claimed.operation);
    const actualCount = byOperation.get(claimed.operation) ?? 0;
    let verdict: 'supported' | 'overclaimed' | 'unsupported';
    if (actualCount === 0) {
      verdict = 'unsupported';
    } else if (claimed.count !== null && claimed.count > actualCount) {
      verdict = 'overclaimed';
    } else {
      verdict = 'supported';
    }
    return { claimed, actualCount, verdict };
  });
  const unclaimedOperations = ledger
    .filter((fact) => !claimedOps.has(fact.operation) && fact.count > 0)
    .map((fact) => ({ operation: fact.operation, count: fact.count }));
  return {
    claims: results,
    unclaimedOperations,
    ok: results.every((item) => item.verdict === 'supported'),
  };
}
