/**
 * Self-Deception Guard — prevents agents from fabricating results.
 *
 * Detects and prevents common LLM self-deception patterns:
 *   1. Numerical hallucination — claims a number not present in any tool result
 *   2. Fabricated execution — claims experiment was run but no execute_code tool was called
 *   3. Citation fabrication — claims with unsourced DOIs/arXiv IDs
 *   4. Contradictory claims — agent says X in one message and not-X in another
 */

import type { ToolResult } from '../core/types.js';

// ─── Types ──────────────────────────────────────────────────

export interface DeceptionCheck {
  /** What was checked */
  check: string;
  /** Whether deception was detected */
  passed: boolean;
  /** Evidence for/against */
  evidence: string;
  /** Severity (0=none, 1=warning, 2=critical) */
  severity: 0 | 1 | 2;
}

export interface GuardReport {
  overallPassed: boolean;
  checks: DeceptionCheck[];
  criticalCount: number;
  warningCount: number;
  summary: string;
}

// ─── Guard Functions ───────────────────────────────────────

/**
 * Check if numerical claims in agent output are backed by tool results.
 */
export function checkNumericalClaims(
  agentOutput: string,
  toolResults: ToolResult[],
): DeceptionCheck {
  const numbers = agentOutput.match(/\d+\.?\d*(?:\s*%?)/g);
  if (!numbers || numbers.length === 0) {
    return { check: '数值声明溯源', passed: true, evidence: '未检测到数值声明', severity: 0 };
  }

  const allToolContent = toolResults.map((tr) => tr.content).join(' ');
  const unsourcedClaims: string[] = [];

  for (const num of numbers) {
    const cleaned = num.replace(/[%\s]/g, '');
    if (cleaned.length < 2) continue; // Skip single digits (years, section numbers)
    if (!allToolContent.includes(cleaned)) {
      unsourcedClaims.push(num);
    }
  }

  if (unsourcedClaims.length === 0) {
    return { check: '数值声明溯源', passed: true, evidence: `${numbers.length}个数值声明全部可在工具结果中找到`, severity: 0 };
  }
  if (unsourcedClaims.length <= 2) {
    return { check: '数值声明溯源', passed: false, evidence: `${unsourcedClaims.length}个数值无法溯源: ${unsourcedClaims.join(', ')}`, severity: 1 };
  }
  return { check: '数值声明溯源', passed: false, evidence: `${unsourcedClaims.length}个数值无法在工具结果中找到来源 — 可能存在虚构数据`, severity: 2 };
}

/**
 * Check if agent claims to have run an experiment but no execute_code was called.
 */
export function checkExperimentExecution(
  agentOutput: string,
  toolResults: ToolResult[],
): DeceptionCheck {
  const execRuns = toolResults.filter((tr) => tr.toolName === 'execute_code');
  const experimentClaims = agentOutput.match(
    /(?:experiment|code|script|execution|run|python|train|evaluat|benchmark)/gi,
  );

  if (!experimentClaims || experimentClaims.length === 0) {
    return { check: '实验执行验证', passed: true, evidence: '未检测到实验声明', severity: 0 };
  }
  if (execRuns.length > 0) {
    return { check: '实验执行验证', passed: true, evidence: `${execRuns.length}次代码执行记录匹配${experimentClaims.length}个实验声明`, severity: 0 };
  }
  return { check: '实验执行验证', passed: false, evidence: `声称进行了实验但未找到任何 execute_code 调用记录`, severity: 2 };
}

/**
 * Check for fabricated references (DOIs/arXiv IDs not in ReferenceValidator).
 */
export function checkFabricatedReferences(
  agentOutput: string,
  validatedRefs: Array<{ ref: string; exists: boolean }>,
): DeceptionCheck {
  const dois = agentOutput.match(/\b10\.\d{4,}\/[\w._\-()/]+\b/g) ?? [];
  const arxivs = agentOutput.match(/\b(?:arXiv:\s*)?\d{4}\.\d{4,5}(?:v\d+)?\b/g) ?? [];
  const allRefs = [...dois, ...arxivs];

  if (allRefs.length === 0) {
    return { check: '引用真实性', passed: true, evidence: '未检测到引用', severity: 0 };
  }

  const verified = validatedRefs.filter((r) => r.exists);
  const fabricated = allRefs.filter(
    (ref) => !verified.some((v) => v.ref === ref),
  );

  if (fabricated.length === 0) {
    return { check: '引用真实性', passed: true, evidence: `${allRefs.length}个引用全部可验证`, severity: 0 };
  }
  return { check: '引用真实性', passed: false, evidence: `${fabricated.length}个引用无法验证 — 可能为虚构引用: ${fabricated.slice(0, 3).join(', ')}`, severity: 2 };
}

/**
 * Check for self-contradiction within agent output.
 */
export function checkSelfConsistency(
  agentOutput: string,
): DeceptionCheck {
  const lower = agentOutput.toLowerCase();

  // Pattern pairs that suggest contradiction
  const patterns = [
    { a: /\bsignificant(?:ly)?\b/, b: /\bnot significant\b/, name: '显著性声称矛盾' },
    { a: /\boutperforms?\b/, b: /\bundeperforms?\b/, name: '性能对比矛盾' },
    { a: /\bstate-of-the-art\b/, b: /\bsimple baseline\b/, name: 'SOTA声称矛盾' },
    { a: /\baccuracy\s*(?:of\s*)?(\d+\.?\d*)/, b: /\baccuracy\s*(?:of\s*)?(\d+\.?\d*)/, name: '多个准确率声明', filter: (m: RegExpMatchArray[]) => {
      if (m.length < 2) return false;
      const vals = m.map((x) => parseFloat(x[1] ?? '0'));
      return Math.abs((vals[0] ?? 0) - (vals[1] ?? 0)) > 10;
    }},
  ];

  const findings: string[] = [];
  for (const pattern of patterns) {
    const matchesA = [...lower.matchAll(
      new RegExp(pattern.a.source, 'gi'),
    )];
    const matchesB = [...lower.matchAll(
      new RegExp(pattern.b.source, 'gi'),
    )];
    if (matchesA.length > 0 && matchesB.length > 0) {
      if (pattern.filter && !pattern.filter(matchesA.concat(matchesB) as RegExpMatchArray[])) continue;
      findings.push(pattern.name);
    }
  }

  if (findings.length === 0) {
    return { check: '自洽性检查', passed: true, evidence: '未检测到明显矛盾', severity: 0 };
  }
  return { check: '自洽性检查', passed: false, evidence: `检测到矛盾标记: ${findings.join(', ')}`, severity: 1 };
}

// ─── Composite Guard ────────────────────────────────────────

/**
 * Run all deception checks against agent output.
 */
export function runAllGuards(
  agentOutput: string,
  toolResults: ToolResult[],
  validatedRefs: Array<{ ref: string; exists: boolean }> = [],
): GuardReport {
  const checks = [
    checkNumericalClaims(agentOutput, toolResults),
    checkExperimentExecution(agentOutput, toolResults),
    checkFabricatedReferences(agentOutput, validatedRefs),
    checkSelfConsistency(agentOutput),
  ];

  const criticalCount = checks.filter((c) => c.severity === 2).length;
  const warningCount = checks.filter((c) => c.severity === 1).length;
  const overallPassed = criticalCount === 0;

  let summary: string;
  if (overallPassed && warningCount === 0) {
    summary = '[通过] 所有自检通过 — 输出可信';
  } else if (overallPassed) {
    summary = `[警告] ${warningCount}项警告 — 建议人工审核`;
  } else {
    summary = `[失败] ${criticalCount}项严重问题 — 输出不可信，不建议直接使用`;
  }

  return { overallPassed, checks, criticalCount, warningCount, summary };
}
