/**
 * Scenario Definition（Phase 17 / T17-001~011）。
 * 科研方法学任务模板：声明式定义，不保存任何运行态（旧引擎运行态不迁移）。
 */

export interface ScenarioDefinition {
  id: string
  name: string
  description: string
  /** 激活后注入系统提示的方法学指令（按需，未激活零注入——R0-025/026）。 */
  instructions: string
  /** 场景必需的工具（缺失时 activation 校验失败，T17-017）。 */
  requiredTools: string[]
  /** 建议的目标模板（映射到 DSH Goal）。 */
  goalTemplate: string
  /** 证据政策：正式成果中引用文献必须有 evidence 支撑。 */
  evidencePolicy: 'require-evidence-for-citations'
  /** 成果契约：本场景最终产出的 Artifact 类型。 */
  outputContract: string
}

export const LITERATURE_REVIEW: ScenarioDefinition = {
  id: 'literature-review',
  name: '文献综述',
  description: '围绕研究主题系统检索中英文文献，形成知识结构化综述（研究传统/争议/缺口/趋势）。',
  instructions: [
    '先明确研究主题的核心概念与同义词，形成多通道检索计划（核心概念/理论/机制/方法/学者/经典/近期/反向观点）。',
    '中文文献用 ncpssd_search（默认核心期刊），英文用 literature_search（Crossref/OpenAlex 真实来源）。必须实际调用工具获取文献，禁止凭记忆列出任何文献。',
    '对每篇纳入文献区分：研究问题、理论视角、方法与数据、核心结论。不同证据等级不得混成统一陈述。',
    '综合时回答：该领域现在知道什么？还不知道什么？为什么不知道（事实/理论/机制/方法/情境缺口）？接下来应该研究什么？',
    '综述正文引用的每篇文献必须已在项目中保存（literature_save），不得出现无来源条目。',
  ].join('\n'),
  requiredTools: ['literature_search', 'literature_save', 'ncpssd_search'],
  goalTemplate: '完成《{{topic}}》文献综述：真实文献 ≥ N 篇，形成研究传统/争议/缺口结构，产出可继续使用的综述文件。',
  evidencePolicy: 'require-evidence-for-citations',
  outputContract: 'literature-review artifact（markdown，含分主题知识结构与缺口判定）',
}

export const EMPIRICAL_PAPER: ScenarioDefinition = {
  id: 'empirical-paper',
  name: '实证论文',
  description: '从研究问题推出研究设计与数据需求，真实执行分析并形成论证完整的实证论文。',
  instructions: [
    '研究设计必须从研究问题反推：问题 → 需要什么证据 → 需要什么数据 → 研究设计 → 方法。不得因"会某方法"而设计问题。',
    '数据分析必须真实执行：读取数据 → 检查变量 → 清洗 → 按方案执行代码 → 稳健性检查。图表中的数字必须来自真实计算并可追溯代码。',
    '结果与预期相反时如实报告，禁止为论文故事修改结果。',
    '对核心命题执行反向检查：替代解释、因果倒置、第三变量、已有文献是否已解释。',
    '论文按论证链组织：研究问题 → 已有研究及不足 → 理论判断 → 分析框架 → 证据 → 分析 → 结果 → 理论解释 → 结论。',
  ].join('\n'),
  requiredTools: ['literature_search', 'literature_save'],
  goalTemplate: '完成《{{topic}}》实证论文：真实数据分析（可追溯代码）+ 完整论证链 + 可投稿草稿。',
  evidencePolicy: 'require-evidence-for-citations',
  outputContract: 'empirical paper artifact（markdown/docx，含数据、代码与图表引用）',
}

export const THEORETICAL_PAPER: ScenarioDefinition = {
  id: 'theoretical-paper',
  name: '理论论文',
  description: '构建有理论依据的机制框架：X → 机制 → Y，并明确条件与边界。',
  instructions: [
    '核心概念必须有正式理论来源；使用含义与学界一般定义不一致时要明确指出，不得顺着错误概念续写。',
    '理论分析不停留在 X 影响 Y：追问为什么/通过什么过程/在什么条件下/对哪些主体/什么时间尺度/哪些中介与边界。',
    '形成机制链（X → 机制 A → 机制 B → Y，受条件 C/D 与制度环境 E 影响），遵循所属学科的概念体系与理论传统。',
    '区分理论命题与已验证结论：未经验证的机制判断必须标注为待检验命题。',
    '主动反向检查：反例、替代机制、概念重叠、上位/下位概念混淆、分析层级错位。',
  ].join('\n'),
  requiredTools: ['literature_search'],
  goalTemplate: '完成《{{topic}}》理论论文：机制框架 + 概念澄清 + 反向检查 + 可继续发展的理论命题。',
  evidencePolicy: 'require-evidence-for-citations',
  outputContract: 'theoretical paper artifact（markdown，含机制图与命题清单）',
}

export const CSSCI_PAPER: ScenarioDefinition = {
  id: 'cssci-paper',
  name: 'CSSCI 期刊论文',
  description: '面向 CSSCI 来源期刊的中文论文写作：真实中文文献 + 学科风格 + 期刊适配。',
  instructions: [
    '中文文献检索优先 ncpssd_search（默认核心期刊），核心标记必须来自来源白名单。',
    '写作遵循学科风格（马理论：经典文本与历史/现实逻辑；社会学：机制、结构、行动者与经验验证；政治学：制度、权力与治理；等等），不得全部写成同一种通用学术语言。',
    '禁止套话堆砌与机械"首先其次再次"；每章承担明确论证任务，段落为论证链服务。',
    '凡引用文献必须有真实来源并已在项目保存；无法核验的条目不得进入正式成果。',
  ].join('\n'),
  requiredTools: ['literature_search', 'ncpssd_search', 'literature_save'],
  goalTemplate: '完成面向 CSSCI 的《{{topic}}》论文：真实中文文献 ≥ N 篇 + 学科化写作 + 可投稿草稿。',
  evidencePolicy: 'require-evidence-for-citations',
  outputContract: 'cssci paper artifact（markdown/docx）',
}

export const PAPER_REVIEW: ScenarioDefinition = {
  id: 'paper-review',
  name: '论文审读',
  description: '对已有稿件做反向检查与质量评估：论证链、证据真实性、概念准确性、结构完整。',
  instructions: [
    '逐章判定论证任务是否完成：研究问题/文献不足判定/理论/框架/证据/分析/结论链条是否断裂。',
    '检查概念：是否有正式理论来源、是否自造概念、概念重叠、层级混淆、规范判断与经验判断混杂。',
    '检查引用真实性：凡可疑条目标注"待核验"，绝不默认真实。',
    '输出分级意见：必须修改 / 建议修改 / 风险提示，并给出具体可执行的修改任务。',
  ].join('\n'),
  requiredTools: ['literature_search'],
  goalTemplate: '完成《{{topic}}》稿件的审读报告：分级意见 + 可执行修改任务清单。',
  evidencePolicy: 'require-evidence-for-citations',
  outputContract: 'review artifact（markdown，分级意见 + 修改任务清单）',
}

/** 内置场景目录（T17-026~031；funding/journal-selection 待对应插件安装后加入）。 */
export const BUILTIN_SCENARIOS: readonly ScenarioDefinition[] = [
  LITERATURE_REVIEW,
  EMPIRICAL_PAPER,
  THEORETICAL_PAPER,
  CSSCI_PAPER,
  PAPER_REVIEW,
]
