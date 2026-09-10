/**
 * research-coding-tools — 编码与论断-证据链 AI 工具（T13 + T16）。
 *
 * 让证据链从"可选登记"变成"对话中随手可建"：
 *   - save_note_code：AI 编码建议落 note_codes（author=ai、pending 状态，
 *     用户在研究工作区确认/驳回 —— 人在环）。
 *   - list_note_codes：读取项目码簿（编码时保持一致性）。
 *   - link_claim_evidence：登记论断并强制挂证据（无证据的论断不允许落库，
 *     T16 的强制关）。
 */

import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';
import type { ResearchRepository } from '../../persistence/ResearchRepository.js';

export const RESEARCH_CODING_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'save_note_code',
    description: 'Save a coding suggestion into the project codebook (grounded theory style open coding). Each code MUST be tied to a concrete evidence snippet. Suggestions land as pending — the user accepts/rejects them in the research workspace. Always list_note_codes first to stay consistent with the existing codebook.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Short code label (e.g. 制度张力、选择性执行).' },
        content: { type: 'string', description: 'What the code means; include the exact evidence snippet it comes from.' },
        evidenceSnippet: { type: 'string', description: 'The verbatim material excerpt the code is grounded in.' },
        evidenceId: { type: 'string', description: 'Existing evidence id if the snippet is already registered.' },
        confidence: { type: 'number', description: '0-1 confidence for the suggestion.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags (e.g. open/axial/selective).' },
      },
      required: ['code', 'content', 'evidenceSnippet'],
    },
  },
  {
    name: 'list_note_codes',
    description: 'List the project codebook (note codes) with acceptance status. Call before suggesting new codes to avoid duplication and keep the codebook coherent.',
    parameters: {
      type: 'object',
      properties: {
        includeRejected: { type: 'boolean', description: 'Include rejected codes (default false).' },
      },
    },
  },
  {
    name: 'link_claim_evidence',
    description: 'Register a research claim AND link it to evidence in one step. A claim without evidenceId is rejected — every claim in METIS must be traceable to registered evidence (T16). Use after analysis to accumulate the claim-evidence network.',
    parameters: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'The claim as a single declarative sentence.' },
        evidenceId: { type: 'string', description: 'Registered evidence id supporting the claim (required).' },
        claimType: { type: 'string', description: 'assertion|hypothesis|finding|limitation (default finding).' },
        confidence: { type: 'number', description: '0-1 confidence.' },
        note: { type: 'string', description: 'Why this evidence supports the claim.' },
      },
      required: ['statement', 'evidenceId'],
    },
  },
];

export function createResearchCodingToolHandlers(
  repository?: ResearchRepository,
): Map<string, ToolHandler> {
  if (!repository) return new Map();

  const requireProject = (context: { projectId?: unknown }): string => {
    const projectId = typeof context.projectId === 'string' ? context.projectId : '';
    if (!projectId) throw new Error('coding tools require an active research project');
    return projectId;
  };

  const saveNoteCode: ToolHandler = async (args, context) => {
    const projectId = requireProject(context as { projectId?: unknown });
    const code = String(args.code ?? '').trim().slice(0, 80);
    const content = String(args.content ?? '').trim().slice(0, 2000);
    const evidenceSnippet = String(args.evidenceSnippet ?? '').trim().slice(0, 2000);
    if (!code || !content || !evidenceSnippet) {
      return 'Error: code, content and evidenceSnippet are all required — a code must be grounded in a verbatim excerpt.';
    }
    const confidence = typeof args.confidence === 'number' ? Math.max(0, Math.min(1, args.confidence)) : 0.6;
    const evidenceId = typeof args.evidenceId === 'string' && args.evidenceId ? args.evidenceId : null;
    const id = `nc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    repository.saveNoteCode({
      id,
      projectId,
      evidenceId,
      code,
      content: `${content}\n[证据摘录] ${evidenceSnippet}`,
      author: 'ai',
      confidence,
      accepted: 'pending',
      tags: Array.isArray(args.tags) ? (args.tags as unknown[]).filter((tag): tag is string => typeof tag === 'string').slice(0, 6) : [],
      metadata: { suggestedAt: Date.now() },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deletedAt: null,
    } as never);
    return JSON.stringify({
      ok: true,
      noteCodeId: id,
      status: 'pending',
      note: '编码建议已保存为待确认状态，用户可在研究工作区接受或驳回。',
    });
  };

  const listNoteCodes: ToolHandler = async (args, context) => {
    const projectId = requireProject(context as { projectId?: unknown });
    const includeRejected = args.includeRejected === true;
    const codes = repository.listNoteCodes(projectId)
      .filter((entry) => includeRejected || entry.accepted !== 'rejected')
      .slice(0, 100)
      .map((entry) => ({
        id: entry.id,
        code: entry.code,
        accepted: entry.accepted,
        author: entry.author,
        confidence: entry.confidence,
        tags: entry.tags,
      }));
    return JSON.stringify({ projectId, total: codes.length, codes });
  };

  const linkClaimEvidence: ToolHandler = async (args, context) => {
    const projectId = requireProject(context as { projectId?: unknown });
    const statement = String(args.statement ?? '').trim().slice(0, 1000);
    const evidenceId = String(args.evidenceId ?? '').trim();
    if (!statement || !evidenceId) {
      return 'Error: statement and evidenceId are both required — claims without evidence are rejected by design (T16).';
    }
    const evidence = repository.listEvidence(projectId).find((item) => item.id === evidenceId);
    if (!evidence) {
      return `Error: evidence '${evidenceId}' not found in this project. Register the evidence first.`;
    }
    const claimType = args.claimType === 'assertion' || args.claimType === 'hypothesis' || args.claimType === 'limitation' ? args.claimType : 'finding';
    const confidence = typeof args.confidence === 'number' ? Math.max(0, Math.min(1, args.confidence)) : 0.6;
    const claimId = `claim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    repository.saveClaim({
      id: claimId,
      projectId,
      statement,
      claimType,
      confidence,
      status: 'supported',
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deletedAt: null,
    } as never);
    const link = repository.linkClaimEvidence({
      id: `link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      claimId,
      evidenceId,
      relation: 'supports',
      weight: confidence,
      note: typeof args.note === 'string' ? args.note.slice(0, 500) : '',
      createdAt: Date.now(),
    } as never);
    return JSON.stringify({
      ok: true,
      claimId,
      linkId: link.id,
      evidenceId,
      note: '论断已登记并强制挂接证据。',
    });
  };

  return new Map<string, ToolHandler>([
    ['save_note_code', saveNoteCode],
    ['list_note_codes', listNoteCodes],
    ['link_claim_evidence', linkClaimEvidence],
  ]);
}
