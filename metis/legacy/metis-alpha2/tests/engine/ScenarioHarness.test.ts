import { describe, expect, it } from 'vitest';
import {
  PersonalizationDefinitionSchema,
  ScenarioDefinitionSchema,
  type ScenarioDefinition,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import {
  assessScenarioHarness,
  autoFixScenarioHarness,
  collectDeliverableCompletenessGaps,
  isPlaceholderText,
  normalizeScenarioHarness,
  renderScenarioMetisMarkdown,
  requiredDeliverableFieldsForKind,
} from '../../engine/personalization/ScenarioHarness.js';

function legacyScenario(overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return {
    contractVersion: 1,
    id: 'user:scenarios/harness-test',
    kind: 'scenario',
    name: 'Harness test',
    description: 'Run a reproducible research workflow.',
    enabled: true,
    tags: [],
    revision: 1,
    provenance: {
      origin: 'user',
      author: 'test',
      version: '1.0.0',
      license: null,
      sourceUrl: null,
      sourceRevision: null,
      installedDigest: null,
      parentId: null,
      parentVersion: null,
      locallyModified: true,
      createdAt: 1,
      updatedAt: 1,
    },
    agentIds: [],
    skillIds: [],
    mcpIds: [],
    rulesIds: [],
    workflow: [{
      id: 'search',
      name: 'Search',
      description: 'Find the relevant literature.',
      skillIds: [],
      toolIds: [],
      mcpIds: [],
      dependsOn: [],
      maxTurns: 12,
    }],
    fullAccess: {
      mode: 'full_access',
      perActionConfirmation: false,
      liveSteering: true,
      silentCheckpoints: true,
      rollbackOnFailure: false,
      persistAcrossRestart: true,
    },
    memory: {
      scope: 'project',
      retainDecisions: true,
      retainArtifacts: true,
      maxSummaryChars: 100_000,
    },
    output: {
      format: 'artifact_bundle',
      schema: null,
      plan: null,
      requireEvidenceEnvelope: true,
      includeIntegrityReport: true,
    },
    triggerPhrases: [],
    capability: 'research',
    ...overrides,
  };
}

describe('Scenario Research Harness compatibility and quality', () => {
  it('keeps a legacy scenario valid while allowing an unassigned workflow Agent', () => {
    const parsed = ScenarioDefinitionSchema.safeParse(legacyScenario());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.workflow[0]?.agentId).toBeUndefined();
  });

  it('normalizes deterministic Harness policies without changing identity or revision', () => {
    const normalized = normalizeScenarioHarness(legacyScenario({ writingRules: ['Use verifiable citations.'] }));
    expect(normalized.id).toBe('user:scenarios/harness-test');
    expect(normalized.revision).toBe(1);
    expect(normalized.workflow[0]).toMatchObject({
      goal: 'Find the relevant literature.',
      prompt: 'Find the relevant literature.',
      failurePolicy: { action: 'retry', retryLimit: 2 },
      loop: { enabled: false, maxIterations: 1 },
    });
    expect(normalized.scenarioMetis?.writingRules).toContain('verifiable citations');
    expect(normalized.checkpointPolicy).toMatchObject({ enabled: true, afterEveryStep: true });
    expect(PersonalizationDefinitionSchema.safeParse(normalized).success).toBe(true);
  });

  it('reports actionable blocking gaps and auto-fixes only deterministic step structure', () => {
    const scenario = legacyScenario();
    const before = assessScenarioHarness(scenario);
    expect(before.status).toBe('blocked');
    expect(before.issues.map((item) => item.code)).toEqual(expect.arrayContaining([
      'deliverable_blueprint_missing',
      'step_criteria_missing',
    ]));

    const fixed = autoFixScenarioHarness(scenario);
    expect(fixed.workflow[0]?.outputs).toHaveLength(1);
    expect(fixed.workflow[0]?.completionCriteria).toHaveLength(1);
    expect(assessScenarioHarness(fixed).issues.map((item) => item.code)).not.toContain('step_criteria_missing');
    expect(assessScenarioHarness(fixed).issues.map((item) => item.code)).toContain('deliverable_blueprint_missing');
    expect(ScenarioDefinitionSchema.safeParse(fixed).success).toBe(true);
  });

  it('renders every required Scenario Metis.md section in inheritance order', () => {
    const normalized = normalizeScenarioHarness(legacyScenario());
    const markdown = renderScenarioMetisMarkdown({
      ...normalized.scenarioMetis!,
      markdown: '',
      purpose: 'P',
      roleBoundaries: 'R',
      researchRules: 'Research',
      writingRules: 'Writing',
      toolRules: 'Tools',
      qualityGates: 'Quality',
      failureRecovery: 'Recovery',
    });
    expect(markdown).toContain('## Purpose\nP');
    expect(markdown).toContain('## Role boundaries\nR');
    expect(markdown).toContain('## Failure recovery\nRecovery');
    expect(normalized.scenarioMetis?.inheritanceOrder).toEqual(['global', 'scenario', 'project']);
  });

  it('heals top-level sections mislabeled as "section" back to "chapter" on normalize', () => {
    const scenario = legacyScenario({
      deliverable: {
        type: 'grant_postdoc',
        globalLength: '7500字',
        sections: [
          { id: 'ch-1', title: '一、立项依据', kind: 'section', status: 'required', children: [
            { id: 'ch-1-1', title: '1.1 研究问题', kind: 'section', status: 'required' },
          ] },
        ],
      } as ScenarioDefinition['deliverable'],
    });
    const normalized = normalizeScenarioHarness(scenario);
    expect(normalized.deliverable?.sections?.[0]?.kind).toBe('chapter');
    // 二级条目保持 "section"
    expect(normalized.deliverable?.sections?.[0]?.children?.[0]?.kind).toBe('section');
  });
});

describe('Deliverable completeness contract (2026-09-04 刘总要求)', () => {
  const deliverableScenario = () => legacyScenario({
    deliverable: {
      type: 'theory_paper',
      globalLength: '10000字',
      sections: [
        {
          id: 'abstract', title: '摘要', kind: 'abstract', status: 'required',
          purpose: '概括研究问题、方法与核心发现。', instructions: '直接报告问题、方法、发现与贡献，不使用「本文」「本研究」。', requirements: ['报告核心发现'], lengthTarget: '300字',
          children: [],
        },
        {
          id: 'chapter-1', title: '引言', kind: 'chapter', status: 'required',
          purpose: '引出研究问题。', instructions: '由现实背景切入。', requirements: ['明确研究问题'], lengthTarget: '1500字',
          children: [{
            id: 'chapter-1-1', title: '研究背景', kind: 'section', status: 'required',
            purpose: '铺垫领域现状。', instructions: '概述发展脉络。', requirements: ['覆盖代表研究'], lengthTarget: '800字',
          }],
        },
        { id: 'references', title: '参考文献', kind: 'references', status: 'required', instructions: '仅列正文实际引用文献。', requirements: ['与正文引用一一对应'] },
      ],
    } as ScenarioDefinition['deliverable'],
  });

  it('requiredDeliverableFieldsForKind is kind-aware (title/references exemptions)', () => {
    // 2026-09 刘总规格：交付物部分只保留 instructions 一个必填字段。
    expect(requiredDeliverableFieldsForKind('chapter')).toEqual(['instructions']);
    expect(requiredDeliverableFieldsForKind('abstract')).toEqual(['instructions']);
    expect(requiredDeliverableFieldsForKind('references')).toEqual(['instructions']);
    expect(requiredDeliverableFieldsForKind('title')).toEqual([]);
  });

  it('isPlaceholderText rejects TBD/待定/根据实际情况 and empty arrays', () => {
    expect(isPlaceholderText('TBD')).toBe(true);
    expect(isPlaceholderText('待定。')).toBe(true);
    expect(isPlaceholderText('根据实际情况')).toBe(true);
    expect(isPlaceholderText(['待补充'])).toBe(true);
    expect(isPlaceholderText('')).toBe(true);
    expect(isPlaceholderText(undefined)).toBe(true);
    expect(isPlaceholderText('围绕三类解释机制组织文献，导出研究缺口。')).toBe(false);
    expect(isPlaceholderText(['比较三类机制'])).toBe(false);
  });

  it('collectDeliverableCompletenessGaps reports missing fields per node', () => {
    const scenario = deliverableScenario();
    scenario.deliverable!.sections![1]!.instructions = undefined;
    const gaps = collectDeliverableCompletenessGaps(scenario);
    expect(gaps.some((gap) => gap.field === 'globalInstructions')).toBe(true);
    expect(gaps.some((gap) => gap.sectionId === 'chapter-1' && gap.field === 'instructions')).toBe(true);
    // purpose/requirements/lengthTarget 不再必填（2026-09 刘总规格）。
    expect(gaps.some((gap) => gap.field === 'purpose')).toBe(false);
    expect(gaps.some((gap) => gap.field === 'requirements')).toBe(false);
    expect(gaps.some((gap) => gap.field === 'lengthTarget')).toBe(false);
    // references 有 instructions 不产生 gap。
    expect(gaps.some((gap) => gap.sectionId === 'references')).toBe(false);
  });

  it('assessScenarioHarness blocks on missing globalInstructions/instructions and turns ready when filled', () => {
    const scenario = deliverableScenario();
    scenario.deliverable!.sections![1]!.instructions = undefined;
    const blocked = assessScenarioHarness(scenario);
    expect(blocked.issues.map((issue) => issue.code)).toContain('deliverable_global_instructions_missing');
    expect(blocked.issues.map((issue) => issue.code)).toContain('section_instructions_missing');
    expect(blocked.status).toBe('blocked');
    const ready = assessScenarioHarness({
      ...deliverableScenario(),
      workflowPrompt: '按步骤推进并保证质量。',
      scenarioMetis: {
        purpose: '', roleBoundaries: '', researchRules: '', writingRules: '', toolRules: '', qualityGates: '', failureRecovery: '',
        markdown: '# 规则\n\n' + '这是一段足够长的真实规则文档内容，用于通过规则长度检查。'.repeat(3),
      },
      workflow: scenario.workflow.map((step) => ({
        ...step,
        goal: step.goal ?? step.description,
        prompt: '执行检索并记录证据。',
        completionCriteria: ['证据已记录。'],
        failurePolicy: { action: 'retry' as const, retryLimit: 2, backtrackStepId: null, instruction: '' },
        loop: { enabled: false, maxIterations: 1, stopCondition: '', evaluator: 'completion_criteria' as const, onExhausted: 'fail' as const, backtrackStepId: null },
      })),
      deliverable: {
        ...scenario.deliverable!,
        globalInstructions: '全文学术化，术语一致，论证连续。',
        sections: scenario.deliverable!.sections!.map((section) => ({
          ...section,
          purpose: section.purpose ?? '完成该部分在全文中的核心论证任务。',
          instructions: section.instructions ?? '按该部分类型组织内容并满足结构要求。',
          requirements: section.requirements ?? ['满足该部分基本要求'],
          lengthTarget: section.lengthTarget ?? '300字',
        })),
      },
    });
    expect(ready.issues.filter((issue) => issue.code.startsWith('section_') || issue.code === 'deliverable_global_instructions_missing')).toEqual([]);
  });

  it('migrates legacy writingRules into deliverable.globalInstructions without dropping old fields', () => {
    const scenario = legacyScenario({
      writingRules: ['引用必须可验证。'],
      deliverable: { type: 'theory_paper', sections: [{ id: 's1', title: '引言', kind: 'chapter', status: 'required' }] },
    } as Partial<ScenarioDefinition>);
    const normalized = normalizeScenarioHarness(scenario);
    expect(normalized.deliverable?.globalInstructions).toContain('引用必须可验证。');
    // 旧字段保留（向后兼容，不丢数据）。
    expect(normalized.writingRules).toContain('引用必须可验证。');
  });

  it('does not overwrite an explicit globalInstructions (empty string stays empty)', () => {
    const scenario = legacyScenario({
      writingRules: ['引用必须可验证。'],
      deliverable: { type: 'theory_paper', globalInstructions: '', sections: [] },
    } as Partial<ScenarioDefinition>);
    const normalized = normalizeScenarioHarness(scenario);
    expect(normalized.deliverable?.globalInstructions).toBe('');
  });

  it('rich fields (instructions/globalInstructions) survive the lenient save parse path', () => {
    const scenario = deliverableScenario();
    scenario.deliverable!.globalInstructions = '全文学术化，术语一致。';
    const parsed = ScenarioDefinitionSchema.safeParse(normalizeScenarioHarness(scenario));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.deliverable?.globalInstructions).toBe('全文学术化，术语一致。');
      const abstract = parsed.data.deliverable?.sections?.find((section) => section.id === 'abstract');
      expect(abstract?.instructions).toContain('本文');
      const child = abstract; // front-matter 保留
      expect(child?.kind).toBe('abstract');
    }
  });
});
