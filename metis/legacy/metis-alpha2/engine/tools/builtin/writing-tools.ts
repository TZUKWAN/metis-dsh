/**
 * writing-tools — 写作与发表支持 AI 工具（T17/T18/T19）。
 *
 *   - format_citations：从项目文献库取指定文献，按 GB/T 7714-2015 /
 *     APA 7 / Chicago 生成"文中引注 + 文末著录"成对输出（T18）。
 *   - build_aigc_report：基于副作用账本生成 AI 参与度报告（T19）。
 *   - simulate_reviewers：审稿人模拟（T29）—— 三种角色审稿提示词工厂，
 *     供对话发起结构化预审（提示词确定性模板，模型执行批判性阅读）。
 */

import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';
import { sharedStore } from '../../persistence/PersistenceStore.js';
import { formatCitationBundle, type CitationStyle, type CitationSource } from '../../research/CitationFormatter.js';
import { buildAigcReport } from '../../research/AigcReport.js';

export const WRITING_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'format_citations',
    description: 'Generate paired in-text citations + bibliography entries from the project library in GB/T 7714-2015, APA 7, or Chicago style. Use whenever the draft cites papers; never hand-write bibliography entries.',
    parameters: {
      type: 'object',
      properties: {
        paperIds: { type: 'array', items: { type: 'string' }, description: 'Library paper ids to cite (order = citation order).' },
        style: { type: 'string', description: 'gbt7714|apa7|chicago (default gbt7714).' },
        projectId: { type: 'string', description: 'Optional: prefer papers linked to this project when ids omitted.' },
      },
    },
  },
  {
    name: 'build_aigc_report',
    description: 'Build an AI-participation report from the side-effect ledger for AIGC disclosure. Call when the user finalizes a manuscript or asks about AI involvement.',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        artifactId: { type: 'string' },
      },
    },
  },
  {
    name: 'simulate_reviewers',
    description: 'Reviewer simulation: returns three structured reviewer prompts (methodological hawk, theoretical opponent, format pedant) to critique the draft. Run the draft through each and return consolidated, numbered comments with section references.',
    parameters: {
      type: 'object',
      properties: {
        draft: { type: 'string', description: 'The manuscript draft text to review.' },
        venue: { type: 'string', description: 'Target journal/venue context (optional).' },
      },
      required: ['draft'],
    },
  },
];

export function getWritingToolHandlers(): Map<string, ToolHandler> {
  const formatCitations: ToolHandler = async (args) => {
    if (!sharedStore) return 'Error: library unavailable.';
    const style: CitationStyle = args.style === 'apa7' || args.style === 'chicago' ? args.style : 'gbt7714';
    const papers = sharedStore.getPapers();
    const ids = Array.isArray(args.paperIds) ? (args.paperIds as unknown[]).filter((id): id is string => typeof id === 'string') : [];
    let selected = ids.length > 0
      ? ids.map((id) => papers.find((paper) => paper.id === id)).filter((paper): paper is NonNullable<typeof paper> => Boolean(paper))
      : papers;
    const projectId = typeof args.projectId === 'string' ? args.projectId : null;
    if (projectId) {
      selected = selected.filter((paper) => paper.projectId === projectId);
    }
    if (selected.length === 0) {
      return JSON.stringify({ style, note: '文献库中没有匹配的文献；请先在资料模式检索导入。', bibliography: [], inText: [] });
    }
    const sources: CitationSource[] = selected.map((paper) => ({
      id: paper.id,
      title: paper.title,
      authors: Array.isArray(paper.authors) ? paper.authors : [],
      year: paper.year ?? 0,
      venue: paper.venue ?? '',
      doi: paper.doi || undefined,
    }));
    const bundle = formatCitationBundle(sources, style);
    return JSON.stringify({
      style,
      count: bundle.bibliography.length,
      note: '文中引注与文末著录一一对应；GB/T 7714 为顺序编码制，序号按引用顺序。',
      inText: bundle.inText,
      bibliography: bundle.bibliography,
    });
  };

  const buildAigc: ToolHandler = async (args) => {
    const projectId = typeof args.projectId === 'string' && args.projectId ? args.projectId : null;
    const artifactId = typeof args.artifactId === 'string' && args.artifactId ? args.artifactId : null;
    let ledgerRows: Array<{ operation: string; committedAt: number }> = [];
    let artifactVersionCount: number | null = null;
    try {
      if (sharedStore) {
        ledgerRows = projectId
          ? sharedStore.raw.prepare('SELECT operation, committed_at FROM side_effect_ledger WHERE project_id = ?').all(projectId).map((row) => {
            const typed = row as { operation: unknown; committed_at: unknown };
            return { operation: String(typed.operation ?? ''), committedAt: Number(typed.committed_at ?? 0) };
          })
          : sharedStore.raw.prepare('SELECT operation, committed_at FROM side_effect_ledger').all().map((row) => {
            const typed = row as { operation: unknown; committed_at: unknown };
            return { operation: String(typed.operation ?? ''), committedAt: Number(typed.committed_at ?? 0) };
          });
        if (artifactId) {
          const row = sharedStore.raw.prepare('SELECT COUNT(*) as c FROM artifact_versions WHERE artifact_id = ?').get(artifactId) as { c: number };
          artifactVersionCount = row.c;
        }
      }
    } catch { /* 账本不可用 → 空报告 */ }
    const report = buildAigcReport({ projectId, artifactId, ledgerRows, artifactVersionCount });
    return JSON.stringify(report);
  };

  const simulateReviewers: ToolHandler = async (args) => {
    const draft = String(args.draft ?? '').slice(0, 40_000);
    const venue = typeof args.venue === 'string' ? args.venue.slice(0, 120) : '';
    if (!draft.trim()) return 'Error: draft is required.';
    const roles = [
      {
        role: 'methodological_hawk',
        prompt: [
          '你是方法论严苛的审稿人。逐节审阅这篇稿件，只挑方法论问题：研究设计与研究问题的匹配度、变量测量与操作化、样本与数据质量、识别策略（内生性/因果推断）、稳健性检验完备性。',
          venue ? `目标期刊语境：${venue}。` : '',
          '要求：输出编号意见列表，每条注明对应章节、问题描述、修改建议；区分「必须修改」与「建议修改」。',
        ].filter(Boolean).join('\n'),
      },
      {
        role: 'theoretical_opponent',
        prompt: [
          '你是持对立理论立场的审稿人。假设你不同意作者的核心理论预设，审阅这篇稿件：理论对话是否充分、文献综述是否选择性偏倚、替代解释是否被排除、概念界定是否自洽、结论是否超出证据边界。',
          '要求：输出编号意见，每条注明章节与修改建议；为稿件指出至少一个值得回应的「善意反对意见」。',
        ].join('\n'),
      },
      {
        role: 'format_pedant',
        prompt: [
          '你是格式与规范挑剔的编辑部初审。检查：标题摘要关键词、结构层级、引注与参考文献配对（是否有没有出处的引注或没有引用的文献）、图表编号与引用、术语前后一致、字数与期刊要求。',
          '要求：输出编号问题清单，能定位到具体位置。',
        ].join('\n'),
      },
    ];
    return JSON.stringify({
      venue: venue || null,
      roles: roles.map((entry) => ({ role: entry.role, prompt: entry.prompt })),
      instruction: '依次以三个角色审阅草稿，汇总为一份分角色编号意见总表；意见要引用原文具体位置，不要泛泛而谈。',
      draftLength: draft.length,
    });
  };

  return new Map<string, ToolHandler>([
    ['format_citations', formatCitations],
    ['build_aigc_report', buildAigc],
    ['simulate_reviewers', simulateReviewers],
  ]);
}
