/**
 * research-network-tools — 引文网络与 QA 收口（T14/T34/T35）。
 *
 *   - fetch_citation_network：OpenAlex 引文关系（种子文献被谁引/引了谁，
 *     两层），题录级数据，供综述定位与文献追踪（T14）。
 *   - adversarial_review：独立红队审查通道 —— 与主通道不同的批判性
 *     提示词框架，专挑方法论漏洞（T34）。
 *   - run_qa_gate：定稿前《可信度报告》收口 —— 聚合数字一致性、行为
 *     审计、（由模型侧提供的）引用清单校验结果（T35）。
 */

import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';
import { sharedStore } from '../../persistence/PersistenceStore.js';
import { checkNumberConsistency } from '../../research/NumberConsistencyChecker.js';
import { auditClaims, extractClaimedBehaviors } from '../../research/ClaimAudit.js';
import { makeComputedFact } from '../../research/ComputedFact.js';

export const RESEARCH_NETWORK_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'fetch_citation_network',
    description: 'Fetch a two-layer citation network from OpenAlex for a seed work: who cited it, and what it cites. Use to locate pivotal papers and map a field before a literature review.',
    parameters: {
      type: 'object',
      properties: {
        doi: { type: 'string', description: 'Seed paper DOI (preferred).' },
        title: { type: 'string', description: 'Seed paper title (used when DOI unknown).' },
        limit: { type: 'number', description: 'Max nodes per direction (1-25, default 10).' },
      },
    },
  },
  {
    name: 'adversarial_review',
    description: 'Independent adversarial review (red team): attack the methodology, evidence sufficiency, and causal claims of a draft/analysis from a hostile reviewer stance. Run IN ADDITION to self-reflection before finalizing research outputs (T34).',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The output to attack (analysis, draft section, or conclusion).' },
        stakes: { type: 'string', description: 'Context: what decision depends on this output.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'run_qa_gate',
    description: 'Final QA gate (T35): aggregate trust checks into one pre-submission report — numeric consistency vs computed facts, behavior-claim audit vs the side-effect ledger, and citation-manifest status. Red items must be fixed or explicitly waived before submission.',
    parameters: {
      type: 'object',
      properties: {
        manuscriptText: { type: 'string', description: 'The final text to gate.' },
        computedFacts: {
          type: 'array',
          description: 'Registered computed facts: [{label, value, unit}].',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, value: { type: 'number' }, unit: { type: 'string' } },
            required: ['label', 'value', 'unit'],
          },
        },
        projectId: { type: 'string', description: 'Ledger scope for the behavior audit.' },
      },
      required: ['manuscriptText'],
    },
  },
];

const OPENALEX_MAILTO = 'metis-workbench@localhost';

export function getResearchNetworkToolHandlers(): Map<string, ToolHandler> {
  const fetchCitationNetwork: ToolHandler = async (args) => {
    const doi = typeof args.doi === 'string' ? args.doi.trim().replace(/^https?:\/\/doi\.org\//iu, '') : '';
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const limit = Math.min(Math.max(Number(args.limit ?? 10), 1), 25);
    if (!doi && !title) return 'Error: provide doi or title.';

    // 1. 定位种子 work。
    const locateUrl = doi
      ? `https://api.openalex.org/works/https://doi.org/${doi}?mailto=${OPENALEX_MAILTO}`
      : `https://api.openalex.org/works?filter=title.search:${encodeURIComponent(title)}&per-page=1&mailto=${OPENALEX_MAILTO}`;
    const locateResponse = await fetch(locateUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!locateResponse.ok) return `Error: openalex_locate_http_${locateResponse.status}`;
    const located = await locateResponse.json() as Record<string, unknown>;
    const seed = (Array.isArray((located as { results?: unknown[] }).results) ? (located as { results: Array<Record<string, unknown>> }).results[0] : located) as {
      id?: string; title?: string; referenced_works?: string[]; cited_by_api_url?: string; cited_by_count?: number; publication_year?: number;
    } | undefined;
    if (!seed?.id) return 'Error: seed work not found.';

    // 2. 引出（它引了谁）：referenced_works → 批量取题录。
    const citedBySeed: Array<{ id: string; title: string; year: number }> = [];
    const refs = Array.isArray(seed.referenced_works) ? seed.referenced_works.slice(0, limit) : [];
    if (refs.length > 0) {
      const batch = `https://api.openalex.org/works?filter=openalex_id:${refs.join('|')}&per-page=${limit}&select=id,title,publication_year&mailto=${OPENALEX_MAILTO}`;
      const batchResponse = await fetch(batch, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (batchResponse.ok) {
        const payload = await batchResponse.json() as { results?: Array<{ id: string; title: string; publication_year?: number }> };
        for (const work of payload.results ?? []) {
          citedBySeed.push({ id: work.id, title: work.title, year: work.publication_year ?? 0 });
        }
      }
    }

    // 3. 引入（谁引了它）：cited_by_api_url。
    const citingSeed: Array<{ id: string; title: string; year: number }> = [];
    if (seed.cited_by_api_url) {
      const citesUrl = `${seed.cited_by_api_url}&per-page=${limit}&select=id,title,publication_year&mailto=${OPENALEX_MAILTO}`;
      const citesResponse = await fetch(citesUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (citesResponse.ok) {
        const payload = await citesResponse.json() as { results?: Array<{ id: string; title: string; publication_year?: number }> };
        for (const work of payload.results ?? []) {
          citingSeed.push({ id: work.id, title: work.title, year: work.publication_year ?? 0 });
        }
      }
    }

    return JSON.stringify({
      seed: { id: seed.id, title: seed.title, year: seed.publication_year ?? 0, citedByCount: seed.cited_by_count ?? 0 },
      citingSeed,
      citedBySeed,
      note: '引文关系来自 OpenAlex（题录级）。citingSeed = 谁引用了种子；citedBySeed = 种子引用了谁。',
    });
  };

  const adversarialReview: ToolHandler = async (args) => {
    const content = String(args.content ?? '').slice(0, 40_000);
    const stakes = typeof args.stakes === 'string' ? args.stakes.slice(0, 300) : '';
    if (!content.trim()) return 'Error: content is required.';
    return JSON.stringify({
      instruction: [
        '切换到对抗审查模式（红队）。你的唯一目标是击溃以下研究产出的可信度，不负责赞美。',
        stakes ? `该产出的用途与利害：${stakes}。` : '',
        '从五个方向攻击：① 方法与问题的错配；② 证据不足以支撑结论（找出跳跃）；③ 因果识别缺陷（内生性/混杂/选择偏误）；④ 数据与数字的可疑之处；⑤ 替代解释未被排除。',
        '输出：按严重度排序的攻击清单（每条注明位置与"若要守住需要什么证据"），最后给出"守得住/守不住"的总体判断。',
        '若产物确实无懈可击，明确说"未找到有效攻击点"并说明检查了什么 —— 不得为了输出而编造攻击点。',
      ].filter(Boolean).join('\n'),
      contentPreview: content.slice(0, 200),
      contentLength: content.length,
    });
  };

  const runQaGate: ToolHandler = async (args) => {
    const text = String(args.manuscriptText ?? '');
    const rawFacts = Array.isArray(args.computedFacts) ? args.computedFacts : [];
    const facts = rawFacts
      .filter((item): item is { label: string; value: number; unit: string } => {
        const candidate = item as { label?: unknown; value?: unknown; unit?: unknown };
        return typeof candidate?.label === 'string' && typeof candidate?.value === 'number' && typeof candidate?.unit === 'string';
      })
      .map((item) => makeComputedFact({
        label: item.label,
        value: item.value,
        unit: item.unit,
        source: { kind: 'statistics', engine: 'qa-gate/1', dataFingerprint: 'inline', seed: 0, runId: null },
      }));

    const numberReport = checkNumberConsistency(text, facts);

    const claims = extractClaimedBehaviors(text);
    let ledger: Array<{ operation: string; count: number }> = [];
    try {
      if (sharedStore) {
        const projectId = typeof args.projectId === 'string' && args.projectId ? args.projectId : null;
        const rows = projectId
          ? sharedStore.raw.prepare('SELECT operation, COUNT(*) as c FROM side_effect_ledger WHERE project_id = ? GROUP BY operation').all(projectId)
          : sharedStore.raw.prepare('SELECT operation, COUNT(*) as c FROM side_effect_ledger GROUP BY operation').all();
        ledger = (rows as Array<{ operation: string; c: number }>).map((row) => ({ operation: row.operation, count: row.c }));
      }
    } catch { /* 账本不可用 */ }
    const claimReport = auditClaims(claims, ledger);

    const redItems: string[] = [];
    if (numberReport.counts.mismatch > 0) redItems.push(`数字与计算事实冲突 ${numberReport.counts.mismatch} 处`);
    if (!claimReport.ok) redItems.push('存在与账本不符的行为声称');
    if (numberReport.counts.unverifiable > 0) {
      redItems.push(`${numberReport.counts.unverifiable} 处数字无计算事实支撑（需补依据或删除）`);
    }

    return JSON.stringify({
      verdict: redItems.length === 0 ? 'pass' : 'blocked',
      redItems,
      checks: {
        numericConsistency: { ok: numberReport.ok, counts: numberReport.counts },
        behaviorAudit: { ok: claimReport.ok, claims: claimReport.claims.length, unclaimed: claimReport.unclaimedOperations.length },
        citationTruth: { note: '引用真实性校验由既有 CitationTruth 清单承担；请确认已运行 claim_manifest_verify 并全部通过。' },
      },
      instruction: redItems.length === 0
        ? '可信度门通过：数字有据、行为可审计。投稿前仍需人工通读一遍。'
        : `可信度门拦截：${redItems.join('；')}。修复或在导师确认后显式豁免，否则不应进入投稿版本。`,
    });
  };

  return new Map<string, ToolHandler>([
    ['fetch_citation_network', fetchCitationNetwork],
    ['adversarial_review', adversarialReview],
    ['run_qa_gate', runQaGate],
  ]);
}
