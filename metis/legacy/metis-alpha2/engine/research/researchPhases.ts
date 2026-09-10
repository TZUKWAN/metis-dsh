/**
 * researchPhases — the four-phase WorkflowDefinition templates that the
 * AutonomousResearchEngine walks: idea → experiment → analysis → paper.
 *
 * Each phase is a WorkflowDefinition consumed by WorkflowEngine, which runs
 * the steps serially against the real agent loop with the phase's allowed
 * tools. Step prompts use {{stepId.output}} to thread upstream outputs.
 *
 * Every tool referenced here was verified to exist in the builtin tool set
 * (engine/tools/builtin/*). Skills are surfaced through `skill_execute`.
 */

import type { WorkflowDefinition } from '../workflow/types.js';
import type { ResearchPhaseKind } from '../runtime/AutonomousRuntimeContract.js';

export const IDEA_PHASE_WORKFLOW: WorkflowDefinition = {
  id: 'autonomous-idea',
  name: '选题与假设',
  description: '调研研究空白，生成候选 idea，提炼可验证假设',
  version: '1.0.0',
  steps: [
    {
      id: 'gap_analysis',
      name: '研究空白分析',
      description: '检索相关文献，识别尚未被充分解决的问题',
      prompt: [
        '研究目标：{{goal}}',
        '请系统检索该方向的最相关文献（用 arxiv_search / search_papers / crossref_lookup / openalex_lookup），',
        '然后用 literature_review 与 literature_triage 归纳当前研究现状，明确指出 2-3 个尚未被充分解决的研究空白。',
        '输出结构化的空白清单，每个空白附 3-5 篇关键支撑文献。',
      ].join('\n'),
      inputFrom: [],
      tools: ['arxiv_search', 'search_papers', 'crossref_lookup', 'openalex_lookup', 'recommend_papers', 'literature_review', 'literature_triage', 'read_pdf', 'memory_recall'],
      maxTurns: 12,
      retry: { maxRetries: 1, onFailPrompt: '如果检索受限，请基于已有知识给出研究空白，不要放弃。' },
    },
    {
      id: 'idea_generation',
      name: '候选 Idea 生成',
      description: '基于空白头脑风暴 2-3 个候选 idea',
      prompt: [
        '基于以下研究空白：\n{{gap_analysis.output}}',
        '请生成 2-3 个具体、可执行、有创新性的候选研究 idea。',
        '可用 multi_agent_orchestrate 派多个专家并行评估各 idea 的可行性与新颖性。',
        '每个 idea 说明：核心主张、与现有工作的差异、可验证性。',
      ].join('\n'),
      inputFrom: ['gap_analysis'],
      tools: ['multi_agent_orchestrate', 'memory_recall', 'memory_remember', 'recommend_papers'],
      maxTurns: 10,
      retry: { maxRetries: 1, onFailPrompt: '若编排受限，请直接基于空白给出 idea。' },
    },
    {
      id: 'hypothesis',
      name: '假设提炼',
      description: '选定最优 idea，提炼可验证假设',
      prompt: [
        '候选 idea：\n{{idea_generation.output}}',
        '请选定其中最有价值的 idea，提炼 1-2 个清晰、可证伪的研究假设（H1, H2...）。',
        '说明每个假设的预期结果、所需数据/实验、以及如何证伪。',
        '用 claim_manifest_add 把核心假设登记为待验证 claim。',
        '最终输出：选定 idea、假设清单、实验预期。',
      ].join('\n'),
      inputFrom: ['idea_generation'],
      tools: ['claim_manifest_add', 'claim_manifest_list', 'memory_remember', 'multi_agent_orchestrate'],
      maxTurns: 8,
      retry: { maxRetries: 1, onFailPrompt: '确保假设可证伪、可执行。' },
    },
  ],
  dependencies: { gap_analysis: [], idea_generation: ['gap_analysis'], hypothesis: ['idea_generation'] },
};

export const EXPERIMENT_PHASE_WORKFLOW: WorkflowDefinition = {
  id: 'autonomous-experiment',
  name: '实验设计与执行',
  description: '设计实验方案、实现代码、执行并记录结果',
  version: '1.0.0',
  steps: [
    {
      id: 'design',
      name: '实验方案设计',
      description: '生成数据集、metric、baseline 方案',
      prompt: [
        '研究目标：{{goal}}',
        '待验证假设：\n{{hypothesis.output}}',
        '请设计严谨的实验方案：数据集（或合成数据）、评价指标、baseline、消融设置。',
        '明确实验的可重复性要求。',
      ].join('\n'),
      inputFrom: [],
      tools: ['memory_recall', 'recommend_papers', 'crossref_lookup', 'multi_agent_orchestrate'],
      maxTurns: 8,
      retry: { maxRetries: 1, onFailPrompt: '方案必须包含可运行的 metric 与 baseline。' },
    },
    {
      id: 'implement',
      name: '实验代码实现',
      description: '编写可执行的实验代码',
      prompt: [
        '实验方案：\n{{design.output}}',
        '请实现完整、可运行的实验代码（优先 Python）。用 write_file 写入实验脚本。',
        '代码要：可独立运行、有明确 metric 输出（METRIC:key=value 格式）、含 baseline 与消融。',
      ].join('\n'),
      inputFrom: ['design'],
      tools: ['write_file', 'read_file', 'execute_code', 'memory_recall'],
      maxTurns: 12,
      retry: { maxRetries: 2, onFailPrompt: '若实现复杂，先用最简 baseline 跑通流程，再补消融。' },
    },
    {
      id: 'run',
      name: '实验执行',
      description: '在沙箱中运行实验并捕获指标',
      prompt: [
        '请用 run_experiment_script 运行已写入的实验脚本，捕获所有 metric。',
        '若失败，先读文件排查错误并修复，再重试（最多 2 次）。',
        '完成后用 experiment_stats / experiment_compare 汇总结果。',
        '输出：所有 metric 的数值表，以及与 baseline 的对比。',
      ].join('\n'),
      inputFrom: ['implement'],
      tools: ['run_experiment_script', 'read_file', 'write_file', 'experiment_stats', 'experiment_compare'],
      maxTurns: 10,
      retry: { maxRetries: 2, onFailPrompt: '若沙箱不支持，改用 execute_code 兜底运行。' },
    },
    {
      id: 'record',
      name: '结果记录',
      description: '把实验结果写入证据账本',
      prompt: [
        '实验结果：\n{{run.output}}',
        '请用 findings_add 把关键发现登记为 finding，用 experiment_to_findings 关联实验与发现。',
        '用 verify_claim 核对实验结果是否支撑先前的假设。',
        '输出：结构化的发现清单 + 假设验证结论。',
      ].join('\n'),
      inputFrom: ['run'],
      tools: ['findings_add', 'findings_list', 'experiment_to_findings', 'verify_claim', 'claim_manifest_verify', 'memory_remember'],
      maxTurns: 8,
      retry: { maxRetries: 1, onFailPrompt: '确保每个 finding 都有实验数据支撑，禁止过度宣称。' },
    },
  ],
  dependencies: { design: [], implement: ['design'], run: ['implement'], record: ['run'] },
};

export const ANALYSIS_PHASE_WORKFLOW: WorkflowDefinition = {
  id: 'autonomous-analysis',
  name: '结果分析',
  description: '统计分析、结果解释、与 baseline 对比',
  version: '1.0.0',
  steps: [
    {
      id: 'analyze',
      name: '统计分析与可视化',
      description: '对实验数据做统计分析',
      prompt: [
        '实验记录：\n{{record.output}}',
        '请用 execute_code 对实验结果做统计分析（显著性、效应量、置信区间），必要时生成图表脚本。',
        '用 figure_audit / table_audit 自检图表与表格的规范性。',
        '输出：统计结论 + 图表清单。',
      ].join('\n'),
      inputFrom: [],
      tools: ['execute_code', 'read_file', 'write_file', 'figure_audit', 'table_audit', 'experiment_stats'],
      maxTurns: 10,
      retry: { maxRetries: 1, onFailPrompt: '若数据不足，明确说明局限并基于现有数据给出最佳分析。' },
    },
    {
      id: 'interpret',
      name: '结果解释',
      description: '结合假设解释结果，防止过度宣称',
      prompt: [
        '统计结果：\n{{analyze.output}}',
        '原始假设：\n{{hypothesis.output}}',
        '请结合假设解释实验结果：哪些假设被支持、哪些被证伪、为什么。',
        '务必用 verify_claim 自检，杜绝过度宣称或选择性报告。',
        '输出：每个假设的验证结论 + 局限性说明。',
      ].join('\n'),
      inputFrom: ['analyze'],
      tools: ['verify_claim', 'claim_manifest_verify', 'provenance_check', 'memory_recall'],
      maxTurns: 8,
      retry: { maxRetries: 1, onFailPrompt: '解释必须忠于数据，承认负面结果。' },
    },
    {
      id: 'compare',
      name: '与 baseline 对比',
      description: '系统对比并定位贡献',
      prompt: [
        '请用 experiment_compare 与 literature_triage 把本工作与 baseline / 相关工作系统对比。',
        '明确本工作的增量贡献与不足。',
        '输出：对比表 + 贡献定位。',
      ].join('\n'),
      inputFrom: ['interpret'],
      tools: ['experiment_compare', 'literature_triage', 'recommend_papers', 'reference_check', 'memory_recall'],
      maxTurns: 8,
      retry: { maxRetries: 1, onFailPrompt: '对比要公平、覆盖主要 baseline。' },
    },
  ],
  dependencies: { analyze: [], interpret: ['analyze'], compare: ['interpret'] },
};

export const PAPER_PHASE_WORKFLOW: WorkflowDefinition = {
  id: 'autonomous-paper',
  name: '论文撰写',
  description: '从大纲到成稿，编译 LaTeX 并审计',
  version: '1.0.0',
  steps: [
    {
      id: 'outline',
      name: '论文大纲',
      description: '生成结构化论文大纲',
      prompt: [
        '研究目标：{{goal}}',
        '假设与发现：\n{{interpret.output}}',
        '实验与对比：\n{{compare.output}}',
        '请生成一份完整的论文大纲（Title/Abstract 要点/Introduction/Related Work/Method/Experiments/Results/Discussion/Conclusion）。',
        '用 writing_stage_check 确认结构完整。',
      ].join('\n'),
      inputFrom: [],
      tools: ['writing_stage_check', 'section_guide', 'memory_recall', 'skill_execute'],
      maxTurns: 8,
      retry: { maxRetries: 1, onFailPrompt: '大纲必须覆盖标准学术论文各节。' },
    },
    {
      id: 'draft_sections',
      name: '逐节起草',
      description: '分专家起草各章节',
      prompt: [
        '大纲：\n{{outline.output}}',
        '请逐节起草完整论文正文。建议用 multi_agent_orchestrate 分专家撰写（methodologist 写 Method，experimentalist 写 Experiments 等）。',
        '所有引用必须用 format_citation 规范化，所有 claim 必须有 provenance。',
        '输出完整 LaTeX 源码（含 abstract/intro/related/method/experiments/results/discussion/conclusion）。',
      ].join('\n'),
      inputFrom: ['outline'],
      tools: ['multi_agent_orchestrate', 'write_file', 'read_file', 'format_citation', 'reference_check', 'findings_list', 'skill_execute'],
      maxTurns: 16,
      retry: { maxRetries: 2, onFailPrompt: '若长度受限，优先保证 Method + Experiments + Results 完整。' },
    },
    {
      id: 'compile_latex',
      name: '编译与审计',
      description: '编译 LaTeX 并运行全套审计',
      prompt: [
        '请对起草的论文运行 LaTeX 审计全家桶：',
        'latex_cleanup / math_audit / section_audit / figure_audit / table_audit / latex_integrity_report / tags_audit。',
        '修复发现的问题，确保编译无误。',
        '输出：审计报告 + 修复后的最终 LaTeX。',
      ].join('\n'),
      inputFrom: ['draft_sections'],
      tools: ['latex_cleanup', 'math_audit', 'section_audit', 'figure_audit', 'table_audit', 'latex_integrity_report', 'tags_audit', 'write_file', 'read_file', 'style_calibration'],
      maxTurns: 12,
      retry: { maxRetries: 2, onFailPrompt: '若编译反复失败，输出最干净的源码并记录未解决错误。' },
    },
    {
      id: 'final',
      name: '定稿与产出',
      description: '生成最终摘要与产出清单',
      prompt: [
        '最终论文：\n{{compile_latex.output}}',
        '请生成：1) 200 字以内的论文摘要；2) 完整的贡献清单；3) 局限性与未来工作。',
        '用 integrity_report 做最终诚信自检。',
        '输出：abstract + contributions + limitations + 完整论文指针。',
      ].join('\n'),
      inputFrom: ['compile_latex'],
      tools: ['integrity_report', 'writing_stage_check', 'findings_list', 'memory_remember'],
      maxTurns: 6,
      retry: { maxRetries: 1, onFailPrompt: '摘要必须如实反映实验结论。' },
    },
  ],
  dependencies: { outline: [], draft_sections: ['outline'], compile_latex: ['draft_sections'], final: ['compile_latex'] },
};

export const PHASE_WORKFLOWS: Partial<Record<ResearchPhaseKind, WorkflowDefinition>> = {
  idea: IDEA_PHASE_WORKFLOW,
  experiment: EXPERIMENT_PHASE_WORKFLOW,
  analysis: ANALYSIS_PHASE_WORKFLOW,
  paper: PAPER_PHASE_WORKFLOW,
};

/**
 * Build the workflow input map that threads the goal + prior phase outputs into
 * the next phase's prompts. WorkflowEngine substitutes {{key}} placeholders.
 */
export function buildPhaseInput(
  goal: string,
  priorOutputs: Partial<Record<string, string>>,
  revisionNote?: string,
): Record<string, unknown> {
  const input: Record<string, unknown> = { goal };
  for (const [key, value] of Object.entries(priorOutputs)) {
    input[key] = value;
  }
  // Revision notes from reflection inject as a top-level key every phase reads.
  if (revisionNote) {
    input.revisionNote = revisionNote;
    input.goal = `${goal}\n\n[反思修订要求] ${revisionNote}`;
  }
  return input;
}
