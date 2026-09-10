import { randomUUID } from 'node:crypto';

/**
 * METIS Skill Studio(2026-09-05 刘总要求,任务7)。
 *
 * 把用户的科研经验、方法和工作习惯转化为 METIS 可重复调用的技能。
 * - 4 种创建入口:from_scratch / from_experience / from_files / from_session
 * - 结构化沉淀:Identity/Activation/Method/Decision Rules(专家经验核心)/
 *   Inputs/Outputs/Evidence Requirements/Tool Requirements/Failure & Recovery/
 *   Quality Criteria/正反例
 * - 生成产物为 SKILL.md(systemPrompt)+ 结构化元数据,写入 Personalization
 *   技能库(进入库 ≠ 注册给普通 Agent,遵守任务7 零可见原则)
 * - Test Run:沙箱只暴露当前 Skill + 测试所需 Native Tool
 */

export type SkillStudioSource = 'from_scratch' | 'from_experience' | 'from_files' | 'from_session';

export interface SkillDecisionRule {
  /** 触发条件(IF)。 */
  when: string;
  /** 应执行(THEN)。 */
  then: string;
  /** 禁止(DO NOT),可空。 */
  doNot?: string;
}

export interface SkillStudioInput {
  source: SkillStudioSource;
  name: string;
  purpose: string;
  /** 适用范围/前置条件(Activation)。 */
  whenToUse: string;
  whenNotToUse?: string;
  prerequisites?: string;
  /** 方法步骤(有序)。 */
  steps: string[];
  decisionRules?: SkillDecisionRule[];
  inputs?: string;
  outputs?: string;
  evidenceRequirements?: string;
  toolRequirements?: string[];
  failureRecovery?: string;
  qualityCriteria?: string[];
  positiveExample?: string;
  negativeExample?: string;
}

export interface SkillStudioDocument {
  skillId: string;
  name: string;
  systemPrompt: string;
  createdAt: number;
}

function section(title: string, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  return `\n## ${title}\n${trimmed}\n`;
}

function numbered(items: readonly string[]): string {
  return items.map((item, index) => `${index + 1}. ${item.trim()}`).join('\n');
}

/** 把结构化输入组装为 SKILL.md 形式的 systemPrompt(结构完整,Decision Rules 显式)。 */
export function buildSkillDocument(input: SkillStudioInput): SkillStudioDocument {
  const name = input.name.trim() || '未命名技能';
  const parts: string[] = [];
  parts.push(`# Skill: ${name}`);
  parts.push(section('用途', input.purpose));
  const activation = [
    input.whenToUse ? `**何时使用**: ${input.whenToUse}` : '',
    input.whenNotToUse ? `**何时不使用**: ${input.whenNotToUse}` : '',
    input.prerequisites ? `**前置条件**: ${input.prerequisites}` : '',
  ].filter(Boolean).join('\n');
  parts.push(section('激活条件 (Activation)', activation));
  if (input.steps.length > 0) {
    parts.push(section('方法步骤 (Method)', numbered(input.steps)));
  }
  if (input.decisionRules && input.decisionRules.length > 0) {
    const rules = input.decisionRules
      .filter((rule) => rule.when.trim() && rule.then.trim())
      .map((rule, index) => `${index + 1}. IF: ${rule.when.trim()}\n   THEN: ${rule.then.trim()}${rule.doNot?.trim() ? `\n   DO NOT: ${rule.doNot.trim()}` : ''}`)
      .join('\n');
    parts.push(section('判断规则 (Decision Rules)', rules || '(无)'));
  }
  parts.push(section('输入 (Inputs)', input.inputs ?? '当前对话上下文与用户提供的材料。'));
  parts.push(section('输出 (Outputs)', input.outputs ?? '结构化的分析与建议文本。'));
  parts.push(section('证据要求 (Evidence Requirements)', input.evidenceRequirements ?? '关键判断须注明依据;不得虚构文献、数据或来源。'));
  if (input.toolRequirements && input.toolRequirements.length > 0) {
    parts.push(section('工具需求 (Tool Requirements)', input.toolRequirements.join('\n')));
  }
  parts.push(section('失败与恢复 (Failure & Recovery)', input.failureRecovery ?? '检索/工具失败时如实报告失败并降级处理,不得伪造成功。'));
  if (input.qualityCriteria && input.qualityCriteria.length > 0) {
    parts.push(section('完成标准 (Quality Criteria)', numbered(input.qualityCriteria)));
  }
  if (input.positiveExample) parts.push(section('正例 (Positive Example)', input.positiveExample));
  if (input.negativeExample) parts.push(section('反例 (Negative Example)', input.negativeExample));

  return {
    skillId: `skill_studio_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    name,
    systemPrompt: parts.join('\n').trim(),
    createdAt: Date.now(),
  };
}

/** 从一次工作/经验文本提取结构化 Skill 的 AI 提示词(文档十八节:AI 主动追问隐性经验)。 */
export function buildExperienceElicitationPrompt(experience: string, source: SkillStudioSource): { system: string; user: string } {
  return {
    system: [
      '你是 METIS Skill Studio 的技能萃取助手(2026-09-05)。用户会描述自己的科研经验、工作习惯或一次工作过程;你的任务是把它们转化为一份结构化 SKILL 文档。',
      'HARD RULES:',
      '1. 必须主动追问隐性经验:什么情况适用/不适用?你怎么判断典型错误?有什么正反例?资料不足怎么办?什么状态算完成?哪些判断必须人工完成?——但一次最多问 3 个最关键的问题,不要问卷式轰炸。',
      '2. 判断规则 (Decision Rules) 是核心:把经验写成 IF/THEN/DO NOT 形式(例:IF 研究核心命题尚未明确 THEN 先做问题界定 DO NOT 直接启动大规模文献综述)。',
      '3. 只使用用户给出的经验,不得编造用户没有的方法论或案例。',
      '4. 输出必须是严格的 JSON(无代码围栏):{"needMoreInfo": boolean, "questions": ["..."], "skill": {"name": "...", "purpose": "...", "whenToUse": "...", "whenNotToUse": "...", "steps": ["..."], "decisionRules": [{"when": "...", "then": "...", "doNot": "..."}], "evidenceRequirements": "...", "qualityCriteria": ["..."]}}',
      '5. 信息足够时 needMoreInfo=false 并给出完整 skill;信息不足时 needMoreInfo=true 并给出 questions 与已知部分。',
    ].join('\n'),
    user: `[创建入口: ${source}]\n[用户描述的经验/工作]\n${experience}`,
  };
}

/** Test Run 沙箱配置:只暴露当前 Skill + 明确列出的 Native Tools(文档十九节)。 */
export function buildTestRunOptions(input: { systemPrompt: string; allowedTools: readonly string[]; message: string }) {
  return {
    sessionId: `skill_studio_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    skillPrompt: input.systemPrompt,
    allowedTools: [...input.allowedTools],
    maxTurns: 6,
    message: input.message,
  };
}
