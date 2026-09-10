import { describe, expect, it } from 'vitest';
import type { ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import {
  ScenarioPatchSession,
  createScenarioPatchRouter,
  deepMergeScenarioField,
} from '../../engine/tools/builtin/scenario-patch-tool.js';

function baseScenario(overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return {
    contractVersion: 1,
    id: 'user:scenario/research-paper',
    kind: 'scenario',
    name: '',
    description: '',
    enabled: true,
    tags: [],
    revision: 3,
    provenance: { origin: 'user', author: 'test', version: '1.0.0', license: null, sourceUrl: null, sourceRevision: null, installedDigest: null, parentId: null, parentVersion: null, locallyModified: true, createdAt: 1, updatedAt: 1 },
    agentIds: [],
    skillIds: [],
    mcpIds: [],
    rulesIds: [],
    workflow: [],
    fullAccess: { mode: 'full_access', perActionConfirmation: false, liveSteering: true, silentCheckpoints: true, rollbackOnFailure: false, persistAcrossRestart: true },
    memory: { scope: 'project', retainDecisions: true, retainArtifacts: true, maxSummaryChars: 4_000 },
    output: { format: 'markdown', schema: null, plan: { primaryDeliverable: '', supportingArtifacts: [], qualityCriteria: [] }, requireEvidenceEnvelope: false, includeIntegrityReport: false },
    triggerPhrases: [],
    capability: 'research',
    ...overrides,
  } as ScenarioDefinition;
}

describe('ScenarioPatchSession incremental authoring', () => {
  it('applies parts one at a time and reports a running overview after each step', () => {
    const session = new ScenarioPatchSession(baseScenario());
    expect(session.getDraft()).toBeNull(); // nothing applied yet

    const basics = session.apply({ name: '博后基金申报', description: '博士后科学基金申报材料场景' });
    expect(basics.ok).toBe(true);
    if (basics.ok) expect(basics.overview).toContain('博后基金申报');

    const workflow = session.apply({
      workflow: [
        { id: 'step-1', name: '解读申报要求', description: '', agentId: 'user:agents/default', skillIds: [], toolIds: [], mcpIds: [], dependsOn: [], maxTurns: 12 },
        { id: 'step-2', name: '撰写立项依据', description: '', agentId: 'user:agents/default', skillIds: [], toolIds: [], mcpIds: [], dependsOn: ['step-1'], maxTurns: 12 },
      ],
    });
    expect(workflow.ok).toBe(true);

    const draft = session.getDraft();
    expect(draft).not.toBeNull();
    expect(draft!.name).toBe('博后基金申报');
    expect(draft!.workflow).toHaveLength(2);
    expect(draft!.workflow[1]!.dependsOn).toEqual(['step-1']);
    // 2026-08-24 方案 C：批量批次内部逐个应用，每步各计一次。
    expect(session.appliedCount).toBe(3);
  });

  it('rejects structurally invalid parts without corrupting the draft, then recovers', () => {
    const session = new ScenarioPatchSession(baseScenario());
    const bad = session.apply({ workflow: 'not-an-array' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.length).toBeGreaterThan(0);
    expect(session.appliedCount).toBe(0); // failed patch must not advance state

    const good = session.apply({ name: '修正后的场景' });
    expect(good.ok).toBe(true);
  });

  it('lets intermediate states stay incomplete; the title fallback and final gate handle the rest', () => {
    const session = new ScenarioPatchSession(baseScenario());
    // Intermediate: empty deliverable/plan is fine while building.
    expect(session.apply({ name: '未完成草稿' }).ok).toBe(true);
    // 标题兜底：模型遗漏 primaryDeliverable 时以场景名填充，不毁掉整次构建。
    const earlyGate = session.validateFinal();
    expect(earlyGate.ok).toBe(true);
    expect(session.getDraft()!.output.plan?.primaryDeliverable).toBe('未完成草稿');

    // Finish the build; the final gate now passes.
    session.apply({ output: { plan: { primaryDeliverable: '博后基金申报书' } } });
    session.apply({ workflow: [
      { id: 'step-1', name: '解读指南', description: '', agentId: 'user:agents/default', skillIds: [], toolIds: [], mcpIds: [], dependsOn: [], maxTurns: 12 },
    ] });
    const gate = session.validateFinal();
    expect(gate.ok).toBe(true);
  });

  it('never lets model output overwrite identity or provenance fields', () => {
    const session = new ScenarioPatchSession(baseScenario());
    const result = session.apply({ id: 'user:scenario/hijacked', kind: 'agent', revision: 999, provenance: { origin: 'builtin' } });
    // The apply itself succeeds (protected keys are ignored) but identity is untouched.
    expect(result.ok).toBe(true);
    expect(session.getDraft()!.id).toBe('user:scenario/research-paper');
    expect(session.getDraft()!.kind).toBe('scenario');
    expect(session.getDraft()!.revision).toBe(3);
  });

  it('deep-merges nested plain objects while arrays replace wholesale', () => {
    expect(deepMergeScenarioField(
      { plan: { primaryDeliverable: 'a', supportingArtifacts: ['x'] }, format: 'markdown' },
      { plan: { primaryDeliverable: 'b' } },
    )).toEqual({ plan: { primaryDeliverable: 'b', supportingArtifacts: ['x'] }, format: 'markdown' });
    expect(deepMergeScenarioField([1, 2], [3])).toEqual([3]);
  });

  it('adapts common model shortcuts: string sections become chapter objects and string criteria become arrays', () => {
    const session = new ScenarioPatchSession(baseScenario());
    const result = session.apply({
      name: '博后基金申报',
      deliverable: { type: 'grant_postdoc', sections: ['立项依据', '研究方案'] },
      workflow: [
        { id: 'step-a', name: '步骤A', prompt: '做A', completionCriteria: '产出A初稿；覆盖全部要点' },
      ],
    });
    expect(result.ok).toBe(true);
    const draft = session.getDraft()!;
    expect(draft.deliverable?.sections?.[0]?.kind).toBe('chapter');
    expect(draft.deliverable?.sections?.[0]?.title).toBe('立项依据');
    expect(Array.isArray(draft.workflow[0]!.completionCriteria)).toBe(true);
    expect((draft.workflow[0]!.completionCriteria as unknown[]).length).toBe(2);

    // 结构适配后严格门应通过（primaryDeliverable 由 output.plan 提供时）。
    session.apply({ workflow: [
      { id: 'step-b', name: '并行终点B', prompt: '做B' },
    ] });
    session.apply({ output: { plan: { primaryDeliverable: '博后基金申报书' } } });
    const gate = session.validateFinal();
    if (!gate.ok) console.log('[DEBUG] gate issues:', JSON.stringify(gate.issues, null, 2));
    expect(gate.ok).toBe(true);
  });

  it('migrates misplaced primaryDeliverable from deliverable to output.plan and fills missing plan arrays', () => {
    const session = new ScenarioPatchSession(baseScenario());
    const result = session.apply({
      name: '迁移场景',
      deliverable: { type: 'grant_postdoc', primaryDeliverable: '博后基金申报书正文' },
      output: { plan: { primaryDeliverable: '' } },
    });
    expect(result.ok).toBe(true);
    const draft = session.getDraft()!;
    expect((draft as unknown as { deliverable: { primaryDeliverable?: string } }).deliverable.primaryDeliverable).toBeUndefined();
    expect(draft.output.plan?.primaryDeliverable).toBe('博后基金申报书正文');
    expect(Array.isArray(draft.output.plan?.supportingArtifacts)).toBe(true);
    expect(Array.isArray(draft.output.plan?.qualityCriteria)).toBe(true);
  });

  it('normalizes invalid section kind/status enums to safe defaults', () => {
    const session = new ScenarioPatchSession(baseScenario());
    const result = session.apply({
      name: '枚举归一场景',
      deliverable: { sections: [{ id: 's1', title: '合法', kind: 'chapter', status: 'required' }, { id: 's2', title: '非法枚举', kind: 'section_head', status: 'mandatory' }] },
    });
    expect(result.ok).toBe(true);
    const draft = session.getDraft()!;
    expect(draft.deliverable?.sections?.[1]?.kind).toBe('chapter');
    expect(draft.deliverable?.sections?.[1]?.status).toBe('required');
  });

  it('rejects non-object fields payloads with an actionable message', () => {
    const session = new ScenarioPatchSession(baseScenario());
    const result = session.apply('give me everything');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toContain('fields');
  });

  it('router scopes drafts by sessionId so concurrent compiles never share state', async () => {
    const router = createScenarioPatchRouter();
    router.open('session-a', baseScenario());
    router.open('session-b', baseScenario());

    // Route through the real handler exactly as ToolDispatcher would.
    await router.handler({ fields: { name: '会话A场景' } }, { sessionId: 'session-a', workspace: '.', turnIndex: 0 });
    await router.handler({ fields: { name: '会话B场景' } }, { sessionId: 'session-b', workspace: '.', turnIndex: 0 });
    const resultA = JSON.parse(await router.handler({ fields: {} }, { sessionId: 'session-a', workspace: '.', turnIndex: 0 })) as { overview: string };
    expect(resultA.overview).toContain('会话A场景');

    router.close('session-a');
    const closed = JSON.parse(await router.handler({ fields: {} }, { sessionId: 'session-a', workspace: '.', turnIndex: 0 })) as { ok: boolean };
    expect(closed.ok).toBe(false); // no cross-turn leakage after close
    expect(router.activeSession?.('session-b')).toBeTruthy();
  });

  it('delivers draft updates to their owning concurrent compile and preserves a replacement listener', async () => {
    const router = createScenarioPatchRouter();
    router.open('session-a', baseScenario());
    router.open('session-b', baseScenario());
    const updatesA: string[] = [];
    const updatesB: string[] = [];
    const listenerA = (update: { sessionId: string; scenario: ScenarioDefinition }) => { updatesA.push(`${update.sessionId}:${update.scenario.name}`); };
    const listenerB = (update: { sessionId: string; scenario: ScenarioDefinition }) => { updatesB.push(`${update.sessionId}:${update.scenario.name}`); };
    router.setDraftUpdatedListener('session-a', listenerA);
    router.setDraftUpdatedListener('session-b', listenerB);

    await Promise.all([
      router.handler({ fields: { name: '仅会话A' } }, { sessionId: 'session-a', workspace: '.', turnIndex: 0 }),
      router.handler({ fields: { name: '仅会话B' } }, { sessionId: 'session-b', workspace: '.', turnIndex: 0 }),
    ]);
    expect(updatesA).toEqual(['session-a:仅会话A']);
    expect(updatesB).toEqual(['session-b:仅会话B']);

    // An older finally block must not remove a callback installed by a newer owner.
    const replacementA = (update: { scenario: ScenarioDefinition }) => { updatesA.push(`replacement:${update.scenario.name}`); };
    router.setDraftUpdatedListener('session-a', replacementA);
    router.removeDraftUpdatedListener('session-a', listenerA);
    await router.handler({ fields: { description: '仍属于会话A' } }, { sessionId: 'session-a', workspace: '.', turnIndex: 1 });
    expect(updatesA).toEqual(['session-a:仅会话A', 'replacement:仅会话A']);
    expect(updatesB).toEqual(['session-b:仅会话B']);
  });
});

describe('ScenarioPatchSession minimal-unit enforcement (2026-08-24 刘总方案 C)', () => {
  function step(id: string): Record<string, unknown> {
    return { id, name: '步骤' + id, prompt: '做这一步的具体工作。', completionCriteria: ['完成标准满足。'] };
  }

  it('applies an oversized workflow batch piece by piece with per-step callbacks', () => {
    const session = new ScenarioPatchSession(baseScenario());
    const snapshots: number[] = [];
    session.onStepApplied = (draft) => { snapshots.push(draft.workflow.length); };
    const result = session.apply({ workflow: [step('a'), step('b'), step('c'), step('d')] });
    expect(result.ok).toBe(true);
    expect(session.getDraft()?.workflow.length).toBe(4);
    // 逐步广播：每个最小单元应用后都触发一次回调。
    expect(snapshots).toEqual([1, 2, 3, 4]);
  });

  it('accepts workflow patches of 1-2 steps', () => {
    const session = new ScenarioPatchSession(baseScenario());
    expect(session.apply({ workflow: [step('a'), step('b')] }).ok).toBe(true);
    expect(session.apply({ workflow: [step('c')] }).ok).toBe(true);
    expect(session.getDraft()?.workflow.length).toBe(3);
  });

  it('applies an oversized sections batch and merges by id across calls', () => {
    const session = new ScenarioPatchSession(baseScenario());
    const result = session.apply({
      deliverable: {
        type: 'grant_postdoc', language: 'zh', globalLength: '7500字',
        structurePolicy: { defaultSections: 1, suggestedMin: 1, suggestedMax: 1 },
        secondarySections: { min: 2, max: 4 },
        sections: [
          { id: 's1', title: '一、选题依据', kind: 'section', status: 'required', children: [] },
          { id: 's2', title: '二、研究内容', kind: 'section', status: 'required', children: [] },
          { id: 's3', title: '三、研究方案', kind: 'section', status: 'required', children: [] },
          { id: 's4', title: '四、特色创新', kind: 'section', status: 'required', children: [] },
        ],
      },
    });
    expect(result.ok).toBe(true);
    expect(session.getDraft()?.deliverable?.sections.length).toBe(4);
    // 分批提交同 id 替换、新 id 追加，不互相覆盖。
    expect(session.apply({ deliverable: { sections: [{ id: 's2', title: '二、研究内容（修订）', kind: 'section', status: 'required', children: [] }] } }).ok).toBe(true);
    expect(session.apply({ deliverable: { sections: [{ id: 's5', title: '五、研究基础', kind: 'section', status: 'required', children: [] }] } }).ok).toBe(true);
    const sections = session.getDraft()?.deliverable?.sections ?? [];
    expect(sections.length).toBe(5);
    expect(sections.find((item) => item.id === 's2')?.title).toContain('修订');
  });

  it('planWorkflow registers an outline, writes skeletons, and fires per-step callbacks', () => {
    const session = new ScenarioPatchSession(baseScenario());
    const names: string[] = [];
    session.onStepApplied = (draft) => { names.push(draft.workflow.map((item) => item.name).join('|')); };
    const result = session.planWorkflow([
      { id: 'step-a', name: '调研' },
      { id: 'step-b', name: '撰写', dependsOn: ['step-a'] },
    ]);
    expect(result.ok).toBe(true);
    expect(session.getPlannedWorkflow().map((item) => item.id)).toEqual(['step-a', 'step-b']);
    expect(session.getPlannedWorkflow().every((item) => item.kind === 'step')).toBe(true);
    expect(session.getDraft()?.workflow.length).toBe(2);
    expect(names).toEqual(['调研', '调研|撰写']);
  });

  it('planWorkflow registers MANDATORY sub-steps under each parent in parent→subStep fill order', () => {
    const session = new ScenarioPatchSession(baseScenario());
    const result = session.planWorkflow([
      {
        id: 'step-1', name: '选题依据',
        subSteps: [
          { id: 'step-1-search', name: '查找文献' },
          { id: 'step-1-logic', name: '构建行文逻辑' },
          { id: 'step-1-draft', name: '撰写综述' },
        ],
      },
      { id: 'step-2', name: '研究内容', subSteps: [{ id: 'step-2-a', name: '分析研究对象' }] },
    ]);
    expect(result.ok).toBe(true);
    // 扁平化顺序：parent → 其子步骤 → 下一个 parent。
    expect(session.getPlannedWorkflow().map((item) => `${item.kind}:${item.id}`)).toEqual([
      'step:step-1', 'substep:step-1-search', 'substep:step-1-logic', 'substep:step-1-draft',
      'step:step-2', 'substep:step-2-a',
    ]);
    const workflow = session.getDraft()?.workflow ?? [];
    expect(workflow.length).toBe(6);
    const search = workflow.find((item) => item.id === 'step-1-search');
    expect(search?.parentStepId).toBe('step-1');
    // 子步骤串行依赖：search → logic → draft。
    expect(search?.dependsOn).toEqual(['step-1']);
    expect(workflow.find((item) => item.id === 'step-1-logic')?.dependsOn).toEqual(['step-1-search']);
    expect(workflow.find((item) => item.id === 'step-2')?.dependsOn).toEqual(['step-1-draft']);
  });

  it('planWorkflow rejects duplicate sub-step ids and empty sub-step names', () => {
    const session = new ScenarioPatchSession(baseScenario());
    expect(session.planWorkflow([{ id: 'a', name: 'A', subSteps: [{ id: 's1', name: 'x' }, { id: 's1', name: 'y' }] }]).ok).toBe(false);
    expect(session.planWorkflow([{ id: 'a', name: 'A', subSteps: [{ id: 's1', name: '' }] }]).ok).toBe(false);
  });

  it('planWorkflow rejects duplicate ids and empty input', () => {
    const session = new ScenarioPatchSession(baseScenario());
    expect(session.planWorkflow([]).ok).toBe(false);
    expect(session.planWorkflow([{ id: 'x', name: 'A' }, { id: 'x', name: 'B' }]).ok).toBe(false);
    expect(session.planWorkflow([{ id: '', name: 'A' }]).ok).toBe(false);
  });

  it('planSections registers section skeletons and rejects childless chapters (2026-08-28 刘总要求)', () => {
    const session = new ScenarioPatchSession(baseScenario());
    // 空壳章节（无 children）必须被拒收——这正是"20 个一级章节、0 个二级章节"的根源。
    const childless = session.planSections([{ id: 'sec-0', title: '空壳章节' }]);
    expect(childless.ok).toBe(false);

    const result = session.planSections([
      { id: 'sec-1', title: '选题依据', children: [{ id: 'sec-1-1', title: '研究背景' }, { id: 'sec-1-2', title: '研究意义' }] },
      { id: 'sec-2', title: '研究内容', children: [{ id: 'sec-2-1', title: '研究对象' }, { id: 'sec-2-2', title: '拟解决的关键问题' }] },
    ]);
    expect(result.ok).toBe(true);
    // 2026-09-04 升级：plannedSections 递归记录每一个待填节点（含二级小节）。
    expect(session.getPlannedSections().length).toBe(6);
    expect(session.getPlannedSections().filter((item) => item.depth === 0).map((item) => item.id)).toEqual(['sec-1', 'sec-2']);
    expect(session.getPlannedSections().filter((item) => item.depth === 1).map((item) => item.id)).toEqual(['sec-1-1', 'sec-1-2', 'sec-2-1', 'sec-2-2']);
    expect(session.getDraft()?.deliverable?.sections.length).toBe(2);
    const draftChildren = session.getDraft()?.deliverable?.sections.find((section) => section.id === 'sec-1')?.children ?? [];
    expect(draftChildren.length).toBe(2);
  });

  it('planSections registers front-matter parts with explicit kind and no children (2026-09-04 刘总要求)', () => {
    const session = new ScenarioPatchSession(baseScenario());
    const result = session.planSections([
      { id: 'abstract', title: '摘要', kind: 'abstract' },
      { id: 'sec-1', title: '引言', children: [{ id: 'sec-1-1', title: '研究背景' }, { id: 'sec-1-2', title: '研究问题' }] },
      { id: 'references', title: '参考文献', kind: 'references' },
    ]);
    expect(result.ok).toBe(true);
    const sections = session.getDraft()?.deliverable?.sections ?? [];
    expect(sections.find((section) => section.id === 'abstract')?.kind).toBe('abstract');
    expect(sections.find((section) => section.id === 'references')?.kind).toBe('references');
    // 摘要/参考文献等部分不要求 children；章节仍被拒收空壳。
    expect(session.getPlannedSections().map((item) => item.id)).toEqual(['abstract', 'sec-1', 'sec-1-1', 'sec-1-2', 'references']);
  });

  it('apply keeps purpose/instructions/requirements/forbidden/lengthTarget through adapt+sanitize (2026-09-04 白名单修复)', () => {
    const session = new ScenarioPatchSession(baseScenario());
    const applied = session.apply({
      deliverable: {
        globalInstructions: '全文学术化，术语一致。',
        sections: [{
          id: 'sec-9', title: '文献综述', kind: 'chapter', status: 'required',
          purpose: '梳理既有解释路径并导出研究缺口。',
          instructions: '围绕三类解释机制组织文献，不逐篇罗列。',
          requirements: ['比较三类机制'], forbidden: ['逐篇罗列文献'], lengthTarget: '2500字',
          children: [{ id: 'sec-9-1', title: '技术控制', kind: 'section', status: 'required', purpose: '阐述技术控制路径。', instructions: '聚焦算法管理。', requirements: ['界定概念'], lengthTarget: '800字', children: [] }],
        }],
      },
    });
    expect(applied.ok).toBe(true);
    const section = session.getDraft()?.deliverable?.sections.find((item) => item.id === 'sec-9');
    expect(section?.purpose).toContain('解释路径');
    expect(section?.instructions).toContain('三类解释机制');
    expect(section?.requirements).toEqual(['比较三类机制']);
    expect(section?.forbidden).toEqual(['逐篇罗列文献']);
    expect(section?.lengthTarget).toBe('2500字');
    expect(session.getDraft()?.deliverable?.globalInstructions).toBe('全文学术化，术语一致。');
    const child = section?.children?.[0];
    expect(child?.instructions).toContain('算法管理');
  });
});
