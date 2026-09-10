/**
 * Scenario incremental-patch tool (2026-08-22, requested by 刘总).
 *
 * Instead of forcing the model to emit one complete scenario JSON in a single
 * answer, the compiler works like an agent: it applies one coherent part at a
 * time through this tool. Every application is merged into a working draft,
 * normalized, and validated against the strict scenario schema immediately —
 * schema violations go back to the model as tool-result feedback so it can
 * self-correct within the same run.
 *
 * The router keeps one open draft session per compile sessionId; the handler
 * resolves the session through ToolContext.sessionId, so concurrent compiles
 * never share state.
 */

import { randomUUID } from 'node:crypto';
import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';
import {
  DELIVERABLE_SECTION_FIELD_KEYS,
  ScenarioDefinitionSchema,
  WorkflowStepBindingSchema,
  type ScenarioDefinition,
} from '../../runtime/PersonalizationRuntimeContract.js';
import { normalizeScenarioHarness } from '../../personalization/ScenarioHarness.js';

/** Identity/provenance fields the model must never control. */
const PROTECTED_FIELDS = new Set(['contractVersion', 'id', 'kind', 'revision', 'provenance']);

/** Workflow step fields the strict schema accepts (kept in sync with the contract). */
const WORKFLOW_STEP_KEYS = new Set(Object.keys(WorkflowStepBindingSchema.shape));
/**
 * Deliverable section fields accepted by DeliverableSectionSchema (strict).
 * 单一来源（2026-09-04 刘总要求）：白名单直接从 contract schema 键集派生，
 * 禁止再维护第二份不一致的手写列表（此前的 adaptCommonStructures 窄白名单
 * 曾把 purpose/requirements/forbidden/lengthTarget 等合法字段从草稿中剥掉）。
 */
const SECTION_KEYS = new Set(DELIVERABLE_SECTION_FIELD_KEYS);

/**
 * 源头净化（2026-08-28 刘总要求：场景构建不再因残留缺陷报错）：
 * 模型经 scenario_apply_update 写入的字段名语义合理（title=名称、
 * step.prompt=指引），但严格 schema 只认规范键；此前这些未知键会一路
 * 留到最终自检，审计修不完就整体作废。现在在写入点直接剥离未知键，
 * 并把放错槽位的引用（如 agents/* 塞进 skillIds）归位——草稿永远合法。
 */
function sanitizeScenarioDraft(draft: ScenarioDefinition): ScenarioDefinition {
  const clean = JSON.parse(JSON.stringify(draft)) as ScenarioDefinition;
  let movedRefs = 0;
  for (const step of clean.workflow ?? []) {
    for (const key of Object.keys(step)) {
      if (!WORKFLOW_STEP_KEYS.has(key)) delete (step as Record<string, unknown>)[key];
    }
    const misplaced = (step.skillIds ?? []).filter((id) => /(^|:|\/)agents(\/|:)/.test(id));
    if (misplaced.length > 0) {
      step.skillIds = (step.skillIds ?? []).filter((id) => !misplaced.includes(id));
      clean.agentIds = [...new Set([...(clean.agentIds ?? []), ...misplaced])];
      movedRefs += misplaced.length;
    }
  }
  const stripSections = (sections: unknown): void => {
    if (!Array.isArray(sections)) return;
    for (const section of sections) {
      if (!section || typeof section !== 'object') continue;
      for (const key of Object.keys(section)) {
        if (!SECTION_KEYS.has(key)) delete (section as Record<string, unknown>)[key];
      }
      stripSections((section as { children?: unknown }).children);
    }
  };
  const capability = clean.capability;
  if (capability && typeof capability === 'object') {
    for (const deliverable of (capability as { deliverables?: Array<{ sections?: unknown }> }).deliverables ?? []) {
      stripSections(deliverable?.sections);
    }
  }
  const legacyDeliverable = (clean as unknown as { deliverable?: { sections?: unknown } }).deliverable;
  if (legacyDeliverable) stripSections(legacyDeliverable.sections);
  if (movedRefs > 0) {
    console.info(`[scenario-patch] sanitized draft: moved ${movedRefs} agent reference(s) into agentIds`);
  }
  return clean;
}

/**
 * 最小单元增量构建（2026-08-24 刘总方案 C）：不再限制单次提交数量——模型
 * 一次提交多少，引擎都内部逐个应用并逐个广播快照；数量上限已废除。
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep merge: plain objects merge recursively; arrays and primitives replace. */
export function deepMergeScenarioField(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = key in merged ? deepMergeScenarioField(merged[key], value) : value;
  }
  return merged;
}

/**
 * 确定性收敛（2026-08-22）：有 output.plan 的场景要求恰有一个终点步骤。
 * 产品语义本就"刻意串行"（同 ScenarioWorkbench.normalizeSerialWorkflow），
 * 因此把多个终点按 authored 顺序链接成单链，不丢弃任何步骤。
 */
function ensureSingleTerminalStep(scenario: ScenarioDefinition): void {
  if (!scenario.output?.plan || scenario.workflow.length === 0) return;
  const dependencyIds = new Set(scenario.workflow.flatMap((step) => step.dependsOn));
  const terminals = scenario.workflow.filter((step) => !dependencyIds.has(step.id));
  if (terminals.length <= 1) return;
  for (let index = 0; index < terminals.length - 1; index += 1) {
    const current = terminals[index]!;
    const next = terminals[index + 1]!;
    if (!next.dependsOn.includes(current.id)) next.dependsOn = [...next.dependsOn, current.id];
  }
}

/**
 * primaryDeliverable 是必填标题字段：模型遗漏时以场景名兜底（用户可在 UI 修改），
 * 避免整次增量构建毁于一个空标题。
 */
function ensurePrimaryDeliverableTitle(scenario: ScenarioDefinition): void {
  if (scenario.output?.plan && !scenario.output.plan.primaryDeliverable.trim()) {
    scenario.output.plan.primaryDeliverable = (scenario.name || '场景交付物').slice(0, 200);
  }
}

/**
 * 结构适配层（2026-08-22）：把模型常见的等价但不规范表示确定性转换为引擎结构。
 * 语义保持的形式转换——不新增、不改写模型给出的任何实质内容。
 */
export function adaptCommonStructures(candidate: Record<string, unknown>): void {
  // 0) deliverable.globalLength：模型常给数字（如 7500），schema 只收字符串
  //    （如 "7500字"）——确定性转换，不再浪费一次修复回合（2026-08-23 刘总要求）。
  const deliverableRoot = isPlainObject(candidate.deliverable) ? candidate.deliverable : undefined;
  if (deliverableRoot && typeof deliverableRoot.globalLength === 'number' && Number.isFinite(deliverableRoot.globalLength)) {
    deliverableRoot.globalLength = `${deliverableRoot.globalLength}字`;
  } else if (deliverableRoot && typeof deliverableRoot.globalLength !== 'string' && deliverableRoot.globalLength != null) {
    delete deliverableRoot.globalLength;
  }
  // 1) completionCriteria：字符串 → 数组（按行/分号拆分；无分隔符则整体一条）。
  const workflow = Array.isArray(candidate.workflow) ? candidate.workflow as Array<Record<string, unknown>> : [];
  for (const step of workflow) {
    if (!isPlainObject(step)) continue;
    const criteria = step.completionCriteria;
    if (typeof criteria === 'string') {
      const parts = criteria.split(/[;；\n]/u).map((item) => item.trim()).filter(Boolean);
      step.completionCriteria = parts.length > 0 ? parts : [criteria.trim()];
    }
  }
  // 2) deliverable：primaryDeliverable 常被误放到 deliverable 下（应属 output.plan）——迁移。
  const deliverable = deliverableRoot;
  if (deliverable && typeof deliverable.primaryDeliverable === 'string' && deliverable.primaryDeliverable.trim()) {
    if (!isPlainObject(candidate.output)) (candidate as Record<string, unknown>).output = {};
    if (!isPlainObject((candidate as Record<string, unknown>).output)) (candidate as Record<string, unknown>).output = {};
    if (!isPlainObject(((candidate as Record<string, unknown>).output as Record<string, unknown>).plan)) ((candidate as Record<string, unknown>).output as Record<string, unknown>).plan = {};
    const plan = ((candidate as Record<string, unknown>).output as Record<string, unknown>).plan as Record<string, unknown>;
    if (!(typeof plan.primaryDeliverable === 'string' && plan.primaryDeliverable.trim())) {
      plan.primaryDeliverable = (deliverable.primaryDeliverable as string).trim();
    }
    delete deliverable.primaryDeliverable;
  }
  // 3) deliverable.sections：字符串数组 → 章节对象数组；对象内非法枚举值归一。
  const SECTION_KINDS = new Set(['title', 'abstract', 'keywords', 'chapter', 'section', 'grant_column', 'attachment', 'references', 'other']);
  const SECTION_STATUSES = new Set(['locked', 'required', 'optional', 'conditional']);
  if (deliverable && Array.isArray(deliverable.sections)) {
    let index = 0;
    deliverable.sections = (deliverable.sections as unknown[]).map((item) => {
      index += 1;
      if (!isPlainObject(item)) {
        const title = typeof item === 'string' ? item.trim() : '';
        return { id: 'chapter-' + index, title, kind: 'chapter', status: 'required', children: [] };
      }
      const section = { ...item } as Record<string, unknown>;
      if (typeof section.kind !== 'string' || !SECTION_KINDS.has(section.kind)) section.kind = 'chapter';
      if (typeof section.status !== 'string' || !SECTION_STATUSES.has(section.status)) section.status = 'required';
      // 顶层条目层级语义：一级章节必须是 "chapter"（模型常把整棵树都写成 "section"）。
      if (section.kind === 'section') section.kind = 'chapter';
      // 白名单剥键（2026-09-04 修正）：与 sanitizeScenarioDraft 共用同一份从
      // schema 派生的 SECTION_KEYS——此前的窄白名单（id/title/kind/status/
      // children/description/prompt）会剥掉模型正确给出的 purpose/requirements/
      // forbidden/lengthTarget/method/evidence/condition/aiAdjust；而它放行的
      // description/prompt 又是 schema 不认识的键，保存时被宽松净化二次剥除。
      for (const key of Object.keys(section)) {
        if (!SECTION_KEYS.has(key)) delete section[key];
        else if (key === 'children' && Array.isArray(section.children)) {
          section.children = (section.children as unknown[]).filter((child) => isPlainObject(child));
        }
      }
      return section;
    });
  }
  // 4) output.plan：存在时补齐必填数组字段（模型常遗漏 supportingArtifacts/qualityCriteria）。
  if (isPlainObject(candidate.output) && isPlainObject(candidate.output.plan)) {
    const plan = candidate.output.plan as Record<string, unknown>;
    // 计划白名单：剥掉模型发明的键（如 secondaryDeliverables）。
    const allowedPlanKeys = new Set(['primaryDeliverable', 'supportingArtifacts', 'qualityCriteria']);
    for (const key of Object.keys(plan)) {
      if (!allowedPlanKeys.has(key)) delete plan[key];
    }
    if (!Array.isArray(plan.supportingArtifacts)) plan.supportingArtifacts = [];
    if (!Array.isArray(plan.qualityCriteria)) plan.qualityCriteria = [];
  }
}

export function scenarioOverview(scenario: ScenarioDefinition, zh: boolean): string {
  const steps = scenario.workflow.length;
  const sections = scenario.deliverable?.sections?.reduce(
    (count, chapter) => count + 1 + (chapter.children?.length ?? 0),
    0,
  ) ?? 0;
  const name = scenario.name || (zh ? '未命名' : 'Untitled');
  const deliverable = scenario.output.plan?.primaryDeliverable || (zh ? '未设定' : 'unset');
  if (zh) {
    return '当前草稿「' + name + '」：' + steps + ' 个工作流步骤，' + sections + ' 个章节/子章节，交付物 ' + deliverable + '。';
  }
  return 'Draft "' + name + '": ' + steps + ' workflow step(s), ' + sections + ' section(s), deliverable ' + deliverable + '.';
}

export class ScenarioPatchSession {
  private draft: ScenarioDefinition;
  private readonly summaries: string[] = [];
  private readonly zh: boolean;
  /** 设计轮（2026-08-24 刘总方案 C）：AI 先提交的大纲，主进程据此逐条驱动填写轮。 */
  private readonly plannedWorkflow: Array<{ id: string; name: string; kind: 'step' | 'substep' }> = [];
  /**
   * 设计轮登记的全部待填 Deliverable 节点（2026-09-04 升级）：从仅记录顶层
   * 章节 {id,title} 升级为递归扁平记录每一个节点（含二级 children 与摘要/
   * 关键词/参考文献等非 chapter 部分），填写轮按此逐节点驱动，杜绝
   * "骨架上屏但大量节点只有标题"的假完成。
   */
  private readonly plannedSections: Array<{ id: string; title: string; kind: string; depth: number }> = [];
  /** 每应用一个最小单元（单个步骤/单个章节）触发一次，用于逐步广播快照。 */
  onStepApplied?: (draft: ScenarioDefinition) => void = undefined;
  /** 无 id 章节的自动编号（跨调用递增，避免拆分后 id 冲突）。 */
  private sectionAutoId = 0;

  constructor(current: ScenarioDefinition, zh = true) {
    this.draft = normalizeScenarioHarness(JSON.parse(JSON.stringify(current)) as ScenarioDefinition);
    this.zh = zh;
  }

  get appliedCount(): number {
    return this.summaries.length;
  }

  getSummaries(): string[] {
    return [...this.summaries];
  }

  getPlannedWorkflow(): ReadonlyArray<{ id: string; name: string; kind: 'step' | 'substep' }> {
    return [...this.plannedWorkflow];
  }

  getPlannedSections(): ReadonlyArray<{ id: string; title: string; kind: string; depth: number }> {
    return [...this.plannedSections];
  }

  /**
   * 设计轮（2026-08-25 刘总细粒度规格）：登记步骤大纲，**每个顶层步骤必须
   * 携带子步骤**（如：查找文献→构建行文逻辑→撰写→审查），骨架逐个立即
   * 上屏；填写轮按 parent→subStep 顺序逐条驱动补全细节。
   */
  planWorkflow(steps: unknown): { ok: true; overview: string } | { ok: false; issues: string[] } {
    if (!Array.isArray(steps) || steps.length === 0) {
      return { ok: false, issues: ['steps 必须是非空数组，每项含唯一 id、name 与 subSteps（子步骤）。'] };
    }
    const seen = new Set<string>();
    interface PlannedStep { id: string; name: string; dependsOn?: string[]; subSteps: Array<{ id: string; name: string }> }
    const normalized: PlannedStep[] = [];
    for (const step of steps) {
      if (!isPlainObject(step) || typeof step.id !== 'string' || !step.id.trim() || typeof step.name !== 'string' || !step.name.trim()) {
        return { ok: false, issues: ['每个步骤都必须有非空的 id 和 name。'] };
      }
      if (seen.has(step.id)) return { ok: false, issues: [`步骤 id 重复：${step.id}`] };
      seen.add(step.id);
      const subSteps: Array<{ id: string; name: string }> = [];
      if (Array.isArray(step.subSteps)) {
        for (const sub of step.subSteps) {
          if (!isPlainObject(sub) || typeof sub.id !== 'string' || !sub.id.trim() || typeof sub.name !== 'string' || !sub.name.trim()) {
            return { ok: false, issues: [`步骤 ${step.id} 的子步骤必须有非空的 id 和 name。`] };
          }
          if (seen.has(sub.id)) return { ok: false, issues: [`子步骤 id 重复：${sub.id}`] };
          seen.add(sub.id);
          subSteps.push({ id: sub.id, name: sub.name });
        }
      }
      normalized.push({
        id: step.id,
        name: step.name,
        dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.filter((d): d is string => typeof d === 'string') : undefined,
        subSteps,
      });
    }
    let previousTailId: string | null = null;
    for (const item of normalized) {
      const dependsOn = item.dependsOn ?? (previousTailId ? [previousTailId] : []);
      const applied = this.apply({ workflow: [{ id: item.id, name: item.name, dependsOn }] });
      if (!applied.ok) return applied;
      this.plannedWorkflow.push({ id: item.id, name: item.name, kind: 'step' });
      this.onStepApplied?.(JSON.parse(JSON.stringify(this.draft)) as ScenarioDefinition);
      let previousId = item.id;
      for (const sub of item.subSteps) {
        const appliedSub = this.apply({ workflow: [{ id: sub.id, name: sub.name, parentStepId: item.id, dependsOn: [previousId] }] });
        if (!appliedSub.ok) return appliedSub;
        this.plannedWorkflow.push({ id: sub.id, name: `${item.name} / ${sub.name}`, kind: 'substep' });
        this.onStepApplied?.(JSON.parse(JSON.stringify(this.draft)) as ScenarioDefinition);
        previousId = sub.id;
      }
      previousTailId = item.subSteps.length > 0 ? item.subSteps[item.subSteps.length - 1]!.id : item.id;
    }
    return { ok: true, overview: scenarioOverview(this.draft, this.zh) };
  }

  /**
   * 设计轮（交付物章节，2026-09-04 升级）：登记完整成果结构大纲——不仅是一级
   * 章节 + children，还包括摘要/关键词/参考文献/申报栏目等非 chapter 部分与
   * 全部二级节点。规划阶段只负责结构（骨架允许暂无详细规范），骨架上屏后由
   * 填写轮按 plannedSections 逐节点驱动补全内容规范。
   */
  planSections(sections: unknown): { ok: true; overview: string } | { ok: false; issues: string[] } {
    if (!Array.isArray(sections) || sections.length === 0) {
      return { ok: false, issues: ['sections 必须是非空数组，每项含唯一 id 与 title。chapter 章节须带 children；摘要/关键词/参考文献等部分也必须一并规划。'] };
    }
    const SECTION_KINDS = new Set(['title', 'abstract', 'keywords', 'chapter', 'section', 'grant_column', 'attachment', 'references', 'other']);
    interface PlannedNode { id: string; title: string; kind: string; children: PlannedNode[] }
    const seen = new Set<string>();
    const issues: string[] = [];
    const parseNodes = (nodes: unknown[], depth: number): PlannedNode[] | null => {
      const result: PlannedNode[] = [];
      for (const node of nodes) {
        if (!isPlainObject(node) || typeof node.id !== 'string' || !node.id.trim() || typeof node.title !== 'string' || !node.title.trim()) {
          issues.push('每个部分都必须有非空的 id 和 title。');
          return null;
        }
        if (seen.has(node.id)) {
          issues.push(`部分 id 重复：${node.id}`);
          return null;
        }
        seen.add(node.id);
        // 无 kind 时按层级默认：顶层=chapter，嵌套=section（与写入语义一致）。
        let kind = typeof node.kind === 'string' && SECTION_KINDS.has(node.kind) ? node.kind : (depth === 0 ? 'chapter' : 'section');
        // 顶层条目层级语义：一级章节必须是 "chapter"（模型常把整棵树都写成 "section"）。
        if (depth === 0 && kind === 'section') kind = 'chapter';
        const children: PlannedNode[] = [];
        if (Array.isArray(node.children)) {
          const parsedChildren = parseNodes(node.children, depth + 1);
          if (!parsedChildren) return null;
          children.push(...parsedChildren);
        }
        // 二级章节硬校验只针对 chapter（2026-08-28 刘总要求）：空壳章节大纲在
        // 这里直接拒收，让模型下一轮立即补齐。摘要/参考文献等部分允许无 children。
        if (kind === 'chapter' && children.length === 0) {
          issues.push(`章节 ${node.id}（${node.title}）缺少 children：每章必须规划 3-5 个二级小节（至少 1 个），请补齐后重新提交完整大纲。`);
          return null;
        }
        result.push({ id: node.id, title: node.title, kind, children });
      }
      return result;
    };
    const normalized = parseNodes(sections, 0);
    if (!normalized) return { ok: false, issues };
    const toPatch = (node: PlannedNode): Record<string, unknown> => ({
      id: node.id,
      title: node.title,
      kind: node.kind,
      status: 'required',
      children: node.children.map((child) => toPatch(child)),
    });
    for (const section of normalized) {
      const applied = this.apply({ deliverable: { sections: [toPatch(section)] } });
      if (!applied.ok) return applied;
      const record = (node: PlannedNode, depth: number): void => {
        this.plannedSections.push({ id: node.id, title: node.title, kind: node.kind, depth });
        for (const child of node.children) record(child, depth + 1);
      };
      record(section, 0);
      this.onStepApplied?.(JSON.parse(JSON.stringify(this.draft)) as ScenarioDefinition);
    }
    return { ok: true, overview: scenarioOverview(this.draft, this.zh) };
  }

  /** Final draft; null when the model never applied any patch. */
  getDraft(): ScenarioDefinition | null {
    if (this.appliedCount === 0) return null;
    return JSON.parse(JSON.stringify(this.draft)) as ScenarioDefinition;
  }

  /**
   * Strict end-of-build gate: validates the finished draft against the full
   * scenario schema and returns actionable issues for a final repair turn.
   */
  validateFinal(): { ok: true; scenario: ScenarioDefinition } | { ok: false; issues: string[] } {
    const parsed = ScenarioDefinitionSchema.safeParse(this.draft);
    if (!parsed.success) {
      return { ok: false, issues: parsed.error.issues.slice(0, 24).map((issue) => issue.path.join('.') + ': ' + issue.message) };
    }
    return { ok: true, scenario: JSON.parse(JSON.stringify(parsed.data)) as ScenarioDefinition };
  }

  /**
   * Apply one part to the working draft.
   *
   * Validation layering (2026-08-29 刘总要求：每写完一步就必须可保存):
   * apply() enforces normalize + engine defaults AND the strict scenario
   * schema at every write, so the draft is always in a savable state —
   * violations (unknown keys, wrong types) go back to the model immediately
   * instead of accumulating into an unsavable draft. Content completeness
   * remains a phase-gate/design hint only and never blocks saving.
   */
  apply(rawFields: unknown): { ok: true; overview: string } | { ok: false; issues: string[] } {
    // 容错（2026-08-25 刘总现场日志）：模型偶发把 fields 发成 JSON 字符串
    // （双重编码）——先解包再走正常路径。
    if (typeof rawFields === 'string') {
      try {
        rawFields = JSON.parse(rawFields);
      } catch { /* 保持原值，走下方拒绝分支 */ }
    }
    // 容错：模型偶发把 fields 发成对象数组（把多个补丁打包成列表）——
    // 逐个应用每个对象元素，而不是整单拒绝。
    if (Array.isArray(rawFields)) {
      const parts = rawFields.filter((item) => isPlainObject(item) && Object.keys(item).length > 0);
      if (parts.length === 0) {
        return { ok: false, issues: ['fields 必须是一个 JSON 对象（场景顶层字段的子集），收到的是不含有效对象的数组。'] };
      }
      for (const part of parts) {
        const applied = this.apply(part);
        if (!applied.ok) return applied;
        this.onStepApplied?.(JSON.parse(JSON.stringify(this.draft)) as ScenarioDefinition);
      }
      return { ok: true, overview: scenarioOverview(this.draft, this.zh) };
    }
    if (!isPlainObject(rawFields)) {
      return { ok: false, issues: ['fields 必须是一个 JSON 对象（场景顶层字段的子集）。'] };
    }
    if (!isPlainObject(this.draft)) {
      return { ok: false, issues: ['内部草稿状态损坏'] };
    }
    // 最小单元保证（2026-08-24 刘总方案 C）：模型一次提交多个步骤/章节时，
    // 引擎内部逐个应用并逐个广播快照——屏幕上永远一个一个出现，且永不因
    // 批量提交而失败。单元素走正常路径。
    const workflowValue = rawFields.workflow;
    if (Array.isArray(workflowValue) && workflowValue.length > 1) {
      const rest = { ...rawFields };
      delete rest.workflow;
      const [first, ...remaining] = workflowValue;
      // 其余顶层字段随第一块一起应用，避免被拆分分支丢弃。
      const appliedFirst = this.apply({ ...rest, workflow: [first] });
      if (!appliedFirst.ok) return appliedFirst;
      this.onStepApplied?.(JSON.parse(JSON.stringify(this.draft)) as ScenarioDefinition);
      for (const step of remaining) {
        const applied = this.apply({ workflow: [step] });
        if (!applied.ok) return applied;
        this.onStepApplied?.(JSON.parse(JSON.stringify(this.draft)) as ScenarioDefinition);
      }
      return { ok: true, overview: scenarioOverview(this.draft, this.zh) };
    }
    const deliverableValue = rawFields.deliverable;
    const sectionsValue = isPlainObject(deliverableValue) ? deliverableValue.sections : undefined;
    if (Array.isArray(sectionsValue) && sectionsValue.length > 1) {
      // 无 id 的章节（字符串/缺 id 对象）先补稳定自增 id，防止拆分后互相覆盖。
      const identified = sectionsValue.map((entry) => {
        if (isPlainObject(entry) && typeof entry.id === 'string' && entry.id.trim()) return entry;
        const title = typeof entry === 'string' ? entry.trim() : (isPlainObject(entry) && typeof entry.title === 'string' ? entry.title : '');
        this.sectionAutoId += 1;
        const id = `chapter-${this.sectionAutoId}`;
        return isPlainObject(entry) ? { ...entry, id } : { id, title, kind: 'chapter', status: 'required', children: [] };
      });
      const rest = { ...rawFields };
      delete rest.deliverable;
      const [first, ...remaining] = identified;
      const appliedFirst = this.apply({ ...rest, deliverable: { ...(deliverableValue as Record<string, unknown>), sections: [first] } });
      if (!appliedFirst.ok) return appliedFirst;
      this.onStepApplied?.(JSON.parse(JSON.stringify(this.draft)) as ScenarioDefinition);
      for (const section of remaining) {
        const applied = this.apply({ deliverable: { ...(deliverableValue as Record<string, unknown>), sections: [section] } });
        if (!applied.ok) return applied;
        this.onStepApplied?.(JSON.parse(JSON.stringify(this.draft)) as ScenarioDefinition);
      }
      return { ok: true, overview: scenarioOverview(this.draft, this.zh) };
    }
    const candidate = { ...(this.draft as unknown as Record<string, unknown>) };
    for (const [key, value] of Object.entries(rawFields)) {
      if (PROTECTED_FIELDS.has(key)) continue; // silently ignore protected identity
      if (key === 'workflow' && Array.isArray(value)) {
        // 增量工作流合并（2026-08-22 刘总要求）：按 id upsert——同 id 替换、
        // 新 id 追加。同名步骤（2026-08-25 追加）：id 不同但名称相同的视为
        // 同一步骤合并（保留原 id），杜绝模型换 id 造成的重复步骤。
        const existing = Array.isArray(candidate.workflow) ? (candidate.workflow as unknown[]) : [];
        const merged = [...existing];
        for (const step of value) {
          if (!isPlainObject(step) || typeof step.id !== 'string') continue;
          const completed = {
            description: '', goal: '', prompt: '', inputs: [], outputs: [],
            completionCriteria: [], condition: null, agentId: undefined,
            skillIds: [], mcpIds: [], toolIds: [], dependsOn: [], maxTurns: 12,
            ...step,
          };
          let index = merged.findIndex((item) => isPlainObject(item) && item.id === step.id);
          if (index < 0 && typeof step.name === 'string' && step.name.trim()) {
            const stepName = step.name.trim();
            index = merged.findIndex((item) => isPlainObject(item) && typeof item.name === 'string' && item.name.trim() === stepName);
          }
          if (index >= 0) merged[index] = deepMergeScenarioField(merged[index], completed);
          else merged.push(completed);
        }
        candidate.workflow = merged;
        continue;
      }
      if (key === 'deliverable' && isPlainObject(value) && Array.isArray((value as { sections?: unknown }).sections)) {
        // 章节 upsert：按 id 合并；**同名章节（title 相同）也合并**（保留原 id）
        // ——模型在填写轮换 id 重发同一章时不再产生重复章节（2026-08-25）。
        const deliverableCandidate = isPlainObject(candidate.deliverable) ? { ...candidate.deliverable } as Record<string, unknown> : { ...value } as Record<string, unknown>;
        const existingSections = Array.isArray(deliverableCandidate.sections) ? [...deliverableCandidate.sections as unknown[]] : [];
        for (const section of (value as { sections: unknown[] }).sections) {
          if (!isPlainObject(section)) continue;
          let index = -1;
          if (typeof section.id === 'string' && section.id) {
            index = existingSections.findIndex((item) => isPlainObject(item) && (item as { id?: unknown }).id === section.id);
          }
          if (index < 0 && typeof section.title === 'string' && section.title.trim()) {
            const sectionTitle = section.title.trim();
            index = existingSections.findIndex((item) => isPlainObject(item) && typeof (item as { title?: unknown }).title === 'string' && (item as { title: string }).title.trim() === sectionTitle);
          }
          if (index < 0 && typeof section.id !== 'string') continue;
          if (index >= 0) existingSections[index] = deepMergeScenarioField(existingSections[index], section);
          else existingSections.push(section);
        }
        deliverableCandidate.sections = existingSections;
        candidate.deliverable = { ...(isPlainObject(candidate.deliverable) ? candidate.deliverable : {}), ...deliverableCandidate };
        continue;
      }
      candidate[key] = key in candidate ? deepMergeScenarioField(candidate[key], value) : value;
    }
    try {
      adaptCommonStructures(candidate);
      const withIdentity = {
        ...candidate,
        contractVersion: this.draft.contractVersion,
        id: this.draft.id,
        kind: 'scenario' as const,
        revision: this.draft.revision,
        provenance: this.draft.provenance,
      };
      const normalized = normalizeScenarioHarness(withIdentity as unknown as ScenarioDefinition);
      ensureSingleTerminalStep(normalized);
      ensurePrimaryDeliverableTitle(normalized);
      this.draft = sanitizeScenarioDraft(normalized);
      // 写入点不拒绝（2026-08-29 刘总要求：每写完一步就处于可保存状态）。
      // 未知字段等偏差由保存路径的宽松净化统一剔除；内容完整性是设计提示，
      // 与保存无关。
    } catch (error) {
      let issues: string[];
      const zodIssues = (error as { issues?: Array<{ path: (string | number)[]; message: string }> }).issues;
      if (Array.isArray(zodIssues)) {
        issues = zodIssues.slice(0, 24).map((issue) => issue.path.join('.') + ': ' + issue.message);
      } else {
        issues = [String(error instanceof Error ? error.message.slice(0, 400) : error)];
      }
      return { ok: false, issues };
    }
    this.summaries.push(scenarioOverview(this.draft, this.zh));
    return { ok: true, overview: scenarioOverview(this.draft, this.zh) };
  }
}

export interface ScenarioDraftUpdatedListener {
  (update: { sessionId: string; scenario: ScenarioDefinition; summaries: readonly string[] }): void;
}

export interface ScenarioPatchRouter {
  spec: ToolSpec;
  handler: ToolHandler;
  /** 设计轮工具（2026-08-24 刘总方案 C）：工作流大纲 / 章节大纲。 */
  planWorkflowSpec: ToolSpec;
  planWorkflowHandler: ToolHandler;
  planSectionsSpec: ToolSpec;
  planSectionsHandler: ToolHandler;
  open(sessionId: string, current: ScenarioDefinition): void;
  close(sessionId: string): void;
  /** Diagnostic peek; production flow relies on getDraft via open/close pairs. */
  activeSession(sessionId: string): ScenarioPatchSession | undefined;
  /** Register the live draft listener for exactly one compile session. */
  setDraftUpdatedListener(sessionId: string, listener: ScenarioDraftUpdatedListener): void;
  /** Remove a listener only if this compile still owns the session slot. */
  removeDraftUpdatedListener(sessionId: string, listener: ScenarioDraftUpdatedListener): void;
}

export const SCENARIO_APPLY_UPDATE_TOOL_NAME = 'scenario_apply_update';
export const SCENARIO_PLAN_WORKFLOW_TOOL_NAME = 'scenario_plan_workflow';
export const SCENARIO_PLAN_SECTIONS_TOOL_NAME = 'scenario_plan_sections';

const SCENARIO_APPLY_UPDATE_PARAMETERS = {
  type: 'object',
  properties: {
    fields: {
      type: 'object',
      description: [
        'Partial scenario update: top-level scenario fields merged into the draft.',
        'Work part by part: {"name","description","capability","deliverable"} first, then {"workflow":[...]}, then {"deliverable":{"sections":[...]}} or {"scenarioMetis":{"markdown":"..."}}.',
        'Arrays merge by stable id for workflow steps and deliverable sections (same id replaces, new id appends) — batches of any size are accepted and applied piece by piece.',
      ].join(' '),
    },
  },
  required: ['fields'],
};

/** One shared router instance survives provider-profile runtime rebuilds. */
export function createScenarioPatchRouter(zh = true): ScenarioPatchRouter {
  const sessions = new Map<string, ScenarioPatchSession>();
  const draftUpdatedListeners = new Map<string, ScenarioDraftUpdatedListener>();
  const broadcast = (sessionId: string, session: ScenarioPatchSession) => {
    try {
      draftUpdatedListeners.get(sessionId)?.({
        sessionId,
        scenario: JSON.parse(JSON.stringify(session.getDraft())) as ScenarioDefinition,
        summaries: session.getSummaries(),
      });
    } catch { /* 通知失败不影响工具结果 */ }
  };
  const spec: ToolSpec = {
    name: SCENARIO_APPLY_UPDATE_TOOL_NAME,
    description: [
      'Apply ONE coherent part of the research scenario to the working draft (incremental authoring).',
      'Call it multiple times, one small piece per call: basics (name/description/capability) → deliverable sections → workflow steps (one step per call with its full prompt/criteria/bindings) → scenarioMetis/workflowPrompt → output.plan.',
      'Entries merge by stable id: same id replaces, new id appends. Batches of any size are accepted and applied piece by piece.',
      'Each call is validated immediately; validation errors are returned so you can fix them in your next call.',
    ].join(' '),
    parameters: SCENARIO_APPLY_UPDATE_PARAMETERS,    // fields 是开放对象（场景顶层字段的任意子集）；默认的 JSON-Schema 严格
    // 校验器会把它当 strictObject 拒绝一切内部键。直通解码，真正的校验由
    // handler 内的场景 schema 门负责（错误会回传给模型自纠）。
    decodeArgs: (raw: unknown) => raw as Record<string, unknown>,
  } as ToolSpec;
  const handler: ToolHandler = async (args, context) => {
    const session = sessions.get(context.sessionId);
    if (!session) {
      return JSON.stringify({ ok: false, error: 'no active scenario patch session for this turn' });
    }
    const result = session.apply(args.fields);
    if (!result.ok) {
      // Validation problems go back to the model verbatim so it self-corrects.
      // 诊断留痕（2026-08-24）：失败也必须可观测。
      console.warn(`[scenario-patch] session=${context.sessionId.slice(-12)} REJECTED keys=${Object.keys(args.fields as Record<string, unknown>).join(',')} issues=${JSON.stringify(result.issues.slice(0, 4))}`);
      return JSON.stringify({ ok: false, error: 'schema_validation_failed', issues: result.issues });
    }
    // 增量可见：每步成功后立即把草稿快照广播出去（绝不中断编译本身）。
    broadcast(context.sessionId, session);
    console.warn(`[scenario-patch] session=${context.sessionId.slice(-12)} apply#${session.appliedCount} keys=${Object.keys(args.fields as Record<string, unknown>).join(',')} overview=${result.overview.slice(0, 160)}`);
    return JSON.stringify({ ok: true, applied: session.appliedCount, overview: result.overview });
  };

  // ── 设计轮工具（2026-08-24 刘总方案 C）：只出大纲，骨架立即上屏 ──
  const planWorkflowSpec: ToolSpec = {
    name: SCENARIO_PLAN_WORKFLOW_TOOL_NAME,
    description: [
      'PLANNING TURN ONLY: register the workflow OUTLINE — one entry per top-level step, and EVERY step MUST carry subSteps (fine-grained sub-steps with parentStepId semantics).',
      'Canonical sub-step pattern for a content-producing step: research/gather materials (bind search MCP/skills) → build the writing logic/outline → draft the content → review the draft. Adapt to the step\u2019s nature; minimum 2 sub-steps per step.',
      'Do NOT write prompts/criteria here; the driver will ask for the parent and each sub-step\u2019s details separately.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable unique step id, e.g. "step-topic-rationale".' },
              name: { type: 'string', description: 'Concise step name, e.g. "选题依据（限1000字）".' },
              dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids of prerequisite steps (empty for the first step).' },
              subSteps: {
                type: 'array',
                description: 'MANDATORY fine-grained sub-steps of this step (minimum 2). Executed in order under the parent.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Stable unique sub-step id, e.g. "step-topic-rationale-search".' },
                    name: { type: 'string', description: 'Concise sub-step name, e.g. "查找文献".' },
                  },
                  required: ['id', 'name'],
                },
              },
            },
            required: ['id', 'name', 'subSteps'],
          },
        },
      },
      required: ['steps'],
    },
    decodeArgs: (raw: unknown) => raw as Record<string, unknown>,
  } as ToolSpec;
  const planWorkflowHandler: ToolHandler = async (args, context) => {
    const session = sessions.get(context.sessionId);
    if (!session) return JSON.stringify({ ok: false, error: 'no active scenario patch session for this turn' });
    const result = session.planWorkflow(args.steps);
    if (!result.ok) {
      console.warn(`[scenario-patch] session=${context.sessionId.slice(-12)} PLAN_WORKFLOW REJECTED issues=${JSON.stringify(result.issues.slice(0, 4))}`);
      return JSON.stringify({ ok: false, error: 'invalid_plan', issues: result.issues });
    }
    broadcast(context.sessionId, session);
    console.warn(`[scenario-patch] session=${context.sessionId.slice(-12)} planWorkflow registered ${session.getPlannedWorkflow().length} step(s)`);
    return JSON.stringify({ ok: true, planned: session.getPlannedWorkflow().length, overview: result.overview });
  };

  const planSectionsSpec: ToolSpec = {
    name: SCENARIO_PLAN_SECTIONS_TOOL_NAME,
    description: [
      'PLANNING TURN ONLY: register the COMPLETE deliverable outline — one entry per top-level part with a stable unique id, title, kind, and its children (second-level sub-sections).',
      'kind must be one of: title/abstract/keywords/chapter/section/grant_column/attachment/references/other (front-matter parts such as abstract/keywords/references MUST be included with their own kind; every chapter needs 3-5 children).',
      'Do NOT write section instructions here; the driver will ask for each node\u2019s details separately.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable unique section id.' },
              title: { type: 'string', description: 'Section title, including the word limit when specified, e.g. "选题依据（限1000字）".' },
              kind: { type: 'string', description: 'Part kind: title/abstract/keywords/chapter/grant_column/attachment/references/other. Defaults to chapter.' },
              children: {
                type: 'array',
                description: 'Second-level sub-sections of this chapter (from the user\u2019s deliverable breakdown). Required for chapter kind.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Stable unique sub-section id.' },
                    title: { type: 'string', description: 'Sub-section title.' },
                  },
                  required: ['id', 'title'],
                },
              },
            },
            required: ['id', 'title'],
          },
        },
      },
      required: ['sections'],
    },
    decodeArgs: (raw: unknown) => raw as Record<string, unknown>,
  } as ToolSpec;
  const planSectionsHandler: ToolHandler = async (args, context) => {
    const session = sessions.get(context.sessionId);
    if (!session) return JSON.stringify({ ok: false, error: 'no active scenario patch session for this turn' });
    const result = session.planSections(args.sections);
    if (!result.ok) {
      console.warn(`[scenario-patch] session=${context.sessionId.slice(-12)} PLAN_SECTIONS REJECTED issues=${JSON.stringify(result.issues.slice(0, 4))}`);
      return JSON.stringify({ ok: false, error: 'invalid_plan', issues: result.issues });
    }
    broadcast(context.sessionId, session);
    console.warn(`[scenario-patch] session=${context.sessionId.slice(-12)} planSections registered ${session.getPlannedSections().length} section(s)`);
    return JSON.stringify({ ok: true, planned: session.getPlannedSections().length, overview: result.overview });
  };

  return {
    spec,
    handler,
    planWorkflowSpec,
    planWorkflowHandler,
    planSectionsSpec,
    planSectionsHandler,
    open: (sessionId: string, current: ScenarioDefinition) => {
      const session = new ScenarioPatchSession(current, zh);
      // 逐个应用回调 → 复用同一会话广播通道，最小单元逐个上屏。
      session.onStepApplied = (draft) => {
        try {
          draftUpdatedListeners.get(sessionId)?.({ sessionId, scenario: draft, summaries: session.getSummaries() });
        } catch { /* 通知失败不影响应用 */ }
      };
      sessions.set(sessionId, session);
    },
    close: (sessionId: string) => {
      sessions.delete(sessionId);
    },
    activeSession: (sessionId: string) => sessions.get(sessionId),
    setDraftUpdatedListener: (sessionId: string, listener: ScenarioDraftUpdatedListener) => {
      draftUpdatedListeners.set(sessionId, listener);
    },
    removeDraftUpdatedListener: (sessionId: string, listener: ScenarioDraftUpdatedListener) => {
      if (draftUpdatedListeners.get(sessionId) === listener) draftUpdatedListeners.delete(sessionId);
    },
  };
}

/** Stable id helper for callers that mint compile session ids. */
export function newCompileSessionId(): string {
  return 'scenario-harness-compiler-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 8);
}
