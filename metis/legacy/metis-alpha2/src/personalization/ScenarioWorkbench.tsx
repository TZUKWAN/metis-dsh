/**
 * Scenario workbench: a focused editor backed by the durable personalization
 * repository.  Authoring stays simple while retries, checkpoints and recovery
 * remain runtime concerns rather than user-facing configuration.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, FolderOpen, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import type {
  ArchivedPersonalizationDefinition,
  DeliverableSpec,
  PersonalizationDefinition,
  ReferenceMaterial,
  ScenarioDefinition,
  WorkflowStepBinding,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { assessScenarioHarness, normalizeScenarioHarness } from '../../engine/personalization/ScenarioHarness.js';
import { consumePendingScenarioHandoff } from '../topic/scenarioHandoff.js';
import { availableUserId, cloneDefinition } from './personalizationLib.js';
import { setScenarioDirtyGuard } from '../lib/scenarioDirtyGuard.js';
import { isScenarioCompileActive, getScenarioCompileState, onScenarioCompileUpdate, trackScenarioCompile } from '../lib/scenarioCompileCoordinator.js';
import ScenarioConfigurationAssistant, { type ScenarioAssistantActionResult, type ScenarioAssistantIdentity } from './ScenarioConfigurationAssistant.js';
import ScenarioFocusedEditor from './ScenarioFocusedEditor.js';
import { ExtensionInstaller } from './ExtensionInstaller.js';
import MarketBrowserPanel from './MarketBrowserPanel.js';
import './scenarioWorkbench.css';

type AcquireMode = 'search' | 'package' | 'url';
type Acquisition = { kind: 'skill' | 'mcp'; stepId: string; mode: AcquireMode } | null;

export type WorkbenchTab = 'overview' | 'structure' | 'rules' | 'adapt' | 'capability';

function draftId(): string {
  return `step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nestedOrder(steps: readonly WorkflowStepBinding[], parentStepId: string | null = null): string[] {
  return steps
    .filter((step) => (step.parentStepId ?? null) === parentStepId)
    .flatMap((step) => [step.id, ...nestedOrder(steps, step.id)]);
}

/** A Scenario is deliberately serial: every authored step consumes prior work. */
function normalizeSerialWorkflow(scenario: ScenarioDefinition): void {
  const orderedIds = nestedOrder(scenario.workflow);
  const allIds = new Set(scenario.workflow.map((step) => step.id));
  const safeOrder = orderedIds.length === allIds.size
    ? orderedIds
    : scenario.workflow.map((step) => step.id);
  const position = new Map(safeOrder.map((id, index) => [id, index]));
  scenario.workflow = [...scenario.workflow]
    .sort((left, right) => (position.get(left.id) ?? 0) - (position.get(right.id) ?? 0))
    .map((step, index) => ({
      ...step,
      dependsOn: index === 0 ? [] : [safeOrder[index - 1]!],
    }));
}

function removeStepAndDescendants(scenario: ScenarioDefinition, stepId: string): void {
  const removed = new Set<string>([stepId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of scenario.workflow) {
      if (step.parentStepId && removed.has(step.parentStepId) && !removed.has(step.id)) {
        removed.add(step.id);
        changed = true;
      }
    }
  }
  scenario.workflow = scenario.workflow.filter((step) => !removed.has(step.id));
}

function ensureDeliverable(scenario: ScenarioDefinition): void {
  if (!scenario.deliverable) {
    scenario.deliverable = {
      type: 'custom',
      language: 'zh',
      globalLength: '',
      structurePolicy: { defaultSections: 1, suggestedMin: 1, suggestedMax: 1 },
      sections: [],
      secondarySections: { min: 3, max: 5 },
    } satisfies DeliverableSpec;
  }
  if (!scenario.output.plan) {
    scenario.output.plan = {
      primaryDeliverable: scenario.name.trim() || 'Scenario deliverable',
      supportingArtifacts: [],
      qualityCriteria: [],
    };
  }
}

function mutationMessage(code: string | undefined, zh: boolean): string {
  if (code === 'revision_conflict') return zh ? '保存冲突：当前草稿已保留，未覆盖较新版本。可继续编辑，或另存为新场景。' : 'Save conflict: the current draft was retained and the newer version was not overwritten. Keep editing or save it as a new scenario.';
  return zh ? '保存未完成，当前编辑仍保留。' : 'Save did not complete; the current edits are retained.';
}

const CATEGORY_PREFIX = 'category:';

function scenarioCategory(scenario: ScenarioDefinition): string {
  const marker = scenario.tags.find((tag) => tag.startsWith(CATEGORY_PREFIX));
  return marker?.slice(CATEGORY_PREFIX.length).trim() ?? '';
}

function updateScenarioCategory(scenario: ScenarioDefinition, category: string): void {
  const clean = category.trim().replace(/\s+/gu, ' ');
  scenario.tags = [
    ...scenario.tags.filter((tag) => !tag.startsWith(CATEGORY_PREFIX)),
    ...(clean ? [`${CATEGORY_PREFIX}${clean}`] : []),
  ];
}

/**
 * 场景草稿跨页保留（2026-08-29 刘总要求：切页不打断、回来不失状态）。
 * 场景页随导航条件渲染——切到成果/科研项目会卸载整棵组件树；此模块级
 * store 让未保存草稿在同一渲染会话内跨卸载存活，切回时原样恢复，右侧
 * 编辑器和编译实时推送的中间态不再"刷新即清空"。
 */
const scenarioWorkbenchDraftStore = new Map<string, ScenarioDefinition>();

function readStoredScenarioDraft(id: string): ScenarioDefinition | null {
  const stored = scenarioWorkbenchDraftStore.get(id);
  if (!stored) return null;
  try {
    return normalizeScenarioHarness(cloneDefinition(stored));
  } catch {
    scenarioWorkbenchDraftStore.delete(id);
    return null;
  }
}

function writeStoredScenarioDraft(draft: ScenarioDefinition | null): void {
  if (!draft || !draft.id) return;
  try {
    scenarioWorkbenchDraftStore.set(draft.id, cloneDefinition(draft));
  } catch { /* 草稿快照失败不影响编辑 */ }
}

/**
 * 全局增量草稿通道（2026-08-29 刘总要求：切页期间编译照常逐块写入）。
 * 组件卸载时页面级订阅随之注销，主进程推送的中间快照会无人接收——
 * 表现为"切回后等全部跑完一次性写入"。此模块级订阅只做一件事：
 * 把每份中间草稿实时写进跨页 store；挂载时的恢复逻辑自然读到最新态。
 */
let scenarioDraftFeedRegistered = false;
function ensureScenarioDraftFeed(): void {
  if (scenarioDraftFeedRegistered) return;
  const metis = typeof window !== 'undefined' ? window.metis : undefined;
  if (!metis?.onScenarioDraftUpdated) return;
  scenarioDraftFeedRegistered = true;
  try {
    metis.onScenarioDraftUpdated((update: { sessionId: string; scenario: ScenarioDefinition; summaries: readonly string[] }) => {
      if (!update?.scenario?.id) return;
      try {
        writeStoredScenarioDraft(normalizeScenarioHarness(cloneDefinition(update.scenario)));
      } catch { /* 快照失败不影响编译本身 */ }
    });
  } catch { /* 订阅失败不阻塞页面 */ }
}

/** 测试隔离钩子：jsdom 模块单次加载，用例间清空跨页草稿。 */
export function resetScenarioWorkbenchDraftStoreForTests(): void {
  scenarioWorkbenchDraftStore.clear();
}

export default function ScenarioWorkbench({
  zh, definitions, archivedScenarios = [], selectedId, onSelect, save, createScenario, onActivateScenario, onDeleteScenario, onRestoreScenario, reload, projectId = null,
}: {
  zh: boolean;
  /** 当前激活项目；用于把助手对话历史按项目+场景隔离持久化。 */
  projectId?: string | null;
  definitions: PersonalizationDefinition[];
  archivedScenarios?: ArchivedPersonalizationDefinition[];
  selectedId: string | null;
  onSelect(id: string | null): void;
  save(definition: PersonalizationDefinition, expectedRevision: number): Promise<{ ok: boolean; code?: string; definition?: PersonalizationDefinition }>;
  createScenario(): void;
  onActivateScenario(id: string): void | Promise<void>;
  onDeleteScenario(id: string): Promise<{ ok: boolean; message?: string } | void> | { ok: boolean; message?: string } | void;
  onRestoreScenario?(id: string): Promise<{ ok: boolean; message?: string } | void> | { ok: boolean; message?: string } | void;
  reload(): Promise<void>;
  onOpenTemplateRecognize?: () => void;
  initialTab?: WorkbenchTab;
}) {
  // 切页期间编译增量照常落 store（幂等注册）。
  ensureScenarioDraftFeed();
  const scenarios = useMemo(() => definitions.filter((item): item is ScenarioDefinition => item.kind === 'scenario'), [definitions]);
  const selected = useMemo(() => scenarios.find((item) => item.id === selectedId) ?? null, [scenarios, selectedId]);
  const [draft, setDraft] = useState<ScenarioDefinition | null>(() => selected ? (readStoredScenarioDraft(selected.id) ?? normalizeScenarioHarness(cloneDefinition(selected))) : null);
  const draftRef = useRef<ScenarioDefinition | null>(selected ? (readStoredScenarioDraft(selected.id) ?? normalizeScenarioHarness(cloneDefinition(selected))) : null);
  const syncedRevisionRef = useRef<number | null>(null);
  // The selected-definition sync is intentionally deferred to avoid a
  // synchronous setState-in-effect update.  Any local authoring action must
  // invalidate that queued sync so it can never overwrite a newer draft (or
  // its completion notice) in the same render turn.
  const draftEpochRef = useRef(0);
  const [notice, setNotice] = useState('');
  const [revisionConflict, setRevisionConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [acquisition, setAcquisition] = useState<Acquisition>(null);
  const [aiUndoStack, setAiUndoStack] = useState<ScenarioDefinition[]>([]);
  const aiUndoStackRef = useRef<ScenarioDefinition[]>([]);
  const [libraryMode, setLibraryMode] = useState<'scenarios' | 'trash'>('scenarios');
  // Let a newly typed category become visible in the left library immediately;
  // it still reaches durable storage only through the normal Save action.
  const libraryScenarios = useMemo(() => scenarios.map((scenario) => (
    draft?.id === scenario.id ? draft : scenario
  )), [draft, scenarios]);
  const categories = useMemo(() => [...new Set(libraryScenarios.map(scenarioCategory).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, zh ? 'zh-CN' : 'en')), [libraryScenarios, zh]);
  const trashScenarios = useMemo(() => archivedScenarios
    .filter((item): item is ArchivedPersonalizationDefinition & { definition: ScenarioDefinition } => item.definition.kind === 'scenario')
    .sort((left, right) => right.archivedAt - left.archivedAt), [archivedScenarios]);

  // ── 分类树（2026-09 刘总规格）：分类竖排成组、场景嵌在组内，
  // 场景可直接拖到某个分类组上完成归类；组头点击折叠/展开。
  const SCENARIO_DRAG_TYPE = 'application/x-metis-scenario';
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);

  useEffect(() => {
    const apply = (next: ScenarioDefinition | null, revision: number | null) => {
      const epoch = draftEpochRef.current;
      const timer = window.setTimeout(() => {
        if (draftEpochRef.current !== epoch) return;
        draftRef.current = next;
        syncedRevisionRef.current = revision;
        setDraft(next);
        writeStoredScenarioDraft(next);
        aiUndoStackRef.current = [];
        setAiUndoStack([]);
        setRevisionConflict(false);
        setNotice('');
      }, 0);
      return () => window.clearTimeout(timer);
    };
    if (!selected) {
      return apply(null, null);
    }
    const current = draftRef.current;
    if (!current || current.id !== selected.id || (syncedRevisionRef.current !== selected.revision && current.revision === selected.revision)) {
      // 跨页恢复（2026-08-29 刘总要求）：挂载/切回时优先使用模块级草稿——
      // 未保存的编辑和编译中间态不因导航卸载而丢失。
      const next = readStoredScenarioDraft(selected.id) ?? normalizeScenarioHarness(cloneDefinition(selected));
      return apply(next, selected.revision);
    }
    return undefined;
  }, [selected]);

  const mutateDraft = useCallback((mutator: (scenario: ScenarioDefinition) => void) => {
    const current = draftRef.current;
    if (!current) return;
    const next = cloneDefinition(current);
    mutator(next);
    normalizeSerialWorkflow(next);
    draftEpochRef.current += 1;
    draftRef.current = next;
    setDraft(next);
    writeStoredScenarioDraft(next);
  }, []);

  const scenarioGroups = useMemo(() => {
    const groups = categories.map((category) => ({
      key: category,
      label: category,
      items: libraryScenarios.filter((scenario) => scenarioCategory(scenario) === category),
    }));
    groups.push({
      key: '__uncategorized__',
      label: zh ? '未分类' : 'Uncategorized',
      items: libraryScenarios.filter((scenario) => !scenarioCategory(scenario)),
    });
    return groups;
  }, [categories, libraryScenarios, zh]);

  const moveScenarioToCategory = useCallback(async (scenarioId: string, category: string) => {
    // 正在编辑的场景走草稿（保存按钮统一落盘）；其余直接保存。
    if (draft && draft.id === scenarioId) {
      mutateDraft((scenario) => updateScenarioCategory(scenario, category));
      return;
    }
    const target = scenarios.find((item) => item.id === scenarioId);
    if (!target) return;
    const next = cloneDefinition(target);
    updateScenarioCategory(next, category);
    setBusy(true);
    try {
      const result = await save(next, target.revision);
      if (!result?.ok) setNotice(zh ? '分类更新失败，请重试。' : 'Failed to update the category.');
      else await reload();
    } finally {
      setBusy(false);
    }
  }, [draft, scenarios, save, reload, zh, mutateDraft]);

  const saveDraft = useCallback(async (): Promise<ScenarioDefinition | null> => {
    const current = draftRef.current;
    if (!current) return null;
    const normalized = normalizeScenarioHarness(cloneDefinition(current));
    normalizeSerialWorkflow(normalized);
    // Repository writes are revision-bound.  The focused editor owns this
    // draft, so it must submit the next immutable revision just like every
    // other personalization editor; otherwise a real repository rejects the
    // save as a stale no-op even though the user just edited the scenario.
    normalized.revision = current.revision + 1;
    normalized.provenance = {
      ...normalized.provenance,
      locallyModified: true,
      updatedAt: Date.now(),
    };
    setBusy(true);
    try {
      const result = await save(normalized, current.revision);
      if (!result.ok || !result.definition || result.definition.kind !== 'scenario') {
        setRevisionConflict(result.code === 'revision_conflict');
        setNotice(mutationMessage(result.code, zh));
        return null;
      }
      const saved = normalizeScenarioHarness(result.definition);
      draftEpochRef.current += 1;
      draftRef.current = saved;
      syncedRevisionRef.current = saved.revision;
      setDraft(saved);
      writeStoredScenarioDraft(saved);
      setRevisionConflict(false);
      setNotice(zh ? '已保存。' : 'Saved.');
      await reload();
      return saved;
    } catch {
      setNotice(zh ? '保存服务暂时不可用，当前编辑仍保留。' : 'The save service is unavailable; current edits are retained.');
      return null;
    } finally {
      setBusy(false);
    }
  }, [reload, save, zh]);

  const saveDraftAsNewScenario = useCallback(async () => {
    const current = draftRef.current;
    if (!current) return;
    const now = Date.now();
    const copy = normalizeScenarioHarness(cloneDefinition(current));
    normalizeSerialWorkflow(copy);
    copy.name = `${current.name || (zh ? '未命名场景' : 'Untitled scenario')} ${zh ? '副本' : 'copy'}`.slice(0, 200);
    copy.id = availableUserId('scenario', copy.name, definitions);
    copy.revision = 1;
    copy.provenance = {
      ...copy.provenance,
      origin: 'user',
      parentId: current.id,
      parentVersion: current.provenance.version,
      locallyModified: true,
      createdAt: now,
      updatedAt: now,
    };
    setBusy(true);
    try {
      let result = await save(copy, 0);
      if (!result.ok && result.code === 'revision_conflict') {
        copy.id = `${copy.id}-${Date.now().toString(36)}`;
        result = await save(copy, 0);
      }
      if (!result.ok || !result.definition || result.definition.kind !== 'scenario') {
        setNotice(zh ? `另存新场景未完成：${result.code ?? 'unknown'}。当前草稿仍保留。` : `Saving as a new scenario did not complete: ${result.code ?? 'unknown'}. The current draft is retained.`);
        return;
      }
      const saved = normalizeScenarioHarness(result.definition);
      draftEpochRef.current += 1;
      draftRef.current = saved;
      syncedRevisionRef.current = saved.revision;
      setDraft(saved);
      writeStoredScenarioDraft(saved);
      setRevisionConflict(false);
      onSelect(saved.id);
      await reload();
      setNotice(zh ? '已另存为新的场景；原场景及其较新版本没有被覆盖。' : 'Saved as a new scenario; the original scenario and its newer version were not overwritten.');
    } catch {
      setNotice(zh ? '另存新场景服务暂时不可用，当前草稿仍保留。' : 'The save-as-new service is unavailable; the current draft is retained.');
    } finally {
      setBusy(false);
    }
  }, [definitions, onSelect, reload, save, zh]);

  const addStep = useCallback((parentStepId?: string) => {
    mutateDraft((scenario) => {
      const parent = parentStepId ? scenario.workflow.find((step) => step.id === parentStepId) : undefined;
      scenario.workflow.push({
        id: draftId(),
        name: zh ? '新步骤' : 'New step',
        description: '',
        goal: '',
        prompt: '',
        inputs: [],
        outputs: [],
        completionCriteria: [],
        condition: null,
        agentId: parent?.agentId,
        skillIds: [],
        mcpIds: [],
        toolIds: [],
        dependsOn: [],
        maxTurns: 12,
        parentStepId: parentStepId ?? undefined,
      });
    });
  }, [mutateDraft, zh]);

  const reorderSteps = useCallback((sourceId: string, targetId: string) => {
    mutateDraft((scenario) => {
      const sourceIndex = scenario.workflow.findIndex((step) => step.id === sourceId);
      const targetIndex = scenario.workflow.findIndex((step) => step.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return;
      const source = scenario.workflow[sourceIndex]!;
      const target = scenario.workflow[targetIndex]!;
      if ((source.parentStepId ?? null) !== (target.parentStepId ?? null)) {
        setNotice(zh ? '只能在同一层级内调整顺序。' : 'Steps can be reordered only within the same level.');
        return;
      }
      scenario.workflow.splice(sourceIndex, 1);
      scenario.workflow.splice(targetIndex, 0, source);
    });
  }, [mutateDraft, zh]);

  const toggleStepResource = useCallback((stepId: string, kind: 'skill' | 'mcp', definitionId: string) => {
    mutateDraft((scenario) => {
      scenario.workflow = scenario.workflow.map((step) => {
        if (step.id !== stepId) return step;
        const ids = kind === 'skill' ? step.skillIds : step.mcpIds;
        const nextIds = ids.includes(definitionId) ? ids.filter((id) => id !== definitionId) : [...ids, definitionId];
        if (kind === 'skill') return { ...step, skillIds: nextIds };
        return { ...step, mcpIds: nextIds };
      });
      const aggregate = scenario.workflow.flatMap((step) => kind === 'skill' ? step.skillIds : step.mcpIds);
      if (kind === 'skill') scenario.skillIds = [...new Set(aggregate)];
      else scenario.mcpIds = [...new Set(aggregate)];
    });
  }, [mutateDraft]);

  const compile = useCallback(async (instruction: string, identity: ScenarioAssistantIdentity = {}): Promise<ScenarioAssistantActionResult> => {
    const current = draftRef.current;
    if (!current) return { ok: false, message: zh ? '当前没有可修改的场景草稿。' : 'There is no scenario draft to modify.' };
    const metisBridge = window.metis;
    if (!metisBridge?.compileScenarioHarness) {
      const message = zh ? 'AI 场景编译服务不可用，当前草稿没有改变。' : 'The AI scenario compiler is unavailable; the current draft was not changed.';
      setNotice(message);
      return { ok: false, message };
    }
    // 后台编译重挂接（2026-08-25 刘总要求）：用户切页后编译在后台继续；
    // 回到场景页时若该场景仍有在途编译，直接重新挂接而不是重复发起。
    if (isScenarioCompileActive(current.id)) {
      setBusy(true);
      setNotice(zh ? '编译仍在后台进行，已重新挂接，完成后自动加载结果…' : 'Compilation is still running in the background; reattached.');
      await new Promise<void>((resolve) => {
        const off = onScenarioCompileUpdate(current.id, (state) => {
          if (state.done) { off(); resolve(); }
        });
      });
      const state = getScenarioCompileState(current.id);
      setBusy(false);
      if (state?.scenario) {
        const next = normalizeScenarioHarness(cloneDefinition(state.scenario));
        normalizeSerialWorkflow(next);
        draftEpochRef.current += 1;
        draftRef.current = next;
        setDraft(next);
        writeStoredScenarioDraft(next);
        if (state.autosaved) {
          try { await reload(); } catch { /* 刷新失败不影响已保存结果 */ }
        }
        if (state.ok) {
          const message = (state.summary || (zh ? '后台编译已完成。' : 'Background compilation finished.')) + (state.autosaved ? (zh ? '（已自动保存。）' : ' (saved automatically.)') : (zh ? '结果已载入为未保存草稿，请检查后手动保存。' : ' The result is loaded as an unsaved draft; review and save it manually.'));
          setNotice(message);
          return { ok: true, message };
        }
        setRevisionConflict(state.code === 'revision_conflict');
        const message = zh
          ? `${state.summary ?? 'AI 已生成场景内容，但未能安全保存。'} ${state.code === 'revision_conflict' ? '生成结果已保留为未保存草稿；当前版本已变化，请另存为新场景，避免覆盖较新版本。' : '生成结果已保留为未保存草稿，请检查后按“保存”重试。'}`
          : `${state.summary ?? 'AI generated scenario content but could not save it safely.'} ${state.code === 'revision_conflict' ? 'The generated result is retained as an unsaved draft; save it as a new scenario to avoid overwriting newer content.' : 'The generated result is retained as an unsaved draft; review it and retry Save.'}`;
        setNotice(message);
        return { ok: false, message };
      }
      const message = zh ? `后台编译已结束：${state?.summary ?? '未完成'}。本轮指令已存入历史记录。` : `Background compilation ended: ${state?.summary ?? 'incomplete'}.`;
      setNotice(message);
      return { ok: false, message };
    }
    setBusy(true);
    setNotice(zh ? '正在生成；现有草稿不会丢失。' : 'Generating; the current draft is retained.');
    // 增量可见（2026-08-23 刘总要求）：订阅主进程的逐步 patch 快照，
    // 模型每写完一个部分就立刻填进右侧编辑器；失败时移除订阅保持原状。
    const unsubscribeDraft = (() => {
      try {
        return metisBridge.onScenarioDraftUpdated?.((update) => {
          if (!update?.scenario || update.scenario.id !== current.id) return;
          const incremental = normalizeScenarioHarness(cloneDefinition(update.scenario));
          draftEpochRef.current += 1;
          draftRef.current = incremental;
          setDraft(incremental);
          writeStoredScenarioDraft(incremental);
        });
      } catch { return undefined; }
    })();
    try {
      // 会话身份由助手组件维护；仅在齐备时透传，主进程据此把本轮指令与摘要落库。
      // 编译 promise 由协调器持有（2026-08-25 刘总要求）：组件卸载/切页不会丢结果，
      // 主进程在编译成功后直接自动保存，历史（含未完成轮）全部落库。
      // 申报书闭环（2026-09-01 刘总要求）：助手绑定了申报书模板时，把栏目结构
      // 注入编译指令前缀，让交付物结构直接对齐申报书栏目。
      const fundingPrefix = identity.fundingTemplateId && identity.fundingStructureText
        ? `【申报书模板已绑定】请把场景交付物组织为以下申报书栏目结构，逐栏产出可直接填写的内容：
${identity.fundingStructureText}

【本轮指令】
`
        : '';
      const result = await trackScenarioCompile(current.id, async (notify) => {
        const r = await metisBridge.compileScenarioHarness({
          current,
          instruction: `${fundingPrefix}${instruction}`,
          materialIds: current.materials?.map((material) => material.id) ?? [],
          ...(identity.thinkingLevel ? { thinkingLevel: identity.thinkingLevel } : {}),
          ...(identity.projectId ? { projectId: identity.projectId } : {}),
          ...(identity.scenarioId ? { scenarioId: identity.scenarioId } : {}),
          ...(identity.conversationId ? { conversationId: identity.conversationId } : {}),
        });
        notify({
          ok: Boolean(r.ok),
          code: typeof r.code === 'string' ? r.code : undefined,
          summary: r.summary ?? r.message,
          scenario: r.scenario,
          autosaved: (r as { autosaved?: boolean }).autosaved === true,
        });
        return r;
      });
      if (!result.scenario) {
        const message = zh ? `AI 未生成可用的场景内容：${result.message ?? result.code ?? '未知原因'}。本轮指令已存入历史记录。` : `AI did not return usable scenario content: ${result.message ?? result.code ?? 'unknown reason'}.`;
        setNotice(message);
        return { ok: false, message };
      }
      const next = normalizeScenarioHarness(cloneDefinition(result.scenario));
      normalizeSerialWorkflow(next);
      const previous = cloneDefinition(current);
      draftEpochRef.current += 1;
      draftRef.current = next;
      setDraft(next);
      writeStoredScenarioDraft(next);
      const nextUndoStack = [...aiUndoStackRef.current.slice(-19), previous];
      aiUndoStackRef.current = nextUndoStack;
      setAiUndoStack(nextUndoStack);
      // 生成结果与持久化结果必须分别处理。主进程保存失败时，已验证的
      // 生成草稿仍可供用户检查、编辑和通过“保存”明确重试，但绝不能被说成已保存。
      if (!result.ok) {
        setRevisionConflict(result.code === 'revision_conflict');
        const message = zh
          ? `${result.message ?? `AI 已生成场景内容，但未能安全保存（${result.code ?? 'unknown'}）。`} ${result.code === 'revision_conflict' ? '生成结果已保留为未保存草稿；当前版本已变化，请另存为新场景，避免覆盖较新版本。' : '生成结果已保留为未保存草稿，请检查后按“保存”重试。'}`
          : `${result.message ?? `AI generated scenario content but could not save it safely (${result.code ?? 'unknown'}).`} ${result.code === 'revision_conflict' ? 'The persisted version changed; save this draft as a new scenario to avoid overwriting newer content.' : 'The generated result is retained as an unsaved draft; review it and retry Save.'}`;
        setNotice(message);
        return { ok: false, message };
      }
      const message = result.summary || (zh ? 'AI 已更新场景草稿；右侧可继续核对和微调。' : 'AI updated the scenario draft; review and refine it on the right.');
      // 全自动安装（2026-08-23 刘总授权）：编译中自动装了技能/MCP 时刷新目录。
      if (Array.isArray(result.installedDefinitions) && result.installedDefinitions.length > 0) {
        try { await reload(); } catch { /* 刷新失败不影响草稿应用 */ }
      }
      // 主进程自动保存（2026-08-25）：成功结果已在主进程持久化——刷新定义列表
      // 让 selected 同步到新修订；仅在主进程未保存时回退到渲染端保存。
      if ((result as { autosaved?: boolean }).autosaved === true) {
        try { await reload(); } catch { /* ignore */ }
        setNotice(`${message}；已自动保存。`);
        return { ok: true, message: `${message}；已自动保存。` };
      }
      const saved = await saveDraft();
      setNotice(saved ? `${message}；已自动保存。` : message);
      return { ok: true, message };
    } catch {
      const message = zh ? 'AI 编译未完成，当前草稿没有改变。本轮指令已存入历史记录。' : 'AI compilation did not finish; the current draft was not changed.';
      setNotice(message);
      return { ok: false, message };
    } finally {
      unsubscribeDraft?.();
      setBusy(false);
    }
  }, [reload, saveDraft, zh]);

  const uploadMaterials = useCallback(async (): Promise<ScenarioAssistantActionResult> => {
    const current = draftRef.current;
    if (!current || !window.metis?.openReferenceFileDialog || !window.metis?.importScenarioMaterials) {
      const message = zh ? '材料导入服务不可用，当前草稿没有改变。' : 'The material import service is unavailable; the current draft was not changed.';
      setNotice(message);
      return { ok: false, message };
    }
    try {
      const paths = await window.metis.openReferenceFileDialog();
      if (paths.length === 0) {
        const message = zh ? '没有选择材料，当前草稿没有改变。' : 'No material was selected; the current draft was not changed.';
        setNotice(message);
        return { ok: false, message };
      }
      setBusy(true);
      const result = await window.metis.importScenarioMaterials({ files: paths.map((path) => ({ path })) });
      const importedMaterials = result.materials;
      if (!result.ok || !importedMaterials?.length) {
        const message = zh ? `没有导入可用材料：${result.error ?? result.code ?? '未知原因'}。` : `No usable material was imported: ${result.error ?? result.code ?? 'unknown reason'}.`;
        setNotice(message);
        return { ok: false, message };
      }
      mutateDraft((scenario) => {
        const existing = new Set((scenario.materials ?? []).map((item) => item.id));
        scenario.materials = [...(scenario.materials ?? []), ...importedMaterials
          .filter((item) => !existing.has(item.id))
          .map((item) => ({ id: item.id, name: item.name, kind: item.kind as ReferenceMaterial['kind'], storageRef: item.storageRef, byteLength: item.charCount, analyzedAt: Date.now() }))];
      });
      const message = zh ? `已导入 ${importedMaterials.length} 份材料；下一轮对话会将它们作为当前场景的参考。` : `${importedMaterials.length} material(s) imported; the next conversation turn will use them for this scenario.`;
      setNotice(message);
      return { ok: true, message };
    } catch {
      const message = zh ? '材料导入未完成，当前草稿没有改变。' : 'Material import did not finish; the current draft was not changed.';
      setNotice(message);
      return { ok: false, message };
    } finally {
      setBusy(false);
    }
  }, [mutateDraft, zh]);

  const undoLastAiChange = useCallback(() => {
    const previous = aiUndoStackRef.current.at(-1);
    if (!previous) return;
    const restored = normalizeScenarioHarness(cloneDefinition(previous));
    normalizeSerialWorkflow(restored);
    draftEpochRef.current += 1;
    draftRef.current = restored;
    setDraft(restored);
    writeStoredScenarioDraft(restored);
    const nextUndoStack = aiUndoStackRef.current.slice(0, -1);
    aiUndoStackRef.current = nextUndoStack;
    setAiUndoStack(nextUndoStack);
    setNotice(zh ? '已撤销上一次 AI 对场景草稿的修改。' : 'The last AI change to the scenario draft was undone.');
  }, [zh]);

  // 选题 → 场景 typed handoff(2026-09-04 刘总要求):用户在选题页点「基于选题构建
  // 场景」后,这里一次性消费 pendingScenarioHandoff,自动发起完整场景编译;无草稿时
  // 先创建新草稿。禁止 DOM 模拟输入——直接调用 compile 指令通道。
  const handoffConsumedRef = React.useRef(false);
  React.useEffect(() => {
    if (handoffConsumedRef.current) return;
    handoffConsumedRef.current = true;
    const handoff = consumePendingScenarioHandoff();
    if (!handoff) return;
    const startBuild = async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (draftRef.current) break;
        if (attempt === 0 && !selectedId) {
          try { createScenario(); } catch { /* 创建失败由下方提示 */ }
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      if (draftRef.current) {
        setNotice(zh ? `来自选题「${handoff.title}」:正在基于选题研究包构建场景……` : `From topic "${handoff.title}": building scenario from the research brief...`);
        await compile(handoff.instruction);
      } else {
        setNotice(zh ? '已收到选题研究包,但没有可构建的场景草稿。请先新建场景,再在左侧助手粘贴构建指令。' : 'Received the topic brief but there is no scenario draft; create one first.');
      }
    };
    void startBuild();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot handoff consumption on mount
  }, []);

  const activateScenario = useCallback(async () => {
    const current = draftRef.current;
    if (!current) return;
    const readiness = assessScenarioHarness(current, definitions);
    if (readiness.blockingCount > 0) {
      setNotice(zh ? `尚不能启动：${readiness.issues.find((issue) => issue.severity === 'blocking')?.message ?? '请补全场景。'}` : `Not ready to start: ${readiness.issues.find((issue) => issue.severity === 'blocking')?.message ?? 'Complete the scenario first.'}`);
      return;
    }
    const saved = await saveDraft();
    if (saved) await onActivateScenario(saved.id);
  }, [definitions, onActivateScenario, saveDraft, zh]);

  const bindInstalled = useCallback(async (definitionId: string) => {
    const target = acquisition;
    if (!target) return;
    toggleStepResource(target.stepId, target.kind, definitionId);
    setAcquisition(null);
    setNotice(zh ? '已安装并绑定到当前步骤；请保存场景。' : 'Installed and bound to the current step; save the scenario.');
    await reload();
  }, [acquisition, reload, toggleStepResource, zh]);

  const moveToTrash = useCallback(async (scenario: ScenarioDefinition) => {
    setBusy(true);
    try {
      const result = await onDeleteScenario(scenario.id);
      if (result && !result.ok) {
        setNotice(result.message ?? (zh ? '未能移入回收站，场景仍保留。' : 'The scenario could not be moved to trash and remains available.'));
        return;
      }
      if (scenario.id === selectedId) onSelect(null);
      setNotice(result?.message ?? (zh ? '已移入回收站，可在 7 天内恢复。' : 'Moved to Trash. You can restore it within 7 days.'));
    } catch {
      setNotice(zh ? '未能移入回收站，场景仍保留。' : 'The scenario could not be moved to Trash and remains available.');
    } finally {
      setBusy(false);
    }
  }, [onDeleteScenario, onSelect, selectedId, zh]);

  const restoreFromTrash = useCallback(async (item: ArchivedPersonalizationDefinition) => {
    if (!onRestoreScenario) return;
    setBusy(true);
    try {
      const result = await onRestoreScenario(item.definition.id);
      if (result && !result.ok) {
        setNotice(result.message ?? (zh ? '恢复未完成，请重试。' : 'Restore did not complete. Try again.'));
        return;
      }
      setLibraryMode('scenarios');
      onSelect(item.definition.id);
      setNotice(result?.message ?? (zh ? '已恢复到场景列表。' : 'Restored to the scenario list.'));
    } catch {
      setNotice(zh ? '恢复未完成，请重试。' : 'Restore did not complete. Try again.');
    } finally {
      setBusy(false);
    }
  }, [onRestoreScenario, onSelect, zh]);

  const remainingTrashDays = useCallback((expiresAt: number) => (
    Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)))
  ), []);

  // 未保存守卫（2026-08-23 刘总要求）：草稿与最近一次同步的持久化版本不一致
  // 即视为有未保存编辑；离开工作台前弹确认框，可当场保存。
  const [unsavedDialogOpen, setUnsavedDialogOpen] = useState(false);
  const pendingLeaveRef = useRef<(() => void) | null>(null);
  const draftDirty = useMemo(() => {
    if (!draft || !selected) return false;
    if (draft.id !== selected.id) return false;
    return JSON.stringify(normalizeScenarioHarness(cloneDefinition(draft))) !== JSON.stringify(selected);
  }, [draft, selected]);

  useEffect(() => {
    setScenarioDirtyGuard((action) => {
      if (!draftDirty || busy) return true;
      // 暂存被拦截的导航动作，待用户在确认弹窗中做出选择后补执行。
      pendingLeaveRef.current = action;
      setUnsavedDialogOpen(true);
      return false;
    });
    return () => setScenarioDirtyGuard(null);
  }, [draftDirty, busy]);

  const leaveNow = useCallback((after?: () => void, options?: { discardDraft?: boolean }) => {
    setUnsavedDialogOpen(false);
    // 「不保存并离开」= 用户明确丢弃草稿：跨页草稿缓存必须同步清除，
    // 否则重开场景时被丢弃的编辑会以幽灵草稿形式复活。
    if (options?.discardDraft && selected) scenarioWorkbenchDraftStore.delete(selected.id);
    const action = pendingLeaveRef.current;
    pendingLeaveRef.current = null;
    action?.();
    after?.();
  }, [selected]);

  const saveAndLeave = useCallback(async () => {
    const saved = await saveDraft();
    if (saved) leaveNow();
  }, [leaveNow, saveDraft]);

  return <div className="scenario-workbench" data-testid="scenario-workbench">
    <div className="scenario-workbench__canvas">
      <aside className={`scenario-library ${libraryMode === 'trash' ? 'scenario-library--trash' : ''}`} aria-label={zh ? '场景列表' : 'Scenario list'} data-testid="sw-scenario-library">
        <header className="scenario-library__header">
          <div className="scenario-library__title"><span>{libraryMode === 'trash' ? (zh ? '回收站' : 'Trash') : (zh ? '场景' : 'Scenarios')}</span><strong>{libraryMode === 'trash' ? trashScenarios.length : scenarios.length}</strong></div>
          <div className="scenario-library__actions">
            <button type="button" className={libraryMode === 'trash' ? 'active' : ''} onClick={() => setLibraryMode((mode) => mode === 'trash' ? 'scenarios' : 'trash')} aria-pressed={libraryMode === 'trash'} data-testid="sw-trash-toggle"><Trash2 size={13} />{zh ? '回收站' : 'Trash'}<small>{trashScenarios.length}</small></button>
            {libraryMode === 'scenarios' && <button type="button" className="btn-primary btn-sm" onClick={createScenario} disabled={busy} data-testid="sw-new-scenario"><Plus size={14} />{zh ? '新建' : 'New'}</button>}
          </div>
        </header>
        <div className="scenario-library__list">
          {libraryMode === 'scenarios' ? <>
            {scenarioGroups.map((group) => (
              <section
                key={group.key}
                className={`scenario-library__group${dragOverGroup === group.key ? ' drop-target' : ''}`}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes(SCENARIO_DRAG_TYPE)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  if (dragOverGroup !== group.key) setDragOverGroup(group.key);
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                    setDragOverGroup((current) => (current === group.key ? null : current));
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOverGroup(null);
                  const scenarioId = event.dataTransfer.getData(SCENARIO_DRAG_TYPE);
                  if (scenarioId) void moveScenarioToCategory(scenarioId, group.key === '__uncategorized__' ? '' : group.key);
                }}
              >
                <button
                  type="button"
                  className="scenario-library__group-header"
                  aria-expanded={!collapsedGroups.has(group.key)}
                  onClick={() => setCollapsedGroups((current) => {
                    const next = new Set(current);
                    if (next.has(group.key)) next.delete(group.key);
                    else next.add(group.key);
                    return next;
                  })}
                >
                  <ChevronRight size={13} className={collapsedGroups.has(group.key) ? undefined : 'is-open'} />
                  <FolderOpen size={13} />
                  <span>{group.label}</span>
                  <small>{group.items.length}</small>
                </button>
                {!collapsedGroups.has(group.key) && group.items.map((scenario) => <article key={scenario.id} className={scenario.id === selectedId ? 'selected' : ''} draggable onDragStart={(event) => { event.dataTransfer.setData(SCENARIO_DRAG_TYPE, scenario.id); event.dataTransfer.effectAllowed = 'move'; }}><button type="button" className="scenario-library__select" disabled={busy} aria-label={scenario.name || (zh ? '未命名场景' : 'Untitled scenario')} onClick={() => onSelect(scenario.id)}><strong>{scenario.name || (zh ? '未命名场景' : 'Untitled scenario')}</strong><span>{scenario.workflow.length}{zh ? ' 步' : ' steps'}</span></button><button type="button" className="scenario-workbench__delete" disabled={busy} aria-label={zh ? `删除场景 ${scenario.name}` : `Delete scenario ${scenario.name}`} title={zh ? '移入回收站' : 'Move to Trash'} onClick={() => void moveToTrash(scenario)}><Trash2 size={14} /></button></article>)}
                {!collapsedGroups.has(group.key) && group.items.length === 0 && <p className="scenario-library__none">{zh ? '还没有场景——把左侧场景拖进这个分类即可。' : 'Empty — drag a scenario into this category.'}</p>}
              </section>
            ))}
            {libraryScenarios.length === 0 && <p className="scenario-library__none">{zh ? '还没有场景。点上方「新建」开始。' : 'No scenarios yet. Use New above to start.'}</p>}
          </> : <>
            {trashScenarios.map((item) => <article key={item.definition.id} className="scenario-library__trash-item"><div className="scenario-library__select"><strong>{item.definition.name || (zh ? '未命名场景' : 'Untitled scenario')}</strong><span>{zh ? `剩余 ${remainingTrashDays(item.expiresAt)} 天后永久删除` : `${remainingTrashDays(item.expiresAt)} day(s) until permanent deletion`}</span></div><button type="button" className="scenario-library__restore" disabled={busy || !onRestoreScenario} aria-label={zh ? `恢复场景 ${item.definition.name}` : `Restore scenario ${item.definition.name}`} onClick={() => void restoreFromTrash(item)}><RotateCcw size={14} />{zh ? '恢复' : 'Restore'}</button></article>)}
            {trashScenarios.length === 0 && <p className="scenario-library__none">{zh ? '回收站为空。已删除场景会保留 7 天。' : 'Trash is empty. Deleted scenarios remain here for 7 days.'}</p>}
          </>}
        </div>
        {libraryMode === 'scenarios' && draft && <label className="scenario-library__category-editor"><span>{zh ? '当前场景分类' : 'Current scenario category'}</span><input value={scenarioCategory(draft)} disabled={busy} list="scenario-category-options" placeholder={zh ? '输入或选择分类' : 'Enter or choose a category'} onChange={(event) => mutateDraft((scenario) => updateScenarioCategory(scenario, event.target.value))} /><datalist id="scenario-category-options">{categories.map((category) => <option key={category} value={category} />)}</datalist><button type="button" onClick={() => mutateDraft((scenario) => updateScenarioCategory(scenario, ''))} disabled={busy || !scenarioCategory(draft)}>{zh ? '移出分类' : 'Remove category'}</button></label>}
      </aside>
      <section className="scenario-workbench__editor" aria-label={zh ? '场景定义' : 'Scenario definition'}>
        {libraryMode === 'trash' ? <div className="scenario-workbench__trash-panel" data-testid="sw-trash-panel"><span>{zh ? '场景回收站' : 'Scenario Trash'}</span><h2>{zh ? '删除后有 7 天恢复期' : 'Deleted scenarios have a 7-day recovery window'}</h2><p>{zh ? '这里的场景尚未永久删除。点击左侧「恢复」后会原样回到场景列表；到期后由 METIS 持久化层自动永久清理。' : 'Items here have not been permanently deleted. Restore from the left to return an unchanged scenario; METIS permanently removes it after expiry.'}</p></div> : <><div className="scenario-workbench__editor-heading"><div className="scenario-workbench__editor-heading-main"><span>{zh ? '场景定义' : 'Scenario definition'}</span><h2>{draft?.name || (zh ? '请选择或新建场景' : 'Select or create a scenario')}</h2></div>{draft && <div className="scenario-workbench__editor-actions"><button type="button" className="btn-secondary" disabled={busy || revisionConflict} onClick={() => void saveDraft()}>{busy ? (zh ? '处理中…' : 'Working…') : (zh ? '保存' : 'Save')}</button>{revisionConflict && <button type="button" className="btn-secondary" disabled={busy} onClick={() => void saveDraftAsNewScenario()} data-testid="sw-save-as-new">{zh ? '另存为新场景' : 'Save as new scenario'}</button>}<button type="button" className="btn-primary" disabled={busy || revisionConflict} onClick={() => void activateScenario()} data-testid="sw-use">{zh ? '使用场景' : 'Use scenario'}</button></div>}<p>{draft ? (zh ? 'AI 与手动编辑作用于同一份草稿；保存后才成为可运行版本。' : 'AI and manual edits share one draft; save it to make the runnable version.') : (zh ? '从左侧选择已有场景，或新建一个场景后开始配置。' : 'Select an existing scenario on the left, or create one to begin configuration.')}</p></div><div className="scenario-workbench__notice" aria-live="polite">{notice}</div>{draft ? <div className="scenario-workbench__editor-scroll"><ScenarioFocusedEditor zh={zh} busy={busy} draft={draft} definitions={definitions} mutateDraft={mutateDraft} ensureDeliverable={ensureDeliverable} addStep={addStep} removeStep={(id) => mutateDraft((scenario) => removeStepAndDescendants(scenario, id))} reorderSteps={reorderSteps} toggleStepResource={toggleStepResource} acquire={(kind, stepId, mode) => setAcquisition({ kind, stepId, mode })} /></div> : <div className="scenario-workbench__editor-empty" data-testid="sw-empty"><h3>{zh ? '还没有打开场景' : 'No scenario is open'}</h3><p>{zh ? '场景列表和配置助手始终保留在这一页；点击左侧「新建」即可从对话开始构建。' : 'The list and configuration assistant remain on this page. Click “New” on the left to start building in conversation.'}</p></div>}</>}
      </section>
      {libraryMode === 'trash' ? <aside className="scenario-assistant scenario-assistant--empty" aria-label={zh ? '回收站说明' : 'Trash details'}><header className="scenario-assistant__header"><span className="scenario-assistant__mark"><Trash2 size={15} /></span><div><h2>{zh ? '安全删除' : 'Safe deletion'}</h2><p>{zh ? '先归档，后清理' : 'Archive first, clean up later'}</p></div></header><div className="scenario-assistant__empty"><h3>{zh ? '不会一键不可逆' : 'Never one-click irreversible'}</h3><p>{zh ? '删除场景只会移入这里。恢复不会改动任何 Workflow、材料或配置；超过 7 天未恢复才会永久删除。' : 'Deleting a scenario only moves it here. Restore does not alter its workflow, materials, or configuration; deletion is permanent only after 7 days.'}</p></div></aside> : draft ? <ScenarioConfigurationAssistant key={draft.id} zh={zh} scenarioName={draft.name} materialNames={(draft.materials ?? []).map((material) => material.name)} busy={busy} canUndo={aiUndoStack.length > 0} projectId={projectId} scenarioId={draft.id} onSubmitInstruction={compile} onUploadMaterials={uploadMaterials}
            onUploadFundingTemplate={async () => {
              const metis = window.metis;
              if (!metis?.analyzeFundingTemplateForAssistant || !projectId) return { ok: false, message: zh ? '服务不可用或未打开项目。' : 'Service unavailable or no project open.' };
              try {
                const result = await metis.analyzeFundingTemplateForAssistant(projectId);
                if (!result.ok) return { ok: false, message: result.message ?? (zh ? '模板分析未完成。' : 'Template analysis failed.') };
                return { ok: true, message: zh ? `申报书模板已分析入库（${result.templateId}）。` : `Template imported (${result.templateId}).`, templateId: result.templateId, structureSummary: result.summary };
              } catch (error) {
                return { ok: false, message: error instanceof Error ? error.message : String(error) };
              }
            }}
            onGenerateFundingDraft={async (request) => {
              const metis = window.metis;
              if (!metis?.draftFundingOutline) return { ok: false, message: zh ? '草稿服务不可用。' : 'Draft service unavailable.' };
              // 素材优先用本轮场景产出的交付物正文摘要，其次用模板结构本身。
              const deliverableText = [
                `场景：${draftRef.current?.name ?? ''}`,
                ...(draftRef.current?.workflow ?? []).map((step) => `${step.name}：${step.description ?? ''}`),
              ].join('\n');
              try {
                const result = await metis.draftFundingOutline({ projectId: request.projectId, templateId: request.templateId, materialText: [request.materialText, deliverableText].filter(Boolean).join('\n\n') });
                if (result.ok && result.markdown) {
                  const exported = await metis.exportMarkdownAsDocx?.({ title: `申报书填写草稿-${new Date().toLocaleDateString('zh-CN')}`, markdown: result.markdown });
                  return { ok: true, message: `${zh ? '已按申报书栏目生成逐栏填写草稿' : 'Draft generated'}${exported?.ok ? (zh ? `，并已导出 DOCX：${exported.fileName ?? ''}（见下载目录）。` : ` and exported as ${exported.fileName ?? ''}.`) : '。'}` };
                }
                return { ok: false, message: result.message ?? (zh ? '草稿生成未完成。' : 'Draft generation failed.') };
              } catch (error) {
                return { ok: false, message: error instanceof Error ? error.message : String(error) };
              }
            }}
            onUndo={undoLastAiChange} /> : <aside className="scenario-assistant scenario-assistant--empty" aria-label={zh ? '场景配置助手' : 'Scenario configuration assistant'}><header className="scenario-assistant__header"><span className="scenario-assistant__mark"><Plus size={15} /></span><div><h2>{zh ? '场景配置助手' : 'Scenario assistant'}</h2><p>{zh ? '对话构建，右侧同步成型' : 'Build in conversation, review in the middle'}</p></div></header><div className="scenario-assistant__empty"><h3>{zh ? '从一个场景开始' : 'Start with a scenario'}</h3><p>{zh ? '先在左侧选择或新建场景。场景打开后，你可以在这里通过自然语言、材料文件和连续对话完成定义。' : 'Select or create a scenario on the left. Once open, use natural language, material files, and continuous conversation here to build it.'}</p></div></aside>}
    </div>
    {acquisition && <div className="scenario-workbench__modal" role="dialog" aria-modal="true" aria-label={zh ? '获取步骤能力' : 'Acquire step capability'}><section><button type="button" className="scenario-workbench__modal-close" aria-label={zh ? '关闭' : 'Close'} onClick={() => setAcquisition(null)}><X size={18} /></button>{acquisition.mode === 'search' ? <MarketBrowserPanel kind={acquisition.kind} zh={zh} definitions={definitions} onInstalled={(id) => void bindInstalled(id)} /> : <ExtensionInstaller kind={acquisition.kind} definitions={definitions} initialMode={acquisition.mode === 'package' ? acquisition.kind === 'mcp' ? 'mcp_package' : 'skill_package' : acquisition.kind === 'skill' ? 'skill_url' : 'mcp_url'} onInstalled={(id) => bindInstalled(id)} onRefresh={reload} />}</section></div>}
    {unsavedDialogOpen && <div className="scenario-workbench__modal" role="dialog" aria-modal="true" aria-label={zh ? '未保存的场景编辑' : 'Unsaved scenario edits'} data-testid="sw-unsaved-dialog"><section>
      <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>{zh ? '当前场景有未保存的编辑' : 'Unsaved scenario edits'}</h3>
      <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-secondary)' }}>{zh ? '离开前要保存「' + (draft?.name || '') + '」的修改吗？不保存将丢失这些编辑。' : `Save your edits to “${draft?.name || ''}” before leaving? Unsaved edits will be lost.`}</p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn-secondary btn-sm" onClick={() => setUnsavedDialogOpen(false)}>{zh ? '留在本页' : 'Stay'}</button>
        <button type="button" className="btn-secondary btn-sm" onClick={() => leaveNow(undefined, { discardDraft: true })} data-testid="sw-unsaved-discard">{zh ? '不保存并离开' : 'Discard & leave'}</button>
        <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void saveAndLeave()} data-testid="sw-unsaved-save">{busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存并离开' : 'Save & leave')}</button>
      </div>
    </section></div>}
  </div>;
}
