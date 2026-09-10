import {
  ScenarioDefinitionSchema,
  type PersonalizationDefinition,
  type ScenarioDefinition,
} from '../runtime/PersonalizationRuntimeContract.js';
import type { ScenarioPhase } from './ScenarioPhaseGates.js';
import {
  assessScenarioHarness,
  normalizeScenarioHarness,
  renderScenarioMetisMarkdown,
  type ScenarioHarnessAssessment,
} from './ScenarioHarness.js';

const MAX_DIFF_ENTRIES = 500;
const MAX_DIFF_VALUE_CHARS = 8_000;

export interface ScenarioHarnessDiffEntry {
  path: string;
  kind: 'add' | 'remove' | 'change';
  before: unknown;
  after: unknown;
}

export interface ScenarioHarnessCompilation {
  scenario: ScenarioDefinition;
  summary: string;
  diff: ScenarioHarnessDiffEntry[];
  assessment: ScenarioHarnessAssessment;
}

export type ScenarioHarnessCompilationResult =
  | { ok: true; compilation: ScenarioHarnessCompilation }
  | { ok: false; code: 'parse_failed' | 'invalid_candidate'; issues: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_DIFF_VALUE_CHARS) {
    return `${value.slice(0, MAX_DIFF_VALUE_CHARS)}…`;
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function diffValues(before: unknown, after: unknown, path: string, output: ScenarioHarnessDiffEntry[]): void {
  if (output.length >= MAX_DIFF_ENTRIES || sameJson(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const keyed = before.every((item) => isRecord(item) && typeof item.id === 'string')
      && after.every((item) => isRecord(item) && typeof item.id === 'string');
    if (keyed) {
      const beforeById = new Map(before.map((item) => [(item as { id: string }).id, item]));
      const afterById = new Map(after.map((item) => [(item as { id: string }).id, item]));
      for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
        diffValues(beforeById.get(id), afterById.get(id), `${path}[${id}]`, output);
      }
      return;
    }
    output.push({ path, kind: 'change', before: boundedValue(before), after: boundedValue(after) });
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      diffValues(before[key], after[key], path ? `${path}.${key}` : key, output);
    }
    return;
  }
  output.push({
    path,
    kind: before === undefined ? 'add' : after === undefined ? 'remove' : 'change',
    before: boundedValue(before),
    after: boundedValue(after),
  });
}

export function diffScenarioHarness(before: ScenarioDefinition, after: ScenarioDefinition): ScenarioHarnessDiffEntry[] {
  const output: ScenarioHarnessDiffEntry[] = [];
  diffValues(before, after, '', output);
  return output;
}

function extractJsonObject(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object found');
  return JSON.parse(stripped.slice(start, end + 1)) as unknown;
}

/**
 * Parse an AI compiler response at a strict trust boundary. Identity, revision and provenance
 * always come from the current persisted Scenario and cannot be rewritten by model output.
 */
export function parseScenarioHarnessCompilerResponse(
  text: string,
  current: ScenarioDefinition,
  definitions: readonly PersonalizationDefinition[] = [],
): ScenarioHarnessCompilationResult {
  let decoded: unknown;
  try {
    decoded = extractJsonObject(text);
  } catch {
    return { ok: false, code: 'parse_failed', issues: ['The compiler response did not contain valid JSON.'] };
  }
  if (!isRecord(decoded) || !isRecord(decoded.scenario)) {
    return { ok: false, code: 'parse_failed', issues: ['The compiler response must contain a scenario object.'] };
  }
  const rawCandidate: Record<string, unknown> = {
    ...decoded.scenario,
    contractVersion: current.contractVersion,
    id: current.id,
    kind: 'scenario',
    revision: current.revision,
    provenance: current.provenance,
  };
  const parsed = ScenarioDefinitionSchema.safeParse(rawCandidate);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_candidate',
      issues: parsed.error.issues.slice(0, 64).map((item) => `${item.path.join('.') || 'scenario'}: ${item.message}`),
    };
  }
  const scenario = normalizeScenarioHarness(parsed.data);
  if (scenario.scenarioMetis) {
    scenario.scenarioMetis.markdown = renderScenarioMetisMarkdown(scenario.scenarioMetis);
  }
  const reparsed = ScenarioDefinitionSchema.safeParse(scenario);
  if (!reparsed.success) {
    return {
      ok: false,
      code: 'invalid_candidate',
      issues: reparsed.error.issues.slice(0, 64).map((item) => `${item.path.join('.') || 'scenario'}: ${item.message}`),
    };
  }
  return {
    ok: true,
    compilation: {
      scenario: reparsed.data,
      summary: typeof decoded.summary === 'string' ? decoded.summary.slice(0, 4_000) : '',
      diff: diffScenarioHarness(normalizeScenarioHarness(current), reparsed.data),
      assessment: assessScenarioHarness(reparsed.data, definitions),
    },
  };
}

export function buildScenarioHarnessCompilerPrompt(input: {
  instruction: string;
  current: ScenarioDefinition;
  definitions: readonly PersonalizationDefinition[];
  materialContext?: readonly { name: string; text: string }[];
}): { system: string; user: string } {
  const catalog = input.definitions.map((definition) => ({
    id: definition.id,
    kind: definition.kind,
    name: definition.name,
    description: definition.description,
  }));
  const materials = (input.materialContext ?? []).map((material) => ({
    name: material.name,
    text: material.text.slice(0, 100_000),
  }));
  return {
    system: [
      'You are the METIS Research Harness compiler working INCREMENTALLY (2026-08-22).',
      'Build or update the scenario part by part with the scenario_apply_update tool; never emit the whole scenario at once.',
      'STRICT TURN DISCIPLINE — every assistant reply must contain EXACTLY ONE scenario_apply_update call and nothing else. No prose, no plan text, no repeated content between calls.',
      'Each call must advance the build with NEW content. Recommended order: (1) basics — name, description, capability, deliverable type/length/structure; (2) workflow — add 1-2 steps per call (entries merge by id; give each step a stable unique id, a dedicated prompt and completionCriteria); (3) sections + scenarioMetis.markdown rules; (4) output.plan quality criteria.',
      'SKILL/MCP PLANNING IS MANDATORY (2026-08-23): for EVERY workflow step, review the installed resource catalog and bind the skills the step needs via skillIds and any required MCP servers via mcpIds. If a needed capability is missing from the catalog, say so explicitly in your final summary instead of inventing IDs. A step with no suitable binding must still justify why none is required in its prompt.',
      BIBLIOGRAPHY_OUTPUT_CONTRACT,
      'BEFORE FINISHING you MUST have produced: a non-empty scenarioMetis.markdown (the scenario-wide Scenario Metis.md rules document) and a non-empty workflowPrompt (end-to-end operating rules). A build without both is incomplete — add them with scenario_apply_update before the final summary.',
      'DELIVERABLE COMPLETENESS (2026-09-04 刘总要求): every deliverable node (chapters, their children, abstract/keywords/references) MUST end up with purpose + instructions + requirements + lengthTarget (references may omit lengthTarget), plus optionalContent/forbidden/method/evidence where genuinely applicable, AND a non-empty deliverable.globalInstructions. Placeholders like 待定/TBD/根据实际情况 or generic filler like "保持学术性" do NOT count as content. A build leaving these empty is incomplete.',
      DELIVERABLE_OWNERSHIP,
      'HARD SCHEMA RULES: completionCriteria MUST be an array of short strings (one criterion per element, never a single string). deliverable.type MUST be exactly one of: theory_paper | empirical_paper | computational_paper | case_study | review_paper | grant_nssfc | grant_postdoc | grant_other | policy_report | survey_report | tech_report | industry_report | thesis | opening_report | completion_report | custom. Never invent deliverable keys like length or structure — use globalLength (a STRING such as "7500字", never a number) and sections. output.plan.primaryDeliverable must be a non-empty short title.',
      'SECTION FIELD VOCABULARY (write ONLY these values): every section kind MUST be exactly one of: title | abstract | keywords | chapter | section | grant_column | attachment | references | other (top-level entries use chapter or front-matter kinds; children use section). Every section status MUST be exactly one of: locked | required | optional | conditional — NEVER Chinese words like 必要/可选 or words like must/mandatory. capability is a short ASCII identifier (e.g. research | writing | custom) — do not invent long labels.',
      'SECTION KIND HIERARCHY: top-level deliverable.sections entries are first-level chapters and MUST use kind "chapter"; only their children use kind "section" (front-matter like title/abstract may sit at top level with those kinds). Never rewrite chapter entries to "section".',
      'Each call is validated immediately. If it returns schema_validation_failed, fix exactly those issues in your next call before moving on.',
      'When every part is done, reply with ONLY: {"summary":"concise change summary"}.',
      'Fallback: if you cannot use tools, return one complete Scenario JSON object {"summary":"...","scenario":{...}} instead.',
      'Preserve contractVersion, id, kind, revision and provenance exactly. Never invent installed resource IDs.',
      'A workflow step may omit agentId. Skill and MCP bindings belong only on the relevant step.',
      'For each step provide a concise name, dedicated prompt, completionCriteria, any required Skills/MCPs, and optional parentStepId for a visible sub-step. Keep the authored workflow in its intended execution order.',
      'Use workflowPrompt for the end-to-end operating rules. Put all scenario-wide rules in one free-form scenarioMetis.markdown document; preserve any existing Markdown unless the user asks to change it.',
      'Do not add user-facing failure policies, retry counts, Hook settings, Loop settings, Checkpoint settings, governance switches, or global Skill/MCP bindings. The runtime derives those mechanisms automatically.',
      'Uploaded materials are compiler context only; do not add them to scenario.materials.',
      'Use only IDs present in the provided resource catalog. Keep the result valid under the strict schema represented by the current scenario.',
    ].join('\n'),
    user: [
      `Instruction:\n${input.instruction}`,
      `Current normalized Scenario:\n${JSON.stringify(normalizeScenarioHarness(input.current), null, 2)}`,
      `Installed resource catalog:\n${JSON.stringify(catalog, null, 2)}`,
      materials.length > 0 ? `Uploaded compiler context:\n${JSON.stringify(materials, null, 2)}` : '',
    ].filter(Boolean).join('\n\n'),
  };
}

/** Shared acquisition policy for every phase (2026-08-23 刘总要求). */
const ACQUISITION_POLICY = [
  'CAPABILITY SOURCING POLICY: if the installed resource catalog lacks a Skill/MCP a workflow step genuinely needs, first verify with scenario_market_search (read-only), then install it with scenario_install_extension (fully authorized by the user).',
  'The install tool returns the new definition id — immediately bind it into the step via scenario_apply_update. Never invent IDs; never reinstall what the catalog already has.',
  'If the market has no suitable candidate or installation fails, continue without it and state the gap honestly in your final summary for this phase.',
].join(' ');

const RESEARCH_FIRST_POLICY = [
  'RESEARCH-BEFORE-WRITING: before writing this phase, use web_search/web_fetch to gather real reference material relevant to THIS phase (domain conventions, structure norms, funding/thesis standards). Keep research BRIEF — at most 2-3 searches/fetches, then move on to writing.',
  'Analyze what you found first, then write the phase content informed by that research. Do not apply generic placeholder text.',
].join(' ');

/**
 * 题录输出契约（2026-08-30 刘总问题 B 修复）：文献检索类步骤必须绑定真实检索
 * 工具，并把查到的题录以 JSON 数组落进产物——运行期的文献入库桥
 * （ScenarioLiteratureBridge）只从该 JSON 结构解析入库，且有真实性闸
 * （DOI 经 crossref 校验 / 仅 URL 直收 / 皆无拒收），凭记忆写的题录进不了文献库。
 */
const BIBLIOGRAPHY_OUTPUT_CONTRACT = [
  'LITERATURE OUTPUT CONTRACT (MANDATORY for any step that gathers/searches literature or builds a bibliography):',
  '(1) the step MUST bind at least one real retrieval capability via skillIds/mcpIds (e.g. openalex_lookup, crossref_lookup, search_papers, arxiv_search, or an equivalent search Skill/MCP from the catalog) — a literature step with no retrieval binding is invalid;',
  '(2) the step prompt MUST require the collected bibliography to be emitted as a ```json fenced block containing ONE array, one object per work: {"title": string, "authors": [string], "year": number, "venue": string, "doi": string (optional), "url": string (optional)};',
  '(3) only works actually returned by a tool call in this run may appear in that array — entries written from model memory are rejected by the ingestion gate and pollute nothing.',
].join(' ');

/**
 * 职责边界（2026-09-04 刘总要求，写死进编译器提示）：
 * Deliverable = 结果契约（最终成果长什么样、每部分怎么写）；
 * Workflow = 生产过程（怎样把它做出来）。Workflow 禁止复制 Deliverable
 * 已声明的完整成文规范，只能引用；Scenario Metis.md 只承载研究行为规则。
 */
const DELIVERABLE_OWNERSHIP = [
  'DELIVERABLE OWNERSHIP: the deliverable blueprint is the AUTHORITATIVE definition of the final artifact — its structure and every part\u2019s content requirements (purpose / instructions / requirements / optionalContent / forbidden / lengthTarget / method / evidence).',
  'WORKFLOW OWNERSHIP: workflow steps describe HOW the deliverables are produced (actions, tools, ordering, execution completion). A workflow step or its completionCriteria MUST NOT restate or independently redefine the writing requirements already declared by a deliverable section — refer to them instead, e.g. "形成 Deliverable 中「文献综述」部分，并满足该部分声明的全部 purpose/instructions/requirements/forbidden/lengthTarget 约束".',
  'SCENARIO METIS OWNERSHIP: scenarioMetis.markdown holds scenario-wide RESEARCH BEHAVIOR rules (truthfulness, evidence, citation, data handling, tool usage, failure recovery) — do NOT write per-section writing style rules (摘要怎么写/综述怎么组织) there; they belong to the deliverable sections.',
].join(' ');

const TOOL_DISCIPLINE = [
  'FINE-GRAINED INCREMENTAL WRITING (2026-08-24, 刘总要求): confirm ONE small piece at a time and apply it IMMEDIATELY with its own scenario_apply_update call — e.g. name first, then description, then capability; one workflow step per call with its complete prompt/criteria/bindings.',
  'If the current draft already satisfies this phase\u2019s requirements, do NOT rewrite it — reply with ONLY {"summary":"本阶段现状已达标，无需修改"} and nothing else.',
  'Each scenario_apply_update must advance this phase with NEW content; validation errors returned by the tool must be fixed in your next call.',
].join(' ');

const PLANNING_TURN_DISCIPLINE = [
  'PLANNING TURN: your ONLY job is to call the outline tool ONCE (scenario_plan_workflow or scenario_plan_sections) registering ids, names/titles and order.',
  'FINE-GRAINED OUTLINE (2026-08-25 刘总规格, MANDATORY): scenario_plan_workflow requires EVERY top-level step to carry subSteps — decompose each step into fine-grained sub-steps such as: gather/search literature & materials (the search sub-step is where MCP/skills get bound later) → build the writing logic/outline → draft the content → review the draft. Adapt the pattern to the step\u2019s nature; minimum 2 sub-steps per step, more when the user\u2019s deliverable breakdown implies them.',
  'scenario_plan_sections (2026-08-28 刘总要求, MANDATORY): register each deliverable chapter WITH its children — EVERY chapter MUST carry 3-5 second-level sub-sections (follow the deliverable.secondarySections policy when present). A chapter without children is a rejected outline. Front-matter (title/abstract/keywords) must sit at top level with kind title/abstract/keywords, NOT as chapters.',
  'Do NOT write prompts, completionCriteria, or any detailed content in this turn. Do NOT web_search/web_fetch in this turn — research happens in fill turns where needed.',
  'Keep ids stable — later fill turns will reference them.',
].join(' ');

function fillTurnDiscipline(
  kind: 'step' | 'substep' | 'section' | 'workflow_prompt' | 'deliverable_global_instructions',
  id: string,
  name: string,
  contextLines: readonly string[] = [],
): string {
  const noResearch = 'Research was already done in earlier turns — do NOT web_search/web_fetch now; write immediately from what you know.';
  const contextBlock = contextLines.length > 0 ? ` Node context (base your content on THIS): ${contextLines.join(' | ')}` : '';
  if (kind === 'workflow_prompt') {
    return [
      `FILL TURN: write ONLY the ${name} (the scenario.workflowPrompt field) via ONE scenario_apply_update call.`,
      'Content: the end-to-end operating rules connecting ALL planned steps and their sub-steps — handoff order, what each consumes/produces, artifact flow, quality gates, failure recovery posture.',
      'Do NOT write any workflow steps, sections, or other fields in this turn.',
      noResearch,
    ].join(' ');
  }
  if (kind === 'deliverable_global_instructions') {
    return [
      'FILL TURN: write ONLY deliverable.globalInstructions via ONE scenario_apply_update call.',
      'Content: the writing/expression requirements shared by the WHOLE final artifact — e.g. 学术化表达与用词准确、核心术语前后一致、章节间论证连续、避免材料堆砌、引用服务于论证、标题层级与正文形成明确关系。',
      'BASE the content on the user instruction, the deliverable type and the actual section outline. Generic filler like "保持学术性" alone is a rejected placeholder.',
      'Do NOT modify sections, workflow, or any other fields in this turn.',
      noResearch,
    ].join(' ');
  }
  if (kind === 'substep') {
    return [
      `FILL TURN: write ONLY the workflow SUB-STEP “${name}” (id: ${id}) via ONE scenario_apply_update call.`,
      'This is a fine-grained sub-step under its parent chapter step. Include: dedicated prompt (exactly what this sub-step does, with concrete quality requirements), completionCriteria (array of verifiable checks), and skillIds/mcpIds bindings — research/gathering sub-steps MUST bind the appropriate search MCP or skills from the catalog.',
      BIBLIOGRAPHY_OUTPUT_CONTRACT,
      'Do NOT modify any other steps or parts of the scenario.',
      noResearch,
    ].join(' ');
  }
  if (kind === 'step') {
    return [
      `FILL TURN: write ONLY the workflow step “${name}” (id: ${id}) via ONE scenario_apply_update call.`,
      'IMPORTANT: reuse the exact id given here — a skeleton with this id (or same title) already exists in the draft; your call MERGES into it.',
      'This step already has sub-steps registered: write the step-level prompt (what this chapter-level step must achieve overall, coordinating its sub-steps), completionCriteria (array of verifiable checks), and skillIds/mcpIds bindings if needed at step level. Do NOT delete or rewrite the sub-steps.',
      'WORKFLOW/Deliverable boundary: describe HOW to execute this step; do NOT restate the full writing requirements declared by the deliverable blueprint — refer to the target section instead.',
      'Do NOT modify any other steps/sections or other parts of the scenario.',
      noResearch,
    ].join(' ');
  }
  // kind === 'section'：Deliverable 节点填写（2026-09-04 升级）——每个节点（章节/
  // 小节/摘要/参考文献等）都必须形成完整内容规范，而不是只补结构。
  return [
    `FILL TURN: write ONLY the deliverable section “${name}” (id: ${id}) via ONE scenario_apply_update call.`,
    'IMPORTANT: reuse the exact id given here — a skeleton with this id (or same title) already exists in the draft; your call MERGES into it (never delete its children).',
    'MANDATORY FIELDS for this one section: purpose（这一部分在全文中的作用）+ instructions（完整的自然语言写作规范：如何组织、采用什么结构、论证展开方式）+ requirements（必须包含的要点，每条一个元素）+ lengthTarget（目标篇幅，如 "2500字"）。',
    'Fill ALSO where genuinely applicable: optionalContent（可包含）、forbidden（禁止出现，如"逐篇罗列""使用本文/本研究"）、method（方法要求）、evidence（证据/引用要求）。标题类部分不需要 method。',
    'QUALITY BAR: every field must be SPECIFIC to this section and this research scenario — derive it from the user instruction, the deliverable type, the section\u2019s position in the outline (parent/sibling sections), and the planned workflow. Generic filler such as "保持学术性" "逻辑清晰" "结构合理" "符合规范" is a REJECTED placeholder; so are 待定/TBD/后续补充/根据实际情况.',
    'Do NOT copy the section\u2019s writing requirements into workflow prompts — the deliverable blueprint is their single source of truth.',
    `Do NOT modify any other sections or parts of the scenario.${contextBlock}`,
    noResearch,
  ].join(' ');
}

export interface ScenarioPhasePromptInput {
  phase: ScenarioPhase;
  instruction: string;
  current: ScenarioDefinition;
  definitions: readonly PersonalizationDefinition[];
  materialContext?: readonly { name: string; text: string }[];
  /** 设计轮（2026-08-24 刘总方案 C）：只出大纲，不填内容。 */
  planMode?: 'workflow' | 'sections';
  /** 填写轮：只填指定步骤/子步骤/交付物节点/全局成文要求/工作流总 Prompt 的详细内容。 */
  fillTarget?: {
    kind: 'step' | 'substep' | 'section' | 'workflow_prompt' | 'deliverable_global_instructions';
    id: string;
    name: string;
    /** 节点上下文（父/相邻章节、在大纲中的位置），驱动填写具备上下文感（2026-09-04）。 */
    contextLines?: readonly string[];
  };
  /** 能力获取轮（2026-08-28 刘总要求）：联网检索并安装 Skill/MCP 后绑定到步骤。 */
  capabilityPass?: boolean;
}

/** 能力获取轮（2026-08-28 刘总要求）：安装工具只在综合轮可用，而综合轮在
 * 填写轮过门后被跳过，导致编译出的场景永远没有 Skill/MCP。此轮是确定性的
 * 补位：逐步骤检索、安装并绑定。 */
const CAPABILITY_PASS_DISCIPLINE = [
  'CAPABILITY PASS: review EVERY workflow step (including sub-steps) and decide whether it needs external capability — literature/data search, web access, document processing, domain tools.',
  'For each needed capability: first check the installed resource catalog; if missing, verify with scenario_market_search, then install with scenario_install_extension (user-authorized, at most the per-build install limit), then IMMEDIATELY bind the returned definition id into the owning step/sub-step via scenario_apply_update (skillIds/mcpIds, scenario-level arrays too).',
  'Never invent ids. Never reinstall what the catalog already has. If no step genuinely needs external capability, bind nothing and reply {"summary":"各步骤无需外部 Skill/MCP"} — do not install for decoration.',
  'Do NOT rewrite prompts/criteria/sections in this turn; only capability bindings may change.',
].join(' ');

/**
 * Per-phase compiler prompt（2026-08-23 刘总方案 v2）：每个阶段独立一轮对话，
 * 强制「先检索 → 再分析 → 后写入」；阶段内容由主进程验收门确定性把关。
 */
export function buildScenarioPhasePrompt(input: ScenarioPhasePromptInput): { system: string; user: string } {
  const catalog = input.definitions.map((definition) => ({ id: definition.id, kind: definition.kind, name: definition.name, description: definition.description }));
  const materials = (input.materialContext ?? []).map((material) => ({ name: material.name, text: material.text.slice(0, 60_000) }));
  const currentJson = JSON.stringify(input.current, null, 2);

  const PHASE_GOALS: Record<ScenarioPhase, string[]> = {
    basics: [
      'PHASE GOAL — 基本信息：write scenario.name (specific, not generic), scenario.description (what this scenario produces, for whom, at least 20 characters of real content), and scenario.capability.',
      'Research how scenarios/tasks of this kind are normally framed before writing.',
    ],
    deliverable: [
      'PHASE GOAL — 交付物蓝图：write deliverable.type (allowed enum only), deliverable.globalLength (STRING like "7500字", never a number), deliverable.globalInstructions (the writing requirements shared by the WHOLE artifact — 学术化表达、术语一致、论证连续；real content, not filler), and deliverable.sections with stable ids and non-empty titles.',
      'EVERY chapter (kind "chapter") MUST carry 3-5 second-level children with stable ids, kind "section" and non-empty titles (2026-08-28 刘总要求; follow deliverable.secondarySections policy when present). Front-matter (title/abstract/keywords/references) sits at top level with its own kind, never as an empty chapter. Also write deliverable.secondarySections {min,max}.',
      'PLANNING VS FILLING (2026-09-04 刘总要求): planning registers the skeleton; the driver then drives a FILL TURN per node. During fills every chapter/section/abstract node MUST end up with purpose + instructions + requirements + lengthTarget (references may omit lengthTarget), plus optionalContent/forbidden/method/evidence where genuinely applicable. A section with only id/title/kind is NOT done.',
      'Research the standard structure of this deliverable type (e.g. grant/postdoc application sections) and mirror it.',
      DELIVERABLE_OWNERSHIP,
    ],
    workflow: [
      'PHASE GOAL — 连续工作流：add workflow steps in SMALL BATCHES of 1-2 steps per call (entries merge by id). Every step needs: stable unique id, concise name, dedicated prompt, array completionCriteria, dependsOn chain, maxTurns.',
      'For each step decide which Skills/MCPs it needs: bind existing catalog ids directly; source missing ones via market search + automatic install.',
      BIBLIOGRAPHY_OUTPUT_CONTRACT,
      'Keep steps strictly serial and ordered as they should execute.',
    ],
    rules: [
      'PHASE GOAL — 场景规则：write a substantive scenarioMetis.markdown document (scenario-wide Metis.md rules: purpose, role boundaries, research rules, tool rules, quality gates, failure recovery — real content, never leave the template) AND workflowPrompt (end-to-end operating rules connecting all steps).',
      'Scope discipline (2026-09-04 刘总要求): scenarioMetis.markdown defines LONG-RUNNING RESEARCH BEHAVIOR rules (truthfulness, evidence, citation integrity, data handling boundaries, tool usage, method constraints, failure recovery). Per-section writing requirements (摘要怎么写/综述怎么组织) belong to the deliverable blueprint — do NOT copy them here.',
      'Base the rules on what the workflow actually does and on conventions found during research.',
    ],
    output_plan: [
      'PHASE GOAL — 输出计划：write output.plan.primaryDeliverable (short title), supportingArtifacts, and concrete qualityCriteria (verifiable statements about the final deliverable quality).',
    ],
  };

  return {
    system: [
      'You are the METIS Research Harness compiler working through ONE specific build phase.',
      ...(input.planMode === 'workflow' ? ['MODE: PLANNING TURN (workflow outline).', PLANNING_TURN_DISCIPLINE] : []),
      ...(input.planMode === 'sections' ? ['MODE: PLANNING TURN (deliverable section outline).', PLANNING_TURN_DISCIPLINE] : []),
      ...(input.fillTarget ? ['MODE: FILL TURN.', fillTurnDiscipline(input.fillTarget.kind, input.fillTarget.id, input.fillTarget.name, input.fillTarget.contextLines ?? [])] : []),
      ...(input.capabilityPass ? ['MODE: CAPABILITY PASS.', CAPABILITY_PASS_DISCIPLINE] : []),
      ...(input.planMode || input.fillTarget || input.capabilityPass ? [] : [ ...PHASE_GOALS[input.phase], RESEARCH_FIRST_POLICY, ACQUISITION_POLICY, TOOL_DISCIPLINE ]),
      DELIVERABLE_OWNERSHIP,
      'HARD SCHEMA RULES: completionCriteria MUST be an array of short strings. deliverable.globalLength MUST be a string. Never touch contractVersion/id/kind/revision/provenance. Only use IDs present in the resource catalog or returned by scenario_install_extension.',
      'SECTION FIELD VOCABULARY (write ONLY these values): section kind MUST be exactly one of: title | abstract | keywords | chapter | section | grant_column | attachment | references | other. Section status MUST be exactly one of: locked | required | optional | conditional — NEVER 必要/可选 or must/mandatory. capability is a short ASCII identifier (research | writing | custom).',
      'Preserve previously written parts: your patches merge into the draft — do not delete or rewrite other phases\u2019 content.',
    ].join('\n'),
    user: [
      `User instruction (overall goal):\n${input.instruction}`,
      `Your current phase: ${input.phase}`,
      `Current normalized Scenario:\n${currentJson}`,
      `Installed resource catalog:\n${JSON.stringify(catalog, null, 2)}`,
      materials.length > 0 ? `Uploaded compiler context:\n${JSON.stringify(materials, null, 2)}` : '',
    ].filter(Boolean).join('\n\n'),
  };
}
