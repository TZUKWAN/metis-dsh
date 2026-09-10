import { z } from 'zod';

/**
 * Topic(选题)运行时契约(2026-09-04 刘总要求:选题一级功能)。
 *
 * Topic 是 Project 创建之前的开放式探索:调查意图 → 真实检索 → 研究版图 →
 * 候选比较 → 确认选题 → Topic Research Brief(handoff)→ Scenario/Project。
 * 选题不是 Scenario,也不是 Project;有独立持久化(SQLite),禁止只存
 * React state / localStorage。
 */

export const TOPIC_CONTRACT_VERSION = 1 as const;

export const TOPIC_SESSION_STATUSES = [
  'exploring', 'researching', 'comparing', 'selected', 'converted', 'archived',
] as const;
export const TopicSessionStatusSchema = z.enum(TOPIC_SESSION_STATUSES);

export const TOPIC_CANDIDATE_STATUSES = [
  'candidate', 'shortlisted', 'selected', 'rejected', 'converted',
] as const;
export const TopicCandidateStatusSchema = z.enum(TOPIC_CANDIDATE_STATUSES);

/** 选题阶段用户约束(研究类型/目标发表/数据条件等,自由结构,第一版不过度 schema 化)。 */
export const TopicConstraintsSchema = z.object({
  researchTypes: z.array(z.string().max(60)).max(12).optional(),
  targetPublications: z.array(z.string().max(60)).max(12).optional(),
  methodPreference: z.string().max(300).optional(),
  dataConditions: z.string().max(500).optional(),
  timeConstraints: z.string().max(300).optional(),
  exclusions: z.string().max(500).optional(),
  extra: z.string().max(2000).optional(),
}).strict();
export type TopicConstraints = z.infer<typeof TopicConstraintsSchema>;

/** 检索证据引用:每个重要研究判断都要能回溯到真实来源(v2 02 第十九节)。 */
export const TopicEvidenceRefSchema = z.object({
  title: z.string().max(500),
  authors: z.array(z.string().max(200)).max(50).optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  venue: z.string().max(300).optional(),
  doi: z.string().max(200).optional(),
  url: z.string().max(2000).optional(),
  sourceType: z.enum(['paper', 'web', 'library', 'project_material']).optional(),
  claim: z.string().max(500).optional(),
}).strict();
export type TopicEvidenceRef = z.infer<typeof TopicEvidenceRefSchema>;

export const TopicSessionCreateRequestSchema = z.object({
  title: z.string().max(120).optional(),
  initialIntent: z.string().max(8000).optional(),
  sourceProjectId: z.string().max(160).nullable().optional(),
  discipline: z.string().max(120).optional(),
  constraints: TopicConstraintsSchema.optional(),
  /** 会话分类(刘总 2026-09 选题 tab 化:可空=未分类,旧数据无此字段向后兼容)。 */
  category: z.string().max(60).nullable().optional(),
}).strict();

export const TopicSessionDtoSchema = z.object({
  id: z.string().max(160),
  title: z.string().max(200),
  initialIntent: z.string().max(8000).default(''),
  sourceProjectId: z.string().max(160).nullable().default(null),
  discipline: z.string().max(120).default(''),
  constraints: TopicConstraintsSchema.nullable().default(null),
  status: TopicSessionStatusSchema,
  selectedCandidateId: z.string().max(160).nullable().default(null),
  researchBrief: z.string().max(200_000).nullable().default(null),
  /** 会话分类(可空=未分类;旧库行无此列,迁移补列后默认 null)。 */
  category: z.string().max(60).nullable().default(null),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
});
export type TopicSessionDto = z.infer<typeof TopicSessionDtoSchema>;

export const TopicCandidateDtoSchema = z.object({
  id: z.string().max(160),
  sessionId: z.string().max(160),
  title: z.string().max(300),
  researchQuestion: z.string().max(2000).default(''),
  summary: z.string().max(4000).default(''),
  rationale: z.string().max(4000).default(''),
  existingResearch: z.string().max(8000).default(''),
  researchGap: z.string().max(4000).default(''),
  theoreticalAngles: z.array(z.string().max(300)).max(12).default([]),
  methodOptions: z.array(z.string().max(300)).max(12).default([]),
  dataOptions: z.array(z.string().max(300)).max(12).default([]),
  /** 创新空间定性判断:较明确/有限/高度拥挤/需继续验证(禁止伪精确评分)。 */
  noveltyAnalysis: z.string().max(600).default(''),
  /** 可行性定性判断:较高/中等/存在明显风险 + 理由。 */
  feasibilityAnalysis: z.string().max(600).default(''),
  risks: z.array(z.string().max(400)).max(12).default([]),
  closestStudies: z.array(z.string().max(500)).max(12).default([]),
  evidenceRefs: z.array(TopicEvidenceRefSchema).max(32).default([]),
  status: TopicCandidateStatusSchema,
  projectId: z.string().max(160).nullable().default(null),
  scenarioId: z.string().max(160).nullable().default(null),
  convertedAt: z.number().int().min(0).nullable().default(null),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
});
export type TopicCandidateDto = z.infer<typeof TopicCandidateDtoSchema>;

export const TopicMessageDtoSchema = z.object({
  id: z.string().max(160),
  sessionId: z.string().max(160),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().max(400_000),
  createdAt: z.number().int().min(0),
});
export type TopicMessageDto = z.infer<typeof TopicMessageDtoSchema>;

// ── IPC 请求 ──

export const TopicSessionUpdatePatchSchema = z.object({
  title: z.string().max(200).optional(),
  status: TopicSessionStatusSchema.optional(),
  discipline: z.string().max(120).optional(),
  constraints: TopicConstraintsSchema.nullable().optional(),
  selectedCandidateId: z.string().max(160).nullable().optional(),
  category: z.string().max(60).nullable().optional(),
}).strict();

export const TopicCandidateUpsertSchema = z.object({
  id: z.string().max(160).optional(),
  title: z.string().min(1).max(300),
  researchQuestion: z.string().max(2000).optional(),
  summary: z.string().max(4000).optional(),
  rationale: z.string().max(4000).optional(),
  existingResearch: z.string().max(8000).optional(),
  researchGap: z.string().max(4000).optional(),
  theoreticalAngles: z.array(z.string().max(300)).max(12).optional(),
  methodOptions: z.array(z.string().max(300)).max(12).optional(),
  dataOptions: z.array(z.string().max(300)).max(12).optional(),
  noveltyAnalysis: z.string().max(600).optional(),
  feasibilityAnalysis: z.string().max(600).optional(),
  risks: z.array(z.string().max(400)).max(12).optional(),
  closestStudies: z.array(z.string().max(500)).max(12).optional(),
  evidenceRefs: z.array(TopicEvidenceRefSchema).max(32).optional(),
  status: TopicCandidateStatusSchema.optional(),
}).strict();

export const TopicChatRequestSchema = z.object({
  sessionId: z.string().max(160),
  message: z.string().min(1).max(16_000),
}).strict();

/** Topic 对话回答中的结构化块(TopicService 确定性解析,禁止 DOM/正则魔法之外的隐式约定)。 */
export const TOPIC_BLOCK_TYPES = ['candidates_update', 'research_landscape', 'selection', 'status_update'] as const;

export const TopicStructuredBlockSchema = z.object({
  type: z.enum(TOPIC_BLOCK_TYPES),
  candidates: z.array(z.object({
    id: z.string().max(160).optional(),
    title: z.string().min(1).max(300),
    researchQuestion: z.string().max(2000).optional(),
    summary: z.string().max(4000).optional(),
    rationale: z.string().max(4000).optional(),
    existingResearch: z.string().max(8000).optional(),
    researchGap: z.string().max(4000).optional(),
    theoreticalAngles: z.array(z.string().max(300)).max(12).optional(),
    methodOptions: z.array(z.string().max(300)).max(12).optional(),
    dataOptions: z.array(z.string().max(300)).max(12).optional(),
    noveltyAnalysis: z.string().max(600).optional(),
    feasibilityAnalysis: z.string().max(600).optional(),
    risks: z.array(z.string().max(400)).max(12).optional(),
    closestStudies: z.array(z.string().max(500)).max(12).optional(),
    evidenceRefs: z.array(TopicEvidenceRefSchema).max(32).optional(),
    status: TopicCandidateStatusSchema.optional(),
  }).strict()).max(12).optional(),
  landscape: z.string().max(60_000).optional(),
  selectedTitle: z.string().max(300).optional(),
  sessionStatus: TopicSessionStatusSchema.optional(),
}).strict();
export type TopicStructuredBlock = z.infer<typeof TopicStructuredBlockSchema>;

// ── Topic Research Brief(跨模块 handoff contract,v2 02 第二十节)──

export const TopicResearchBriefSchema = z.object({
  source: z.literal('topic'),
  topicSessionId: z.string().max(160),
  candidateId: z.string().max(160),
  title: z.string().max(300),
  originalIntent: z.string().max(8000).default(''),
  researchQuestion: z.string().max(2000).default(''),
  discipline: z.string().max(120).default(''),
  researchBackground: z.string().max(8000).default(''),
  rationale: z.string().max(4000).default(''),
  literatureLandscape: z.string().max(60_000).default(''),
  mainResearchStreams: z.array(z.string().max(400)).max(12).default([]),
  majorDebates: z.array(z.string().max(400)).max(12).default([]),
  researchGap: z.string().max(4000).default(''),
  closestStudies: z.array(z.string().max(500)).max(12).default([]),
  theoreticalAngles: z.array(z.string().max(300)).max(12).default([]),
  methodologySuggestions: z.array(z.string().max(300)).max(12).default([]),
  dataSuggestions: z.array(z.string().max(300)).max(12).default([]),
  constraints: TopicConstraintsSchema.nullable().default(null),
  risks: z.array(z.string().max(400)).max(12).default([]),
  targetPublication: z.array(z.string().max(60)).max(12).default([]),
  evidenceRefs: z.array(TopicEvidenceRefSchema).max(32).default([]),
  userDecisions: z.string().max(4000).default(''),
  createdAt: z.number().int().min(0),
}).strict();
export type TopicResearchBrief = z.infer<typeof TopicResearchBriefSchema>;

/** Topic → Project 字段映射(v2 02 第二十六节)。 */
export const TopicProjectMappingSchema = z.object({
  title: z.string().max(200),
  originalIntent: z.string().max(8000),
  researchQuestion: z.string().max(2000),
  methodology: z.string().max(1000),
  discipline: z.string().max(120),
}).strict();

/** 结果信封。 */
export const TopicOperationResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    session: TopicSessionDtoSchema.optional(),
    candidates: z.array(TopicCandidateDtoSchema).optional(),
    messages: z.array(TopicMessageDtoSchema).optional(),
    brief: TopicResearchBriefSchema.optional(),
    answer: z.string().max(400_000).optional(),
    appliedBlocks: z.array(z.enum(TOPIC_BLOCK_TYPES)).optional(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().max(80),
    message: z.string().max(2000).optional(),
  }),
]);
export type TopicOperationResult = z.infer<typeof TopicOperationResultSchema>;
