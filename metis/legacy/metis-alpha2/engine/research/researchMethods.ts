/**
 * Automatic humanities/social-science method selection.
 *
 * Method profiles are execution contracts, not teaching wizards. They give the
 * autonomous engine a trusted phase chain and explicit quality criteria while
 * leaving it free to retry, branch and roll back when reflection finds a gap.
 */

import { z } from 'zod';
import type { BaseProvider } from '../providers/BaseProvider.js';
import {
  StrategyActionKindSchema,
  type ResearchStrategyPhase,
  type StrategyActionKind,
} from '../runtime/ResearchStrategyContract.js';

export const RESEARCH_METHOD_FAMILIES = [
  'theoretical',
  'qualitative',
  'historical',
  'quantitative',
  'mixed',
  'general',
] as const;

export type ResearchMethodFamily = (typeof RESEARCH_METHOD_FAMILIES)[number];

export const ResearchMethodFamilySchema = z.enum(RESEARCH_METHOD_FAMILIES);

const MethodPhaseSchema = z.strictObject({
  action: StrategyActionKindSchema,
  name: z.string().trim().min(1).max(200),
  prompt: z.string().max(4_000).optional(),
});

export const ResearchMethodSpecSchema = z.strictObject({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  family: ResearchMethodFamilySchema,
  name: z.string().trim().min(1).max(200),
  rationale: z.string().trim().min(1).max(2_000),
  confidence: z.number().min(0).max(1),
  selectedBy: z.enum(['automatic_heuristic', 'automatic_provider', 'researcher']),
  phases: z.array(MethodPhaseSchema).min(1).max(32),
  sourceNeeds: z.array(z.string().trim().min(1).max(500)).max(32),
  qualityCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(32),
  assumptions: z.array(z.string().trim().min(1).max(500)).max(32),
});

export type ResearchMethodSpec = z.infer<typeof ResearchMethodSpecSchema>;

interface MethodProfile {
  name: string;
  phases: ResearchStrategyPhase[];
  sourceNeeds: string[];
  qualityCriteria: string[];
  assumptions: string[];
}

const phase = (action: StrategyActionKind, name: string, prompt?: string): ResearchStrategyPhase => ({
  action,
  name,
  ...(prompt ? { prompt } : {}),
});

const METHOD_PROFILES: Record<ResearchMethodFamily, MethodProfile> = {
  theoretical: {
    name: '理论研究',
    phases: [
      phase('question_formulation', '界定理论问题与解释目标'),
      phase('literature_review', '梳理理论谱系与核心争论'),
      phase('conceptual_analysis', '概念辨析与理论映射'),
      phase('argumentation', '构建命题、机制与竞争性解释'),
      phase('synthesis', '形成理论模型与适用边界'),
      phase('quality_audit', '审计论证有效性与概念一致性'),
      phase('writing', '撰写理论研究成果'),
    ],
    sourceNeeds: ['经典原典与权威版本', '核心理论争论的一手论述', '相关经验研究与反例'],
    qualityCriteria: [
      '核心概念定义清楚且跨章节一致',
      '命题、前提、推理与结论之间可追踪',
      '主动比较竞争性解释并处理反例',
      '理论贡献及适用边界被明确陈述',
    ],
    assumptions: ['研究目标主要是解释、概念重构或理论发展，而非估计总体参数'],
  },
  qualitative: {
    name: '定性研究',
    phases: [
      phase('question_formulation', '细化解释性研究问题'),
      phase('literature_review', '建立敏化概念与研究缺口'),
      phase('research_design', '设计案例、抽样与资料获取方案'),
      phase('data_collection', '获取并整理访谈、观察或文本资料'),
      phase('coding', '编码、范畴化与负例搜索'),
      phase('analysis', '解释主题、机制与情境差异'),
      phase('triangulation', '跨资料与跨解释三角互证'),
      phase('argumentation', '建立证据支撑的解释性论证'),
      phase('quality_audit', '审计饱和度、反身性与审计轨迹'),
      phase('writing', '撰写定性研究成果'),
    ],
    sourceNeeds: ['访谈、观察、文本或案例资料', '抽样和资料获取过程记录', '可回溯的原始片段与研究备忘录'],
    qualityCriteria: [
      '抽样逻辑、案例边界与资料来源透明',
      '编码或解释能够回溯到原始资料片段',
      '报告负例、分歧材料与研究者反身性',
      '通过资料、方法或解释层面的三角互证检验结论',
    ],
    assumptions: ['研究问题重在理解意义、过程、机制或情境化经验'],
  },
  historical: {
    name: '历史研究',
    phases: [
      phase('question_formulation', '界定时空范围与历史问题'),
      phase('literature_review', '梳理史学争论与既有解释'),
      phase('source_discovery', '发现档案、报刊、口述及相关史料'),
      phase('screening', '建立史料纳入、排除与分层规则'),
      phase('source_criticism', '执行外部与内部史料批判'),
      phase('analysis', '重建时序、情境与历史机制'),
      phase('triangulation', '跨来源互证并处理沉默与冲突'),
      phase('argumentation', '形成历史解释与竞争性叙事比较'),
      phase('quality_audit', '审计史料链、年代与解释边界'),
      phase('writing', '撰写历史研究成果'),
    ],
    sourceNeeds: ['档案、报刊、书信、统计、图像或口述史等一手史料', '史料形成背景和保存传递信息', '不同立场与不同类型的同期来源'],
    qualityCriteria: [
      '史料真伪、作者、形成时间、目的与传递链经过批判',
      '关键事实由异质来源互证，冲突材料不被隐藏',
      '年代、时序与时代语境保持一致',
      '明确讨论史料沉默、幸存偏差与后见之明风险',
    ],
    assumptions: ['研究目标关注历时变化、历史行动者、制度形成或事件解释'],
  },
  quantitative: {
    name: '定量研究',
    phases: [
      phase('question_formulation', '提出可检验问题与理论预期'),
      phase('literature_review', '梳理变量关系、机制与已有证据'),
      phase('research_design', '设计识别策略、抽样与测量方案'),
      phase('data_collection', '获取数据并记录来源与口径'),
      phase('data_preparation', '清理、编码变量并处理缺失数据'),
      phase('statistics', '估计模型、检验假设与报告效应'),
      phase('triangulation', '执行稳健性、替代解释与敏感性检验'),
      phase('synthesis', '解释结果并连接理论机制'),
      phase('quality_audit', '审计测量、模型假设与可复现性'),
      phase('writing', '撰写定量研究成果'),
    ],
    sourceNeeds: ['具有明确来源、口径与时间范围的数据', '变量字典、测量说明和数据处理记录', '支持复核的分析脚本或操作步骤'],
    qualityCriteria: [
      '概念操作化、测量效度与变量口径透明',
      '模型选择、识别假设与统计假设被检查',
      '报告效应量、不确定性、缺失处理与稳健性结果',
      '分析步骤可复现，结论不超出数据和设计所支持的范围',
    ],
    assumptions: ['研究问题需要描述分布、检验关系、估计效应或比较模式'],
  },
  mixed: {
    name: '混合研究',
    phases: [
      phase('question_formulation', '拆分并整合定性与定量研究问题'),
      phase('literature_review', '建立共同理论框架与研究缺口'),
      phase('research_design', '设计并行或序列式混合研究方案'),
      phase('data_collection', '获取可对应的定性与定量资料'),
      phase('data_preparation', '整理定量数据与跨资料对应关系'),
      phase('statistics', '完成定量估计与稳健性检验'),
      phase('coding', '完成定性编码、范畴化与负例搜索'),
      phase('triangulation', '整合收敛、互补与矛盾发现'),
      phase('synthesis', '形成跨方法的元推论'),
      phase('quality_audit', '分别及整体审计方法质量'),
      phase('writing', '撰写混合研究成果'),
    ],
    sourceNeeds: ['能够回答不同子问题的定性与定量资料', '两类资料之间的样本、时间或案例对应关系', '各方法独立的处理与分析记录'],
    qualityCriteria: [
      '定性与定量部分各自满足其方法质量要求',
      '方法组合服务于同一研究问题而非简单拼接',
      '明确处理收敛、互补与矛盾结果',
      '元推论能够追踪到两条证据链及其整合规则',
    ],
    assumptions: ['单一方法不足以回答研究问题，且两类证据可以形成有意义的整合'],
  },
  general: {
    name: '通用人文社科研究',
    phases: [
      phase('question_formulation', '澄清研究问题、范围与可能路径'),
      phase('literature_review', '检索并综合相关研究'),
      phase('source_discovery', '发现可用资料与数据'),
      phase('analysis', '分析材料并识别模式与解释'),
      phase('triangulation', '核对证据、反例与替代解释'),
      phase('argumentation', '构建可追踪的核心论证'),
      phase('quality_audit', '审计证据充分性与结论边界'),
      phase('writing', '撰写研究成果'),
    ],
    sourceNeeds: ['与研究问题直接相关的一手或权威资料', '能够支持关键主张的可定位证据'],
    qualityCriteria: [
      '研究问题、材料范围与方法选择相互匹配',
      '核心判断可追踪到资料或证据',
      '主动检查反例、竞争性解释与结论边界',
    ],
    assumptions: ['当前目标信息不足以可靠锁定单一方法，应先探索材料后在运行中重规划'],
  },
};

const SIGNALS: Record<Exclude<ResearchMethodFamily, 'mixed' | 'general'>, readonly string[]> = {
  theoretical: ['理论', '概念', '思想', '哲学', '规范', '命题', '逻辑', '解释框架', '范畴', '学说', '话语体系'],
  qualitative: ['访谈', '田野', '观察', '民族志', '质性', '定性', '扎根', '叙事', '话语分析', '案例研究', '生命史', '职业认同'],
  historical: ['历史', '档案', '史料', '口述史', '报刊', '书信', '谱系', '演变', '历时', '民国', '古代', '近代'],
  quantitative: ['定量', '统计', '回归', '问卷', '变量', '样本', '数据', '因果', '效应', '假设检验', '实验数据', '计量'],
};

const EXPLICIT_MIXED = /混合研究|混合方法|定性.{0,12}定量|定量.{0,12}定性|访谈.{0,18}(问卷|统计|回归)|(?:问卷|统计|回归).{0,18}访谈/u;

function buildSpec(
  family: ResearchMethodFamily,
  options: { rationale: string; confidence: number; selectedBy: ResearchMethodSpec['selectedBy'] },
): ResearchMethodSpec {
  const profile = METHOD_PROFILES[family];
  return ResearchMethodSpecSchema.parse({
    id: `method_${family}_v1`,
    family,
    name: profile.name,
    rationale: options.rationale,
    confidence: Math.max(0, Math.min(1, options.confidence)),
    selectedBy: options.selectedBy,
    phases: profile.phases.map((item) => ({ ...item })),
    sourceNeeds: [...profile.sourceNeeds],
    qualityCriteria: [...profile.qualityCriteria],
    assumptions: [...profile.assumptions],
  });
}

/** Deterministic, offline-safe selection used when no provider is available. */
export function selectResearchMethod(goal: string): ResearchMethodSpec {
  const normalized = String(goal ?? '').trim().toLowerCase();
  if (EXPLICIT_MIXED.test(normalized)) {
    return buildSpec('mixed', {
      rationale: '研究目标明确要求整合定性与定量证据，因此采用混合研究路径并设置跨方法整合与矛盾处理阶段。',
      confidence: 0.96,
      selectedBy: 'automatic_heuristic',
    });
  }

  const scores = (Object.keys(SIGNALS) as Array<keyof typeof SIGNALS>).map((family) => ({
    family,
    score: SIGNALS[family].reduce((sum, signal) => sum + (normalized.includes(signal) ? 1 : 0), 0),
  })).sort((a, b) => b.score - a.score);
  const first = scores[0];
  const second = scores[1];

  if (first && second && first.score >= 2 && second.score >= 2 && first.score - second.score <= 1) {
    return buildSpec('mixed', {
      rationale: `研究目标同时呈现${METHOD_PROFILES[first.family].name}与${METHOD_PROFILES[second.family].name}信号，先采用可整合的混合路径，并在运行中依据资料可得性继续调整。`,
      confidence: 0.78,
      selectedBy: 'automatic_heuristic',
    });
  }
  if (first && first.score > 0) {
    const confidence = Math.min(0.93, 0.62 + first.score * 0.08);
    return buildSpec(first.family, {
      rationale: `研究目标中的问题表述和资料线索与${METHOD_PROFILES[first.family].name}最匹配；系统将先按该路径探索，并允许根据实际证据自动回退或换路。`,
      confidence,
      selectedBy: 'automatic_heuristic',
    });
  }
  return buildSpec('general', {
    rationale: '目标尚未提供足够的方法或资料线索，先采用通用人文社科探索路径；在发现材料和约束后由反思环节继续重规划。',
    confidence: 0.45,
    selectedBy: 'automatic_heuristic',
  });
}

/** Provider-assisted classification; the phase chain always comes from the trusted catalog. */
export async function selectResearchMethodWithProvider(
  goal: string,
  provider?: BaseProvider,
): Promise<ResearchMethodSpec> {
  if (!provider) return selectResearchMethod(goal);
  try {
    const response = await provider.complete([
      {
        role: 'system',
        content: [
          '你是人文社会科学研究设计模块。只判断当前目标最适合的研究方法家族，不写研究计划。',
          `family 只能是：${RESEARCH_METHOD_FAMILIES.join(', ')}。`,
          '返回严格 JSON：{"family":"...","confidence":0到1,"rationale":"不超过300字的方法匹配理由"}',
          '若目标同时需要可整合的定性与定量证据，选择 mixed；信息不足选择 general。',
        ].join('\n'),
      },
      { role: 'user', content: `研究目标：${String(goal).slice(0, 8_000)}` },
    ], undefined, { temperature: 0.1, thinking: true });
    const parsed = parseProviderSelection(response.content);
    if (!parsed) return selectResearchMethod(goal);
    return buildSpec(parsed.family, {
      rationale: parsed.rationale,
      confidence: parsed.confidence,
      selectedBy: 'automatic_provider',
    });
  } catch {
    return selectResearchMethod(goal);
  }
}

function parseProviderSelection(raw: string): { family: ResearchMethodFamily; confidence: number; rationale: string } | null {
  try {
    const text = String(raw ?? '').trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
    const candidate = (fenced?.[1] ?? text).trim();
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const value = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
    const family = ResearchMethodFamilySchema.safeParse(value.family);
    const confidence = Number(value.confidence);
    const rationale = String(value.rationale ?? '').trim().slice(0, 2_000);
    if (!family.success || !Number.isFinite(confidence) || !rationale) return null;
    return { family: family.data, confidence: Math.max(0, Math.min(1, confidence)), rationale };
  } catch {
    return null;
  }
}

export function researchMethodProfile(family: ResearchMethodFamily): ResearchMethodSpec {
  return buildSpec(family, {
    rationale: `研究者选择了${METHOD_PROFILES[family].name}路径。`,
    confidence: 1,
    selectedBy: 'researcher',
  });
}
