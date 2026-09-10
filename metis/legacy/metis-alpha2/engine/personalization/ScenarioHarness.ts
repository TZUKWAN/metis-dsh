import type {
  PersonalizationDefinition,
  ScenarioDefinition,
  ScenarioMetisDocument,
  ScenarioQualityGate,
  ScenarioWritingStyle,
  WorkflowStepBinding,
} from '../runtime/PersonalizationRuntimeContract.js';

export type ScenarioHarnessIssueSeverity = 'blocking' | 'warning';

export interface ScenarioHarnessIssue {
  code: string;
  severity: ScenarioHarnessIssueSeverity;
  path: string;
  message: string;
  autoFixable: boolean;
}

export interface ScenarioHarnessAssessment {
  score: number;
  status: 'ready' | 'needs_attention' | 'blocked';
  issues: ScenarioHarnessIssue[];
  blockingCount: number;
  warningCount: number;
}

const DEFAULT_WRITING_STYLE: ScenarioWritingStyle = {
  voice: 'academic',
  person: 'impersonal',
  tone: 'formal',
  tense: '',
  terminology: [],
  paragraphPattern: '',
  citationStyle: '',
  formulaStyle: '',
  tableFigureStyle: '',
  prohibitedExpressions: [],
  customInstructions: '',
};

const DEFAULT_SCENARIO_METIS: ScenarioMetisDocument = {
  purpose: '',
  roleBoundaries: '',
  researchRules: '',
  writingRules: '',
  toolRules: '',
  qualityGates: '',
  failureRecovery: '',
  markdown: '',
  inheritanceOrder: ['global', 'scenario', 'project'],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function safeLocalId(value: string, fallback: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 150);
  return cleaned || fallback;
}

function normalizeWorkflowStep(step: WorkflowStepBinding): WorkflowStepBinding {
  const description = step.description.trim();
  return {
    ...step,
    goal: step.goal ?? description,
    prompt: step.prompt ?? description,
    inputs: clone(step.inputs ?? []),
    outputs: clone(step.outputs ?? []),
    completionCriteria: [...(step.completionCriteria ?? [])],
    condition: step.condition ?? null,
    failurePolicy: clone(step.failurePolicy ?? {
      action: 'retry',
      retryLimit: 2,
      backtrackStepId: null,
      instruction: '',
    }),
    loop: clone(step.loop ?? {
      enabled: false,
      maxIterations: 1,
      stopCondition: '',
      evaluator: 'completion_criteria',
      onExhausted: 'fail',
      backtrackStepId: null,
    }),
  };
}

/** Render the structured Scenario Metis fields into the exact runtime Markdown layer. */
export function renderScenarioMetisMarkdown(document: ScenarioMetisDocument): string {
  if (document.markdown.trim()) return document.markdown.trim();
  return [
    '# Scenario Metis.md',
    '',
    '## Purpose',
    document.purpose,
    '',
    '## Role boundaries',
    document.roleBoundaries,
    '',
    '## Research rules',
    document.researchRules,
    '',
    '## Writing rules',
    document.writingRules,
    '',
    '## Tool rules',
    document.toolRules,
    '',
    '## Quality gates',
    document.qualityGates,
    '',
    '## Failure recovery',
    document.failureRecovery,
  ].join('\n').trim();
}

/**
 * Upgrade a valid legacy Scenario in memory without changing its identity or revision.
 * All additions are deterministic policy defaults; no research content is fabricated.
 */
export function normalizeScenarioHarness(input: ScenarioDefinition): ScenarioDefinition {
  const scenario = clone(input);
  const workflow = scenario.workflow.map(normalizeWorkflowStep);
  const writingStyle = clone(scenario.writingStyle ?? DEFAULT_WRITING_STYLE);
  const scenarioMetis = clone(scenario.scenarioMetis ?? {
    ...DEFAULT_SCENARIO_METIS,
    purpose: scenario.description,
    writingRules: (scenario.writingRules ?? []).join('\n'),
  });
  if (!scenarioMetis.markdown.trim()) {
    scenarioMetis.markdown = renderScenarioMetisMarkdown(scenarioMetis);
  }
  const rootStepIds = new Set(workflow.map((step) => step.id));
  const firstRootStep = workflow.find((step) => step.dependsOn.length === 0)?.id ?? workflow[0]?.id ?? null;
  const workflowGovernance = clone(scenario.workflowGovernance ?? {
    entryStepId: firstRootStep,
    completionCriteria: [],
    allowDynamicReorder: false,
    allowStepSplit: false,
    allowStepMerge: false,
    allowStepInsertion: false,
    requireChangeLog: true,
    // This is a runtime safety ceiling, not a user-facing workflow setting.
    // Criteria failures are repaired in-place and must not turn into a false
    // terminal result just because a short legacy default was reached.
    maxTotalStepExecutions: 10_000,
  });
  if (workflowGovernance.entryStepId && !rootStepIds.has(workflowGovernance.entryStepId)) {
    workflowGovernance.entryStepId = firstRootStep;
  }
  workflowGovernance.maxTotalStepExecutions = 10_000;
  // 章节层级语义自愈：模型/历史补丁可能把顶层章节写成 "section"，
  // 渲染层只把顶层 "chapter" 当一级章节展示；此处统一纠正，避免结构在重载后"消失"。
  if (scenario.deliverable?.sections?.some((section) => section.kind === 'section')) {
    scenario.deliverable = {
      ...scenario.deliverable,
      sections: scenario.deliverable.sections.map((section) => (
        section.kind === 'section' ? { ...section, kind: 'chapter' as const } : section
      )),
    };
  }
  // 旧 writingRules → globalInstructions 兼容迁移（2026-09-04，任务文档第十七节）：
  // 仅当 globalInstructions 从未填写（undefined）时把能够安全转换的旧规则汇总
  // 进去；旧字段一律保留，保证旧场景可加载可运行。用户显式清空（''）后不回填。
  if (scenario.deliverable && scenario.deliverable.globalInstructions === undefined) {
    const migrated = migrateLegacyGlobalInstructions(scenario);
    if (migrated) scenario.deliverable = { ...scenario.deliverable, globalInstructions: migrated };
  }
  return {
    ...scenario,
    workflow,
    workflowPrompt: scenario.workflowPrompt ?? '',
    agentIds: unique([
      ...scenario.agentIds,
      ...workflow.flatMap((step) => step.agentId ? [step.agentId] : []),
    ]),
    skillIds: unique([...scenario.skillIds, ...workflow.flatMap((step) => step.skillIds)]),
    mcpIds: unique([...scenario.mcpIds, ...workflow.flatMap((step) => step.mcpIds)]),
    writingStyle,
    scenarioMetis,
    workflowGovernance,
    workflowLoop: clone(scenario.workflowLoop ?? {
      enabled: false,
      maxIterations: 1,
      stopCondition: '',
      reentryStepId: firstRootStep,
      carryArtifacts: true,
      onExhausted: 'complete',
    }),
    checkpointPolicy: clone(scenario.checkpointPolicy ?? {
      enabled: true,
      afterEveryStep: true,
      afterEveryLoopIteration: true,
      includeToolCallSummary: true,
      resumeMode: 'continue',
    }),
    qualityGates: clone(scenario.qualityGates ?? []),
    adjustmentLog: clone(scenario.adjustmentLog ?? []),
  };
}

function hasText(value: string | undefined | null): boolean {
  return Boolean(value?.trim());
}

/**
 * 旧版成文规则汇总（兼容迁移，任务文档第十七节）：把旧 Scenario 的
 * writingRules / scenarioMetis.writingRules / writingStyle 中能够安全转换的
 * 文本规则合并为一段 globalInstructions；不删除任何旧字段。无可迁移内容时
 * 返回 null。
 */
function migrateLegacyGlobalInstructions(scenario: ScenarioDefinition): string | null {
  const parts: string[] = [];
  const metisRules = (scenario.scenarioMetis?.writingRules ?? '').trim();
  if (metisRules) parts.push(metisRules);
  const scenarioRules = (scenario.writingRules ?? []).map((rule) => rule.trim()).filter((rule) => rule.length > 0);
  const joinedScenarioRules = scenarioRules.join('\n');
  if (joinedScenarioRules && joinedScenarioRules !== metisRules) parts.push(joinedScenarioRules);
  const style = scenario.writingStyle;
  if (style) {
    const styleBits: string[] = [];
    if (style.prohibitedExpressions && style.prohibitedExpressions.length > 0) {
      styleBits.push(`禁用表达：${style.prohibitedExpressions.join('、')}`);
    }
    const customInstructions = (style.customInstructions ?? '').trim();
    if (customInstructions) styleBits.push(customInstructions);
    if (styleBits.length > 0) parts.push(styleBits.join('；'));
  }
  if (parts.length === 0) return null;
  return parts.join('\n');
}

// ── Deliverable 完整性契约（2026-09-04 刘总要求：AI 填写必须有完整性闭环）──

/** Deliverable section 按 kind 必填的核心内容字段（集中规则，禁止散落多处各写一套）。 */
export type DeliverableRequiredField = 'purpose' | 'instructions' | 'requirements' | 'lengthTarget';

/**
 * 每个 section kind 语义上必须填写的字段。
 * 2026-09 刘总规格：交付物部分只保留「具体写作要求」一个必填提示词字段；
 * 作用/必须包含/禁止事项/方法/证据等结构化字段不再是必填（数据字段保留
 * 向后兼容，AI 构建时仍可填充，但不再对用户制造机械必填负担）。
 */
export function requiredDeliverableFieldsForKind(kind: string): readonly DeliverableRequiredField[] {
  switch (kind) {
    case 'chapter':
    case 'section':
    case 'abstract':
    case 'keywords':
    case 'grant_column':
    case 'references':
    case 'attachment':
    case 'other':
      return ['instructions'];
    case 'title':
    default:
      return [];
  }
}

const PLACEHOLDER_TEXTS = new Set([
  'tbd', 'todo', 'placeholder', '待补充', '待补', '待定', '后续补充', '后续完善',
  '根据实际情况', '视情况而定', '暂无', '由用户决定', 'none', 'n/a', 'na',
]);

/**
 * 确定性 placeholder 检测（任务文档第二十四节）：不做复杂 AI 评分，只做
 * 确定性识别——空文本或整段就是占位词（TBD/待定/根据实际情况等）时，
 * 该字段视为未填写，不得让 required 字段通过完整性检查。
 */
export function isPlaceholderText(value: string | string[] | undefined | null): boolean {
  if (value == null) return true;
  const items = Array.isArray(value) ? value : [value];
  const meaningful = items.map((item) => (item ?? '').trim()).filter((item) => item.length > 0);
  if (meaningful.length === 0) return true;
  return meaningful.every((item) => {
    const normalized = item.toLowerCase().replace(/[。．.！!？?\s]+$/gu, '');
    return PLACEHOLDER_TEXTS.has(normalized);
  });
}

export interface DeliverableCompletenessGap {
  /** 缺失字段所属节点 id；globalInstructions 缺失时为 '__global__'。 */
  sectionId: string;
  sectionTitle: string;
  field: DeliverableRequiredField | 'globalInstructions';
}

/**
 * 收集 Deliverable 完整性缺口（assess 与编译期门共用的单一实现）。
 * 只检查语义上必填的字段（requiredDeliverableFieldsForKind），不要求
 * 所有字段非空——标题/参考文献等部分不制造无意义的机械要求。
 */
export function collectDeliverableCompletenessGaps(scenario: ScenarioDefinition): DeliverableCompletenessGap[] {
  const gaps: DeliverableCompletenessGap[] = [];
  const deliverable = scenario.deliverable;
  if (!deliverable) return gaps;
  if ((deliverable.sections?.length ?? 0) > 0 && isPlaceholderText(deliverable.globalInstructions)) {
    gaps.push({ sectionId: '__global__', sectionTitle: '总体成文要求', field: 'globalInstructions' });
  }
  const visit = (sections: readonly { id: string; title: string; kind: string; purpose?: string; instructions?: string; requirements?: string[]; lengthTarget?: string; children?: unknown[] }[]): void => {
    for (const section of sections) {
      for (const field of requiredDeliverableFieldsForKind(section.kind)) {
        if (field === 'requirements') {
          if (isPlaceholderText(section.requirements)) gaps.push({ sectionId: section.id, sectionTitle: section.title, field });
        } else if (field === 'lengthTarget') {
          if (isPlaceholderText(section.lengthTarget)) gaps.push({ sectionId: section.id, sectionTitle: section.title, field });
        } else if (isPlaceholderText(section[field])) {
          gaps.push({ sectionId: section.id, sectionTitle: section.title, field });
        }
      }
      if (Array.isArray(section.children) && section.children.length > 0) {
        visit(section.children as Parameters<typeof visit>[0]);
      }
    }
  };
  visit(deliverable.sections ?? []);
  return gaps;
}

/** 把完整性缺口渲染为面向模型的中文修复指令（编译器 completeness pass 复用）。 */
export function formatDeliverableCompletenessIssues(gaps: readonly DeliverableCompletenessGap[]): string[] {
  if (gaps.length === 0) return [];
  const fieldLabels: Record<DeliverableCompletenessGap['field'], string> = {
    globalInstructions: '总体成文要求（deliverable.globalInstructions）',
    purpose: '作用（purpose）',
    instructions: '具体写作要求（instructions）',
    requirements: '必须包含（requirements）',
    lengthTarget: '目标篇幅（lengthTarget）',
  };
  const lines: string[] = [];
  const globalGap = gaps.find((gap) => gap.field === 'globalInstructions');
  if (globalGap) {
    lines.push(`deliverable.globalInstructions 缺失：请写出整个最终成果共同遵守的成文要求（全文学术化表达、术语一致性、论证连续性等），不得使用占位文本。`);
  }
  for (const field of ['purpose', 'instructions', 'requirements', 'lengthTarget'] as const) {
    const missing = gaps.filter((gap) => gap.field === field);
    if (missing.length === 0) continue;
    const targets = missing.slice(0, 10).map((gap) => `「${gap.sectionTitle}」(${gap.sectionId})`).join('、');
    lines.push(`以下 Deliverable 部分缺少${fieldLabels[field]}：${targets}${missing.length > 10 ? ` 等 ${missing.length} 处` : ''}。请用 scenario_apply_update 逐个补全，要求必须具体到该部分的内容，禁止「保持学术性/逻辑清晰」这类泛化表述。`);
  }
  return lines;
}

/**
 * 完整性缺口 → assess blocking issues（任务文档第八节规定的 issue 编码：
 * deliverable_global_instructions_missing / section_purpose_missing /
 * section_instructions_missing / section_requirements_missing / section_length_missing）。
 */
function deliverableCompletenessHarnessIssues(gaps: readonly DeliverableCompletenessGap[]): ScenarioHarnessIssue[] {
  const result: ScenarioHarnessIssue[] = [];
  if (gaps.some((gap) => gap.field === 'globalInstructions')) {
    result.push(issue('deliverable_global_instructions_missing', 'blocking', 'deliverable.globalInstructions', 'Deliverable 缺少总体成文要求（globalInstructions）。', false));
  }
  const codeByField: Record<'purpose' | 'instructions' | 'requirements' | 'lengthTarget', string> = {
    purpose: 'section_purpose_missing',
    instructions: 'section_instructions_missing',
    requirements: 'section_requirements_missing',
    lengthTarget: 'section_length_missing',
  };
  const labelByField: Record<'purpose' | 'instructions' | 'requirements' | 'lengthTarget', string> = {
    purpose: '作用（purpose）',
    instructions: '写作要求（instructions）',
    requirements: '必须包含（requirements）',
    lengthTarget: '目标篇幅（lengthTarget）',
  };
  for (const field of ['purpose', 'instructions', 'requirements', 'lengthTarget'] as const) {
    const missing = gaps.filter((gap) => gap.field === field);
    if (missing.length === 0) continue;
    const targets = missing.slice(0, 8).map((gap) => `「${gap.sectionTitle}」`).join('、');
    result.push(issue(codeByField[field], 'blocking', 'deliverable.sections', `以下部分缺少${labelByField[field]}：${targets}${missing.length > 8 ? ` 等 ${missing.length} 处` : ''}。`, false));
  }
  return result;
}

function issue(
  code: string,
  severity: ScenarioHarnessIssueSeverity,
  path: string,
  message: string,
  autoFixable: boolean,
): ScenarioHarnessIssue {
  return { code, severity, path, message, autoFixable };
}

/** Pure, deterministic quality audit used by both the renderer and compiler boundary. */
export function assessScenarioHarness(
  input: ScenarioDefinition,
  definitions: readonly PersonalizationDefinition[] = [],
): ScenarioHarnessAssessment {
  const scenario = normalizeScenarioHarness(input);
  const issues: ScenarioHarnessIssue[] = [];
  const known = new Map(definitions.map((definition) => [definition.id, definition]));
  if (!scenario.deliverable || (scenario.deliverable.sections?.length ?? 0) === 0) {
    issues.push(issue('deliverable_blueprint_missing', 'blocking', 'deliverable.sections', 'Define at least one deliverable section.', false));
  } else {
    // Deliverable 内容完整性（2026-09-04 刘总要求）：骨架上屏不等于场景完成。
    // 缺失/占位的 purpose/instructions/requirements/lengthTarget/globalInstructions
    // 必须以 blocking 呈现，杜绝「创建成功但大量字段空白」的假完成。
    const gaps = collectDeliverableCompletenessGaps(scenario);
    for (const completenessIssue of deliverableCompletenessHarnessIssues(gaps)) {
      issues.push(completenessIssue);
    }
  }
  if (!hasText(scenario.scenarioMetis?.markdown)) {
    issues.push(issue('scenario_metis_missing', 'warning', 'scenarioMetis.markdown', 'Add the Scenario Metis.md rules that apply throughout this workflow.', false));
  }
  if (scenario.workflow.length === 0) {
    issues.push(issue('workflow_missing', 'blocking', 'workflow', 'Add at least one executable workflow step.', false));
  }
  const stepIds = new Set(scenario.workflow.map((step) => step.id));
  for (let index = 0; index < scenario.workflow.length; index += 1) {
    const step = scenario.workflow[index]!;
    const base = `workflow.${index}`;
    if (!hasText(step.prompt)) issues.push(issue('step_prompt_missing', 'blocking', `${base}.prompt`, `Step “${step.name}” has no dedicated prompt.`, true));
    if ((step.completionCriteria?.length ?? 0) === 0) issues.push(issue('step_criteria_missing', 'blocking', `${base}.completionCriteria`, `Step “${step.name}” has no completion criterion.`, true));
    if (step.failurePolicy?.action === 'backtrack' && !step.failurePolicy.backtrackStepId) {
      issues.push(issue('failure_backtrack_target_missing', 'blocking', `${base}.failurePolicy.backtrackStepId`, `Step “${step.name}” backtracks without a target.`, false));
    }
    if (step.loop?.enabled && !hasText(step.loop.stopCondition)) {
      issues.push(issue('step_loop_stop_missing', 'blocking', `${base}.loop.stopCondition`, `Step “${step.name}” loop has no stop condition.`, false));
    }
    if (step.loop?.backtrackStepId && !stepIds.has(step.loop.backtrackStepId)) {
      issues.push(issue('step_loop_target_invalid', 'blocking', `${base}.loop.backtrackStepId`, `Step “${step.name}” loop target is invalid.`, false));
    }
    for (const skillId of step.skillIds) {
      if (known.size > 0 && known.get(skillId)?.kind !== 'skill') issues.push(issue('step_skill_unavailable', 'blocking', `${base}.skillIds`, `Step “${step.name}” references unavailable Skill ${skillId}.`, false));
    }
    for (const mcpId of step.mcpIds) {
      if (known.size > 0 && known.get(mcpId)?.kind !== 'mcp') issues.push(issue('step_mcp_unavailable', 'blocking', `${base}.mcpIds`, `Step “${step.name}” references unavailable MCP ${mcpId}.`, false));
    }
  }
  const blockingCount = issues.filter((item) => item.severity === 'blocking').length;
  const warningCount = issues.length - blockingCount;
  const score = Math.max(0, 100 - blockingCount * 12 - warningCount * 3);
  return {
    score,
    status: blockingCount > 0 ? 'blocked' : warningCount > 0 ? 'needs_attention' : 'ready',
    issues,
    blockingCount,
    warningCount,
  };
}

/** Apply only deterministic, content-preserving fixes advertised by the assessment. */
export function autoFixScenarioHarness(input: ScenarioDefinition): ScenarioDefinition {
  const scenario = normalizeScenarioHarness(input);
  scenario.workflow = scenario.workflow.map((step, index) => {
    const goal = step.goal?.trim() || step.description.trim() || step.name;
    const prompt = step.prompt?.trim() || step.description.trim() || `Complete the goal: ${goal}`;
    const outputId = safeLocalId(`${step.id}-output`, `step-${index + 1}-output`);
    return {
      ...step,
      goal,
      prompt,
      outputs: step.outputs && step.outputs.length > 0 ? step.outputs : [{
        id: outputId,
        name: `${step.name} output`,
        format: 'artifact',
        description: goal,
        required: true,
      }],
      completionCriteria: step.completionCriteria && step.completionCriteria.length > 0
        ? step.completionCriteria
        : [`The declared output for “${step.name}” is complete and satisfies the step goal.`],
      condition: step.condition?.trim() ? step.condition : null,
    };
  });
  if (scenario.scenarioMetis && !scenario.scenarioMetis.markdown.trim()) {
    scenario.scenarioMetis.markdown = renderScenarioMetisMarkdown(scenario.scenarioMetis);
  }
  scenario.checkpointPolicy = {
    ...(scenario.checkpointPolicy ?? {
      enabled: true,
      afterEveryStep: true,
      afterEveryLoopIteration: true,
      includeToolCallSummary: true,
      resumeMode: 'continue',
    }),
    enabled: true,
    afterEveryStep: true,
  };
  scenario.agentIds = unique([...scenario.agentIds, ...scenario.workflow.flatMap((step) => step.agentId ? [step.agentId] : [])]);
  scenario.skillIds = unique([...scenario.skillIds, ...scenario.workflow.flatMap((step) => step.skillIds)]);
  scenario.mcpIds = unique([...scenario.mcpIds, ...scenario.workflow.flatMap((step) => step.mcpIds)]);
  return scenario;
}

/** Convenience helper for a new empty Harness quality gate. */
export function createScenarioQualityGate(index: number): ScenarioQualityGate {
  return {
    id: `quality-${index + 1}`,
    name: `Quality gate ${index + 1}`,
    scope: 'workflow',
    targetStepId: null,
    criterion: '',
    severity: 'blocking',
    autoFix: false,
  };
}
