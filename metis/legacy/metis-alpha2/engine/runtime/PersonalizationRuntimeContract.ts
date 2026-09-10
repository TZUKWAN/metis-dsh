import { z } from 'zod';

/**
 * Public contract for user-personalized Metis behavior.
 *
 * Truth and provenance states are deliberately absent from editable definitions. A scenario,
 * skill, agent, MCP server, or Metis.md layer may influence research behavior, but only the
 * main-process Truth Layer may assert that evidence is verified, clean, corrected, or safe to
 * publish.
 */

export const PERSONALIZATION_CONTRACT_VERSION = 1 as const;

export const PERSONALIZATION_LIMITS = Object.freeze({
  idChars: 160,
  nameChars: 200,
  descriptionChars: 4_000,
  markdownChars: 500_000,
  promptChars: 500_000,
  urlChars: 8_192,
  commandChars: 4_096,
  argumentChars: 4_096,
  environmentKeys: 128,
  environmentKeyChars: 128,
  references: 256,
  tags: 128,
  tagChars: 128,
  tools: 512,
  workflowSteps: 128,
  deliverableSections: 96,
  deliverableSectionDepth: 4,
  materialInsights: 64,
  materials: 32,
  adaptTriggers: 32,
  definitionList: 2_000,
  version: 1_000_000_000,
} as const);

// eslint-disable-next-line no-control-regex -- this boundary intentionally rejects C0/C1 input
const UNSAFE_SINGLE_LINE = /[\u0000-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex -- tabs/newlines are allowed in authored instructions
const UNSAFE_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

function singleLine(max: number) {
  return z.string().min(1).max(max).refine((value) => !UNSAFE_SINGLE_LINE.test(value), {
    message: 'Text contains unsafe control characters',
  });
}

function multiline(max: number) {
  return z.string().max(max).refine((value) => !UNSAFE_MULTILINE.test(value), {
    message: 'Text contains unsafe control characters',
  });
}

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function uniqueStringsHookIds(hooks: ReadonlyArray<{ id: string }>): boolean {
  return new Set(hooks.map((hook) => hook.id)).size === hooks.length;
}

function uniqueStringsLoopIds(loops: ReadonlyArray<{ id: string }>): boolean {
  return new Set(loops.map((loop) => loop.id)).size === loops.length;
}

function httpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && parsed.username.length === 0
      && parsed.password.length === 0;
  } catch {
    return false;
  }
}

export const PersonalizationIdSchema = z.string()
  .min(3)
  .max(PERSONALIZATION_LIMITS.idChars)
  .regex(/^(?:builtin|user|url|generated):[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
  .refine((value) => !value.includes('..') && !value.includes('\\'), {
    message: 'Identifier contains an unsafe path segment',
  });

export const PersonalizationLocalIdSchema = z.string()
  .min(1)
  .max(PERSONALIZATION_LIMITS.idChars)
  // 下划线合法（2026-08-28）：运行时会话 id 形如 session_17878…（含 _），
  // 旧正则拒绝下划线导致绑定了场景的会话在 agent:chat 一律
  // personalization_resolution_failed（0.0s 执行失败）。
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u);

export const PersonalizationDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const PersonalizationSemverSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
export const PersonalizationTimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PersonalizationUrlSchema = z.string()
  .min(1)
  .max(PERSONALIZATION_LIMITS.urlChars)
  .refine(httpUrl, { message: 'Only credential-free HTTP(S) URLs are supported' });

const ReferenceListSchema = z.array(PersonalizationIdSchema)
  .max(PERSONALIZATION_LIMITS.references)
  .refine(uniqueStrings, { message: 'References must be unique' });
const ToolListSchema = z.array(PersonalizationLocalIdSchema)
  .max(PERSONALIZATION_LIMITS.tools)
  .refine(uniqueStrings, { message: 'Tools must be unique' })
  .refine((tools) => !tools.includes('execute_command'), {
    message: 'Full Access personalization cannot bind an unrestricted command interpreter',
  });
const TagListSchema = z.array(singleLine(PERSONALIZATION_LIMITS.tagChars))
  .max(PERSONALIZATION_LIMITS.tags)
  .refine(uniqueStrings, { message: 'Tags must be unique' });

export const DefinitionOriginSchema = z.enum(['builtin', 'user', 'url', 'generated']);
export const PersonalizationKindSchema = z.enum(['scenario', 'agent', 'skill', 'mcp', 'rules']);

export const DefinitionProvenanceSchema = z.strictObject({
  origin: DefinitionOriginSchema,
  author: singleLine(PERSONALIZATION_LIMITS.nameChars),
  version: PersonalizationSemverSchema,
  license: singleLine(PERSONALIZATION_LIMITS.nameChars).nullable(),
  sourceUrl: PersonalizationUrlSchema.nullable(),
  sourceRevision: singleLine(256).nullable(),
  installedDigest: PersonalizationDigestSchema.nullable(),
  parentId: PersonalizationIdSchema.nullable(),
  parentVersion: PersonalizationSemverSchema.nullable(),
  locallyModified: z.boolean(),
  createdAt: PersonalizationTimestampSchema,
  updatedAt: PersonalizationTimestampSchema,
}).superRefine((value, context) => {
  if (value.origin === 'url' && value.sourceUrl === null) {
    context.addIssue({ code: 'custom', message: 'URL definitions require sourceUrl', path: ['sourceUrl'] });
  }
  if (value.parentId === null && value.parentVersion !== null) {
    context.addIssue({ code: 'custom', message: 'parentVersion requires parentId', path: ['parentVersion'] });
  }
  if (value.updatedAt < value.createdAt) {
    context.addIssue({ code: 'custom', message: 'updatedAt cannot predate createdAt', path: ['updatedAt'] });
  }
});

const DefinitionHeaderSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  id: PersonalizationIdSchema,
  name: singleLine(PERSONALIZATION_LIMITS.nameChars),
  description: multiline(PERSONALIZATION_LIMITS.descriptionChars),
  enabled: z.boolean(),
  tags: TagListSchema,
  revision: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
  provenance: DefinitionProvenanceSchema,
});

export const FullAccessPolicySchema = z.strictObject({
  mode: z.literal('full_access'),
  perActionConfirmation: z.literal(false),
  liveSteering: z.literal(true),
  silentCheckpoints: z.boolean(),
  /** Generic external side effects are not falsely advertised as reversible. */
  rollbackOnFailure: z.literal(false),
  persistAcrossRestart: z.boolean(),
});

/**
 * 系统默认权限：一律 Full Access。用户不需要（也无法）管理权限——schema
 * 本身只允许这一种形态，运行时在未提供策略时也按此常量全权执行。
 */
export const SYSTEM_FULL_ACCESS_POLICY: FullAccessPolicy = {
  mode: 'full_access',
  perActionConfirmation: false,
  liveSteering: true,
  silentCheckpoints: true,
  rollbackOnFailure: false,
  persistAcrossRestart: true,
};

export const MemoryPolicySchema = z.strictObject({
  scope: z.enum(['none', 'session', 'project', 'scenario']),
  retainDecisions: z.boolean(),
  retainArtifacts: z.boolean(),
  maxSummaryChars: z.number().int().min(1_000).max(500_000),
});

export const OutputPlanSchema = z.strictObject({
  primaryDeliverable: singleLine(512),
  supportingArtifacts: z.array(singleLine(512)).max(64).refine(uniqueStrings, {
    message: 'Supporting artifacts must be unique',
  }),
  qualityCriteria: z.array(singleLine(1_000)).max(64).refine(uniqueStrings, {
    message: 'Quality criteria must be unique',
  }),
});

export const OutputContractSchema = z.strictObject({
  format: z.enum(['markdown', 'json', 'document', 'artifact_bundle', 'custom']),
  schema: z.record(z.string(), z.unknown()).nullable(),
  plan: OutputPlanSchema.nullable().optional(),
  requireEvidenceEnvelope: z.boolean(),
  includeIntegrityReport: z.boolean(),
});

/** Explicit input contract for one Harness workflow step. */
export const WorkflowInputBindingSchema = z.strictObject({
  id: PersonalizationLocalIdSchema,
  name: singleLine(PERSONALIZATION_LIMITS.nameChars),
  source: z.enum(['user', 'project', 'file', 'context', 'step_output', 'artifact', 'custom']),
  sourceRef: multiline(1_000).nullable(),
  description: multiline(PERSONALIZATION_LIMITS.descriptionChars),
  required: z.boolean(),
});

/** Explicit artifact/value contract emitted by one Harness workflow step. */
export const WorkflowOutputBindingSchema = z.strictObject({
  id: PersonalizationLocalIdSchema,
  name: singleLine(PERSONALIZATION_LIMITS.nameChars),
  format: z.enum(['markdown', 'json', 'document', 'table', 'figure', 'dataset', 'artifact', 'custom']),
  description: multiline(PERSONALIZATION_LIMITS.descriptionChars),
  required: z.boolean(),
});

export const WorkflowFailurePolicySchema = z.strictObject({
  action: z.enum(['stop', 'retry', 'skip', 'backtrack', 'pause_for_user']),
  retryLimit: z.number().int().min(0).max(10),
  backtrackStepId: PersonalizationLocalIdSchema.nullable(),
  instruction: multiline(4_000),
});

/** Iteration owned by one step; this is separate from the legacy periodic scheduler. */
export const WorkflowStepLoopSchema = z.strictObject({
  enabled: z.boolean(),
  maxIterations: z.number().int().min(1).max(100),
  stopCondition: multiline(4_000),
  evaluator: z.enum(['completion_criteria', 'validation', 'ai_judgement', 'manual']),
  onExhausted: z.enum(['fail', 'continue', 'backtrack', 'pause_for_user']),
  backtrackStepId: PersonalizationLocalIdSchema.nullable(),
});

export const WorkflowStepBindingSchema = z.strictObject({
  id: PersonalizationLocalIdSchema,
  /** UI hierarchy only. Runtime still uses the explicit dependency DAG. */
  parentStepId: PersonalizationLocalIdSchema.nullable().optional(),
  name: singleLine(PERSONALIZATION_LIMITS.nameChars),
  description: multiline(PERSONALIZATION_LIMITS.descriptionChars),
  /** Optional specialist. When omitted, the scenario's default runtime executes the step. */
  agentId: PersonalizationIdSchema.optional(),
  skillIds: ReferenceListSchema,
  toolIds: ToolListSchema,
  mcpIds: ReferenceListSchema,
  dependsOn: z.array(PersonalizationLocalIdSchema)
    .max(PERSONALIZATION_LIMITS.workflowSteps)
    .refine(uniqueStrings, { message: 'Workflow dependencies must be unique' }),
  maxTurns: z.number().int().min(1).max(100),
  goal: multiline(PERSONALIZATION_LIMITS.descriptionChars).optional(),
  prompt: multiline(PERSONALIZATION_LIMITS.promptChars).optional(),
  inputs: z.array(WorkflowInputBindingSchema).max(64).optional(),
  outputs: z.array(WorkflowOutputBindingSchema).max(64).optional(),
  completionCriteria: z.array(singleLine(1_000)).max(64)
    .refine(uniqueStrings, { message: 'Completion criteria must be unique' }).optional(),
  condition: multiline(4_000).nullable().optional(),
  failurePolicy: WorkflowFailurePolicySchema.optional(),
  loop: WorkflowStepLoopSchema.optional(),
});

/** Runtime-only fields resolved from the executing Agent and its bound Skills. */
export const ResolvedWorkflowStepSchema = WorkflowStepBindingSchema.extend({
  agentModelPreference: singleLine(512).nullable().optional(),
  retryLimit: z.number().int().min(0).max(10).optional(),
  memory: MemoryPolicySchema.optional(),
  output: OutputContractSchema.optional(),
}).strict();

export const AgentDefinitionSchema = DefinitionHeaderSchema.extend({
  kind: z.literal('agent'),
  role: singleLine(PERSONALIZATION_LIMITS.nameChars),
  systemPrompt: multiline(PERSONALIZATION_LIMITS.promptChars),
  modelPreference: singleLine(512).nullable(),
  skillIds: ReferenceListSchema,
  toolIds: ToolListSchema,
  mcpIds: ReferenceListSchema,
  memory: MemoryPolicySchema,
  output: OutputContractSchema,
  maxTurns: z.number().int().min(1).max(100),
  retryLimit: z.number().int().min(0).max(10),
}).strict();

export const SkillDefinitionV2Schema = DefinitionHeaderSchema.extend({
  kind: z.literal('skill'),
  sourceMode: z.enum(['markdown', 'package', 'url']),
  markdown: multiline(PERSONALIZATION_LIMITS.markdownChars),
  systemPrompt: multiline(PERSONALIZATION_LIMITS.promptChars),
  toolIds: ToolListSchema,
  mcpIds: ReferenceListSchema,
  maxTurns: z.number().int().min(1).max(100),
  inputSchema: z.record(z.string(), z.unknown()).nullable(),
  outputSchema: z.record(z.string(), z.unknown()).nullable(),
  packageEntry: singleLine(512).nullable(),
}).strict();

const EnvironmentSchema = z.record(
  z.string().min(1).max(PERSONALIZATION_LIMITS.environmentKeyChars).regex(/^[A-Z_][A-Z0-9_]*$/u),
  z.strictObject({
    secret: z.boolean(),
    value: singleLine(PERSONALIZATION_LIMITS.argumentChars).nullable(),
  }),
).refine((value) => Object.keys(value).length <= PERSONALIZATION_LIMITS.environmentKeys, {
  message: 'Too many environment entries',
});

export const McpDefinitionSchema = DefinitionHeaderSchema.extend({
  kind: z.literal('mcp'),
  sourceMode: z.enum(['generated', 'package', 'url']),
  transport: z.literal('stdio'),
  command: singleLine(PERSONALIZATION_LIMITS.commandChars),
  args: z.array(singleLine(PERSONALIZATION_LIMITS.argumentChars)).max(128),
  environment: EnvironmentSchema,
  sourceUrl: PersonalizationUrlSchema.nullable(),
  exposedTools: ToolListSchema,
  workingDirectoryToken: PersonalizationLocalIdSchema.nullable(),
}).strict();

export const MetisRulesDefinitionSchema = DefinitionHeaderSchema.extend({
  kind: z.literal('rules'),
  scope: z.enum(['global', 'scenario', 'project']),
  scopeId: PersonalizationIdSchema.nullable(),
  markdown: multiline(PERSONALIZATION_LIMITS.markdownChars),
}).strict().superRefine((value, context) => {
  if (value.scope === 'global' && value.scopeId !== null) {
    context.addIssue({ code: 'custom', message: 'Global rules cannot have scopeId', path: ['scopeId'] });
  }
  if (value.scope !== 'global' && value.scopeId === null) {
    context.addIssue({ code: 'custom', message: 'Scoped rules require scopeId', path: ['scopeId'] });
  }
});

// ── 成果结构（Deliverable）：场景对最终成果及其各部分写作要求的定义 ──

export const DeliverableSectionKindSchema = z.enum([
  'title', 'abstract', 'keywords', 'chapter', 'section', 'grant_column',
  'attachment', 'references', 'other',
]);

/** 部分 status：锁定（AI 不可增删改核心功能）/ 必选 / 可选 / 条件出现。 */
export const DeliverableSectionStatusSchema = z.enum(['locked', 'required', 'optional', 'conditional']);

/** 单个部分上 AI 可执行的调整（未提供时按 status 推导：locked 全 false，其余默认可调）。 */
export const SectionAiAdjustSchema = z.strictObject({
  renameTitle: z.boolean(),
  addChildren: z.boolean(),
  split: z.boolean(),
  merge: z.boolean(),
  move: z.boolean(),
  remove: z.boolean(),
  adjustLength: z.boolean(),
});

export interface DeliverableSectionInput {
  id: string;
  title: string;
  kind: z.infer<typeof DeliverableSectionKindSchema>;
  status: z.infer<typeof DeliverableSectionStatusSchema>;
  condition?: string;
  purpose?: string;
  /** 完整自然语言写作规范（无法拆成 requirements 短句的成文要求整体存放于此）。 */
  instructions?: string;
  requirements?: string[];
  optionalContent?: string[];
  forbidden?: string[];
  lengthTarget?: string;
  method?: string;
  evidence?: string;
  aiAdjust?: z.infer<typeof SectionAiAdjustSchema>;
  children?: DeliverableSectionInput[];
}

/**
 * DeliverableSection 字段形状的唯一来源（2026-09-04 刘总要求：所有合法 section
 * 字段由一个统一白名单/Schema 来源管理，patch/sanitize/adapt 层从这里的键集
 * 派生，禁止另行维护第二份不一致的列表）。
 */
const deliverableSectionShape = {
  id: PersonalizationLocalIdSchema,
  title: singleLine(PERSONALIZATION_LIMITS.nameChars),
  kind: DeliverableSectionKindSchema,
  status: DeliverableSectionStatusSchema,
  condition: multiline(PERSONALIZATION_LIMITS.descriptionChars).optional(),
  purpose: multiline(PERSONALIZATION_LIMITS.descriptionChars).optional(),
  instructions: multiline(PERSONALIZATION_LIMITS.descriptionChars).optional(),
  requirements: z.array(singleLine(500)).max(32).refine(uniqueStrings, { message: 'Section requirements must be unique' }).optional(),
  optionalContent: z.array(singleLine(500)).max(32).refine(uniqueStrings, { message: 'Section optional content must be unique' }).optional(),
  forbidden: z.array(singleLine(500)).max(32).refine(uniqueStrings, { message: 'Section forbidden rules must be unique' }).optional(),
  lengthTarget: singleLine(200).optional(),
  method: singleLine(500).optional(),
  evidence: singleLine(500).optional(),
  aiAdjust: SectionAiAdjustSchema.optional(),
} as const;

/**
 * DeliverableSection 合法字段白名单（schema 键集直接派生，含 instructions）。
 * children 在递归 schema 中单独声明，此处显式并入。
 */
export const DELIVERABLE_SECTION_FIELD_KEYS: readonly string[] = [...Object.keys(deliverableSectionShape), 'children'];

export const DeliverableSectionSchema: z.ZodType<DeliverableSectionInput> = z.lazy(() => z.strictObject({
  ...deliverableSectionShape,
  children: z.array(DeliverableSectionSchema).max(24).optional(),
}));

/** 成果结构策略：默认章节数与允许范围（仅约束 chapter/section 类部分的顶层计数）。 */
export const DeliverableStructurePolicySchema = z.strictObject({
  defaultSections: z.number().int().min(1).max(48),
  suggestedMin: z.number().int().min(1).max(48),
  suggestedMax: z.number().int().min(1).max(64),
}).refine((value) => value.suggestedMin <= value.suggestedMax, {
  message: 'suggestedMin cannot exceed suggestedMax',
  path: ['suggestedMin'],
});

/** Global default for second-level sections; individual chapters may override it through their actual child count. */
export const DeliverableSecondarySectionPolicySchema = z.strictObject({
  min: z.number().int().min(0).max(24),
  max: z.number().int().min(0).max(24),
}).refine((value) => value.min <= value.max, {
  message: 'secondary section minimum cannot exceed maximum',
  path: ['min'],
});

export const DeliverableTypeSchema = z.enum([
  'theory_paper', 'empirical_paper', 'computational_paper', 'case_study', 'review_paper',
  'grant_nssfc', 'grant_nsfc', 'grant_postdoc', 'grant_other',
  'policy_report', 'survey_report', 'tech_report', 'industry_report',
  'thesis', 'opening_report', 'completion_report', 'custom',
]);

/** 场景级成果定义：类型 + 结构树 + 结构策略 + 全局要求。 */
export const DeliverableSpecSchema = z.strictObject({
  type: DeliverableTypeSchema,
  typeLabel: singleLine(120).optional(),
  sections: z.array(DeliverableSectionSchema).max(48).optional(),
  structurePolicy: DeliverableStructurePolicySchema.optional(),
  secondarySections: DeliverableSecondarySectionPolicySchema.optional(),
  globalLength: singleLine(200).optional(),
  language: z.enum(['zh', 'en']).optional(),
  journalTier: z.enum(['any', 'core', 'general']).optional(),
  /** 整个最终成果共同遵守的成文/表达要求（全文学术化、术语一致、论证连续等）。 */
  globalInstructions: multiline(PERSONALIZATION_LIMITS.descriptionChars).optional(),
  /** 刘总 2026-09：开启后蓝图中的章节/小节标题仅作默认值，AI 按本次实际
      研究内容自适应调整各小节标题（结构与数量不变，标题可重命名）。 */
  adaptiveTitles: z.boolean().optional(),
}).superRefine((value, context) => {
  let total = 0;
  const visit = (sections: readonly DeliverableSectionInput[], depth: number): void => {
    for (const section of sections) {
      total += 1;
      if (total > PERSONALIZATION_LIMITS.deliverableSections) {
        context.addIssue({ code: 'custom', message: 'Deliverable section count exceeds limit', path: ['sections'] });
        return;
      }
      if (section.status === 'conditional' && !section.condition) {
        context.addIssue({ code: 'custom', message: 'Conditional sections require a condition', path: ['sections'] });
      }
      if (depth >= PERSONALIZATION_LIMITS.deliverableSectionDepth) {
        context.addIssue({ code: 'custom', message: 'Deliverable section nesting exceeds limit', path: ['sections'] });
        return;
      }
      if (section.children && section.children.length > 0) visit(section.children, depth + 1);
    }
  };
  visit(value.sections ?? [], 0);
});

// ── 自适应策略（Adaptivity）：AI 在场景内可自主调整的边界 ──

export const AdaptivityPolicySchema = z.strictObject({
  structure: z.strictObject({
    addSections: z.boolean(),
    deleteUnlockedSections: z.boolean(),
    splitSections: z.boolean(),
    mergeSections: z.boolean(),
    reorderSections: z.boolean(),
    adjustLength: z.boolean(),
  }),
  content: z.strictObject({
    reviseQuestion: z.boolean(),
    addQuestion: z.boolean(),
    reviseHypothesis: z.boolean(),
    dropUnsupportedHypothesis: z.boolean(),
    adjustFramework: z.boolean(),
  }),
  method: z.strictObject({
    addMethod: z.boolean(),
    replaceUnsuitableMethod: z.boolean(),
    addRobustness: z.boolean(),
    addHeterogeneity: z.boolean(),
    addMechanism: z.boolean(),
  }),
  /** Runtime workflow changes that the Harness may make without leaving its boundary. */
  workflow: z.strictObject({
    reorderSteps: z.boolean(),
    splitSteps: z.boolean(),
    mergeSteps: z.boolean(),
    insertSteps: z.boolean(),
    skipConditionalSteps: z.boolean(),
    rebindStepResources: z.boolean(),
  }).optional(),
  /** 允许的回溯边（如 "analysis->literature"、"writing->framework"）。 */
  allowedBacktracks: z.array(singleLine(120)).max(32).refine(uniqueStrings, { message: 'Backtrack edges must be unique' }).optional(),
  /** 何时允许 AI 进行重大调整（原则描述，不逐次审批但须记录依据）。 */
  majorAdjustmentTriggers: z.array(singleLine(500)).max(PERSONALIZATION_LIMITS.adaptTriggers).refine(uniqueStrings, { message: 'Adjustment triggers must be unique' }).optional(),
  maxMajorAdjustments: z.number().int().min(0).max(100).optional(),
  maxWorkflowIterations: z.number().int().min(1).max(100).optional(),
  requireChangeLog: z.boolean().optional(),
});

// ── Research Harness writing, governance, Metis.md and quality contracts ──

export const ScenarioWritingStyleSchema = z.strictObject({
  voice: z.enum(['academic', 'analytical', 'policy', 'technical', 'narrative', 'custom']),
  person: z.enum(['first', 'third', 'impersonal', 'mixed']),
  tone: z.enum(['formal', 'neutral', 'persuasive', 'concise', 'custom']),
  tense: multiline(1_000),
  terminology: z.array(singleLine(500)).max(64).refine(uniqueStrings, { message: 'Terminology rules must be unique' }),
  paragraphPattern: multiline(4_000),
  citationStyle: multiline(4_000),
  formulaStyle: multiline(4_000),
  tableFigureStyle: multiline(4_000),
  prohibitedExpressions: z.array(singleLine(500)).max(64).refine(uniqueStrings, { message: 'Prohibited expressions must be unique' }),
  customInstructions: multiline(PERSONALIZATION_LIMITS.promptChars),
});

export const ScenarioMetisDocumentSchema = z.strictObject({
  purpose: multiline(PERSONALIZATION_LIMITS.descriptionChars),
  roleBoundaries: multiline(PERSONALIZATION_LIMITS.promptChars),
  researchRules: multiline(PERSONALIZATION_LIMITS.promptChars),
  writingRules: multiline(PERSONALIZATION_LIMITS.promptChars),
  toolRules: multiline(PERSONALIZATION_LIMITS.promptChars),
  qualityGates: multiline(PERSONALIZATION_LIMITS.promptChars),
  failureRecovery: multiline(PERSONALIZATION_LIMITS.promptChars),
  markdown: multiline(PERSONALIZATION_LIMITS.markdownChars),
  inheritanceOrder: z.tuple([
    z.literal('global'),
    z.literal('scenario'),
    z.literal('project'),
  ]),
});

export const ScenarioWorkflowGovernanceSchema = z.strictObject({
  entryStepId: PersonalizationLocalIdSchema.nullable(),
  completionCriteria: z.array(singleLine(1_000)).max(64)
    .refine(uniqueStrings, { message: 'Workflow completion criteria must be unique' }),
  allowDynamicReorder: z.boolean(),
  allowStepSplit: z.boolean(),
  allowStepMerge: z.boolean(),
  allowStepInsertion: z.boolean(),
  requireChangeLog: z.boolean(),
  maxTotalStepExecutions: z.number().int().min(1).max(10_000),
});

/** Iteration of the complete workflow, distinct from a step loop and periodic schedule. */
export const ScenarioWorkflowLoopSchema = z.strictObject({
  enabled: z.boolean(),
  maxIterations: z.number().int().min(1).max(100),
  stopCondition: multiline(4_000),
  reentryStepId: PersonalizationLocalIdSchema.nullable(),
  carryArtifacts: z.boolean(),
  onExhausted: z.enum(['complete', 'fail', 'pause_for_user']),
});

export const ScenarioCheckpointPolicySchema = z.strictObject({
  enabled: z.boolean(),
  afterEveryStep: z.boolean(),
  afterEveryLoopIteration: z.boolean(),
  includeToolCallSummary: z.boolean(),
  resumeMode: z.enum(['continue', 'review_then_continue']),
});

export const ScenarioQualityGateSchema = z.strictObject({
  id: PersonalizationLocalIdSchema,
  name: singleLine(PERSONALIZATION_LIMITS.nameChars),
  scope: z.enum(['scenario', 'workflow', 'step', 'deliverable']),
  targetStepId: PersonalizationLocalIdSchema.nullable(),
  criterion: multiline(4_000),
  severity: z.enum(['blocking', 'warning']),
  autoFix: z.boolean(),
});

export const ScenarioAdjustmentLogEntrySchema = z.strictObject({
  id: PersonalizationLocalIdSchema,
  occurredAt: PersonalizationTimestampSchema,
  source: z.enum(['user', 'ai_compiler', 'runtime']),
  scope: z.enum(['deliverable', 'writing_style', 'metis', 'workflow', 'resource', 'adaptivity', 'runtime']),
  summary: singleLine(1_000),
  reason: multiline(4_000),
  affectedIds: z.array(PersonalizationLocalIdSchema).max(128).refine(uniqueStrings, { message: 'Affected IDs must be unique' }),
});

// ── 参考材料（Reference Material）：AI 学习科研方式的原始材料，区别于 Metis.md 规则文档 ──

export const MaterialKindSchema = z.enum([
  'template', 'exemplar', 'paper', 'textbook', 'method_book',
  'guide', 'policy', 'format_spec', 'user_spec', 'other',
]);

export const MaterialInsightsSchema = z.strictObject({
  structureRules: z.array(singleLine(500)).max(PERSONALIZATION_LIMITS.materialInsights).default([]),
  writingPrinciples: z.array(singleLine(500)).max(PERSONALIZATION_LIMITS.materialInsights).default([]),
  methodSuggestions: z.array(singleLine(500)).max(PERSONALIZATION_LIMITS.materialInsights).default([]),
  hardRequirements: z.array(singleLine(500)).max(PERSONALIZATION_LIMITS.materialInsights).default([]),
});

export const ReferenceMaterialSchema = z.strictObject({
  id: PersonalizationLocalIdSchema,
  name: singleLine(PERSONALIZATION_LIMITS.nameChars),
  kind: MaterialKindSchema,
  /** 主进程管理目录中的相对路径（材料以文本形态持久化）。 */
  storageRef: singleLine(PERSONALIZATION_LIMITS.urlChars).optional(),
  byteLength: z.number().int().min(0).max(50_000_000).optional(),
  analyzedAt: PersonalizationTimestampSchema,
  insights: MaterialInsightsSchema.optional(),
});

// ── 场景 Hook 与 Loop（场景重构 P4）──

/** Harness lifecycle hook: runtime events can notify, gate, repair, retry or backtrack. */
export const ScenarioHookSchema = z.strictObject({
  id: PersonalizationLocalIdSchema,
  event: z.enum([
    'scenario_activate',
    'run_start',
    'run_end',
    'step_start',
    'step_end',
    'validation_failed',
    'tool_failed',
    'checkpoint_saved',
    'loop_iteration',
    'workflow_adjusted',
  ]),
  /** null matches the complete workflow. */
  matchStepId: PersonalizationLocalIdSchema.nullable(),
  action: z.enum(['approval', 'notify', 'log', 'execute_prompt', 'retry', 'backtrack', 'pause', 'auto_fix']),
  instruction: multiline(2_000),
  enabled: z.boolean(),
  condition: multiline(2_000).optional(),
  targetStepId: PersonalizationLocalIdSchema.nullable().optional(),
});

/** Legacy-compatible periodic schedule. Step/workflow loops live in the Harness policies above. */
export const ScenarioLoopSchema = z.strictObject({
  id: PersonalizationLocalIdSchema,
  name: singleLine(PERSONALIZATION_LIMITS.nameChars),
  kind: z.literal('schedule').optional(),
  /** 触发间隔（分钟，1 分钟至 7 天）。 */
  intervalMinutes: z.number().int().min(1).max(10_080),
  /** 最大触发次数（达到后停用）。 */
  maxRuns: z.number().int().min(1).max(1_000),
  /** 每次触发执行的指令（作为该次运行的用户消息）。 */
  instruction: multiline(4_000),
  enabled: z.boolean(),
  /** 调度器维护的运行状态（非用户编辑字段）。 */
  lastRunAt: PersonalizationTimestampSchema.nullable(),
  runCount: z.number().int().min(0).max(1_000),
});

export const ScenarioDefinitionSchema = DefinitionHeaderSchema.extend({
  kind: z.literal('scenario'),
  agentIds: ReferenceListSchema,
  skillIds: ReferenceListSchema,
  mcpIds: ReferenceListSchema,
  rulesIds: ReferenceListSchema,
  workflow: z.array(WorkflowStepBindingSchema)
    .max(PERSONALIZATION_LIMITS.workflowSteps)
    .refine((steps) => uniqueStrings(steps.map((step) => step.id)), {
      message: 'Workflow step IDs must be unique',
    }),
  fullAccess: FullAccessPolicySchema,
  memory: MemoryPolicySchema,
  output: OutputContractSchema,
  triggerPhrases: z.array(singleLine(512)).max(128).refine(uniqueStrings, {
    message: 'Trigger phrases must be unique',
  }),
  /** User-authored operating rules for the complete workflow, separate from per-step prompts. */
  workflowPrompt: multiline(PERSONALIZATION_LIMITS.promptChars).optional(),
  // capability 是自由语义标签（2026-08-29 刘总要求）：模型可能产出
  // academic_literature_review_writing 之类的自造值。封闭枚举会让整个场景
  // 无法通过 schema 校验、保存必然失败（invalid_request），是此前“场景
  // 创建后重启丢失”的总根源。改为受控字符串；'presentation_reserved' 保留
  // 其保留语义，其余值仅作展示与分类用途。
  capability: singleLine(PERSONALIZATION_LIMITS.nameChars),
  deliverable: DeliverableSpecSchema.optional(),
  adaptivity: AdaptivityPolicySchema.optional(),
  /** 内容规范（写作规范类规则，场景级；区别于逐部分规则）。 */
  writingRules: z.array(singleLine(500)).max(64).refine(uniqueStrings, { message: 'Writing rules must be unique' }).optional(),
  /** First-class, explicit writing style for the Research Harness. */
  writingStyle: ScenarioWritingStyleSchema.optional(),
  /** First-class Scenario Metis.md; legacy rulesIds remain supported as inherited layers. */
  scenarioMetis: ScenarioMetisDocumentSchema.optional(),
  workflowGovernance: ScenarioWorkflowGovernanceSchema.optional(),
  workflowLoop: ScenarioWorkflowLoopSchema.optional(),
  checkpointPolicy: ScenarioCheckpointPolicySchema.optional(),
  qualityGates: z.array(ScenarioQualityGateSchema).max(128).refine(uniqueStringsHookIds, {
    message: 'Quality gate IDs must be unique',
  }).optional(),
  adjustmentLog: z.array(ScenarioAdjustmentLogEntrySchema).max(1_000).refine(uniqueStringsHookIds, {
    message: 'Adjustment log IDs must be unique',
  }).optional(),
  /** 研究方法策略：推荐/允许/条件/禁止。 */
  methodPolicy: z.strictObject({
    recommended: z.array(singleLine(200)).max(24).default([]),
    allowed: z.array(singleLine(200)).max(24).default([]),
    conditional: z.array(singleLine(200)).max(24).default([]),
    forbidden: z.array(singleLine(200)).max(24).default([]),
  }).optional(),
  materials: z.array(ReferenceMaterialSchema).max(PERSONALIZATION_LIMITS.materials).optional(),
  /** 生命周期钩子（场景重构 P4；optional 保持旧数据兼容）。 */
  hooks: z.array(ScenarioHookSchema).max(64).refine(uniqueStringsHookIds, {
    message: 'Hook IDs must be unique',
  }).optional(),
  /** 循环执行配置（场景重构 P4）。 */
  loops: z.array(ScenarioLoopSchema).max(32).refine(uniqueStringsLoopIds, {
    message: 'Loop IDs must be unique',
  }).optional(),
}).strict().superRefine((value, context) => {
  // 成果结构：树深度/总节点数/条件状态必须给出条件说明。
  if (value.deliverable) {
    let total = 0;
    const visit = (sections: readonly DeliverableSectionInput[], depth: number): void => {
      for (const section of sections) {
        total += 1;
        if (total > PERSONALIZATION_LIMITS.deliverableSections) {
          context.addIssue({ code: 'custom', message: 'Deliverable section count exceeds limit', path: ['deliverable', 'sections'] });
          return;
        }
        if (section.status === 'conditional' && !section.condition) {
          context.addIssue({ code: 'custom', message: 'Conditional sections require a condition', path: ['deliverable', 'sections'] });
        }
        if (depth >= PERSONALIZATION_LIMITS.deliverableSectionDepth) {
          context.addIssue({ code: 'custom', message: 'Deliverable section nesting exceeds limit', path: ['deliverable', 'sections'] });
          return;
        }
        if (section.children && section.children.length > 0) visit(section.children, depth + 1);
      }
    };
    visit(value.deliverable.sections ?? [], 0);
  }
  const stepIds = new Set(value.workflow.map((step) => step.id));
  const selectedAgentIds = new Set(value.agentIds);
  const selectedSkillIds = new Set(value.skillIds);
  const selectedMcpIds = new Set(value.mcpIds);
  for (let index = 0; index < value.workflow.length; index += 1) {
    const step = value.workflow[index];
    if (!step) continue;
    if (step.agentId && !selectedAgentIds.has(step.agentId)) {
      context.addIssue({
        code: 'custom',
        message: 'Workflow Agent must be declared by scenario',
        path: ['workflow', index, 'agentId'],
      });
    }
    if (step.parentStepId && !stepIds.has(step.parentStepId)) {
      context.addIssue({
        code: 'custom',
        message: 'Workflow parent step does not exist',
        path: ['workflow', index, 'parentStepId'],
      });
    }
    if (step.parentStepId === step.id) {
      context.addIssue({
        code: 'custom',
        message: 'Workflow step cannot be its own parent',
        path: ['workflow', index, 'parentStepId'],
      });
    }
    for (const skillId of step.skillIds) {
      if (selectedSkillIds.has(skillId)) continue;
      context.addIssue({
        code: 'custom',
        message: 'Workflow Skill must be declared by scenario',
        path: ['workflow', index, 'skillIds'],
      });
    }
    for (const mcpId of step.mcpIds) {
      if (selectedMcpIds.has(mcpId)) continue;
      context.addIssue({
        code: 'custom',
        message: 'Workflow MCP must be declared by scenario',
        path: ['workflow', index, 'mcpIds'],
      });
    }
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) {
        context.addIssue({
          code: 'custom',
          message: 'Workflow dependency does not exist',
          path: ['workflow', index, 'dependsOn'],
        });
      }
      if (dependency === step.id) {
        context.addIssue({
          code: 'custom',
          message: 'Workflow step cannot depend on itself',
          path: ['workflow', index, 'dependsOn'],
        });
      }
    }
    if (step.failurePolicy?.backtrackStepId && !stepIds.has(step.failurePolicy.backtrackStepId)) {
      context.addIssue({
        code: 'custom',
        message: 'Workflow failure backtrack target does not exist',
        path: ['workflow', index, 'failurePolicy', 'backtrackStepId'],
      });
    }
    if (step.loop?.backtrackStepId && !stepIds.has(step.loop.backtrackStepId)) {
      context.addIssue({
        code: 'custom',
        message: 'Workflow loop backtrack target does not exist',
        path: ['workflow', index, 'loop', 'backtrackStepId'],
      });
    }
  }
  const parentById = new Map(value.workflow.map((step) => [step.id, step.parentStepId ?? null]));
  for (let index = 0; index < value.workflow.length; index += 1) {
    const start = value.workflow[index];
    if (!start) continue;
    const visitedParents = new Set<string>([start.id]);
    let parentId = start.parentStepId ?? null;
    while (parentId) {
      if (visitedParents.has(parentId)) {
        context.addIssue({
          code: 'custom',
          message: 'Workflow parent hierarchy must not contain a cycle',
          path: ['workflow', index, 'parentStepId'],
        });
        break;
      }
      visitedParents.add(parentId);
      parentId = parentById.get(parentId) ?? null;
    }
  }
  if (value.workflowGovernance?.entryStepId && !stepIds.has(value.workflowGovernance.entryStepId)) {
    context.addIssue({ code: 'custom', message: 'Workflow entry step does not exist', path: ['workflowGovernance', 'entryStepId'] });
  }
  if (value.workflowLoop?.reentryStepId && !stepIds.has(value.workflowLoop.reentryStepId)) {
    context.addIssue({ code: 'custom', message: 'Workflow loop re-entry step does not exist', path: ['workflowLoop', 'reentryStepId'] });
  }
  for (let index = 0; index < (value.qualityGates?.length ?? 0); index += 1) {
    const gate = value.qualityGates?.[index];
    if (gate?.targetStepId && !stepIds.has(gate.targetStepId)) {
      context.addIssue({ code: 'custom', message: 'Quality gate target step does not exist', path: ['qualityGates', index, 'targetStepId'] });
    }
  }
  const indegree = new Map(value.workflow.map((step) => [step.id, 0]));
  const dependents = new Map<string, string[]>();
  for (const step of value.workflow) {
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency) || dependency === step.id) continue;
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      const children = dependents.get(dependency) ?? [];
      children.push(step.id);
      dependents.set(dependency, children);
    }
  }
  const ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift();
    if (!id) break;
    visited += 1;
    for (const child of dependents.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) ready.push(child);
    }
  }
  if (visited !== value.workflow.length) {
    context.addIssue({
      code: 'custom',
      message: 'Workflow dependencies must form an acyclic DAG',
      path: ['workflow'],
    });
  }
  if (value.output.plan && value.workflow.length > 0) {
    const dependencyIds = new Set(value.workflow.flatMap((step) => step.dependsOn));
    const terminalSteps = value.workflow.filter((step) => !dependencyIds.has(step.id));
    if (terminalSteps.length !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'A scenario with an output plan must have exactly one final workflow step',
        path: ['workflow'],
      });
    }
  }
  if (value.capability === 'presentation_reserved') {
    const reservedBehaviorFields: Array<[boolean, keyof typeof value]> = [
      [value.enabled, 'enabled'],
      [value.agentIds.length > 0, 'agentIds'],
      [value.skillIds.length > 0, 'skillIds'],
      [value.mcpIds.length > 0, 'mcpIds'],
      [value.workflow.length > 0, 'workflow'],
      [value.triggerPhrases.length > 0, 'triggerPhrases'],
    ];
    for (const [hasBehavior, field] of reservedBehaviorFields) {
      if (!hasBehavior) continue;
      context.addIssue({
        code: 'custom',
        message: 'Presentation behavior is reserved until its product specification is approved',
        path: [field],
      });
    }
  }
});

export const PersonalizationDefinitionSchema = z.discriminatedUnion('kind', [
  ScenarioDefinitionSchema,
  AgentDefinitionSchema,
  SkillDefinitionV2Schema,
  McpDefinitionSchema,
  MetisRulesDefinitionSchema,
]);

export type DefinitionProvenance = z.infer<typeof DefinitionProvenanceSchema>;
export type FullAccessPolicy = z.infer<typeof FullAccessPolicySchema>;
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
export type SkillDefinitionV2 = z.infer<typeof SkillDefinitionV2Schema>;
export type McpDefinition = z.infer<typeof McpDefinitionSchema>;
export type MetisRulesDefinition = z.infer<typeof MetisRulesDefinitionSchema>;
export type ScenarioDefinition = z.infer<typeof ScenarioDefinitionSchema>;
export type ScenarioHook = z.infer<typeof ScenarioHookSchema>;
export type ScenarioLoop = z.infer<typeof ScenarioLoopSchema>;
export type WorkflowStepBinding = z.infer<typeof WorkflowStepBindingSchema>;
export type WorkflowFailurePolicy = z.infer<typeof WorkflowFailurePolicySchema>;
export type WorkflowStepLoop = z.infer<typeof WorkflowStepLoopSchema>;
export type DeliverableSection = z.infer<typeof DeliverableSectionSchema>;
export type DeliverableSpec = z.infer<typeof DeliverableSpecSchema>;
export type AdaptivityPolicy = z.infer<typeof AdaptivityPolicySchema>;
export type ScenarioWritingStyle = z.infer<typeof ScenarioWritingStyleSchema>;
export type ScenarioMetisDocument = z.infer<typeof ScenarioMetisDocumentSchema>;
export type ScenarioWorkflowGovernance = z.infer<typeof ScenarioWorkflowGovernanceSchema>;
export type ScenarioWorkflowLoop = z.infer<typeof ScenarioWorkflowLoopSchema>;
export type ScenarioCheckpointPolicy = z.infer<typeof ScenarioCheckpointPolicySchema>;
export type ScenarioQualityGate = z.infer<typeof ScenarioQualityGateSchema>;
export type ScenarioAdjustmentLogEntry = z.infer<typeof ScenarioAdjustmentLogEntrySchema>;
export type ReferenceMaterial = z.infer<typeof ReferenceMaterialSchema>;
export type MaterialInsights = z.infer<typeof MaterialInsightsSchema>;
export type PersonalizationDefinition = z.infer<typeof PersonalizationDefinitionSchema>;

export const PersonalizationListRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  kind: PersonalizationKindSchema.optional(),
  includeDisabled: z.boolean(),
});

/** A recoverable item that has been moved to the seven-day scenario trash. */
export const ArchivedPersonalizationDefinitionSchema = z.strictObject({
  definition: PersonalizationDefinitionSchema,
  archivedAt: PersonalizationTimestampSchema,
  expiresAt: PersonalizationTimestampSchema,
});

export const PersonalizationTrashListRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  kind: PersonalizationKindSchema.optional(),
});

export const PersonalizationGetRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  id: PersonalizationIdSchema,
});

export const PersonalizationSaveRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  definition: PersonalizationDefinitionSchema,
  expectedRevision: z.number().int().min(0).max(PERSONALIZATION_LIMITS.version),
});

export const PersonalizationDeleteRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  id: PersonalizationIdSchema,
  expectedRevision: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
});

export const PersonalizationForkRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  sourceId: PersonalizationIdSchema,
  targetId: PersonalizationIdSchema.refine((value) => value.startsWith('user:'), {
    message: 'Fork target must use the user namespace',
  }),
  author: singleLine(PERSONALIZATION_LIMITS.nameChars),
});

export const PersonalizationRestoreRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  id: PersonalizationIdSchema,
  sourceRevision: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
  expectedRevision: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
});

/** Restores a soft-deleted definition without changing its authored content. */
export const PersonalizationTrashRestoreRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  id: PersonalizationIdSchema,
  expectedRevision: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
});

export const PersonalizationVersionsRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  id: PersonalizationIdSchema,
});

/**
 * A non-executable definition row that failed repository verification. The
 * payload intentionally contains only identifiers and recovery metadata; the
 * unverified authored JSON remains quarantined in the main-process database.
 */
export const PersonalizationIntegrityIssueSchema = z.strictObject({
  id: PersonalizationIdSchema,
  kind: PersonalizationKindSchema,
  archived: z.boolean(),
  currentRevision: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
  latestVerifiedRevision: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version).nullable(),
  code: z.enum([
    'current_version_missing',
    'current_definition_invalid',
    'current_definition_identity_mismatch',
    'current_version_invalid',
    'current_version_content_mismatch',
    'current_digest_mismatch',
  ]),
});

export const PersonalizationIntegrityListRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  kind: PersonalizationKindSchema.optional(),
});

/**
 * Explicitly replaces an unverified current snapshot with a selected, already
 * verified historical revision. The discarded snapshot is copied to the
 * repository quarantine before the new immutable revision is published.
 */
export const PersonalizationIntegrityRecoverRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  id: PersonalizationIdSchema,
  sourceRevision: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
  expectedCurrentRevision: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
});

export const PersonalizationResolveRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  sessionId: PersonalizationLocalIdSchema,
  projectId: PersonalizationLocalIdSchema,
  scenarioId: PersonalizationIdSchema,
  projectRulesId: PersonalizationIdSchema.optional(),
});

export const PersonalizationListResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    definitions: z.array(PersonalizationDefinitionSchema).max(PERSONALIZATION_LIMITS.definitionList),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['invalid_request', 'unavailable', 'invalid_response']),
  }),
]);

export const PersonalizationTrashListResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    definitions: z.array(ArchivedPersonalizationDefinitionSchema).max(PERSONALIZATION_LIMITS.definitionList),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['invalid_request', 'unavailable', 'invalid_response']),
  }),
]);

export const PersonalizationGetResponseSchema = z.strictObject({
  ok: z.literal(true),
  definition: PersonalizationDefinitionSchema.nullable(),
});

export const PersonalizationVersionViewSchema = z.strictObject({
  id: PersonalizationIdSchema,
  revision: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
  contentDigest: PersonalizationDigestSchema,
  definition: PersonalizationDefinitionSchema,
  createdAt: PersonalizationTimestampSchema,
});

export const PersonalizationVersionsResponseSchema = z.strictObject({
  ok: z.literal(true),
  versions: z.array(PersonalizationVersionViewSchema).max(PERSONALIZATION_LIMITS.version),
});

export const PersonalizationIntegrityListResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    issues: z.array(PersonalizationIntegrityIssueSchema).max(PERSONALIZATION_LIMITS.definitionList),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['invalid_request', 'unavailable', 'invalid_response']),
  }),
]);

export const PersonalizationMutationResultSchema = z.discriminatedUnion('code', [
  z.strictObject({ ok: z.literal(true), code: z.literal('saved'), definition: PersonalizationDefinitionSchema }),
  z.strictObject({ ok: z.literal(true), code: z.literal('restored'), definition: PersonalizationDefinitionSchema }),
  z.strictObject({ ok: z.literal(true), code: z.literal('deleted'), id: PersonalizationIdSchema }),
  z.strictObject({ ok: z.literal(false), code: z.literal('invalid_request'), issues: z.array(multiline(500)).max(64).optional() }),
  z.strictObject({ ok: z.literal(false), code: z.literal('not_found') }),
  z.strictObject({ ok: z.literal(false), code: z.literal('factory_protected') }),
  z.strictObject({ ok: z.literal(false), code: z.literal('revision_conflict'), currentRevision: z.number().int().min(1) }),
  z.strictObject({ ok: z.literal(false), code: z.literal('dependency_invalid'), issues: z.array(multiline(4_000)).max(128) }),
  z.strictObject({ ok: z.literal(false), code: z.literal('io_error') }),
]);

export const ResolvedPromptLayerSchema = z.strictObject({
  sourceId: PersonalizationIdSchema,
  sourceKind: z.enum(['rules', 'scenario_metis', 'agent', 'skill']),
  precedence: z.number().int().min(0).max(10_000),
  contentDigest: PersonalizationDigestSchema,
  content: multiline(PERSONALIZATION_LIMITS.promptChars),
});

export const ResolvedRunManifestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  sessionId: PersonalizationLocalIdSchema,
  projectId: PersonalizationLocalIdSchema,
  scenarioId: PersonalizationIdSchema,
  scenarioRevision: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
  definitionRevisions: z.record(
    PersonalizationIdSchema,
    z.number().int().min(1).max(PERSONALIZATION_LIMITS.version),
  ),
  agentIds: ReferenceListSchema,
  skillIds: ReferenceListSchema,
  mcpIds: ReferenceListSchema,
  allowedTools: ToolListSchema,
  workflow: z.array(ResolvedWorkflowStepSchema).max(PERSONALIZATION_LIMITS.workflowSteps),
  workflowPrompt: multiline(PERSONALIZATION_LIMITS.promptChars).optional(),
  /** Frozen runtime policy for a one-Agent output plan whose authored workflow is intentionally empty. */
  implicitOutputStep: ResolvedWorkflowStepSchema.nullable().optional(),
  maxTurns: z.number().int().min(1).max(100),
  promptStack: z.array(ResolvedPromptLayerSchema).max(PERSONALIZATION_LIMITS.references),
  /** 场景生命周期钩子快照（场景重构 P4；由 resolver 从场景定义复制）。 */
  hooks: z.array(ScenarioHookSchema).max(64).optional(),
  /** Frozen Harness policies used for deterministic recovery and audit. */
  harnessVersion: z.number().int().min(1).max(PERSONALIZATION_LIMITS.version).optional(),
  deliverable: DeliverableSpecSchema.optional(),
  writingStyle: ScenarioWritingStyleSchema.optional(),
  adaptivity: AdaptivityPolicySchema.optional(),
  scenarioMetis: ScenarioMetisDocumentSchema.optional(),
  workflowGovernance: ScenarioWorkflowGovernanceSchema.optional(),
  workflowLoop: ScenarioWorkflowLoopSchema.optional(),
  checkpointPolicy: ScenarioCheckpointPolicySchema.optional(),
  qualityGates: z.array(ScenarioQualityGateSchema).max(128).optional(),
  fullAccess: FullAccessPolicySchema,
  memory: MemoryPolicySchema,
  output: OutputContractSchema,
  truthPolicy: z.literal('automatic_required'),
  createdAt: PersonalizationTimestampSchema,
  manifestDigest: PersonalizationDigestSchema,
});

export const PersonalizationResolveResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), manifest: ResolvedRunManifestSchema }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['scenario_not_found', 'scenario_disabled', 'dependency_invalid', 'definition_corrupt']),
    issues: z.array(multiline(4_000)).max(128),
  }),
]);

export type PersonalizationListRequest = z.infer<typeof PersonalizationListRequestSchema>;
export type ArchivedPersonalizationDefinition = z.infer<typeof ArchivedPersonalizationDefinitionSchema>;
export type PersonalizationTrashListRequest = z.infer<typeof PersonalizationTrashListRequestSchema>;
export type PersonalizationGetRequest = z.infer<typeof PersonalizationGetRequestSchema>;
export type PersonalizationSaveRequest = z.infer<typeof PersonalizationSaveRequestSchema>;
export type PersonalizationDeleteRequest = z.infer<typeof PersonalizationDeleteRequestSchema>;
export type PersonalizationForkRequest = z.infer<typeof PersonalizationForkRequestSchema>;
export type PersonalizationRestoreRequest = z.infer<typeof PersonalizationRestoreRequestSchema>;
export type PersonalizationTrashRestoreRequest = z.infer<typeof PersonalizationTrashRestoreRequestSchema>;
export type PersonalizationVersionsRequest = z.infer<typeof PersonalizationVersionsRequestSchema>;
export type PersonalizationIntegrityIssue = z.infer<typeof PersonalizationIntegrityIssueSchema>;
export type PersonalizationIntegrityListRequest = z.infer<typeof PersonalizationIntegrityListRequestSchema>;
export type PersonalizationIntegrityRecoverRequest = z.infer<typeof PersonalizationIntegrityRecoverRequestSchema>;
export type PersonalizationResolveRequest = z.infer<typeof PersonalizationResolveRequestSchema>;
export type PersonalizationListResponse = z.infer<typeof PersonalizationListResponseSchema>;
export type PersonalizationTrashListResponse = z.infer<typeof PersonalizationTrashListResponseSchema>;
export type PersonalizationGetResponse = z.infer<typeof PersonalizationGetResponseSchema>;
export type PersonalizationVersionView = z.infer<typeof PersonalizationVersionViewSchema>;
export type PersonalizationVersionsResponse = z.infer<typeof PersonalizationVersionsResponseSchema>;
export type PersonalizationIntegrityListResponse = z.infer<typeof PersonalizationIntegrityListResponseSchema>;
export type PersonalizationMutationResult = z.infer<typeof PersonalizationMutationResultSchema>;
export type ResolvedPromptLayer = z.infer<typeof ResolvedPromptLayerSchema>;
export type ResolvedRunManifest = z.infer<typeof ResolvedRunManifestSchema>;
export type PersonalizationResolveResponse = z.infer<typeof PersonalizationResolveResponseSchema>;

export function decodePersonalizationDefinition(input: unknown): PersonalizationDefinition | undefined {
  const parsed = PersonalizationDefinitionSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

/**
 * 宽松净化解析（2026-08-29 刘总要求：校验只用来净化，不用来拒绝保存）。
 * 严格 schema 逐轮剔除“未知字段”（如模型写在步骤上的 title/agentIds），
 * 保住其余全部内容；只有引擎运行必需字段出现真实类型错误时才判定失败。
 */
/**
 * 章节枚举同义归一（2026-08-29 刘总要求：校验只用来净化，不用来拒绝）。
 * 模型常用"必要/必须/must"等同义词表达状态，用"章/小节/标题"等中文表达
 * 类型；这些是合法意图，只是不在枚举字面里。写入前归一到合法枚举，
 * 未知值回落到语义安全默认（状态→required；类型→按层级 chapter/section）。
 */
const DELIVERABLE_STATUS_SYNONYMS: Record<string, 'locked' | 'required' | 'optional' | 'conditional'> = {
  locked: 'locked', lock: 'locked', '锁定': 'locked', '锁定项': 'locked',
  required: 'required', must: 'required', mandatory: 'required', '必要': 'required', '必须': 'required', '必备': 'required', '必填': 'required', '核心': 'required',
  optional: 'optional', '可选': 'optional', '选用': 'optional',
  conditional: 'conditional', condition: 'conditional', '条件': 'conditional', '视情况': 'conditional',
};

const DELIVERABLE_KIND_SYNONYMS: Record<string, 'title' | 'abstract' | 'keywords' | 'chapter' | 'section' | 'grant_column' | 'attachment' | 'references' | 'other'> = {
  title: 'title', '标题': 'title', '题目': 'title',
  abstract: 'abstract', '摘要': 'abstract',
  keywords: 'keywords', '关键词': 'keywords',
  chapter: 'chapter', '章': 'chapter', '一级章节': 'chapter',
  section: 'section', '节': 'section', '小节': 'section', '二级章节': 'section', '子章节': 'section',
  grant_column: 'grant_column', '栏目': 'grant_column',
  attachment: 'attachment', '附件': 'attachment',
  references: 'references', '参考文献': 'references',
  other: 'other', '其他': 'other',
};

function normalizeDeliverableSectionEnums(entries: unknown, topLevel: boolean): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const section = entry as Record<string, unknown>;
    if (typeof section.status === 'string') {
      section.status = DELIVERABLE_STATUS_SYNONYMS[section.status.trim().toLowerCase()] ?? 'required';
    } else if (section.status === undefined || section.status === null) {
      section.status = 'required';
    }
    if (typeof section.kind === 'string') {
      section.kind = DELIVERABLE_KIND_SYNONYMS[section.kind.trim().toLowerCase()] ?? (topLevel ? 'chapter' : 'section');
    } else if (section.kind === undefined || section.kind === null) {
      section.kind = topLevel ? 'chapter' : 'section';
    }
    if (Array.isArray(section.children)) normalizeDeliverableSectionEnums(section.children, false);
  }
}

export function parsePersonalizationDefinitionLenient(
  definition: PersonalizationDefinition,
): { ok: true; definition: PersonalizationDefinition; removed: string[] } | { ok: false; issues: string[] } {
  const candidate: unknown = JSON.parse(JSON.stringify(definition)) as unknown;
  const removed: string[] = [];
  {
    const deliverable = (candidate as { deliverable?: { sections?: unknown } }).deliverable;
    if (deliverable && typeof deliverable === 'object' && Array.isArray(deliverable.sections)) {
      normalizeDeliverableSectionEnums(deliverable.sections, true);
    }
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const parsed = PersonalizationDefinitionSchema.safeParse(candidate);
    if (parsed.success) return { ok: true, definition: parsed.data, removed };
    const pruneTargets: Array<{ path: string; keys: string[] }> = [];
    const otherIssues: string[] = [];
    for (const issue of parsed.error.issues) {
      const keys = (issue as { keys?: unknown }).keys;
      if (issue.code === 'unrecognized_keys' && Array.isArray(keys)) {
        pruneTargets.push({ path: issue.path.join('.'), keys: keys as string[] });
      } else {
        otherIssues.push(`${issue.path.join('.') || 'root'}: ${issue.message}`);
      }
    }
    if (pruneTargets.length === 0) return { ok: false, issues: otherIssues.slice(0, 12) };
    for (const target of pruneTargets) {
      let node: Record<string, unknown> | null = candidate as Record<string, unknown>;
      if (target.path) {
        for (const key of target.path.split('.')) {
          if (node === null || typeof node !== 'object') { node = null; break; }
          node = node[key] as Record<string, unknown> | null;
        }
      }
      if (node && typeof node === 'object') {
        for (const key of target.keys) {
          if (key in node) {
            delete node[key];
            removed.push(`${target.path ? target.path + '.' : ''}${key}`);
          }
        }
      }
    }
  }
  return { ok: false, issues: ['多次净化后仍未通过校验'] };
}

export function decodePersonalizationListResponse(input: unknown): PersonalizationListResponse {
  const parsed = PersonalizationListResponseSchema.safeParse(input);
  return parsed.success ? parsed.data : { ok: false, code: 'invalid_response' };
}

export function decodePersonalizationTrashListResponse(input: unknown): PersonalizationTrashListResponse {
  const parsed = PersonalizationTrashListResponseSchema.safeParse(input);
  return parsed.success ? parsed.data : { ok: false, code: 'invalid_response' };
}

export function decodePersonalizationGetResponse(input: unknown): PersonalizationGetResponse {
  const parsed = PersonalizationGetResponseSchema.safeParse(input);
  return parsed.success ? parsed.data : { ok: true, definition: null };
}

export function decodePersonalizationVersionsResponse(input: unknown): PersonalizationVersionsResponse {
  const parsed = PersonalizationVersionsResponseSchema.safeParse(input);
  return parsed.success ? parsed.data : { ok: true, versions: [] };
}

export function decodePersonalizationIntegrityListResponse(input: unknown): PersonalizationIntegrityListResponse {
  const parsed = PersonalizationIntegrityListResponseSchema.safeParse(input);
  return parsed.success ? parsed.data : { ok: false, code: 'invalid_response' };
}

export function decodePersonalizationMutationResult(input: unknown): PersonalizationMutationResult {
  const parsed = PersonalizationMutationResultSchema.safeParse(input);
  return parsed.success ? parsed.data : { ok: false, code: 'invalid_request' };
}

export function decodePersonalizationResolveResponse(input: unknown): PersonalizationResolveResponse {
  const parsed = PersonalizationResolveResponseSchema.safeParse(input);
  return parsed.success
    ? parsed.data
    : { ok: false, code: 'definition_corrupt', issues: ['Invalid personalization response'] };
}
