import { describe, expect, it } from 'vitest';
import {
  buildExperienceElicitationPrompt,
  buildSkillDocument,
  buildTestRunOptions,
  type SkillStudioInput,
} from '../../engine/skills/SkillStudio.js';

function sampleInput(overrides: Partial<SkillStudioInput> = {}): SkillStudioInput {
  return {
    source: 'from_experience',
    name: 'CSSCI 选题判断',
    purpose: '判断一个候选选题是否值得投入。',
    whenToUse: '选题阶段的候选比较。',
    whenNotToUse: '已有明确题目后的写作阶段。',
    steps: ['判断现实矛盾', '核查既有研究回答到哪一步', '确认数据可得'],
    decisionRules: [
      { when: '研究核心命题尚未明确', then: '先做问题界定与概念辨析', doNot: '直接启动大规模文献综述' },
    ],
    evidenceRequirements: '判断必须引用真实检索结果。',
    qualityCriteria: ['产出明确的选题判断与理由'],
    ...overrides,
  };
}

describe('Skill Studio(2026-09-05 任务7)', () => {
  it('builds a structured SKILL document with explicit Decision Rules', () => {
    const document = buildSkillDocument(sampleInput());
    expect(document.name).toBe('CSSCI 选题判断');
    expect(document.systemPrompt).toContain('# Skill: CSSCI 选题判断');
    expect(document.systemPrompt).toContain('## 判断规则 (Decision Rules)');
    expect(document.systemPrompt).toContain('IF: 研究核心命题尚未明确');
    expect(document.systemPrompt).toContain('DO NOT: 直接启动大规模文献综述');
    expect(document.systemPrompt).toContain('## 完成标准 (Quality Criteria)');
  });

  it('omits empty sections and falls back to honest failure recovery', () => {
    const document = buildSkillDocument(sampleInput({
      decisionRules: [],
      positiveExample: undefined,
      negativeExample: undefined,
      failureRecovery: undefined,
    }));
    expect(document.systemPrompt).not.toContain('## 判断规则');
    expect(document.systemPrompt).not.toContain('## 正例');
    expect(document.systemPrompt).toContain('不得伪造成功');
  });

  it('elicitation prompt enforces structured JSON output and bounded questioning', () => {
    const elicitation = buildExperienceElicitationPrompt('我做选题时先看现实矛盾……', 'from_experience');
    expect(elicitation.system).toContain('needMoreInfo');
    expect(elicitation.system).toContain('IF/THEN/DO NOT');
    expect(elicitation.system).toContain('一次最多问 3 个');
    expect(elicitation.user).toContain('from_experience');
  });

  it('test run sandbox only exposes the declared tools and stays ephemeral', () => {
    const options = buildTestRunOptions({
      systemPrompt: '# Skill: 测试',
      allowedTools: ['web_search', 'web_fetch'],
      message: '用这个技能处理一个案例',
    });
    expect(options.allowedTools).toEqual(['web_search', 'web_fetch']);
    expect(options.maxTurns).toBeLessThanOrEqual(6);
    expect(options.sessionId.startsWith('skill_studio_test_')).toBe(true);
  });
});
