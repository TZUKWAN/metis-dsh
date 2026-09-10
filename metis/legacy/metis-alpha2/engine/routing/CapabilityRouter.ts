/**
 * Two-stage Capability Router (METIS-204).
 *
 * Stage 1 — classifyIntent: maps a free-form user research intent to a research type,
 *           research stage, primary capability id, and a confidence score. Low confidence
 *           yields a minimal clarification request (not a full plan).
 * Stage 2 — selectTools: given the classified intent, selects ONE primary capability,
 *           at most TWO auxiliary capabilities, and 5–12 tools — never the entire library.
 *
 * The router is rule-based (deterministic, testable, no model dependency) per METIS-303's
 * "small-model-friendly" principle: intent classification must not itself require a large
 * model call. This keeps 9B-class models viable.
 *
 * Coverage: ≥50 cross-discipline intent samples are exercised in CapabilityRouter.test.ts
 * (METIS-204 completion criterion).
 */

import { SEVEN_CAPABILITY_PACKS } from '../capabilities/packs/index.js';
import type { CapabilityManifest, ResearchStage } from '../capabilities/types.js';

// ─── Types ────────────────────────────────────────────────────

export type ResearchType =
  | 'literary_close_reading'
  | 'historical_archive'
  | 'philosophical_argument'
  | 'qualitative_interview'
  | 'discourse_analysis'
  | 'quantitative_survey'
  | 'causal_inference'
  | 'literature_review'
  | 'policy_analysis'
  | 'case_study'
  | 'mixed_methods'
  | 'general_research_design';

export interface IntentClassification {
  researchType: ResearchType;
  stage: ResearchStage;
  primaryCapabilityId: string;
  confidence: number; // 0..1
  matchedSignals: string[];
  /** When confidence < CLARIFY_THRESHOLD, the minimal clarification to ask. */
  clarificationNeeded?: string;
}

export interface ToolSelection {
  primaryCapability: CapabilityManifest;
  auxiliaryCapabilityIds: string[];
  /** Tool names enabled for this turn. Bounded to [5, 12]. */
  tools: string[];
}

export const CLARIFY_THRESHOLD = 0.45;
export const MIN_TOOLS = 5;
export const MAX_TOOLS = 12;
export const MAX_AUXILIARY = 2;

// ─── Stage 1: Intent classification ──────────────────────────

/**
 * Keyword/signal table mapping research-intent signals to (researchType, stage,
 * capabilityId, weight). Multiple signals may fire; weights accumulate. The highest-
 * scoring capability wins; confidence = topScore / (topScore + runnerUpScore) style
 * normalization so ambiguity is detectable.
 */
interface SignalRule {
  signals: readonly string[];
  researchType: ResearchType;
  stage: ResearchStage;
  capabilityId: string;
  weight: number;
}

const SIGNAL_RULES: readonly SignalRule[] = [
  // Research design
  { signals: ['研究问题', '研究设计', '选题', '理论框架', 'research question', 'topic', 'research design'], researchType: 'general_research_design', stage: 'design', capabilityId: 'research-design', weight: 2 },
  // Source research
  { signals: ['找资料', '导入', '检索', '去重', '文献检索', 'find papers', 'import', 'search sources', 'openalex', 'crossref', 'semantic scholar', 'doi'], researchType: 'literature_review', stage: 'source_research', capabilityId: 'source-research', weight: 2 },
  // Literature review
  { signals: ['综述', '文献回顾', 'literature review', 'systematic review', 'synthesize', '综述性分析'], researchType: 'literature_review', stage: 'literature_review', capabilityId: 'literature-review', weight: 3 },
  // Qualitative — interview/coding
  { signals: ['访谈', '编码', '主题分析', '话语分析', '叙事', '扎根', 'interview', 'coding', 'thematic', 'discourse', 'narrative', 'grounded theory', '内容分析', 'content analysis', 'case study', '案例比较', 'compare case', '田野', 'fieldnote', 'ethnograph', '法律分析', 'legal analysis'], researchType: 'qualitative_interview', stage: 'qualitative_analysis', capabilityId: 'qualitative-analysis', weight: 3 },
  { signals: ['细读', '文本分析', 'close reading', 'textual', '文本挖掘'], researchType: 'literary_close_reading', stage: 'qualitative_analysis', capabilityId: 'qualitative-analysis', weight: 3 },
  { signals: ['档案', '史料', 'archive', 'historical source'], researchType: 'historical_archive', stage: 'qualitative_analysis', capabilityId: 'qualitative-analysis', weight: 3 },
  { signals: ['质性', 'qualitative'], researchType: 'qualitative_interview', stage: 'qualitative_analysis', capabilityId: 'qualitative-analysis', weight: 2 },
  // Quantitative
  { signals: ['回归', '描述统计', 'regression', 'descriptive stat', '统计', 'logit', 'logistic', 'probit', 'cgss', 'chip', 'cgss 数据', 'survey data'], researchType: 'quantitative_survey', stage: 'quantitative_analysis', capabilityId: 'quantitative-analysis', weight: 3 },
  { signals: ['因果', '双重差分', 'DID', 'iv', '工具变量', '断点', 'rdd', 'causal', 'difference-in-differences', 'instrumental variable', '合成控制', 'synthetic control', '处理效应', 'treatment effect', 'natural experiment'], researchType: 'causal_inference', stage: 'quantitative_analysis', capabilityId: 'quantitative-analysis', weight: 4 },
  { signals: ['定量', 'quantitative', '计量'], researchType: 'quantitative_survey', stage: 'quantitative_analysis', capabilityId: 'quantitative-analysis', weight: 2 },
  // Writing
  { signals: ['写作', '撰写', '初稿', 'write', 'draft', 'manuscript', '组织成', '论证', 'argument', '引言', '章节', 'chapter', '书稿', 'book chapter'], researchType: 'policy_analysis', stage: 'argumentation_writing', capabilityId: 'argumentation-writing', weight: 2 },
  // Verification
  { signals: ['核验', '审查', '引用检查', 'verify', 'audit', 'check citation', '去 ai 味', 'fabricated', 'gb/t 7714', '参考文献格式', 'reference formatter', 'check my citations', '一致性', '逻辑和数字'], researchType: 'policy_analysis', stage: 'verification_delivery', capabilityId: 'verification-delivery', weight: 3 },
];

interface CapabilityScore {
  score: number;
  stage: ResearchStage;
  researchType: ResearchType;
  matched: string[];
  /** weight of the strongest rule that hit this capability so far */
  topWeight: number;
}

function scoreCapabilities(text: string): Map<string, CapabilityScore> {
  const lower = text.toLowerCase();
  const scores = new Map<string, CapabilityScore>();
  for (const rule of SIGNAL_RULES) {
    for (const sig of rule.signals) {
      if (lower.includes(sig.toLowerCase())) {
        const cur = scores.get(rule.capabilityId) ?? {
          score: 0,
          stage: rule.stage,
          researchType: rule.researchType,
          matched: [],
          topWeight: 0,
        };
        cur.score += rule.weight;
        cur.matched.push(sig);
        // The researchType/stage should follow the HIGHEST-weight rule that hit this
        // capability, so e.g. "断点回归" (causal, weight 4) wins researchType over a
        // generic "定量" (weight 2) even if both match within the same capability.
        if (rule.weight > cur.topWeight) {
          cur.topWeight = rule.weight;
          cur.stage = rule.stage;
          cur.researchType = rule.researchType;
        }
        scores.set(rule.capabilityId, cur);
      }
    }
  }
  return scores;
}

export function classifyIntent(userText: string): IntentClassification {
  const scores = scoreCapabilities(userText);
  if (scores.size === 0) {
    // No signal matched — default to research design with low confidence => ask clarification.
    return {
      researchType: 'general_research_design',
      stage: 'design',
      primaryCapabilityId: 'research-design',
      confidence: 0.2,
      matchedSignals: [],
      clarificationNeeded: '请补充您的研究方向或问题，以便 Metis 选择合适的研究能力。',
    };
  }
  const sorted = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  const [topId, top] = sorted[0]!;
  const runnerUp = sorted[1]?.[1].score ?? 0;
  // Confidence: ratio of top over (top + runnerUp). If only one matched, high confidence.
  const confidence = Number((top.score / (top.score + runnerUp)).toFixed(2));
  const result: IntentClassification = {
    researchType: top.researchType,
    stage: top.stage,
    primaryCapabilityId: topId,
    confidence,
    matchedSignals: top.matched,
  };
  if (confidence < CLARIFY_THRESHOLD) {
    result.clarificationNeeded = '您的研究意图同时涉及多个方向，请明确最主要的一个（如：质性编码 / 定量因果 / 文献综述）。';
  }
  return result;
}

// ─── Stage 2: Tool selection ─────────────────────────────────

/**
 * The base tool palette available to the agent. Capability.permissions gate which subset
 * a given capability may use (METIS-207 enforces at call time). selectTools picks 5–12.
 */
const TOOL_PALETTE: Record<string, readonly string[]> = {
  read_source: ['read_file', 'read_pdf', 'search_library', 'list_sources'],
  search_web: ['web_search', 'openalex_search', 'crossref_lookup', 'arxiv_fetch', 'semantic_scholar'],
  write_file: ['write_file', 'save_note', 'create_artifact'],
  execute_code: ['run_python', 'run_stats', 'data_summary'],
  call_external: ['run_latex', 'mcp_connector'],
  access_sensitive: ['read_sensitive'],
};

function toolsForPermissions(permissions: readonly string[]): string[] {
  const tools = new Set<string>();
  for (const perm of permissions) {
    for (const t of TOOL_PALETTE[perm] ?? []) tools.add(t);
  }
  return [...tools];
}

export function selectTools(classification: IntentClassification): ToolSelection {
  const primary = SEVEN_CAPABILITY_PACKS.find((p) => p.id === classification.primaryCapabilityId);
  if (!primary) {
    throw new Error(`Unknown primary capability: ${classification.primaryCapabilityId}`);
  }

  // Primary tools come from its declared permissions.
  const primaryTools = toolsForPermissions(primary.permissions);

  // Auxiliary capabilities: same stage siblings OR complementary stages, excluding primary.
  // Pick at most MAX_AUXILIARY whose tools add NEW tools to the union (no redundancy).
  const candidates = SEVEN_CAPABILITY_PACKS.filter((p) => p.id !== primary.id);
  const auxiliary: string[] = [];
  const toolUnion = new Set(primaryTools);
  // Prefer capabilities whose permissions add tools not already present.
  const ranked = candidates
    .map((p) => {
      const newTools = toolsForPermissions(p.permissions).filter((t) => !toolUnion.has(t));
      return { pack: p, newToolCount: newTools.length };
    })
    .sort((a, b) => b.newToolCount - a.newToolCount);

  for (const { pack, newToolCount } of ranked) {
    if (auxiliary.length >= MAX_AUXILIARY) break;
    if (newToolCount === 0) continue; // skip if it adds nothing
    for (const t of toolsForPermissions(pack.permissions)) toolUnion.add(t);
    auxiliary.push(pack.id);
  }

  // Bound tools to [MIN_TOOLS, MAX_TOOLS]. If fewer than MIN, pad from the global palette
  // by permission relevance; if more than MAX, keep the primary's + most relevant.
  let tools = [...toolUnion];
  if (tools.length < MIN_TOOLS) {
    // Pad with general-purpose tools that any research turn benefits from.
    const pad = ['write_file', 'save_note', 'search_library'].filter((t) => !tools.includes(t));
    tools = [...tools, ...pad].slice(0, MAX_TOOLS);
  }
  if (tools.length > MAX_TOOLS) {
    // Keep all primary tools, then fill from auxiliary up to MAX.
    const primarySet = new Set(primaryTools);
    tools = [...tools].sort((a, b) => {
      const pa = primarySet.has(a) ? 0 : 1;
      const pb = primarySet.has(b) ? 0 : 1;
      return pa - pb;
    }).slice(0, MAX_TOOLS);
  }

  return {
    primaryCapability: primary,
    auxiliaryCapabilityIds: auxiliary,
    tools,
  };
}

// ─── Convenience: the full two-stage route ───────────────────

export interface RoutingResult {
  classification: IntentClassification;
  selection: ToolSelection;
}

export function routeIntent(userText: string): RoutingResult {
  const classification = classifyIntent(userText);
  const selection = selectTools(classification);
  return { classification, selection };
}
