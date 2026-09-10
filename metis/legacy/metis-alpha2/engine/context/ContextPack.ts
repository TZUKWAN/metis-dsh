/**
 * Context Pack generator (METIS-205).
 *
 * Produces a SHORT, STRUCTURED, TASK-RELEVANT context block for small models, so a 9B-class
 * model can act on a long research project without being fed the entire history.
 *
 * The pack is assembled from live project objects (research question, current evidence,
 * recent decisions, current task, allowed tools) and is BOUNDED by a hard character/token
 * budget. Every field carries a back-reference (id) so any statement in the pack can be
 * traced back to its source object (METIS-205: "key info traceable to original object").
 *
 * This complements (does not replace) ContextEngine, which handles message-list budgeting.
 */

import type { ToolSelection } from '../routing/CapabilityRouter.js';

// ─── Inputs (project state) ───────────────────────────────────

export interface ProjectContextInput {
  projectId: string;
  projectTitle: string;
  researchQuestion?: string;
  /** Current research-plan status (METIS-102 lifecycle). */
  planStatus?: string;
  /** Recent key decisions, newest first, each with id + text. */
  recentDecisions?: Array<{ id: string; text: string; at?: number }>;
  /** Current evidence items, each with id + a short label/snippet. */
  evidence?: Array<{ id: string; sourceId: string; snippet: string }>;
  /** The current task/step being worked on. */
  currentTask?: string;
  /** Tool selection from the router (METIS-204). */
  tools?: ToolSelection;
}

export interface ContextPack {
  projectId: string;
  /** Rendered plain-text block to inject into the model context. */
  text: string;
  /** Back-references: every id mentioned in the text, for traceability. */
  references: {
    decisions: string[];
    evidence: string[];
    sources: string[];
  };
  /** Measured size before budgeting (chars). */
  rawChars: number;
  /** Final size after budgeting (chars). */
  finalChars: number;
  /** Whether truncation occurred. */
  truncated: boolean;
}

// ─── Budget ───────────────────────────────────────────────────

/** Hard upper bound on the rendered pack, in characters. ~4 chars/token => ~1500 tokens. */
export const DEFAULT_CONTEXT_PACK_BUDGET_CHARS = 6000;
export const MAX_CONTEXT_PACK_BUDGET_CHARS = 12_000;

// Rough char-per-line targets for each section (keeps the pack readable + bounded).
const SECTION_LIMITS = {
  header: 300,
  question: 400,
  evidence: 2200,
  decisions: 1200,
  task: 500,
  tools: 600,
} as const;

function truncateLines(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Keep whole lines until the budget, then add an ellipsis marker.
  const lines = text.split('\n');
  let out = '';
  for (const line of lines) {
    if ((out + line + '\n').length > maxChars - 30) break;
    out += line + '\n';
  }
  return out + `[…已截断，原始内容更长，参见对象 id]\n`;
}

// ─── Generator ────────────────────────────────────────────────

export function buildContextPack(
  input: ProjectContextInput,
  budgetChars: number = DEFAULT_CONTEXT_PACK_BUDGET_CHARS,
): ContextPack {
  if (budgetChars > MAX_CONTEXT_PACK_BUDGET_CHARS) {
    budgetChars = MAX_CONTEXT_PACK_BUDGET_CHARS;
  }

  const refs = { decisions: [] as string[], evidence: [] as string[], sources: [] as string[] };

  // ── Header
  const status = input.planStatus ? `（计划状态：${input.planStatus}）` : '';
  const header = `# 项目：${input.projectTitle}${status}`.slice(0, SECTION_LIMITS.header);

  // ── Research question
  const question = input.researchQuestion
    ? `## 研究问题\n${input.researchQuestion}`.slice(0, SECTION_LIMITS.question + 20)
    : '## 研究问题\n（待澄清）';

  // ── Evidence (traceable)
  let evidenceBlock = '## 当前证据\n';
  if (input.evidence && input.evidence.length > 0) {
    const kept = [];
    for (const ev of input.evidence) {
      const line = `- [证据 ${ev.id}，来源 ${ev.sourceId}] ${ev.snippet}`;
      kept.push(line);
      refs.evidence.push(ev.id);
      refs.sources.push(ev.sourceId);
    }
    evidenceBlock += truncateLines(kept.join('\n'), SECTION_LIMITS.evidence);
  } else {
    evidenceBlock += '（暂无登记证据）';
  }

  // ── Recent decisions (traceable)
  let decisionsBlock = '## 最近决策\n';
  if (input.recentDecisions && input.recentDecisions.length > 0) {
    const kept = [];
    // newest first assumed; take up to 6
    for (const d of input.recentDecisions.slice(0, 6)) {
      kept.push(`- [决策 ${d.id}] ${d.text}`);
      refs.decisions.push(d.id);
    }
    decisionsBlock += truncateLines(kept.join('\n'), SECTION_LIMITS.decisions);
  } else {
    decisionsBlock += '（暂无最近决策）';
  }

  // ── Current task
  const taskBlock = input.currentTask
    ? `## 当前任务\n${input.currentTask}`.slice(0, SECTION_LIMITS.task + 20)
    : '## 当前任务\n（未指定）';

  // ── Allowed tools (from router)
  let toolsBlock = '## 允许工具\n';
  if (input.tools && input.tools.tools.length > 0) {
    toolsBlock += input.tools.tools.join(', ');
    toolsBlock += `\n（主能力：${input.tools.primaryCapability.name}）`;
  } else {
    toolsBlock += '（未限定）';
  }
  toolsBlock = toolsBlock.slice(0, SECTION_LIMITS.tools + 40);

  // ── Assemble + final hard budget
  const fullText = [header, question, evidenceBlock, decisionsBlock, taskBlock, toolsBlock].join('\n\n');
  const rawChars = fullText.length;

  let finalText = fullText;
  let truncated = false;
  if (finalText.length > budgetChars) {
    // Reserve room for a truncation footer, then cut.
    finalText = finalText.slice(0, budgetChars - 80);
    finalText += '\n\n[…上下文包已达硬上限，更多信息请通过工具按 id 查询原对象。]';
    truncated = true;
  }

  return {
    projectId: input.projectId,
    text: finalText,
    references: refs,
    rawChars,
    finalChars: finalText.length,
    truncated,
  };
}
