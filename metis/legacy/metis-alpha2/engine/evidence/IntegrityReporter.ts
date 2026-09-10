/**
 * Integrity Reporter — generates a comprehensive trustworthiness report
 * for each AgentRunResult.
 *
 * Evaluates 9 dimensions:
 *   1. Experiment reproducibility — was code actually executed?
 *   2. Numerical claim sourcing — do numbers trace back to tool results?
 *   3. Reference authenticity — are DOIs/arXiv IDs verified?
 *   4. Tool call audit — is the operation chain complete?
 *   5. LLM self-consistency — does the agent contradict itself?
 *   6. Retraction check — are any cited papers known to be retracted?
 *   7. Provenance coverage — what % of claims can be traced?
 *   8. Claim faithfulness — are factual claims supported by cited source text?
 *   9. Writing/format quality — are LaTeX figures, tables, math, sections, and cleanup audits clean?
 *   10. Overall integrity score — weighted composite
 */

import type { ProvenanceReport } from './ProvenanceChain.js';
import type { ReferenceValidationResult } from './ReferenceValidator.js';
import type { AgentRunResult, ToolResult } from '../core/types.js';
import type { ClaimManifestEntry, ClaimStatus } from '../manifest/ClaimManifest.js';

// ─── Types ──────────────────────────────────────────────────

export interface DimensionScore {
  name: string;
  score: number; // 0-1
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface WritingAuditSummary {
  totalIssues: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  toolsFound: number;
  topIssues: Array<{ tool: string; message: string; severity?: string }>;
  recommendations: string[];
}

export interface IntegrityReport {
  /** Overall integrity score (0-100) */
  overallScore: number;
  /** Individual dimension scores */
  dimensions: DimensionScore[];
  /** Session identifier */
  sessionId: string;
  /** When this report was generated */
  generatedAt: number;
  /** Summary banner (one-line verdict) */
  verdict: string;
  /** Color code for UI */
  verdictColor: 'green' | 'yellow' | 'red';
  /** Actionable recommendations */
  recommendations: string[];
  /** Raw underlying data */
  raw: {
    provenance?: ProvenanceReport;
    referenceResults?: ReferenceValidationResult[];
    agentResult?: AgentRunResult;
    claimManifestEntries?: ClaimManifestEntry[];
    toolResults?: ToolResult[];
    writingAudit?: WritingAuditSummary;
  };
}

// ─── Integrity Reporter ────────────────────────────────────

export class IntegrityReporter {
  /**
   * Generate a full integrity report from agent execution data.
   */
  generate(options: {
    agentResult?: AgentRunResult;
    provenance?: ProvenanceReport;
    referenceResults?: ReferenceValidationResult[];
    toolResults?: ToolResult[];
    claimManifestEntries?: ClaimManifestEntry[];
    writingAudit?: WritingAuditSummary;
    sessionId: string;
  }): IntegrityReport {
    const dimensions: DimensionScore[] = [];
    const recommendations: string[] = [];

    // 1. Experiment reproducibility
    dimensions.push(this.scoreExperimentReproducibility(options.toolResults));

    // 2. Numerical claim sourcing
    dimensions.push(this.scoreNumericalSourcing(options.provenance));

    // 3. Reference authenticity
    dimensions.push(this.scoreReferenceAuthenticity(options.referenceResults));

    // 4. Tool call audit
    dimensions.push(this.scoreToolCallAudit(options.agentResult));

    // 5. LLM self-consistency
    dimensions.push(this.scoreSelfConsistency(options.agentResult));

    // 6. Retraction check
    dimensions.push(this.scoreRetractionCheck(options.referenceResults));

    // 7. Provenance coverage
    dimensions.push(this.scoreProvenanceCoverage(options.provenance));

    // 8. Claim faithfulness
    dimensions.push(this.scoreClaimFaithfulness(options.claimManifestEntries));

    // 9. Writing/format quality
    const writingAudit = options.writingAudit ?? this.extractWritingAuditSummary(options.toolResults);
    dimensions.push(this.scoreWritingQuality(writingAudit));

    // 10. Overall integrity
    const overallScore = this.computeOverall(dimensions, recommendations);

    const verdict = this.makeVerdict(overallScore);

    return {
      overallScore,
      dimensions,
      sessionId: options.sessionId,
      generatedAt: Date.now(),
      verdict: verdict.text,
      verdictColor: verdict.color,
      recommendations,
      raw: {
        provenance: options.provenance,
        referenceResults: options.referenceResults,
        agentResult: options.agentResult,
        claimManifestEntries: options.claimManifestEntries,
        toolResults: options.toolResults,
        writingAudit,
      },
    };
  }

  // ─── Dimension Scorers ────────────────────────────────────

  private scoreExperimentReproducibility(toolResults?: ToolResult[]): DimensionScore {
    const execResults = toolResults?.filter((tr) => tr.toolName === 'execute_code') ?? [];
    if (execResults.length === 0) {
      return { name: '实验可复现性', score: 0.5, status: 'warn', detail: '未检测到代码执行，无法验证实验真实性' };
    }
    const successCount = execResults.filter((tr) => tr.status === 'ok').length;
    const ratio = successCount / execResults.length;
    if (ratio >= 0.9) return { name: '实验可复现性', score: 0.9, status: 'pass', detail: `${execResults.length}次代码执行，${successCount}次成功 (${(ratio * 100).toFixed(0)}%)` };
    if (ratio >= 0.7) return { name: '实验可复现性', score: 0.7, status: 'warn', detail: `${execResults.length}次执行，${execResults.length - successCount}次失败` };
    return { name: '实验可复现性', score: 0.3, status: 'fail', detail: `${execResults.length}次执行，${execResults.length - successCount}次失败 — 多数未能复现` };
  }

  private scoreNumericalSourcing(provenance?: ProvenanceReport): DimensionScore {
    if (!provenance || provenance.stats.totalClaims === 0) {
      return { name: '数据可溯源', score: 0.5, status: 'warn', detail: '未检测到数值声明进行溯源' };
    }
    const ratio = provenance.stats.verifiedCount / provenance.stats.totalClaims;
    if (ratio >= 0.8) return { name: '数据可溯源', score: 0.9, status: 'pass', detail: `${provenance.stats.verifiedCount}/${provenance.stats.totalClaims}条声明可追溯 (${(ratio * 100).toFixed(0)}%)` };
    if (ratio >= 0.5) return { name: '数据可溯源', score: 0.6, status: 'warn', detail: `仅${(ratio * 100).toFixed(0)}%声明可追溯，${provenance.stats.unverifiableCount}条无法验证` };
    return { name: '数据可溯源', score: 0.3, status: 'fail', detail: `大部分声明(${provenance.stats.unverifiableCount}条)无法追溯到数据来源` };
  }

  private scoreReferenceAuthenticity(refResults?: ReferenceValidationResult[]): DimensionScore {
    if (!refResults || refResults.length === 0) {
      return { name: '引用真实性', score: 0.5, status: 'warn', detail: '未检测到引用进行验证' };
    }
    const verified = refResults.filter((r) => r.exists).length;
    const ratio = verified / refResults.length;
    if (ratio >= 0.9) return { name: '引用真实性', score: 0.95, status: 'pass', detail: `${verified}/${refResults.length}条引用已验证存在` };
    if (ratio >= 0.7) return { name: '引用真实性', score: 0.7, status: 'warn', detail: `${refResults.length - verified}条引用无法验证` };
    return { name: '引用真实性', score: 0.3, status: 'fail', detail: `多数引用(${refResults.length - verified}条)无法验证 — 可能存在虚构引用` };
  }

  private scoreToolCallAudit(agentResult?: AgentRunResult): DimensionScore {
    if (!agentResult) return { name: '操作链完整', score: 0.5, status: 'warn', detail: '无 Agent 执行数据' };
    const toolCount = agentResult.toolResults?.length ?? 0;
    const errorCount = agentResult.errors?.length ?? 0;
    if (toolCount === 0) return { name: '操作链完整', score: 0.6, status: 'warn', detail: 'Agent 未使用任何工具 — 输出可能仅基于模型记忆' };
    if (errorCount === 0) return { name: '操作链完整', score: 0.95, status: 'pass', detail: `${toolCount}步操作，0个错误` };
    return { name: '操作链完整', score: 0.7, status: 'warn', detail: `${toolCount}步操作，${errorCount}个错误` };
  }

  private scoreSelfConsistency(agentResult?: AgentRunResult): DimensionScore {
    if (!agentResult) return { name: '自洽性', score: 0.5, status: 'warn', detail: '无 Agent 执行数据' };
    // Simple heuristic: check if finalText contains contradictions markers
    const text = agentResult.finalText?.toLowerCase() ?? '';
    const contradictionMarkers = ['however', 'on the other hand', 'contradict', 'inconsist', 'but then', 'although'];
    const markerCount = contradictionMarkers.filter((m) => text.includes(m)).length;

    if (markerCount <= 2) return { name: '自洽性', score: 0.9, status: 'pass', detail: '未检测到明显自相矛盾' };
    if (markerCount <= 5) return { name: '自洽性', score: 0.7, status: 'warn', detail: `检测到${markerCount}处可能的矛盾标记` };
    return { name: '自洽性', score: 0.5, status: 'fail', detail: `检测到${markerCount}处矛盾 — 建议人工审核` };
  }

  private scoreRetractionCheck(refResults?: ReferenceValidationResult[]): DimensionScore {
    if (!refResults || refResults.length === 0) {
      return { name: '撤稿检查', score: 1.0, status: 'pass', detail: '未引用论文，无需检查' };
    }
    const retracted = refResults.filter((r) => r.retracted);
    if (retracted.length === 0) return { name: '撤稿检查', score: 1.0, status: 'pass', detail: `${refResults.length}条引用，0篇撤稿` };
    return { name: '撤稿检查', score: 0.2, status: 'fail', detail: `[警告] ${retracted.length}篇已被撤稿！${retracted.map((r) => r.reference).join(', ')}` };
  }

  private scoreProvenanceCoverage(provenance?: ProvenanceReport): DimensionScore {
    if (!provenance || provenance.stats.totalClaims === 0) {
      return { name: '溯源覆盖', score: 0.3, status: 'fail', detail: '输出中未检测到可追溯的声明' };
    }
    const ratio = provenance.stats.verifiedCount / provenance.stats.totalClaims;
    if (ratio >= 0.8) return { name: '溯源覆盖', score: 0.9, status: 'pass', detail: `${(ratio * 100).toFixed(0)}%声明有明确来源` };
    if (ratio >= 0.5) return { name: '溯源覆盖', score: 0.6, status: 'warn', detail: `${provenance.stats.unverifiableCount}条声明无来源` };
    return { name: '溯源覆盖', score: 0.3, status: 'fail', detail: '大部分声明无法追溯到具体来源' };
  }

  private scoreClaimFaithfulness(entries?: ClaimManifestEntry[]): DimensionScore {
    if (!entries || entries.length === 0) {
      return { name: '声明忠实度', score: 0.5, status: 'warn', detail: '未检测到已审计声明' };
    }

    const statusScore: Record<ClaimStatus, number> = {
      verified: 1.0,
      single_index: 0.6,
      proposed: 0.4,
      mismatch: 0.2,
      contradicted: 0.0,
      unverifiable: 0.1,
      gap: 0.1,
    };

    const total = entries.reduce((sum, e) => sum + (statusScore[e.status] ?? 0.1), 0);
    const average = total / entries.length;
    const verifiedCount = entries.filter((e) => e.status === 'verified').length;
    const contradictedCount = entries.filter((e) => e.status === 'contradicted').length;

    if (average >= 0.8) {
      return {
        name: '声明忠实度',
        score: 0.9,
        status: 'pass',
        detail: `${verifiedCount}/${entries.length}条声明被源文本支持`,
      };
    }
    if (average >= 0.5) {
      return {
        name: '声明忠实度',
        score: 0.6,
        status: 'warn',
        detail: `${entries.length - verifiedCount}条声明未被直接支持`,
      };
    }
    return {
      name: '声明忠实度',
      score: 0.3,
      status: 'fail',
      detail: `${contradictedCount}条声明与源文本矛盾，${entries.length - verifiedCount - contradictedCount}条证据不足`,
    };
  }

  private scoreWritingQuality(summary?: WritingAuditSummary): DimensionScore {
    if (!summary || summary.toolsFound === 0) {
      return {
        name: '写作/格式质量',
        score: 0.5,
        status: 'warn',
        detail: '未检测到 LaTeX 写作/格式审计结果',
      };
    }

    if (summary.critical > 0 || summary.high >= 3) {
      return {
        name: '写作/格式质量',
        score: 0.25,
        status: 'fail',
        detail: `发现 ${summary.critical} 个严重、${summary.high} 个高危问题（共 ${summary.totalIssues} 个），需立即修改`,
      };
    }

    if (summary.totalIssues === 0) {
      return {
        name: '写作/格式质量',
        score: 0.95,
        status: 'pass',
        detail: `写作审计通过：${summary.toolsFound} 项检查均未发现问题`,
      };
    }

    if (summary.totalIssues <= 3 && summary.high === 0) {
      return {
        name: '写作/格式质量',
        score: 0.8,
        status: 'pass',
        detail: `共 ${summary.totalIssues} 个轻微问题，建议顺手修复`,
      };
    }

    if (summary.totalIssues <= 10 && summary.high <= 1) {
      return {
        name: '写作/格式质量',
        score: 0.6,
        status: 'warn',
        detail: `共 ${summary.totalIssues} 个问题（高危 ${summary.high}，中等 ${summary.medium}），建议投稿前修复`,
      };
    }

    return {
      name: '写作/格式质量',
      score: 0.35,
      status: 'fail',
      detail: `共 ${summary.totalIssues} 个问题（严重 ${summary.critical}，高危 ${summary.high}），影响稿件质量`,
    };
  }

  extractWritingAuditSummary(toolResults?: ToolResult[]): WritingAuditSummary | undefined {
    const auditNames = new Set([
      'latex_integrity_report',
      'section_audit',
      'figure_audit',
      'table_audit',
      'math_audit',
      'latex_cleanup',
    ]);

    const auditResults = toolResults?.filter((tr) => auditNames.has(tr.toolName)) ?? [];
    if (auditResults.length === 0) return undefined;

    let totalIssues = 0;
    let critical = 0;
    let high = 0;
    let medium = 0;
    let low = 0;
    const toolsFound = new Set<string>();
    const topIssues: WritingAuditSummary['topIssues'] = [];

    for (const result of auditResults) {
      const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? '');
      if (!text) continue;
      toolsFound.add(result.toolName);

      const totalMatch = text.match(/Total issues:\s*(\d+)/i);
      if (totalMatch) {
        totalIssues += parseInt(totalMatch[1]!, 10);
      }

      const criticalMatch = text.match(/critical:\s*(\d+)/i);
      if (criticalMatch) critical += parseInt(criticalMatch[1]!, 10);

      const highMatch = text.match(/high:\s*(\d+)/i);
      if (highMatch) high += parseInt(highMatch[1]!, 10);

      const mediumMatch = text.match(/medium:\s*(\d+)/i);
      if (mediumMatch) medium += parseInt(mediumMatch[1]!, 10);

      const lowMatch = text.match(/low:\s*(\d+)/i);
      if (lowMatch) low += parseInt(lowMatch[1]!, 10);

      // Collect first few issue lines like "- [type] file:line — message"
      const issueLines = text.match(/^-\s*\[[^\]]+\]\s*.+$/gm) ?? [];
      for (const line of issueLines.slice(0, 3)) {
        if (topIssues.length >= 10) break;
        topIssues.push({ tool: result.toolName, message: line.trim() });
      }
    }

    return { totalIssues, critical, high, medium, low, toolsFound: toolsFound.size, topIssues, recommendations: [] };
  }

  // ─── Composite ────────────────────────────────────────────

  private computeOverall(dimensions: DimensionScore[], recommendations: string[]): number {
    // 9 dimensions: reproducibility, numerical sourcing, reference authenticity,
    // tool-call audit, self-consistency, retraction check, provenance coverage,
    // claim faithfulness, writing/format quality.
    const weights = [0.11, 0.13, 0.13, 0.09, 0.09, 0.13, 0.07, 0.13, 0.12];
    let total = 0;
    let totalWeight = 0;

    for (let i = 0; i < dimensions.length; i++) {
      const w = weights[i] ?? 0.1;
      total += dimensions[i]!.score * w;
      totalWeight += w;
    }

    const score = Math.round((total / totalWeight) * 100);

    // Generate recommendations
    for (const dim of dimensions) {
      if (dim.status === 'fail') {
        recommendations.push(`[${dim.name}] ${dim.detail} — 建议人工审核`);
      } else if (dim.status === 'warn') {
        recommendations.push(`[${dim.name}] ${dim.detail}`);
      }
    }

    return score;
  }

  private makeVerdict(score: number): { text: string; color: 'green' | 'yellow' | 'red' } {
    if (score >= 80) return { text: `[通过] 可信度高 (${score}/100) — 输出有可靠数据支撑`, color: 'green' };
    if (score >= 60) return { text: `[警告] 可信度中等 (${score}/100) — 部分声明无法验证，建议审核`, color: 'yellow' };
    return { text: `[失败] 可信度低 (${score}/100) — 存在大量无法验证的声明，不建议直接引用`, color: 'red' };
  }

  /**
   * Format report as human-readable markdown.
   */
  formatReport(report: IntegrityReport): string {
    const lines: string[] = [
      `# [实验] Metis 研究诚信报告`,
      ``,
      `**综合评分**: ${report.overallScore}/100`,
      `**判定**: ${report.verdict}`,
      `**会话**: ${report.sessionId}`,
      `**生成时间**: ${new Date(report.generatedAt).toISOString()}`,
      ``,
      `## 维度评分`,
      ``,
      ...report.dimensions.map((d) => {
        const icon = d.status === 'pass' ? '[通过]' : d.status === 'warn' ? '[警告]' : '[失败]';
        return `- ${icon} **${d.name}**: ${d.score.toFixed(2)} — ${d.detail}`;
      }),
      ``,
    ];

    if (report.raw.writingAudit && report.raw.writingAudit.toolsFound > 0) {
      const wa = report.raw.writingAudit;
      lines.push(`## 写作/格式审计明细`, ``);
      lines.push(`- 审计工具数: ${wa.toolsFound}`);
      lines.push(`- 问题总数: ${wa.totalIssues}（严重 ${wa.critical}，高危 ${wa.high}，中等 ${wa.medium}，低危 ${wa.low}）`);
      lines.push(``);

      if (wa.topIssues.length > 0) {
        lines.push(`### 主要问题`);
        for (const issue of wa.topIssues) {
          lines.push(`- [${issue.tool}] ${issue.message}`);
        }
        lines.push(``);
      }

      if (wa.recommendations.length > 0) {
        lines.push(`### 修改建议`);
        lines.push(...wa.recommendations.map((r) => `- ${r}`));
        lines.push(``);
      }
    }

    if (report.recommendations.length > 0) {
      lines.push(`## 建议`, ``);
      lines.push(...report.recommendations.map((r) => `- ${r}`));
      lines.push(``);
    }

    return lines.join('\n');
  }
}

// ─── Singleton ─────────────────────────────────────────────

let _instance: IntegrityReporter | null = null;

export function getIntegrityReporter(): IntegrityReporter {
  if (!_instance) {
    _instance = new IntegrityReporter();
  }
  return _instance;
}
