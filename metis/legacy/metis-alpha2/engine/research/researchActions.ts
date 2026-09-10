/**
 * researchActions — the action library of the research strategy engine.
 *
 * Each strategy phase names one action; the executor runs the action with the
 * research goal, prior phase outputs, and any user-supplied phase instruction.
 * Actions are methodology-agnostic building blocks: a researcher composes
 * their own sequence (literature → coding → argumentation → writing, or
 * literature → statistics → writing, …) instead of a hard-coded pipeline.
 */

import type { StrategyActionKind } from '../runtime/ResearchStrategyContract.js';
import type { PaperStructureTemplate } from '../runtime/ResearchStrategyContract.js';

export interface ActionRunInput {
  goal: string;
  /** Outputs of previous phases keyed by their phase names. */
  priorOutputs: Record<string, string>;
  /** User-supplied instruction for this phase, if any. */
  userPrompt?: string;
  /** Optional paper structure template (used by the writing action). */
  structure?: PaperStructureTemplate;
}

export interface ActionTemplate {
  kind: StrategyActionKind;
  label: string;
  /** System prompt shaping the model's role for this research action. */
  systemPrompt: string;
  /** User prompt combining goal, prior context, and the user's instruction. */
  buildUserPrompt(input: ActionRunInput): string;
}

const joinPrior = (priorOutputs: Record<string, string>): string => {
  const entries = Object.entries(priorOutputs);
  if (entries.length === 0) return '（无前序阶段输出）';
  return entries
    .map(([phase, output]) => `## 阶段「${phase}」的产出\n${output.slice(0, 12_000)}`)
    .join('\n\n');
};

const withUserPrompt = (base: string, userPrompt?: string): string =>
  userPrompt ? `${base}\n\n研究者对本阶段的额外要求：\n${userPrompt}` : base;

// ─── Action templates ─────────────────────────────────────────

export const ACTION_TEMPLATES: Record<StrategyActionKind, ActionTemplate> = {
  question_formulation: {
    kind: 'question_formulation',
    label: '研究问题界定',
    systemPrompt: '你是人文社会科学研究设计者。把宽泛目标转化为可研究的问题、子问题、分析单位、时空范围与判断标准。你要主动识别歧义并采用可逆假设继续探索，不把普通方法选择变成人工确认关卡。',
    buildUserPrompt(input) {
      return withUserPrompt(
        `研究目标：${input.goal}\n\n已有研究上下文：\n${joinPrior(input.priorOutputs)}\n\n请形成可执行的问题定义：\n1) 核心问题与必要子问题；\n2) 分析单位、时空范围和关键概念；\n3) 需要何种证据才能回答；\n4) 当前不确定性及可逆的工作假设；\n5) 何种发现会迫使研究换路。不要要求研究者逐项确认，直接给出最合理的工作版本并标注可调整处。`,
        input.userPrompt,
      );
    },
  },
  literature_review: {
    kind: 'literature_review',
    label: '文献综述',
    systemPrompt: '你是一名严谨的文献综述研究者。你的任务是：检索与目标相关的文献，筛选出真正相关的部分，按主题归类，综合已有研究，指出研究空白。综述必须基于可核验的文献信息，区分"作者观点"与"你自己的综合判断"，引用时给出文献标识（作者-年份或 DOI）。',
    buildUserPrompt(input) {
      return withUserPrompt(
        `研究目标：${input.goal}\n\n前序阶段产出：\n${joinPrior(input.priorOutputs)}\n\n请完成文献综述：\n1) 检索与目标直接相关的文献并说明检索思路；\n2) 筛选标准与排除理由；\n3) 按主题维度归类并综合各主题的共识与分歧；\n4) 明确指出研究空白与你的研究可贡献的位置。\n输出为结构化中文综述草稿，引用处标注（作者，年份）。`,
        input.userPrompt,
      );
    },
  },
  source_discovery: {
    kind: 'source_discovery',
    label: '资料发现',
    systemPrompt: '你是人文社科资料发现研究者。围绕研究问题主动寻找论文、专著、档案目录、报刊、统计资料、数据库、口述史或其他一手材料。只记录真实检索到或项目中实际存在的资料，不用占位条目冒充来源。',
    buildUserPrompt(input) {
      return withUserPrompt(
        `研究目标：${input.goal}\n\n问题定义与已有资料：\n${joinPrior(input.priorOutputs)}\n\n请自主执行资料发现：\n1) 把研究问题拆成检索概念、同义词、时间与地域限定；\n2) 检索可用来源并记录题名、作者/形成者、年代、出处或稳定标识；\n3) 区分一手材料、二手研究与线索性材料；\n4) 评估材料覆盖、缺口和可获得性；\n5) 若某渠道不可用，主动换用相邻数据库、引文追踪或替代材料。不得虚构检索结果。`,
        input.userPrompt,
      );
    },
  },
  screening: {
    kind: 'screening',
    label: '文献筛选',
    systemPrompt: '你是一名文献筛选助手。根据研究目标与纳入/排除标准，从候选文献中筛出真正相关的部分，并给出每篇的简要理由与相关度评级（高/中/低）。',
    buildUserPrompt(input) {
      return withUserPrompt(
        `研究目标：${input.goal}\n\n候选文献或检索结果：\n${joinPrior(input.priorOutputs)}\n\n请筛选：对每篇候选给出（标题、作者-年份、相关度、纳入或排除、理由）。输出为筛选表。`,
        input.userPrompt,
      );
    },
  },
  conceptual_analysis: {
    kind: 'conceptual_analysis',
    label: '概念与理论分析',
    systemPrompt: '你是理论研究方法专家。你的任务是还原概念在不同作者、文本和语境中的定义、问题意识、逻辑关系与变化，构造可检验的理论映射，并避免把相似词误当同一概念。',
    buildUserPrompt(input) {
      return withUserPrompt(
        `研究目标：${input.goal}\n\n理论文献与问题定义：\n${joinPrior(input.priorOutputs)}\n\n请完成概念与理论分析：\n1) 给出核心概念的来源化定义与使用语境；\n2) 比较不同理论传统的同义、歧义和不可通约处；\n3) 抽取前提、命题、机制与推论；\n4) 建立概念—命题—证据/反例映射；\n5) 指出概念重构或理论推进的可能位置。每个判断都应可追踪到实际文本或明确标为你的推论。`,
        input.userPrompt,
      );
    },
  },
  source_criticism: {
    kind: 'source_criticism',
    label: '史料批判',
    systemPrompt: '你是历史研究中的史料批判专家。对史料执行外部批判与内部批判：真实性、形成者、年代、目的、受众、传递链、立场、沉默与可证范围。不得把后来的解释倒灌进历史行动者。',
    buildUserPrompt(input) {
      return withUserPrompt(
        `研究目标：${input.goal}\n\n候选史料与既有研究：\n${joinPrior(input.priorOutputs)}\n\n请逐类完成史料批判：\n1) 外部批判：来源、真伪、形成时间、版本与传递链；\n2) 内部批判：形成目的、受众、立场、术语语境与信息来源；\n3) 判断每项史料能证明什么、不能证明什么；\n4) 标记相互冲突、相互依赖及共同来源；\n5) 识别保存偏差、制度性沉默和幸存者偏差。输出史料审查表及可用证据链。`,
        input.userPrompt,
      );
    },
  },
  research_design: {
    kind: 'research_design',
    label: '研究设计',
    systemPrompt: '你是人文社科研究设计专家。根据问题和现有条件选择分析单位、案例/样本、资料方案与识别逻辑。优先作出可逆且有理由的决定，不为普通选择停下来等待人工批准。',
    buildUserPrompt(input) {
      return withUserPrompt(
        `研究目标：${input.goal}\n\n问题、文献和前序探索：\n${joinPrior(input.priorOutputs)}\n\n请形成可执行研究设计：\n1) 研究问题与方法的匹配；\n2) 分析单位、案例或总体与样本；\n3) 抽样/比较/识别策略；\n4) 概念操作化或定性敏化概念；\n5) 资料获取和分析步骤；\n6) 失败条件、替代路线与质量检查。直接选择当前证据下最合理的方案，并把不确定选择记录为后续反思点。`,
        input.userPrompt,
      );
    },
  },
  data_collection: {
    kind: 'data_collection',
    label: '资料与数据获取',
    systemPrompt: '你负责依照研究设计获取和整理真实资料。可自主检索公开文献、数据库与项目已有材料；对需要线下访谈、授权档案或尚未提供的数据，只能生成具体采集方案并标记为未取得，绝不能声称已经完成。遇到不可用渠道时主动寻找合法替代来源。',
    buildUserPrompt(input) {
      return withUserPrompt(
        `研究目标：${input.goal}\n\n研究设计和已有来源：\n${joinPrior(input.priorOutputs)}\n\n请执行可在当前环境中完成的资料获取：\n1) 检索并读取可访问的真实资料；\n2) 为每项资料记录来源、获取时间、口径/版本与用途；\n3) 评估覆盖范围、缺失与偏差；\n4) 对不可访问或必须由研究者线下取得的资料，明确标记“尚未取得”，给出采集工具、抽样和记录方案；\n5) 主动寻找能部分回答问题的替代来源。输出真实取得清单、未取得清单及下一步。`,
        input.userPrompt,
      );
    },
  },
  coding: {
    kind: 'coding',
    label: '质性编码',
    systemPrompt: '你是一名质性研究方法专家，精通扎根理论的三级编码（开放编码 → 轴心编码 → 选择编码）。你的任务是把访谈记录、文本或史料资料系统编码并归纳出主题与范畴，编码过程透明可追溯，每条编码标注来源片段。',
    buildUserPrompt(input) {
      return withUserPrompt(
        `研究目标：${input.goal}\n\n待编码资料与前序产出：\n${joinPrior(input.priorOutputs)}\n\n请完成三级编码：\n1) 开放编码：逐段贴标签，标注来源片段；\n2) 轴心编码：把标签归并为范畴，说明范畴间的关系；\n3) 选择编码：提炼核心范畴与故事线，形成理论归纳。\n输出为完整的编码文档（编码表 + 范畴网络 + 归纳结论）。`,
        input.userPrompt,
      );
    },
  },
  data_preparation: {
    kind: 'data_preparation',
    label: '数据准备',
    systemPrompt: '你是社会科学数据管理与测量专家。对真实存在的数据执行结构检查、变量编码、缺失与异常诊断，形成可复现的数据处理记录。没有数据时只能给出准备方案，不得制造观测值或伪造清洗结果。',
    buildUserPrompt(input) {
      return withUserPrompt(
        `研究目标：${input.goal}\n\n研究设计、数据与前序记录：\n${joinPrior(input.priorOutputs)}\n\n请完成数据准备：\n1) 核验数据文件、来源、样本量、时间和空间口径；\n2) 建立变量字典并说明概念操作化；\n3) 诊断缺失、异常、重复、编码与合并问题；\n4) 记录每项转换、排除与衍生变量规则；\n5) 给出准备后数据的可用范围与残余偏差。若原始数据不存在，停止在可执行脚本/步骤和数据需求清单，不得假装已清洗。`,
        input.userPrompt,
      );
    },
  },
  statistics: {
    kind: 'statistics',
    label: '定量分析',
    systemPrompt: '你是一名定量研究方法专家。你负责设计并执行与研究目标匹配的定量分析：明确变量、数据要求、检验或模型选择、结果解读与局限。所有统计结论必须说明方法与假设，不得编造数据。',
    buildUserPrompt(input) {
      return withUserPrompt(
        `研究目标：${input.goal}\n\n数据与前序产出：\n${joinPrior(input.priorOutputs)}\n\n请完成定量分析：\n1) 明确变量与数据要求；\n2) 选择与检验/模型（说明理由与适用条件）；\n3) 解读结果、效应量与局限；\n4) 指出还需要的数据或检验。\n输出为分析方案+结果解读。`,
        input.userPrompt,
      );
    },
  },
  triangulation: {
    kind: 'triangulation',
    label: '三角互证与稳健性检验',
    systemPrompt: '你是证据整合与反证检查专家。主动寻找异质来源、负例、竞争性解释、替代口径和敏感性结果；不是只为既有结论搜集支持。',
    buildUserPrompt(input) {
      return withUserPrompt(
        `研究目标：${input.goal}\n\n当前资料、分析与初步发现：\n${joinPrior(input.priorOutputs)}\n\n请执行三角互证：\n1) 列出每个核心发现的独立证据来源；\n2) 检查来源间是否真正独立；\n3) 搜索反例、冲突材料与竞争性解释；\n4) 按方法执行替代编码、替代模型、替代时段/样本或跨来源核对；\n5) 将结论分为稳健、暂定、冲突和证据不足，并提出无需人工确认即可继续的补证路线。`,
        input.userPrompt,
      );
    },
  },
  argumentation: {
    kind: 'argumentation',
    label: '论证构建',
    systemPrompt: '你是一名论证结构专家。你的任务是构建结构化论证：论点、支持论据（附证据来源）、可能的反驳与回应、限定条件。论证必须清晰区分事实断言、价值判断与解释性主张。',
    buildUserPrompt(input) {
      return withUserPrompt(
        `研究目标：${input.goal}\n\n证据与前序产出：\n${joinPrior(input.priorOutputs)}\n\n请构建结构化论证：\n对每个核心论点给出：\n1) 论点陈述；\n2) 论据（标注证据来源）；\n3) 可能反驳与你的回应；\n4) 限定条件（在什么范围内成立）。\n输出为论证结构文档。`,
        input.userPrompt,
      );
    },
  },
  writing: {
    kind: 'writing',
    label: '论文写作',
    systemPrompt: '你是一名学术写作助手。你按研究者定义的论文结构逐节写作，不擅自增删章节。写作须基于前序阶段的证据与论证，语言学术化，引用一致。',
    buildUserPrompt(input) {
      const structure = input.structure;
      const sections = structure && structure.sections.length > 0
        ? structure.sections.map((section, index) => `${index + 1}. ${section.title}${section.instruction ? `（写作要求：${section.instruction}）` : ''}`).join('\n')
        : '1. 引言\n2. 研究问题与背景\n3. 方法与资料\n4. 发现与分析\n5. 结论';
      return withUserPrompt(
        `研究目标：${input.goal}\n\n论文结构（研究者定义，不可增删）：\n${sections}\n\n前序阶段证据与论证：\n${joinPrior(input.priorOutputs)}\n\n请按上述结构逐节撰写论文正文，每节内容基于前序产出，不得虚构数据或来源。`,
        input.userPrompt,
      );
    },
  },
  analysis: {
    kind: 'analysis',
    label: '文本分析',
    systemPrompt: '你是一名文本分析研究者。你负责对资料进行系统的解释性分析：识别主题、模式与关系，并把发现与研究目标关联起来。',
    buildUserPrompt(input) {
      return withUserPrompt(
        `研究目标：${input.goal}\n\n待分析资料与前序产出：\n${joinPrior(input.priorOutputs)}\n\n请完成文本分析：识别核心主题、模式、关系与例外，给出解释性结论，并说明结论的证据边界。`,
        input.userPrompt,
      );
    },
  },
  synthesis: {
    kind: 'synthesis',
    label: '综合归纳',
    systemPrompt: '你是一名研究综合专家。你把各阶段的发现综合为连贯的研究结论：回答研究问题、说明贡献、指出局限与后续方向。',
    buildUserPrompt(input) {
      return withUserPrompt(
        `研究目标：${input.goal}\n\n各阶段产出：\n${joinPrior(input.priorOutputs)}\n\n请综合归纳：\n1) 回答研究问题；\n2) 核心贡献（区分实证发现与解释性判断）；\n3) 局限与边界；\n4) 后续研究方向。`,
        input.userPrompt,
      );
    },
  },
  quality_audit: {
    kind: 'quality_audit',
    label: '研究质量审计',
    systemPrompt: '你是独立的研究质量审计者。按当前方法的质量标准检查问题—方法—资料—分析—结论全链条，发现缺口时提出明确的重做、回退或降级结论方案，而不是用篇幅或措辞判断质量。',
    buildUserPrompt(input) {
      return withUserPrompt(
        `研究目标：${input.goal}\n\n完整研究过程与产出：\n${joinPrior(input.priorOutputs)}\n\n请执行方法质量审计：\n1) 问题、方法与资料是否匹配；\n2) 关键主张是否有可定位、足够且相对独立的证据；\n3) 是否处理反例、竞争解释、偏差和不确定性；\n4) 方法专属标准是否满足；\n5) 是否存在虚构数据、不可核验来源或超范围结论；\n6) 给出“通过/需补证/需回退/只能降级陈述”的逐项判断及下一行动。`,
        input.userPrompt,
      );
    },
  },
};

export const ACTION_ORDER: StrategyActionKind[] = Object.keys(ACTION_TEMPLATES) as StrategyActionKind[];

/** Built-in default strategy: a balanced quantitative/qualitative review path. */
export function defaultResearchStrategy(): {
  id: string;
  name: string;
  description: string;
  phases: Array<{ action: StrategyActionKind; name: string }>;
} {
  return {
    id: 'strategy_default_general',
    name: '通用研究流程',
    description: '文献综述 → 资料分析 → 论证构建 → 论文写作（默认策略，可在自主科研中自定义）',
    phases: [
      { action: 'literature_review', name: '文献综述' },
      { action: 'analysis', name: '资料分析' },
      { action: 'argumentation', name: '论证构建' },
      { action: 'writing', name: '论文写作' },
    ],
  };
}
