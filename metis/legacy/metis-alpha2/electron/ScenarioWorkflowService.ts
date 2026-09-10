import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentLoop } from '../engine/core/AgentLoop.js';
import type { ChatMessage } from '../engine/core/types.js';
import type { PersistenceStore } from '../engine/persistence/PersistenceStore.js';
import type { ResearchRepository } from '../engine/persistence/ResearchRepository.js';
import type { ArtifactType } from '../engine/artifacts/ArtifactManifest.js';
import type { PersonalizationRepository } from '../engine/personalization/PersonalizationRepository.js';
import { composeManifestSystemPrompt } from '../engine/personalization/PersonalizationResolver.js';
import {
  ScenarioRunCoordinator,
  ScenarioRunRecordSchema,
  digestScenarioStepOutput,
  digestResolvedManifestSnapshot,
  resolveScenarioExecutionOrder,
  type ScenarioRunRecord,
  type ScenarioStepExecutionInput,
} from '../engine/personalization/ScenarioRunCoordinator.js';
import {
  emitScenarioHookEvent,
  hooksFromManifest,
  notifyScenarioRunEvent,
  scenarioHookExecutor,
  scenarioRuntimeHookBridge,
  type ScenarioHookEvent,
} from '../engine/personalization/ScenarioHookExecutor.js';
import {
  AgentResponseSchema,
  CHAT_RUNTIME_CONTRACT_VERSION,
  RuntimeIdSchema,
  type AgentResponse,
} from '../engine/runtime/ChatRuntimeContract.js';
import {
  ResolvedRunManifestSchema,
  type ResolvedRunManifest,
} from '../engine/runtime/PersonalizationRuntimeContract.js';
import {
  bundleFromSectionedReport,
  decodeScenarioOutputBundle,
  mergeSectionedParseReports,
  parseScenarioSectionedOutput,
  type ScenarioOutputBundle,
  type ScenarioOutputPlan,
  type SectionedParseReport,
} from '../engine/runtime/ScenarioOutputBundleContract.js';
import type { LiveSteeringSource } from '../engine/runtime/LiveSteeringContract.js';
import { createChatTurnErrorResponse, type ChatTurnMode } from './ChatTurnService.js';
import type { ScenarioLiteratureBridge } from './ScenarioLiteratureBridge.js';

interface RunPersistedScenarioWorkflowOptions {
  agentLoop: Pick<AgentLoop, 'run'>;
  agentLoopForModel?: (modelPreference: string) => Pick<AgentLoop, 'run'>;
  store: Pick<
    PersistenceStore,
    'appendMessage' | 'createArtifacts' | 'createSession' | 'getSession' | 'truncateMessagesAfterLastUser'
  >;
  repository: Pick<
    PersonalizationRepository,
    'saveScenarioRunRecord' | 'getRecoverableScenarioRun' | 'listCompletedScenarioRunRecords' | 'get' | 'supersedeOtherScenarioRuns'
  >;
  sessionId: string;
  messages: ChatMessage[];
  requestId: string;
  manifest: ResolvedRunManifest;
  mode?: ChatTurnMode;
  signal?: AbortSignal;
  /** Public pause control: persists a durable paused checkpoint that the next turn resumes. */
  pauseSignal?: AbortSignal;
  /** Public cancel control: persists terminal cancelled; late provider results cannot revive the run. */
  cancelSignal?: AbortSignal;
  liveSteering?: LiveSteeringSource;
  projectId?: string;
  /**
   * 研究成果仓（2026-08-30 刘总问题 E 修复）：传入且 run 带 projectId 时，场景
   * 产物在落会话级 artifacts 的同时镜像进项目级 research_artifacts（含内容体，
   * 「研究成果」页按项目时间倒序可见）。幂等：research id 由源 artifact id 派生，
   * 重跑/修订轮同 id 走 saveArtifactVersion 的 upsert+版本自增，不重复建行。
   */
  researchRepository?: Pick<ResearchRepository, 'saveArtifactVersion'>;
  /**
   * 文献入库桥（2026-08-30 刘总问题 B 修复）：产物落库后调用，解析 JSON 题录、
   * 过真实性闸（DOI 经 crossref 校验 / 仅 URL 直收 / 皆无拒收）后写 papers 表并
   * 三写 sources+paper_project_links。桥内部对非书目产物零成本跳过（无 JSON 数组
   * 即返回）。失败只记日志，不阻断运行。
   */
  literatureBridge?: ScenarioLiteratureBridge;
  isCurrentRuntime?: () => boolean;  /** 场景 Hook（场景重构 P4）：审批决策通道必须接到真实确认；事件汇用于通知/日志。 */
  hookApproval?: (input: { hookId: string; stepId: string; instruction: string; runId: string }) => Promise<boolean> | boolean;
  hookEvent?: (event: ScenarioHookEvent) => void;
}

export function hasExecutableScenarioWorkflow(
  manifest: ResolvedRunManifest | undefined,
): manifest is ResolvedRunManifest {
  const result = preflightScenarioExecution(manifest);
  return result.ok && result.useCoordinator;
}

export type ScenarioExecutionPreflight =
  | { ok: true; useCoordinator: boolean }
  | { ok: false; code: 'scenario_output_agent_ambiguous' | 'scenario_output_policy_missing' };

/** Main-process preflight; call before preparing MCP processes or other run side effects. */
export function preflightScenarioExecution(
  manifest: ResolvedRunManifest | undefined,
): ScenarioExecutionPreflight {
  if (!manifest) return { ok: true, useCoordinator: false };
  if (manifest.workflow.length > 0) return { ok: true, useCoordinator: true };
  if (!manifest.output.plan) return { ok: true, useCoordinator: false };
  if (manifest.agentIds.length !== 1) return { ok: false, code: 'scenario_output_agent_ambiguous' };
  if (!manifest.implicitOutputStep || manifest.implicitOutputStep.agentId !== manifest.agentIds[0]) {
    return { ok: false, code: 'scenario_output_policy_missing' };
  }
  return { ok: true, useCoordinator: true };
}

export type ScenarioExecutionCompilation =
  | { ok: true; useCoordinator: boolean; manifest: ResolvedRunManifest | undefined }
  | {
      ok: false;
      code:
        | 'scenario_output_agent_ambiguous'
        | 'scenario_output_policy_missing'
        | 'scenario_execution_manifest_invalid';
    };

/**
 * Compile the one immutable manifest identity used by MCP evidence, workflow checkpoints and
 * artifacts. Runtime instructions are frozen into a final prompt layer before the digest is made.
 */
export function compileScenarioExecutionManifest(
  manifest: ResolvedRunManifest | undefined,
  options: { executionInstructions?: readonly string[] } = {},
): ScenarioExecutionCompilation {
  const preflight = preflightScenarioExecution(manifest);
  if (!preflight.ok) return preflight;
  if (!manifest) return { ok: true, useCoordinator: false, manifest: undefined };
  const instructions = (options.executionInstructions ?? []).filter((value) => value.trim().length > 0);
  const executionContent = instructions.join('\n\n');
  const promptStack = executionContent
    ? [
        ...manifest.promptStack,
        {
          sourceId: manifest.scenarioId,
          sourceKind: 'rules' as const,
          precedence: 10_000,
          contentDigest: createHash('sha256').update(executionContent, 'utf8').digest('hex'),
          content: executionContent,
        },
      ]
    : manifest.promptStack;
  const workflow = preflight.useCoordinator && manifest.workflow.length === 0
    ? [{ ...manifest.implicitOutputStep! }]
    : manifest.workflow;
  if (workflow === manifest.workflow && promptStack === manifest.promptStack) {
    return { ok: true, useCoordinator: preflight.useCoordinator, manifest };
  }
  const candidate: ResolvedRunManifest = {
    ...manifest,
    workflow,
    promptStack,
    manifestDigest: '0'.repeat(64),
  };
  const parsed = ResolvedRunManifestSchema.safeParse({
    ...candidate,
    manifestDigest: digestResolvedManifestSnapshot(candidate),
  });
  return parsed.success
    ? { ok: true, useCoordinator: preflight.useCoordinator, manifest: parsed.data }
    : { ok: false, code: 'scenario_execution_manifest_invalid' };
}

function latestUserMessage(messages: readonly ChatMessage[]): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return message;
  }
  return undefined;
}

function safeTurnId(requestId: string): string {
  const parsed = RuntimeIdSchema.safeParse(requestId);
  return parsed.success ? parsed.data : 'scenario-recovery';
}

function memoryScopeFilters(
  manifest: ResolvedRunManifest,
  step: ResolvedRunManifest['workflow'][number],
): { sessionId?: string; projectId?: string; scenarioId?: string } | undefined {
  const policies = [manifest.memory, step.memory ?? manifest.memory];
  if (policies.some((policy) => policy.scope === 'none')) return undefined;
  const filters: { sessionId?: string; projectId?: string; scenarioId?: string } = {};
  for (const policy of policies) {
    if (policy.scope === 'session') filters.sessionId = manifest.sessionId;
    if (policy.scope === 'project') filters.projectId = manifest.projectId;
    if (policy.scope === 'scenario') filters.scenarioId = manifest.scenarioId;
  }
  return Object.keys(filters).length > 0 ? filters : undefined;
}

function scenarioMemoryContext(
  manifest: ResolvedRunManifest,
  step: ResolvedRunManifest['workflow'][number],
  repository: Pick<PersonalizationRepository, 'listCompletedScenarioRunRecords'>,
): string {
  const filters = memoryScopeFilters(manifest, step);
  if (!filters) return '';
  const stepPolicy = step.memory ?? manifest.memory;
  const retainDecisions = manifest.memory.retainDecisions && stepPolicy.retainDecisions;
  const retainArtifacts = manifest.memory.retainArtifacts && stepPolicy.retainArtifacts;
  if (!retainDecisions && !retainArtifacts) return '';
  const limit = Math.min(manifest.memory.maxSummaryChars, stepPolicy.maxSummaryChars);
  const sections: string[] = [];
  for (const record of repository.listCompletedScenarioRunRecords({ ...filters, limit: 20 })) {
    const lines = [`Run ${record.runId} (${record.manifestSnapshot.scenarioId}):`];
    if (retainDecisions) {
      for (const previousStep of record.steps.filter((candidate) => candidate.status === 'completed')) {
        if (previousStep.output !== null) {
          lines.push(`- ${previousStep.stepId} output: ${JSON.stringify(previousStep.output)}`);
        }
      }
    }
    if (retainArtifacts) {
      for (const artifact of record.steps.flatMap((candidate) => candidate.artifactRefs)) {
        lines.push(`- artifact ${artifact.id} v${artifact.version} digest ${artifact.contentDigest}`);
      }
    }
    if (lines.length > 1) sections.push(lines.join('\n'));
  }
  if (sections.length === 0) return '';
  const value = `# Prior scenario memory\n${sections.join('\n\n')}`;
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 24))}\n[Memory truncated]`;
}

function outputBundleInstruction(plan: ScenarioOutputPlan): string {
  // 分段线格式 + 编号标签（2026-08-31 机制修正，第二轮）：第一轮实证模型会
  // 把步骤自身验收标准错当成 quality 段、把步骤提示词里的交付物错当成
  // supporting 段。编号标签（S1..Sn / Q1..Qn）免除照抄长中文名称的负担，
  // 并显式声明两组清单与步骤自身标准不可混用；代码负责归一、组包与严格
  // 校验，交付物要求（全部 supporting + quality、内容非空）一项不降。
  return [
    '# Required output bundle',
    'Deliver EVERY artifact and quality assessment listed below using this exact sectioned format. Write raw content between the markers — do not escape anything, do not wrap sections in code fences.',
    '',
    '===METIS-PRIMARY===',
    '<complete content of the primary deliverable>',
    '',
    '===METIS-SUPPORTING===',
    'name: S1',
    '<complete content of that artifact>',
    '',
    '(repeat one ===METIS-SUPPORTING=== section for every supporting artifact: S1, S2, ...)',
    '',
    '===METIS-QUALITY===',
    'criterion: Q1',
    'status: <met | partially_met | unmet>',
    '<specific evidence from the generated deliverables>',
    '',
    '(repeat one ===METIS-QUALITY=== section for every quality criterion: Q1, Q2, ...)',
    '',
    'Required entries — reference each by its index label (S1..Sn / Q1..Qn) or its verbatim name, each exactly once:',
    `primary deliverable: ${JSON.stringify(plan.primaryDeliverable)}`,
    'supporting artifacts:',
    ...plan.supportingArtifacts.map((name, index) => `  S${index + 1} = ${JSON.stringify(name)}`),
    'quality criteria:',
    ...plan.qualityCriteria.map((criterion, index) => `  Q${index + 1} = ${JSON.stringify(criterion)}`),
    '',
    'Section rules:',
    '- In a ===METIS-SUPPORTING=== section the first line must be "name: S<n>" (or "name: <exact artifact name>"); the content starts on the next line and continues until the next marker.',
    '- In a ===METIS-QUALITY=== section the first two lines must be "criterion: Q<n>" (or "criterion: <exact criterion>") and "status: <met | partially_met | unmet>" in either order; the evidence starts on the next line.',
    '- The quality criteria listed above (Q1..Qn) are the delivery contract. Do NOT create quality sections for the step\'s own completion criteria or any other checklist — those are internal checks, not bundle entries.',
    '- Do NOT create sections for anything outside the lists above. Additional step-level deliverables (checklists, processing records, self-review logs, etc.) belong inside the primary content or the most relevant supporting artifact, not as separate sections.',
    '- Paged delivery: one response does NOT have to hold everything. Deliver as much as fits, then stop; you will be told exactly what is still missing and can continue in your next response. To continue a long entry, use its continuation marker — ===METIS-PRIMARY-CONTINUED=== appends to the primary, ===METIS-SUPPORTING-CONTINUED=== with "name: S<n>" appends to that artifact, ===METIS-QUALITY-CONTINUED=== with "criterion: Q<n>" appends to that evidence. Re-sending a plain marker replaces that entry.',
    '- Never truncate the primary deliverable to fit one response: continue it across responses with the continuation marker instead.',
    '- Markdown is allowed inside section content. Do not write any text before the first marker.',
    '- Every artifact and criterion must be delivered in full; none may be omitted, truncated, or replaced by placeholders.',
  ].join('\n');
}

/**
 * 续投/纠偏反馈（2026-08-31 分页交付机制）：已匹配的段落跨轮保留，反馈只
 * 列仍缺失的条目（编号标签），长正文用当前结尾锚点引导 CONTINUED 续写，
 * 避免整篇重生成（生产实证单轮 44 分钟且重生成会引入新不匹配）。
 */
function deliveryContinuationMessage(
  plan: ScenarioOutputPlan,
  carried: SectionedParseReport | undefined,
  error: string | undefined,
): string {
  const base = error
    ? `The previous response failed the required output bundle contract (${error}).`
    : 'Delivery is incomplete.';
  if (!carried) {
    return `${base} Re-read the "Required output bundle" section and deliver in the sectioned format, referencing entries by their index labels (S1..Sn / Q1..Qn). Raw content, no JSON. Paged delivery is allowed — deliver what fits, the next response continues.`;
  }
  const received: string[] = [];
  if (carried.primary) received.push(`primary (≈${carried.primary.content.length} chars so far)`);
  const receivedSupporting = plan.supportingArtifacts
    .map((name, index) => (carried.supporting.has(name) ? `S${index + 1}` : null))
    .filter(Boolean);
  if (receivedSupporting.length > 0) received.push(`supporting ${receivedSupporting.join(', ')}`);
  const receivedQuality = plan.qualityCriteria
    .map((criterion, index) => (carried.quality.has(criterion) ? `Q${index + 1}` : null))
    .filter(Boolean);
  if (receivedQuality.length > 0) received.push(`quality ${receivedQuality.join(', ')}`);
  const parts = [base];
  if (received.length > 0) {
    parts.push(`Received and kept: ${received.join('; ')} — do not resend them.`);
  }
  if (carried.primary) {
    const tail = carried.primary.content.replace(/\s+$/u, '').slice(-300);
    parts.push(`If the primary deliverable is not finished, continue it with a ===METIS-PRIMARY-CONTINUED=== section. Its current ending:\n…${tail}`);
  }
  const missing: string[] = [];
  if (!carried.primary) missing.push(`===METIS-PRIMARY=== (primary deliverable "${plan.primaryDeliverable}")`);
  plan.supportingArtifacts.forEach((name, index) => {
    if (!carried.supporting.has(name)) missing.push(`===METIS-SUPPORTING=== with name: S${index + 1} ("${name}")`);
  });
  plan.qualityCriteria.forEach((criterion, index) => {
    if (!carried.quality.has(criterion)) missing.push(`===METIS-QUALITY=== with criterion: Q${index + 1} ("${criterion}")`);
  });
  if (missing.length > 0) {
    parts.push(`Return ONLY these missing sections in the sectioned format (raw content, no JSON):\n- ${missing.join('\n- ')}`);
  } else {
    parts.push('Fix the sections reported above and resend only those.');
  }
  return parts.join('\n');
}

// 上下文载荷预算（2026-08-31 生产失败修正）：生产模型 qwen3.5-122b-a10b
// 上下文 128k token、输出预留 16,384 token，提示词上限 ≈111k token。中文按
// 保守 1 字符≈1 token 计，扣除系统提示词与指令模板 ≈13k，再留安全边距，
// 载荷（上游产出 + 上一轮产出）合计预算 70k 字符。2026-08-31 事故：协调器
// 注入 100k 上游 + 13k 上一轮产出，请求 ≈124k 字符超出窗口，API 三次秒拒。
const CONTEXT_PAYLOAD_BUDGET_CHARS = 70_000;
const PREVIOUS_OUTPUT_MAX_CHARS = 24_000;

// 预算化序列化上游产出：按插入序（直接前驱在前、其后新近优先）贪心装入，
// 装不下的显式列入 trimmed 清单写进提示词——不静默丢弃（无痕失败禁令）。
// 第一个条目（直接前驱）无条件保留。
function serializeDependencyOutputsForPrompt(
  dependencyOutputs: Record<string, unknown>,
  budgetChars: number,
): { json: string; trimmed: string[] } {
  const kept: Record<string, unknown> = {};
  const trimmed: string[] = [];
  let used = 0;
  let keptCount = 0;
  for (const [key, value] of Object.entries(dependencyOutputs ?? {})) {
    if (key === '_omittedUpstream') {
      kept[key] = value;
      continue;
    }
    const serialized = JSON.stringify(value) ?? 'null';
    if (keptCount > 0 && used + serialized.length > budgetChars) {
      trimmed.push(`${key} (${serialized.length} chars)`);
      continue;
    }
    kept[key] = value;
    used += serialized.length;
    keptCount += 1;
  }
  return { json: JSON.stringify(kept), trimmed };
}

function stepInstruction(
  input: ScenarioStepExecutionInput,
  memoryContext: string,
  finalOutputPlan?: ScenarioOutputPlan,
  userDirective?: string,
): string {
  // 修订轮上下文（2026-08-31 机制修正）：协调器一直把 runtimeInstruction
  // （评审缺陷清单）与 previousIterationOutput（上一轮完整产出）传给执行器，
  // 但此前 stepInstruction 从未使用——修订轮盲改，只能凭印象重写，是长文
  // 定稿反复失败的深层原因之一。现在两者都进提示词，并共享上下文载荷预算
  // （上一轮产出优先，上限 24k 字符，截断时明确标注）。
  const previousText = (() => {
    const output = input.previousIterationOutput;
    if (!output || typeof output !== 'object' || !('text' in output)) return '';
    const text = (output as { text?: unknown }).text;
    if (typeof text !== 'string' || !text.trim()) return '';
    return text.length > PREVIOUS_OUTPUT_MAX_CHARS
      ? `${text.slice(0, PREVIOUS_OUTPUT_MAX_CHARS)}\n[previous output truncated at ${PREVIOUS_OUTPUT_MAX_CHARS.toLocaleString('en-US')} chars to fit the model context window]`
      : text;
  })();
  const upstreamBudget = Math.max(8_000, CONTEXT_PAYLOAD_BUDGET_CHARS - previousText.length);
  const { json: dependencyJson, trimmed } = serializeDependencyOutputsForPrompt(
    input.dependencyOutputs as Record<string, unknown>,
    upstreamBudget,
  );
  const upstreamNote = trimmed.length > 0
    ? `\n_trimmedForContext: omitted to fit the model context window (their content exists in earlier steps' artifacts): ${trimmed.join('; ')}`
    : '';
  return [
    `Execute scenario workflow step "${input.step.name}" (${input.step.id}).`,
    input.step.goal ? `Step goal:\n${input.step.goal}` : input.step.description,
    input.step.prompt ? `Dedicated step prompt:\n${input.step.prompt}` : '',
    input.step.condition ? `Execution condition:\n${input.step.condition}` : '',
    input.step.inputs?.length ? `Declared inputs:\n${JSON.stringify(input.step.inputs, null, 2)}` : '',
    input.step.outputs?.length ? `Required outputs:\n${JSON.stringify(input.step.outputs, null, 2)}` : '',
    input.step.completionCriteria?.length
      ? `Completion criteria (all must be checked before returning):\n- ${input.step.completionCriteria.join('\n- ')}`
      : '',
    input.step.failurePolicy?.instruction ? `Failure recovery instruction:\n${input.step.failurePolicy.instruction}` : '',
    input.step.loop?.enabled
      ? `Step Loop policy: at most ${input.step.loop.maxIterations} iteration(s); stop when ${input.step.loop.stopCondition || 'the completion criteria are met'}.`
      : '',
    userDirective
      ? `DIRECTIVE FROM THE USER (刘总的指导，最高优先级 — follow it while redoing this step):\n${userDirective}`
      : '',
    input.runtimeInstruction
      ? `Revision directive from the completion review — address every listed defect; keep content the list does not mention unchanged:\n${input.runtimeInstruction}`
      : '',
    previousText
      ? `Your previous iteration's complete output (revise from it; do not restart from scratch):\n<previous_iteration_output>\n${previousText}\n</previous_iteration_output>`
      : '',
    `Stable execution key: ${input.executionKey}.`,
    'Treat upstream outputs as context, not as automatically verified evidence.',
    `Upstream outputs: ${dependencyJson}${upstreamNote}`,
    memoryContext,
    finalOutputPlan ? outputBundleInstruction(finalOutputPlan) : '',
    finalOutputPlan
      ? ''
      // 进度汇报契约（2026-09-01 刘总方案一期「看得见」）：非交付包步骤末尾
      // 附一段极简汇报，执行器剥离后进聊天步骤卡，正文不受污染。
      : [
        'PROGRESS REPORT (MANDATORY): AFTER the main output, append a <step_brief> block on its own lines:',
        '<step_brief>',
        '思路：why you took this approach (1-2 sentences)',
        '结果：what this step actually produced or changed (1-2 sentences)',
        '下一步：what the next step should do with it (1 sentence)',
        '</step_brief>',
        'Keep the whole block under 150 Chinese characters. It is stripped from the stored artifact automatically. Never put the main output inside the block.',
      ].join('\n'),
    'Before returning, satisfy every active Agent, Skill, and Metis.md instruction from the system prompt. Exact tokens, required content, and placement constraints are mandatory.',
    'Return only the complete, evidence-aware output for this step. Do not claim that later steps ran.',
  ].filter(Boolean).join('\n\n');
}

function artifactContentDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function artifactName(label: string, fallback: string): string {
  const normalized = label
    .replace(/[\\/<>:"|?*]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const stem = (normalized || fallback).slice(0, 232).trimEnd();
  return /\.md$/iu.test(stem) ? stem : `${stem}.md`;
}

// ── 步骤卡（2026-09-01 刘总方案一期：过程可见）─────────────────────────────

export interface ScenarioStepBrief {
  approach: string;
  result: string;
  next: string;
}

const STEP_BRIEF_PATTERN = /<step_brief>([\s\S]*?)<\/step_brief>/iu;

/**
 * 从步骤输出中提取并剥离 `<step_brief>` 汇报块（一期「看得见」）：思路/结果/
 * 下一步三行进聊天步骤卡，剥离后的正文才落生成物——摘要不污染交付物。
 * 模型没按要求输出时返回 null（卡片诚实降级，不伪造摘要）。
 */
export function extractStepBrief(text: string): { text: string; brief: ScenarioStepBrief | null } {
  const matches = [...text.matchAll(new RegExp(STEP_BRIEF_PATTERN.source, 'giu'))];
  if (matches.length === 0) return { text, brief: null };
  const last = matches[matches.length - 1]!;
  const stripped = `${text.slice(0, last.index ?? 0)}${text.slice((last.index ?? 0) + last[0].length)}`.trimEnd();
  const pick = (labels: readonly string[]): string => {
    for (const label of labels) {
      const line = (last[1] ?? '')
        .split(/\r?\n/u)
        .map((row) => row.trim())
        .find((row) => row.startsWith(label));
      if (line) return line.slice(label.length).replace(/^[:：\s]+/u, '').trim().slice(0, 300);
    }
    return '';
  };
  const approach = pick(['思路', 'Approach', '方法']);
  const result = pick(['结果', 'Result', '产出']);
  const next = pick(['下一步', 'Next']);
  if (!approach && !result && !next) return { text, brief: null };
  return {
    text: stripped,
    brief: {
      approach: approach || '（未填写）',
      result: result || '（未填写）',
      next: next || '（未填写）',
    },
  };
}

export interface ScenarioStepCardPayload {
  v: 1;
  runId: string;
  sessionId: string;
  stepId: string;
  stepName: string;
  iteration: number;
  status: 'completed' | 'final';
  brief: ScenarioStepBrief | null;
  artifactName: string;
  chars: number;
  scenarioId: string;
}

// T3 全局对话体验重构（2026-09-08）：新消息禁用 metis-step-card 围栏协议。
// 卡片结构化数据放消息 metadata.stepCard，正文只留人话摘要；
// ChatPage 渲染层从 metadata 读取 scenario_step part（历史围栏走 legacy decoder）。
function stepCardMessageText(payload: ScenarioStepCardPayload): string {
  const lines: string[] = [`${payload.stepName}（第 ${payload.iteration} 轮）已完成 ✓`];
  if (payload.brief) {
    const briefLines = [payload.brief.approach, payload.brief.result, payload.brief.next].filter(Boolean);
    if (briefLines.length > 0) lines.push('', ...briefLines);
  }
  if (payload.artifactName) {
    lines.push('', `产出：${payload.artifactName}（约 ${payload.chars.toLocaleString('en-US')} 字符）——右侧成果面板可查看全文。`);
  }
  return lines.join('\n');
}

// ── 步骤卡控制（二期：可介入）──────────────────────────────────────────────

export type ScenarioStepControlAction = 'redo' | 'skip';

export interface ScenarioStepControlInput {
  action: ScenarioStepControlAction;
  stepId: string;
  /** redo 时的用户指导（如"把定量研究也纳入"）；skip 无指导。 */
  guidance?: string;
}

export type ScenarioStepControlResult =
  | { ok: true; record: ScenarioRunRecord; message: string }
  | { ok: false; code: 'step_not_found' | 'invalid_state' | 'invalid_guidance'; message: string };

const TERMINAL_STEP_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'blocked', 'skipped']);

function scenarioExecutionKeyFor(runId: string, manifestDigest: string, stepSnapshotDigest: string): string {
  return createHash('sha256').update(`${runId}:${manifestDigest}:${stepSnapshotDigest}`, 'utf8').digest('hex');
}

/**
 * 步骤控制的纯函数核心（2026-09-01 刘总方案二期）：把「重做这步（可带指导）/
 * 跳过这步」落到运行记录上。
 *
 * 两种记录形态：
 * - recoverable（running/failed/interrupted/paused）：就地改。回退授权走
 *   backtrackCount+1（与协调器自身回退同一合法信号，进度断言放行 pending 重置）。
 * - completed：运行记录是防篡改不可变终态（刘总报告后的安全契约），不 reopened；
 *   改为派生「续作分支」——新 runId、重算每步 executionKey（键绑定 runId）、
 *   原记录原样保留作审计。分支完成步数不少于原记录减去重置步，恢复选择必然选中它。
 *
 * 目标步及其下游全部重置 pending（下游对旧上游产出的依赖必须作废）；skip 的
 * 目标步置 skipped（不产出，下游按空输入重跑）。redo 指导写 pendingDirectives，
 * 执行器消费后在 checkpoint 标记 consumedAt，防止后续重跑误用旧指导。
 */
export function applyStepControl(record: ScenarioRunRecord, control: ScenarioStepControlInput): ScenarioStepControlResult {
  const stepIndex = record.steps.findIndex((step) => step.stepId === control.stepId);
  if (stepIndex < 0) return { ok: false, code: 'step_not_found', message: `Step ${control.stepId} is not part of this run` };
  if (record.status === 'running') {
    return { ok: false, code: 'invalid_state', message: 'A step is currently executing — wait for it to finish before redoing or skipping another step' };
  }
  if (control.action === 'redo' && control.guidance !== undefined && !control.guidance.trim()) {
    return { ok: false, code: 'invalid_guidance', message: 'Guidance text is empty' };
  }
  if (control.action === 'skip' && record.steps.find((step) => step.stepId === control.stepId)?.status === 'skipped') {
    return { ok: false, code: 'invalid_state', message: 'This step is already skipped' };
  }
  const orderIndex = record.executionOrder.indexOf(control.stepId);
  if (orderIndex < 0) return { ok: false, code: 'step_not_found', message: `Step ${control.stepId} is not in the execution order` };
  const downstreamIds = new Set(record.executionOrder.slice(orderIndex));
  const now = Date.now();

  // completed 原记录不可变 → 派生续作分支；其余就地回退（backtrackCount+1 授权）。
  const isBranch = record.status === 'completed' || record.status === 'cancelled';
  const runId = isBranch
    ? `${record.runId}-rb${now.toString(36)}`.slice(0, 256)
    : record.runId;
  const next: ScenarioRunRecord = {
    ...record,
    runId,
    status: 'interrupted',
    completedAt: null,
    updatedAt: now,
    startedAt: isBranch ? now : record.startedAt,
    failureStepIds: [],
    backtrackCount: isBranch ? record.backtrackCount : record.backtrackCount + 1,
    steps: record.steps.map((step) => {
      const rebased = isBranch
        ? { ...step, executionKey: scenarioExecutionKeyFor(runId, record.manifestDigest, step.stepSnapshotDigest) }
        : step;
      if (!downstreamIds.has(step.stepId)) return rebased;
      if (TERMINAL_STEP_STATUSES.has(rebased.status) || rebased.status === 'pending' || rebased.status === 'running') {
        return {
          ...rebased,
          status: control.action === 'skip' && step.stepId === control.stepId ? 'skipped' : 'pending',
          startedAt: null,
          completedAt: null,
          output: null,
          outputDigest: null,
          errorCode: null,
          errorMessage: null,
          activeExecutionKey: null,
        };
      }
      return rebased;
    }),
  };
  if (control.action === 'redo') {
    const directives = (next.pendingDirectives ?? []).filter((entry) => entry.stepId !== control.stepId);
    directives.push({
      stepId: control.stepId,
      guidance: (control.guidance ?? '').trim(),
      issuedAt: now,
      consumedAt: null,
    });
    next.pendingDirectives = directives;
  }
  const parsed = ScenarioRunRecordSchema.safeParse(next);
  if (!parsed.success) {
    return { ok: false, code: 'invalid_state', message: `Mutated record failed validation: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  }
  const verb = control.action === 'redo' ? '重做' : '跳过';
  const affected = [...downstreamIds].filter((stepId) => {
    const step = next.steps.find((candidate) => candidate.stepId === stepId);
    return step?.status === 'pending';
  }).length;
  return {
    ok: true,
    record: parsed.data,
    message: `已标记${verb}「${control.stepId}」，${control.action === 'skip' ? '该步将不出产出' : '将按您的指导重跑'}，下游 ${affected} 步随之重跑。发送「继续」立即生效。`,
  };
}

function qualityReport(bundle: ScenarioOutputBundle): string {
  return [
    '# Quality report',
    '',
    ...bundle.quality.flatMap((entry) => [
      `## ${entry.criterion}`,
      '',
      `Status: ${entry.status}`,
      '',
      entry.evidence,
      '',
    ]),
  ].join('\n').trim();
}

function artifactRecordsForBundle(
  input: ScenarioStepExecutionInput,
  bundle: ScenarioOutputBundle,
  storeSessionId: string,
): {
  records: Parameters<PersistenceStore['createArtifacts']>[0];
  refs: Array<{ id: string; version: number; contentDigest: string }>;
} {
  const planned = [
    { role: 'primary', name: bundle.primary.name, content: bundle.primary.content },
    ...bundle.supporting.map((item) => ({ role: 'supporting', name: item.name, content: item.content })),
    ...(bundle.quality.length > 0
      ? [{ role: 'quality', name: `${bundle.primary.name} quality report`, content: qualityReport(bundle) }]
      : []),
  ];
  const records = planned.map((item, index) => {
    const contentDigest = artifactContentDigest(item.content);
    // 产物 ID 并入 stepIteration（2026-08-31 机制修正）：完成度评审打回后
    // 协调器会驱动第 2+ 轮修订迭代，修订后内容不同而 ID 不变会被只追加式
    // 存储以"id 冲突"拒绝（生产实证 artifact_persistence_failed）。过程产物
    // 的 ID 一直含迭代号，bundle 产物漏了。
    const idDigest = createHash('sha256')
      .update(`${input.runId}\u0000${input.step.id}\u0000${index}\u0000${item.name}\u0000${input.stepIteration ?? 1}`, 'utf8')
      .digest('hex');
    return {
      id: `scenario-artifact-${idDigest.slice(0, 40)}`,
      sessionId: storeSessionId,
      name: artifactName(item.name, `${item.role}-${index + 1}`),
      type: 'md',
      size: `${Buffer.byteLength(item.content, 'utf8')} B`,
      content: item.content,
      metadata: {
        kind: 'scenario_output',
        role: item.role,
        runId: input.runId,
        stepId: input.step.id,
        manifestDigest: input.manifestDigest,
        contentDigest,
      },
    };
  });
  return {
    records,
    refs: records.map((record) => ({
      id: record.id,
      version: 1,
      contentDigest: artifactContentDigest(record.content ?? ''),
    })),
  };
}

function researchArtifactTypeForScenario(role: string, name: string): ArtifactType {
  if (role === 'primary' || role === 'final') return 'manuscript';
  if (/(表|矩阵|台账|table|matrix|ledger)/iu.test(name)) return 'table';
  return 'report';
}

/**
 * 场景产物 → research_artifacts 镜像（刘总问题 E 修复，2026-08-30）。
 * 源 artifact id 含 runId/stepId/迭代号派生摘要，天然幂等：同一运行同一步骤
 * 重放时 id 相同，saveArtifactVersion 走 upsert + 版本自增，不会重复建行；
 * 修订轮（stepIteration 递增）产生新 id，作为独立产物保留，符合时间倒序展示。
 */
function mirrorScenarioArtifactToResearch(options: {
  researchRepository?: Pick<ResearchRepository, 'saveArtifactVersion'>;
  projectId?: string;
  artifact: { id: string; name: string; content?: string };
  scenarioId: string;
  runId: string;
  role: string;
}): void {
  const { researchRepository, projectId, artifact, scenarioId, runId, role } = options;
  if (!researchRepository || !projectId || !artifact.content?.trim()) return;
  const now = Date.now();
  researchRepository.saveArtifactVersion({
    id: `ra-${artifact.id}`,
    projectId,
    title: artifact.name.slice(0, 200) || artifact.id,
    artifactType: researchArtifactTypeForScenario(role, artifact.name),
    reviewStatus: 'draft',
    inputs: [{ kind: 'previous_artifact', id: artifact.id }],
    generatedBy: {
      capabilityId: 'scenario-workflow',
      method: `scenario:${scenarioId}#${runId}`,
    },
    citedSourceIds: [],
    renderer: { kind: 'markdown' },
    reviewTrail: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  }, artifact.content);
}

/** 文献入库桥安全调用：无桥/无项目/无内容即零成本跳过；失败留日志不阻断运行。 */

/** 检索类步骤运行期注入的内置检索工具（全部在共享 ToolRegistry 已注册）。 */
export const LITERATURE_SEARCH_TOOL_IDS: readonly string[] = [
  'search_papers',
  'arxiv_search',
  'openalex_lookup',
  'crossref_lookup',
  'ncpssd_search',
  'journal_directory_search',
  'journal_directory_detail',
] as const;

const LITERATURE_TOOL_DISCIPLINE = `

【文献检索纪律（运行期补充，本步骤涉及文献/资料检索）】
- 你挂载了真实检索工具（中文文献用 ncpssd_search＝国家哲学社会科学文献中心，默认核心期刊；外文文献用 search_papers / arxiv_search / openalex_lookup / crossref_lookup）。必须实际调用工具获取文献，禁止凭记忆列出任何文献。
- 检索到文献后，在产物中输出一个 JSON 数组（可放在 Markdown 代码块里），每个元素形如：
  [{"title":"论文标题","authors":["作者"],"year":2024,"venue":"期刊/会议名","doi":"10.xxxx/…","url":"https://…"}]
- doi 与 url 至少提供一项；两者都没有的条目不要输出（无法核验的文献不会入库）。
- 工具调用失败或检索不到时，如实说明检索情况，不要伪造题录凑数。`;

/**
 * 判定是否为文献/资料检索类步骤：仅依据 stepId 与名称/目标/提示词的显式
 * 检索语义，克制匹配——写作、大纲等步骤不注入检索工具。
 */
export function isLiteratureSearchStep(step: { id: string; name?: string; goal?: string; prompt?: string }): boolean {
  const idToken = /search|literature|biblio|reference|citation|gather.?source|source.?gather|retriev/iu.test(step.id ?? '');
  if (idToken) return true;
  const haystack = `${step.name ?? ''} ${step.goal ?? ''} ${step.prompt ?? ''}`.slice(0, 600);
  return /文献检索|文献搜索|检索文献|搜索文献|文献资料|查找文献|书目信息|文献列表|gather sources|search literature|bibliographic/iu.test(haystack);
}
async function runLiteratureBridge(options: {
  literatureBridge?: ScenarioLiteratureBridge;
  projectId?: string;
  artifactId: string;
  content?: string;
  runId: string;
  stepId?: string;
}): Promise<void> {
  const { literatureBridge, projectId, artifactId, content, runId, stepId } = options;
  // 结构闸门在桥内部（无 '{' 即零成本返回）；这里只做绑定/项目/空内容守卫，
  // 不在调用侧重复过滤逻辑。
  if (!literatureBridge || !projectId || !content?.trim()) return;
  try {
    await literatureBridge({ projectId, artifactId, content, runId, ...(stepId ? { stepId } : {}) });
  } catch (bridgeError) {
    console.warn('[ScenarioRun] literature bridge failed:', bridgeError instanceof Error ? bridgeError.message : bridgeError);
  }
}

function resultFailureCode(status: string): string {
  return `agent_${status.replace(/[^a-z0-9_]/gu, '_')}`.slice(0, 128);
}

// ── Restricted Harness judges ────────────────────────────────────────────────
// 受限评估 Agent：无工具、单轮、严格 JSON 裁决。任何解析失败都不放行：
// 条件裁决抛错由 coordinator fail-closed 为 condition_evaluation_failed；
// Step/Workflow 停止裁决失败按“未满足”处理，由耗尽策略兜底。

const JUDGE_MARKER = '[ScenarioJudge]';

const ConditionVerdictSchema = z.strictObject({
  run: z.boolean(),
  reason: z.string().min(1).max(4_000),
});
const CompletionVerdictSchema = z.strictObject({
  satisfied: z.boolean(),
  reason: z.string().min(1).max(4_000),
});
const WorkflowLoopVerdictSchema = z.strictObject({
  complete: z.boolean(),
  reason: z.string().min(1).max(4_000),
});

function extractJudgeJson(text: string): unknown | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|```\s*$/giu, '');
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through to bounded substring extraction */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

interface JudgeRunOptions {
  sessionId: string;
  requestId: string;
  manifestDigest: string;
  fullAccess: ResolvedRunManifest['fullAccess'];
  prompt: string;
  signal?: AbortSignal;
}

async function runRestrictedJudge(
  agentLoop: Pick<AgentLoop, 'run'>,
  options: JudgeRunOptions,
): Promise<unknown | undefined> {
  const verdictHash = createHash('sha256').update(`judge:${options.requestId}`, 'utf8').digest('hex');
  const result = await agentLoop.run({
    messages: [{ role: 'user', content: options.prompt }],
    maxTurns: 2,
    allowedTools: [],
    sessionId: options.sessionId,
    requestId: options.requestId.slice(0, 128),
    taskContractHash: verdictHash,
    promptStackHash: options.manifestDigest,
    resumeFromCheckpoint: false,
    // 受限来自空工具集与单轮上限；权限策略只有 full_access 一种合法形态。
    fullAccess: options.fullAccess,
    signal: options.signal,
  });
  if (result.status !== 'completed' || !result.finalText.trim()) return undefined;
  return extractJudgeJson(result.finalText);
}

function judgeJsonRules(shape: string): string {
  return [
    JUDGE_MARKER,
    'You are a strict Harness evaluation judge. You have no tools and must not claim side effects.',
    'Return exactly one JSON object and nothing else — no Markdown fences, no commentary.',
    `Use this exact shape: ${shape}`,
    'The reason must be one concise sentence grounded in the provided evidence.',
  ].join('\n');
}

function boundedJson(value: unknown, maxChars: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? 'null';
  } catch {
    return '"[unserializable]"';
  }
  return serialized.length <= maxChars ? serialized : `${serialized.slice(0, maxChars)}…[truncated]`;
}

function conditionJudgePrompt(input: {
  stepName: string;
  condition: string;
  dependencyOutputs: Readonly<Record<string, unknown>>;
}): string {
  return [
    judgeJsonRules('{"run": true, "reason": "<one sentence>"}'),
    '',
    'Decide whether the workflow step below must run in this pass.',
    `Step: ${input.stepName}`,
    `Authored execution condition:\n${input.condition}`,
    `Upstream outputs (context, not verified evidence): ${boundedJson(input.dependencyOutputs, 4_000)}`,
    'Set "run" to false only when the condition is clearly not met.',
  ].join('\n');
}

function completionJudgePrompt(input: {
  stepName: string;
  stopCondition: string;
  completionCriteria: readonly string[];
  outputText: string;
  stepIteration: number;
}): string {
  return [
    judgeJsonRules('{"satisfied": true, "reason": "<one sentence>"}'),
    '',
    `Judge whether iteration ${input.stepIteration} of workflow step "${input.stepName}" satisfies its stop condition.`,
    `Stop condition:\n${input.stopCondition || '(none authored — judge against the completion criteria)'}`,
    input.completionCriteria.length > 0
      ? `Completion criteria:\n- ${input.completionCriteria.join('\n- ')}`
      : '',
    `Step output under judgement:\n${input.outputText.slice(0, 6_000)}`,
    'Set "satisfied" to true only when the stop condition is genuinely met by this output.',
    // 清单式校验（2026-08-28 刘总定稿）：未满足时 reason 必须是编号缺陷清单
    // （每条对应一条未满足的完成标准），供修正轮逐项修复；只允许把"本步骤
    // 能力范围内可完成"的标准判为缺陷，依赖后续步骤（如文献检索）的条目
    // 不算本步骤缺陷。
    'When not satisfied, "reason" MUST be a numbered defect list (1. 2. 3.) covering every unmet criterion, and each defect must be achievable within THIS step\'s own capability — criteria that depend on later workflow steps (e.g. literature retrieval) do not count as defects here.',
  ].filter(Boolean).join('\n');
}

function workflowLoopJudgePrompt(input: {
  stopCondition: string;
  workflowIteration: number;
  steps: ReadonlyArray<{ stepId: string; status: string; output: unknown }>;
}): string {
  const summary = input.steps.map((step) => ({
    stepId: step.stepId,
    status: step.status,
    output: boundedJson(step.output, 1_500),
  }));
  return [
    judgeJsonRules('{"complete": true, "reason": "<one sentence>"}'),
    '',
    `Judge whether workflow iteration ${input.workflowIteration} as a whole satisfies its stop condition.`,
    `Workflow stop condition:\n${input.stopCondition}`,
    `Step results this iteration:\n${boundedJson(summary, 8_000)}`,
    'Set "complete" to true only when the stop condition is genuinely met; another full iteration is expensive.',
  ].join('\n');
}

function toolCallSummaries(
  result: { toolResults?: ReadonlyArray<{ toolName: string; status: 'ok' | 'error'; error?: string; metadata?: Record<string, unknown> }> },
): Array<{ toolName: string; status: 'ok' | 'error'; code: string | null }> {
  return (result.toolResults ?? []).slice(0, 1_000).map((tool) => ({
    toolName: tool.toolName.slice(0, 256),
    status: tool.status,
    code: tool.status === 'error'
      ? (typeof tool.metadata?.['code'] === 'string' ? tool.metadata['code'].slice(0, 128) : 'tool_error')
      : null,
  }));
}

export async function runPersistedScenarioWorkflow({
  agentLoop,
  agentLoopForModel,
  store,
  repository,
  sessionId,
  messages,
  requestId,
  manifest,
  mode = 'send',
  signal,
  pauseSignal,
  cancelSignal,
  liveSteering,
  projectId,
  researchRepository,
  literatureBridge,
  isCurrentRuntime,
  hookApproval,
  hookEvent,
}: RunPersistedScenarioWorkflowOptions): Promise<AgentResponse> {
  const turnId = safeTurnId(requestId);
  const userMessage = latestUserMessage(messages);
  console.log(`[ScenarioRun] start: session=${sessionId.slice(0, 40)} manifestSession=${manifest.sessionId.slice(0, 40)} workflow=${manifest.workflow.length} hooks=${manifest.hooks?.length ?? 0}`);
  if (!sessionId.trim()) return createChatTurnErrorResponse(turnId, 'error', 'invalid_session');
  if (!userMessage) return createChatTurnErrorResponse(turnId, 'error', 'missing_user_message');
  if (manifest.sessionId !== sessionId.replace(/:/gu, '-')) {
    console.warn('[ScenarioRun] rejected: scenario_session_mismatch');
    return createChatTurnErrorResponse(turnId, 'error', 'scenario_session_mismatch');
  }
  const preflight = preflightScenarioExecution(manifest);
  if (!preflight.ok) {
    console.warn('[ScenarioRun] rejected:', preflight.code);
    return createChatTurnErrorResponse(
      turnId,
      'error',
      preflight.code,
    );
  }
  if (!preflight.useCoordinator || manifest.workflow.length === 0) {
    console.warn('[ScenarioRun] rejected: scenario_execution_manifest_uncompiled');
    return createChatTurnErrorResponse(turnId, 'error', 'scenario_execution_manifest_uncompiled');
  }
  const executionOrder = resolveScenarioExecutionOrder(manifest);
  if (!executionOrder) {
    console.warn('[ScenarioRun] rejected: scenario_workflow_invalid (dag); workflow=', JSON.stringify(manifest.workflow).slice(0, 500), '; output.plan=', JSON.stringify(manifest.output?.plan ?? null).slice(0, 120));
    return createChatTurnErrorResponse(turnId, 'error', 'scenario_workflow_invalid');
  }
  const dependencyIds = new Set(manifest.workflow.flatMap((step) => step.dependsOn));
  const terminalStepIds = manifest.workflow
    .filter((step) => !dependencyIds.has(step.id))
    .map((step) => step.id);
  if (manifest.output.plan && terminalStepIds.length !== 1) {
    return createChatTurnErrorResponse(turnId, 'error', 'scenario_output_step_ambiguous');
  }
  const configuredFinalStepId = manifest.output.plan
    ? terminalStepIds[0]
    : executionOrder.at(-1);

  if (!store.getSession(sessionId)) store.createSession(sessionId);
  if (mode === 'send') store.appendMessage(sessionId, 'user', userMessage.content);

  const runId = `scenario-${turnId}`;
  const scenarioHooks = hooksFromManifest(manifest);
  notifyScenarioRunEvent(scenarioHooks, 'run_start', { runId, onHookEvent: hookEvent });
  const runtimeHookBridge = scenarioRuntimeHookBridge({
    hooks: scenarioHooks,
    runId,
    // 无审批通道时 fail closed：approval 钩子拒绝/异常 → pause 指令。
    onApprovalRequired: hookApproval ?? (() => false),
    onHookEvent: hookEvent,
  });
  // 步骤卡「指导重做」（2026-09-01 刘总方案二期）：从恢复记录里取未消费的
  // 用户指导，executor 在执行对应步骤时注入并消费。声明在 coordinator 之前、
  // 填充在 start/resume 之前——executor 闭包读到的永远是最新内容。
  const activeStepDirectives = new Map<string, string>();
  const coordinator = new ScenarioRunCoordinator({
    onCheckpoint: (record) => {
      // 步骤卡指导（2026-09-01 刘总方案二期）：目标步完成后把指令标记为已消费，
      // 防止后续重跑误用旧指导（执行器内存同步删除，这里是持久层兜底）。
      if (record.pendingDirectives?.length) {
        const completedSteps = new Set(record.steps.filter((step) => step.status === 'completed').map((step) => step.stepId));
        record.pendingDirectives = record.pendingDirectives.map((entry) => (
          completedSteps.has(entry.stepId) && entry.consumedAt === null
            ? { ...entry, consumedAt: Date.now() }
            : entry
        ));
      }
      try {
        repository.saveScenarioRunRecord(record);
      } catch (error) {
        // 检查点落库失败是运行秒败的头号嫌疑，必须留下证据（保持 fail-closed 语义）。
        console.warn('[ScenarioRun] checkpoint save failed:', error instanceof Error ? `${error.message}` : error);
        throw error;
      }
    },
    onCheckpointSaved: () => {
      emitScenarioHookEvent(scenarioHooks, 'checkpoint_saved', { runId, onHookEvent: hookEvent });
    },
    onRuntimeEvent: (event) => runtimeHookBridge(event),
    evaluateStepCondition: manifest.workflow.some((step) => step.condition)
      ? async ({ step, dependencyOutputs }) => {
          const verdict = ConditionVerdictSchema.safeParse(await runRestrictedJudge(agentLoop, {
            sessionId,
            requestId: `${turnId}-${step.id}-condition`,
            manifestDigest: manifest.manifestDigest,
            fullAccess: manifest.fullAccess,
            prompt: conditionJudgePrompt({
              stepName: step.name,
              condition: step.condition ?? '',
              dependencyOutputs,
            }),
            signal,
          }));
          if (!verdict.success) throw new Error('Condition judge returned an invalid verdict');
          return verdict.data;
        }
      : undefined,
    evaluateWorkflowLoop: manifest.workflowLoop?.enabled
      ? async ({ record, stopCondition }) => {
          const verdict = WorkflowLoopVerdictSchema.safeParse(await runRestrictedJudge(agentLoop, {
            sessionId,
            requestId: `${turnId}-workflow-loop-${record.workflowIteration}`,
            manifestDigest: manifest.manifestDigest,
            fullAccess: manifest.fullAccess,
            prompt: workflowLoopJudgePrompt({
              stopCondition,
              workflowIteration: record.workflowIteration,
              steps: record.steps.map((step) => ({
                stepId: step.stepId,
                status: step.status,
                output: step.output,
              })),
            }),
            signal,
          }));
          return verdict.success
            ? verdict.data
            : { complete: false, reason: 'Workflow stop-condition judge returned an invalid verdict' };
        }
      : undefined,
    executor: scenarioHookExecutor(async (input) => {
      const memoryContext = scenarioMemoryContext(manifest, input.step, repository);
      const finalOutputPlan = input.step.id === configuredFinalStepId
        ? manifest.output.plan ?? undefined
        : undefined;
      // 指导消费（2026-09-01 二期）：该步有待执行指导则取出使用（取出即消费，
      // loop 迭代不重复注入；checkpoint 侧再标记 consumedAt 持久化）。
      const userDirective = activeStepDirectives.get(input.step.id);
      if (userDirective !== undefined) {
        activeStepDirectives.delete(input.step.id);
        console.log(`[ScenarioRun] step directive consumed for ${input.step.id}: ${userDirective.slice(0, 80)}`);
      }
      const stepMessages: ChatMessage[] = [
        ...messages,
        { role: 'user', content: stepInstruction(input, memoryContext, finalOutputPlan, userDirective) },
      ];
      const stepAgentLoop = input.step.agentModelPreference && agentLoopForModel
        ? agentLoopForModel(input.step.agentModelPreference)
        : agentLoop;
      const retryLimit = input.step.retryLimit ?? 0;
      // 分页交付（2026-08-31 机制修正，替代此前的"解码纠偏 2 次"）：模型输出
      // 上限（生产实测 Qwen3.5-122B maxOutputTokens=16,384 ≈ 2.6 万汉字）物理
      // 装不下"整篇定稿 + 6 个 supporting + 8 条 quality"的一次性响应——上轮
      // 失败实证正文在第三部分被截断。最终步骤因此按页交付：每页尽力交付、
      // 代码跨页合并（CONTINUED 追加），只补缺失条目；连续 2 页无进展或超过
      // 8 页才诚实判死。执行类失败（非 completed）仍按 step.retryLimit 计。
      const maxDeliveryPages = finalOutputPlan ? 8 : 0;
      // 检索步骤运行期兜底（2026-09-01 刘总报告：老场景跑完文献库仍为空）。
      // 编译纪律只约束新编译的场景；存量场景的检索步骤 toolIds 为空，模型
      // 裸写凭记忆编造文献，文献桥无真实题录可入库。这里在执行侧判定检索类
      // 步骤并动态注入真实检索工具与题录纪律，不依赖场景重新编译。
      const wantsLiteratureTools = isLiteratureSearchStep(input.step);
      const effectiveToolIds: string[] | undefined = wantsLiteratureTools && (input.step.toolIds ?? []).length === 0
        ? [...LITERATURE_SEARCH_TOOL_IDS]
        : input.step.toolIds;
      const literatureDiscipline = wantsLiteratureTools && (input.step.toolIds ?? []).length === 0
        ? LITERATURE_TOOL_DISCIPLINE
        : '';
      let lastResult: Awaited<ReturnType<typeof stepAgentLoop.run>> | undefined;
      let outputBundle: ScenarioOutputBundle | undefined;
      let outputBundleError: string | undefined;
      let carriedReport: SectionedParseReport | undefined;
      let deliveryPages = 0;
      let noProgressPages = 0;
      let lastCoverage = -1;
      let execFailures = 0;
      for (;;) {
        const isFirstDelivery = deliveryPages === 0 && execFailures === 0 && !outputBundleError;
        const attemptMessages = isFirstDelivery
          ? stepMessages
          : [
              ...stepMessages,
              {
                role: 'user' as const,
                content: deliveryContinuationMessage(finalOutputPlan!, carriedReport, outputBundleError),
              },
            ];
        lastResult = await stepAgentLoop.run({
          messages: attemptMessages,
          maxTurns: input.step.maxTurns,
          allowedTools: effectiveToolIds,
          sessionId,
          requestId: `${turnId}-${input.step.id}-p${deliveryPages + execFailures + 1}`.slice(0, 128),
          taskContractHash: input.executionKey,
          promptStackHash: input.manifestDigest,
          resumeFromCheckpoint: false,
          skillPrompt: `${composeManifestSystemPrompt(manifest, input.step)}${literatureDiscipline}`,
          fullAccess: manifest.fullAccess,
          signal,
          liveSteering,
          projectId,
        });
        if (lastResult.status === 'completed' && lastResult.finalVerified && lastResult.finalText.trim()) {
          if (!finalOutputPlan) break;
          // 严格 JSON 直通（整包一次成功时无需进入分段合并）；失败则按分段
          // 格式解析并跨页合并，组包后仍走原严格校验。
          const strictDecoded = decodeScenarioOutputBundle(lastResult.finalText, finalOutputPlan);
          if (strictDecoded.ok) {
            outputBundle = strictDecoded.bundle;
            break;
          }
          const report = parseScenarioSectionedOutput(lastResult.finalText, finalOutputPlan);
          if (report) {
            carriedReport = carriedReport ? mergeSectionedParseReports(carriedReport, report) : report;
            const assembled = bundleFromSectionedReport(carriedReport, finalOutputPlan);
            if (assembled.ok) {
              outputBundle = assembled.bundle;
              break;
            }
            const coverage = (carriedReport.primary ? 1 : 0)
              + carriedReport.supporting.size + carriedReport.quality.size;
            const madeProgress = coverage > lastCoverage;
            lastCoverage = Math.max(lastCoverage, coverage);
            noProgressPages = madeProgress ? 0 : noProgressPages + 1;
            outputBundleError = assembled.detail ? `${assembled.code}: ${assembled.detail}` : assembled.code;
          } else {
            outputBundleError = strictDecoded.code;
            noProgressPages += 1;
          }
          deliveryPages += 1;
          if (deliveryPages >= maxDeliveryPages || noProgressPages >= 2) break;
          continue;
        }
        if (signal?.aborted || lastResult.status === 'interrupted' || lastResult.status === 'cancelled') break;
        execFailures += 1;
        if (execFailures > retryLimit) break;
      }
      if (!lastResult || lastResult.status !== 'completed' || !lastResult.finalVerified || !lastResult.finalText.trim()) {
        // 无痕失败禁令（2026-08-31）：AgentRunResult.errors 携带 provider 底层
        // 错误（如上下文超限的 Provider error 400），必须透出到日志与步骤失败
        // 消息。2026-08-31 事故：上下文超窗被 API 秒拒，错误文本在此被吞，
        // 只剩一句笼统文案，无法定位。
        const cause = (lastResult?.errors ?? []).filter(Boolean).join(' | ').slice(0, 500);
        if (cause) console.warn('[ScenarioRun] step execution failed:', cause);
        return {
          ok: false,
          code: resultFailureCode(lastResult?.status ?? 'error'),
          message: `The workflow step did not produce a complete validated response${cause ? ` (${cause})` : ''}`,
        };
      }
      if (finalOutputPlan && !outputBundle) {
        return {
          ok: false,
          code: 'output_bundle_invalid',
          message: `The final workflow output did not match the configured output plan (${outputBundleError ?? 'invalid_shape'})`,
        };
      }
      let text = lastResult.finalText;
      let stepBrief: ScenarioStepBrief | null = null;
      let artifactRefs: Array<{ id: string; version: number; contentDigest: string }> = [];
      if (outputBundle) {
        const artifacts = artifactRecordsForBundle(input, outputBundle, sessionId);
        try {
          store.createArtifacts(artifacts.records);
        } catch (persistError) {
          // 无痕失败禁令（2026-08-31）：底层冲突原因（如 id 撞车）必须进日志
          // 与错误消息，不能只落一句笼统文案。
          const detail = persistError instanceof Error ? persistError.message : String(persistError);
          console.warn('[ScenarioRun] bundle artifact persistence failed:', detail);
          return {
            ok: false,
            code: 'artifact_persistence_failed',
            message: `The output bundle could not be persisted as reusable artifacts (${detail})`,
          };
        }
        // 研究成果页双写（刘总问题 E）：镜像进项目级 research_artifacts。
        // 镜像失败不阻断运行（会话产物已落库），但原因必须进日志。
        for (const record of artifacts.records) {
          try {
            mirrorScenarioArtifactToResearch({
              researchRepository,
              projectId,
              artifact: { id: record.id, name: record.name, content: record.content },
              scenarioId: manifest.scenarioId,
              runId,
              role: typeof record.metadata?.role === 'string' ? record.metadata.role : 'supporting',
            });
          } catch (mirrorError) {
            console.warn('[ScenarioRun] research mirror failed:', mirrorError instanceof Error ? mirrorError.message : mirrorError);
          }
          await runLiteratureBridge({
            literatureBridge,
            projectId,
            artifactId: record.id,
            content: record.content,
            runId,
            stepId: input.step.id,
          });
        }
        text = outputBundle.primary.content;
        artifactRefs = artifacts.refs;
      } else {
        // 步骤卡摘要（2026-09-01 一期）：非交付包步骤从输出里提取并剥离
        // <step_brief> 汇报块——摘要进聊天卡，剥离后的正文才落生成物。
        const stripped = extractStepBrief(text);
        text = stripped.text;
        stepBrief = stripped.brief;
      }
      const output = {
        stepId: input.step.id,
        text,
        turnsUsed: lastResult.turnsUsed,
        ...(stepBrief ? { brief: stepBrief } : {}),
      };
      // 过程产物文档化（2026-08-29 刘总要求，架构修正）：步骤全文注册为会话
      // 生成物（右侧「生成物」面板可查看/预览/复用），聊天里只落一条摘要指引。
      // 此前把全文塞进聊天流：上下文压缩时关键过程内容被丢弃、过程产物未
      // 文件化不利于后续调用。步骤间数据传递仍走 checkpoint 的 output，
      // 与聊天展示无关，本改动不影响后续步骤的输入。
      let stepArtifactName = '';
      try {
        const contentDigest = artifactContentDigest(text);
        const idDigest = createHash('sha256')
          .update(`${input.runId}\u0000${input.step.id}\u0000process\u0000${input.stepIteration ?? 1}`, 'utf8')
          .digest('hex');
        const artifactId = `scenario-artifact-${idDigest.slice(0, 40)}`;
        stepArtifactName = artifactName(`${input.step.name || input.step.id} 过程产出`, `step-${input.step.id}-process`);
        store.createArtifacts([{
          id: artifactId,
          sessionId,
          name: stepArtifactName,
          type: 'md',
          size: `${Buffer.byteLength(text, 'utf8')} B`,
          content: text,
          metadata: {
            kind: 'scenario_process',
            role: 'process',
            runId: input.runId,
            stepId: input.step.id,
            manifestDigest: input.manifestDigest,
            contentDigest,
          },
        }]);
        mirrorScenarioArtifactToResearch({
          researchRepository,
          projectId,
          artifact: { id: artifactId, name: stepArtifactName, content: text },
          scenarioId: manifest.scenarioId,
          runId,
          role: 'process',
        });
        await runLiteratureBridge({
          literatureBridge,
          projectId,
          artifactId,
          content: text,
          runId,
          stepId: input.step.id,
        });
      } catch (persistError) {
        console.warn('[ScenarioRun] step artifact persistence failed:', persistError instanceof Error ? persistError.message : persistError);
      }
      // 步骤卡（2026-09-01 刘总方案一期）：聊天里不再是干巴巴的"完成✓"，而
      // 是思路/结果/下一步摘要 + 可交互卡片（指导重做/跳过），全文仍在生成物。
      try {
        const card: ScenarioStepCardPayload = {
          v: 1,
          runId,
          sessionId,
          stepId: input.step.id,
          stepName: input.step.name || input.step.id,
          iteration: input.stepIteration ?? 1,
          status: 'completed',
          brief: stepBrief,
          artifactName: stepArtifactName || '(生成物注册失败)',
          chars: Buffer.byteLength(text, 'utf8'),
          scenarioId: manifest.scenarioId,
        };
        store.appendMessage(sessionId, 'assistant', stepCardMessageText(card), { metadata: { stepCard: card } });
      } catch (persistError) {
        console.warn('[ScenarioRun] step summary persistence failed:', persistError instanceof Error ? persistError.message : persistError);
      }
      let completionAssessment: { satisfied: boolean; reason: string } | undefined;
      // Every authored completion standard is a real state-machine gate.  A
      // hidden system loop is synthesized by ScenarioRunCoordinator whenever
      // a step has criteria but no explicit legacy loop policy.
      if ((input.step.completionCriteria?.length ?? 0) > 0 || input.step.loop?.enabled) {
        if (input.step.loop?.enabled && input.step.loop.evaluator === 'manual') {
          // 人工评估复用审批通道；无通道或通道异常都 fail closed 为“未满足”，由耗尽策略接管。
          let approved = false;
          let channelFailed = false;
          if (hookApproval) {
            try {
              approved = await hookApproval({
                hookId: `manual-loop-${input.step.id}`,
                stepId: input.step.id,
                instruction: `Step "${input.step.name}" iteration ${input.stepIteration ?? 1} awaits manual review. Stop condition: ${input.step.loop.stopCondition || '(none)'}. Approve to stop the loop.`,
                runId,
              }) === true;
            } catch {
              channelFailed = true;
            }
          }
          completionAssessment = {
            satisfied: approved,
            reason: !hookApproval
              ? 'Manual evaluation requires a user approval channel'
              : channelFailed
                ? 'Manual review channel failed closed'
                : approved
                  ? 'Approved by manual review'
                  : 'Manual review requested another iteration',
          };
        } else {
          const verdict = CompletionVerdictSchema.safeParse(await runRestrictedJudge(agentLoop, {
            sessionId,
            requestId: `${turnId}-${input.step.id}-loop-${input.stepIteration ?? 1}`,
            manifestDigest: input.manifestDigest,
            fullAccess: manifest.fullAccess,
            prompt: completionJudgePrompt({
              stepName: input.step.name,
              stopCondition: input.step.loop?.stopCondition
                ?? input.step.completionCriteria?.join('\n')
                ?? '',
              completionCriteria: input.step.completionCriteria ?? [],
              outputText: text,
              stepIteration: input.stepIteration ?? 1,
            }),
            signal,
          }));
          completionAssessment = verdict.success
            ? verdict.data
            : { satisfied: false, reason: 'Completion judge returned an invalid verdict' };
        }
      }
      const includeToolSummary = manifest.checkpointPolicy?.includeToolCallSummary !== false;
      const toolCallSummary = includeToolSummary ? toolCallSummaries(lastResult) : undefined;
      return {
        ok: true,
        output,
        outputDigest: digestScenarioStepOutput(output),
        artifactRefs,
        completionAssessment,
        toolCallSummary,
      };
    }, {
      hooks: scenarioHooks,
      runId,
      // 无审批通道时 fail closed：带 approval 钩子的步骤不能静默放行。
      onApprovalRequired: hookApproval ?? (() => false),
      onHookEvent: hookEvent,
    }),
  });

  const recoverable = repository.getRecoverableScenarioRun(manifest.sessionId);
  // 指导注入（2026-09-01 二期）：恢复记录携带的未消费指导进内存表，executor
  // 执行对应步骤时消费（同时删除 + checkpoint 标记 consumedAt 双保险）。
  for (const entry of recoverable?.pendingDirectives ?? []) {
    if (entry.consumedAt === null && entry.guidance.trim()) activeStepDirectives.set(entry.stepId, entry.guidance);
  }
  if (activeStepDirectives.size > 0) {
    console.log(`[ScenarioRun] step directives pending: ${JSON.stringify([...activeStepDirectives.keys()])}`);
  }
  const runResult = recoverable?.manifestDigest === manifest.manifestDigest
    ? await (async () => {
        // 恢复前归并同会话的其他活跃断点（2026-08-30 刘总报告：堆积的
        // 竞争记录会让「继续」选中空断点从头重跑）。取 progress 最深的
        // 记录恢复，其余终止为 cancelled。
        try {
          const superseded = repository.supersedeOtherScenarioRuns(manifest.sessionId, recoverable.runId, manifest.scenarioId);
          if (superseded > 0) console.log(`[ScenarioRun] superseded ${superseded} competing run(s) in session ${manifest.sessionId}`);
        } catch { /* 归并失败不阻塞恢复本身 */ }
        return coordinator.resume(recoverable, { signal, pauseSignal, cancelSignal });
      })()
    : await (async () => {
        try {
          const superseded = repository.supersedeOtherScenarioRuns(manifest.sessionId, runId, manifest.scenarioId);
          if (superseded > 0) console.log(`[ScenarioRun] superseded ${superseded} stale run(s) before starting ${runId}`);
        } catch { /* 归并失败不阻塞新开轮 */ }
        return coordinator.start({ runId, manifest, signal, pauseSignal, cancelSignal });
      })();
  notifyScenarioRunEvent(scenarioHooks, 'run_end', { runId, onHookEvent: hookEvent });

  if (!runResult.ok) {
    // 静默失败会让“运行秒败”完全无法诊断（2026-08-29 刘总要求排查）。
    console.warn(`[ScenarioRun] failed: code=${runResult.code} runId=${runId} issues=${JSON.stringify((runResult.issues ?? []).slice(0, 6))}`);
    return createChatTurnErrorResponse(turnId, 'error', `scenario_${runResult.code}`);
  }
  // ── 整轮归档机制（2026-08-30 刘总批评后的机制级修正）──
  // 此前只有步骤级消息改为「生成物+摘要」，而整轮结束时 answer 全文仍然
  // 直接写进聊天（completed），中断/暂停/失败时更是什么都不落库、几万字
  // 只活在渲染层内存里（刷新即失）。现在所有出口统一：
  //   产出全文 → 生成物（右侧「生成物」面板，可预览/复用）
  //   聊天流   → 一条摘要/状态指引
  const scenarioName = repository.get(manifest.scenarioId)?.name?.trim() || manifest.scenarioId;
  const persistTurnFinalArtifact = (content: string, suffix: string, fallbackName: string): { name: string; id: string } | null => {
    try {
      const contentDigest = artifactContentDigest(content);
      const idDigest = createHash('sha256')
        .update(`${runId}\u0000final\u0000${suffix}`, 'utf8')
        .digest('hex');
      const artifactId = `scenario-artifact-${idDigest.slice(0, 40)}`;
      const artifactNameFinal = artifactName(`${scenarioName} ${fallbackName}`, `final-${suffix}`);
      store.createArtifacts([{
        id: artifactId,
        sessionId,
        name: artifactNameFinal,
        type: 'md',
        size: `${Buffer.byteLength(content, 'utf8')} B`,
        content,
        metadata: {
          kind: 'scenario_output',
          role: 'final',
          runId,
          manifestDigest: manifest.manifestDigest,
          contentDigest,
        },
      }]);
      mirrorScenarioArtifactToResearch({
        researchRepository,
        projectId,
        artifact: { id: artifactId, name: artifactNameFinal, content },
        scenarioId: manifest.scenarioId,
        runId,
        role: 'final',
      });
      return { name: artifactNameFinal, id: artifactId };
    } catch (persistError) {
      console.warn('[ScenarioRun] final artifact persistence failed:', persistError instanceof Error ? persistError.message : persistError);
      return null;
    }
  };
  const countCompletedSteps = runResult.ok
    ? runResult.record.steps.filter((step) => step.status === 'completed').length
    : 0;
  const totalSteps = runResult.ok ? runResult.record.executionOrder.length : 0;

  // Public control outcomes are first-class responses: paused keeps the
  // checkpoint resumable, cancelled is terminal and persists as such.
  if (runResult.record.status === 'cancelled') {
    return createChatTurnErrorResponse(turnId, 'cancelled', 'scenario_run_cancelled');
  }
  if (runResult.record.status === 'paused') {
    const pausedMessage = countCompletedSteps > 0
      ? `【场景工作流已暂停】已完成 ${countCompletedSteps}/${totalSteps} 步；各步产出已存为生成物（右侧「生成物」面板可查看），发送「继续」将从断点恢复。`
      : `【场景工作流已暂停】本轮尚未完成任何步骤（没有可恢复的断点）；重新发送指令将重新开始推进。`;
    try { store.appendMessage(sessionId, 'assistant', pausedMessage); } catch { /* 摘要落库失败不阻塞 turn 返回 */ }
    return createChatTurnErrorResponse(turnId, 'interrupted', 'scenario_run_paused');
  }
  if (runResult.record.status === 'interrupted') {
    const interruptedMessage = countCompletedSteps > 0
      ? `【场景工作流已中断】已完成 ${countCompletedSteps}/${totalSteps} 步；已完成步骤的产出已存为生成物（右侧「生成物」面板可查看），发送「继续」即可从断点继续。`
      : `【场景工作流已中断】本轮尚未完成任何步骤（没有可恢复的断点）；重新发送指令将重新开始推进。`;
    try { store.appendMessage(sessionId, 'assistant', interruptedMessage); } catch { /* 摘要落库失败不阻塞 turn 返回 */ }
    return createChatTurnErrorResponse(turnId, 'interrupted', 'agent_interrupted');
  }
  if (runResult.record.status !== 'completed') {
    // 无痕失败禁令：run 级失败（区别于 coordinator 拒绝）此前完全不打日志。
    const failedStepIds = runResult.record.steps.filter((step) => step.status === 'failed').map((step) => step.stepId);
    console.warn(`[ScenarioRun] run ended with status=${runResult.record.status} runId=${runId} failedSteps=${JSON.stringify(failedStepIds)} reasons=${JSON.stringify(runResult.record.steps.filter((step) => step.status === 'failed').map((step) => `${step.stepId}:${step.errorCode ?? 'unknown'}:${step.errorMessage ?? ''}`.slice(0, 300)))}`);
    const failedMessage = countCompletedSteps > 0
      ? `【场景工作流执行失败】已完成 ${countCompletedSteps}/${totalSteps} 步；已完成步骤的产出已存为生成物（右侧「生成物」面板可查看），可重新发送指令继续推进。`
      : `【场景工作流执行失败】本轮尚未完成任何步骤；请检查模型连接或指令后重新发送。`;
    try { store.appendMessage(sessionId, 'assistant', failedMessage); } catch { /* 摘要落库失败不阻塞 turn 返回 */ }
    return createChatTurnErrorResponse(turnId, 'error', 'scenario_workflow_failed');
  }
  if (isCurrentRuntime && !isCurrentRuntime()) {
    return createChatTurnErrorResponse(turnId, 'cancelled', 'runtime_reconfigured');
  }

  const finalStepId = runResult.record.executionOrder.at(-1);
  const finalStep = runResult.record.steps.find((step) => step.stepId === finalStepId);
  const output = finalStep?.output;
  const answer = typeof output === 'object' && output !== null && 'text' in output
    && typeof output.text === 'string'
    ? output.text
    : '';
  if (!answer.trim()) return createChatTurnErrorResponse(turnId, 'error', 'scenario_output_missing');

  if (mode === 'regenerate') store.truncateMessagesAfterLastUser(sessionId);
  // 最终成果文档化：answer 全文注册为生成物，聊天只落摘要指引——
  // 几万字的最终交付物不再整段出现在聊天记录里。
  const finalArtifact = persistTurnFinalArtifact(answer, 'deliverable', '最终成果');
  if (finalArtifact) {
    await runLiteratureBridge({
      literatureBridge,
      projectId,
      artifactId: finalArtifact.id,
      content: answer,
      runId,
    });
  }
  const finalArtifactName = finalArtifact?.name ?? '';
  const finalCard: ScenarioStepCardPayload = {
    v: 1,
    runId,
    sessionId,
    stepId: finalStepId ?? 'final',
    stepName: `${scenarioName} · 最终成果`,
    iteration: runResult.record.workflowIteration,
    status: 'final',
    brief: typeof output === 'object' && output !== null && 'brief' in output
      ? ((output as { brief?: ScenarioStepBrief }).brief ?? null)
      : null,
    artifactName: finalArtifactName || '(生成物注册失败)',
    chars: Buffer.byteLength(answer, 'utf8'),
    scenarioId: manifest.scenarioId,
  };
  const completedMessageText = finalArtifactName
    ? `场景工作流已完成。最终成果（约 ${finalCard.chars.toLocaleString('en-US')} 字符）已保存为生成物「${finalArtifactName}」${projectId ? '，并自动写入本项目成果库（科研产出分类）' : ''}。`
    : '场景工作流已完成。最终成果已生成（生成物注册失败，请检查存储）。';
  try {
    store.appendMessage(sessionId, 'assistant', completedMessageText, { metadata: { stepCard: finalCard } });
  } catch { /* 摘要落库失败不阻塞 turn 返回 */ }
  return AgentResponseSchema.parse({
    version: CHAT_RUNTIME_CONTRACT_VERSION,
    turnId,
    status: 'completed',
    answer,
    diagnostics: [],
    citations: [],
    events: [],
  });
}
