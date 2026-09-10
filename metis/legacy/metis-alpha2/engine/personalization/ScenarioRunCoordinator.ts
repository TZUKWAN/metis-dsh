import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ResolvedRunManifestSchema,
  ResolvedWorkflowStepSchema,
  type ResolvedRunManifest,
} from '../runtime/PersonalizationRuntimeContract.js';

const RUN_RECORD_VERSION = 1 as const;
const MAX_STEP_OUTPUT_CHARS = 2_000_000;
// Completion standards are not optional at runtime: when a user authored
// criteria but did not expose a Loop configuration, the Harness supplies one
// internal repair pass. 语义（2026-08-28 刘总定稿）：第 1 轮产出后校验一次并
// 生成完整缺陷清单，第 2 轮按清单逐项修正，然后无论是否完全达标都结束该
// 步骤（未达标项保留在 errorCode/errorMessage 中供用户查看）。世界上没有
// 完美的产出：不允许"重跑→不过→再重跑"的永动机，也不允许无限打磨。
const SYSTEM_COMPLETION_MAX_ITERATIONS = 2;
const SYSTEM_FAILURE_RETRY_LIMIT = 2;

const SafeRunIdSchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
// eslint-disable-next-line no-control-regex -- runtime records intentionally reject C0/C1 text
const UNSAFE_RECORD_TEXT = new RegExp('[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]', 'u');
const SafeRecordTextSchema = z.string().max(4_000).refine(
  (value) => !UNSAFE_RECORD_TEXT.test(value),
  'Record text contains control characters',
);

const ArtifactReferenceSchema = z.strictObject({
  id: z.string().min(1).max(256),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contentDigest: DigestSchema,
});

const ToolCallSummarySchema = z.strictObject({
  toolName: z.string().min(1).max(256),
  status: z.enum(['ok', 'error']),
  code: z.string().min(1).max(128).nullable(),
});

const CompletionAssessmentSchema = z.strictObject({
  satisfied: z.boolean(),
  reason: SafeRecordTextSchema,
});

const ScenarioStepExecutionSuccessSchema = z.strictObject({
  ok: z.literal(true),
  output: z.unknown(),
  outputDigest: DigestSchema,
  artifactRefs: z.array(ArtifactReferenceSchema).max(256),
  completionAssessment: CompletionAssessmentSchema.optional(),
  toolCallSummary: z.array(ToolCallSummarySchema).max(1_000).optional(),
});

const ScenarioStepExecutionFailureSchema = z.strictObject({
  ok: z.literal(false),
  code: z.string().min(1).max(128).regex(/^[a-z][a-z0-9_]*$/u),
  message: SafeRecordTextSchema,
});

export const ScenarioStepExecutionResultSchema = z.discriminatedUnion('ok', [
  ScenarioStepExecutionSuccessSchema,
  ScenarioStepExecutionFailureSchema,
]);

export type ScenarioStepExecutionResult = z.infer<typeof ScenarioStepExecutionResultSchema>;
export type ScenarioArtifactReference = z.infer<typeof ArtifactReferenceSchema>;

const ScenarioStepRunRecordSchema = z.strictObject({
  stepId: z.string().min(1).max(160),
  executionKey: DigestSchema,
  stepSnapshot: ResolvedWorkflowStepSchema,
  stepSnapshotDigest: DigestSchema,
  status: z.enum(['pending', 'running', 'completed', 'failed', 'blocked', 'skipped']),
  startedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  completedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  output: z.unknown().nullable(),
  outputDigest: DigestSchema.nullable(),
  artifactRefs: z.array(ArtifactReferenceSchema).max(256),
  errorCode: z.string().min(1).max(128).regex(/^[a-z][a-z0-9_]*$/u).nullable(),
  errorMessage: SafeRecordTextSchema.nullable(),
  activeExecutionKey: DigestSchema.nullable().default(null),
  attempts: z.number().int().min(0).max(10_000).default(0),
  loopIteration: z.number().int().min(0).max(100).default(0),
  validationHistory: z.array(z.strictObject({
    workflowIteration: z.number().int().min(1).max(100),
    stepIteration: z.number().int().min(1).max(100),
    satisfied: z.boolean(),
    reason: SafeRecordTextSchema,
    occurredAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })).max(10_000).default([]),
  toolCallSummary: z.array(ToolCallSummarySchema).max(10_000).default([]),
});

export const ScenarioRunRecordSchema = z.strictObject({
  recordVersion: z.literal(RUN_RECORD_VERSION),
  runId: SafeRunIdSchema,
  manifestSnapshot: ResolvedRunManifestSchema,
  manifestDigest: DigestSchema,
  // Public lifecycle contract: `paused` is a durable, resumable checkpoint state;
  // `cancelled` is terminal and can never be resumed or revived by late results.
  status: z.enum(['running', 'completed', 'failed', 'interrupted', 'paused', 'cancelled']),
  startedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  completedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  executionOrder: z.array(z.string().min(1).max(160)).max(128),
  steps: z.array(ScenarioStepRunRecordSchema).max(128),
  failureStepIds: z.array(z.string().min(1).max(160)).max(128),
  workflowIteration: z.number().int().min(1).max(100).default(1),
  workflowIterationsCompleted: z.number().int().min(0).max(100).default(0),
  totalStepExecutions: z.number().int().min(0).max(10_000).default(0),
  backtrackCount: z.number().int().min(0).max(10_000).default(0),
  /**
   * 步骤卡「指导重做」的待执行指令（2026-09-01 刘总方案二期）：stepControl
   * 把用户对某一步的指导写进记录后恢复运行；执行器消费该步的指导后，在
   * checkpoint 回调里标记 consumedAt，避免后续重跑误用旧指导。
   */
  pendingDirectives: z.array(z.strictObject({
    stepId: z.string().min(1).max(160),
    guidance: SafeRecordTextSchema,
    issuedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    consumedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().default(null),
  })).max(64).optional(),
});

export type ScenarioRunRecord = z.infer<typeof ScenarioRunRecordSchema>;
export type ScenarioStepRunRecord = z.infer<typeof ScenarioStepRunRecordSchema>;

export interface ScenarioStepExecutionInput {
  runId: string;
  executionKey: string;
  sessionId: string;
  projectId: string;
  scenarioId: string;
  manifestDigest: string;
  step: ScenarioStepRunRecord['stepSnapshot'];
  dependencyOutputs: Readonly<Record<string, unknown>>;
  workflowIteration?: number;
  stepIteration?: number;
  attempt?: number;
  previousIterationOutput?: unknown;
  runtimeInstruction?: string;
  signal?: AbortSignal;
}

export type ScenarioStepExecutor = (
  input: ScenarioStepExecutionInput,
) => Promise<unknown>;

export interface StartScenarioRunRequest {
  runId: string;
  manifest: ResolvedRunManifest;
  signal?: AbortSignal;
  /** Cooperative pause: persists a durable `paused` checkpoint that a later resume() continues. */
  pauseSignal?: AbortSignal;
  /** Terminal cancellation: persists a `cancelled` record; late executor results cannot revive it. */
  cancelSignal?: AbortSignal;
}

/** Control signals accepted by start()/resume(); every one is checked at step boundaries. */
export interface ScenarioRunControlSignals {
  signal?: AbortSignal;
  pauseSignal?: AbortSignal;
  cancelSignal?: AbortSignal;
}

export interface ScenarioRunCoordinatorOptions {
  executor: ScenarioStepExecutor;
  now?: () => number;
  /** Durable, synchronous checkpoint sink invoked before and after every side-effecting step. */
  onCheckpoint?: (record: ScenarioRunRecord) => void;
  onCheckpointSaved?: (record: ScenarioRunRecord) => void;
  evaluateStepCondition?: (input: {
    record: ScenarioRunRecord;
    step: ScenarioStepRunRecord['stepSnapshot'];
    dependencyOutputs: Readonly<Record<string, unknown>>;
  }) => Promise<{ run: boolean; reason: string }>;
  evaluateWorkflowLoop?: (input: {
    record: ScenarioRunRecord;
    stopCondition: string;
  }) => Promise<{ complete: boolean; reason: string }>;
  onRuntimeEvent?: (event: ScenarioRuntimeEvent) => Promise<ScenarioRuntimeDirective | void> | ScenarioRuntimeDirective | void;
}

export interface ScenarioRuntimeEvent {
  event: 'validation_failed' | 'tool_failed' | 'loop_iteration' | 'workflow_adjusted';
  runId: string;
  stepId: string | null;
  workflowIteration: number;
  stepIteration: number | null;
  code: string | null;
  message: string;
}

export interface ScenarioRuntimeDirective {
  action: 'retry' | 'backtrack' | 'pause' | 'auto_fix' | 'execute_prompt';
  targetStepId?: string | null;
  instruction?: string;
}

export type ScenarioRunStartResult =
  | { ok: true; record: ScenarioRunRecord }
  | {
      ok: false;
      code: 'invalid_manifest' | 'invalid_dag' | 'invalid_snapshot' | 'invalid_record';
      issues: string[];
    };

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite numbers are not serializable');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new Error('Step output is not JSON serializable');
  if (seen.has(value)) throw new Error('Step output contains a cycle');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Step output must contain plain JSON objects');
    }
    const record = value as Record<string, unknown>;
    // undefined 值键与 JSON 语义一致：不参与序列化（与 resolver 端摘要同规）。
    return `{${Object.keys(record).filter(
      (key) => record[key] !== undefined,
    ).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`,
    ).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function digestScenarioStepOutput(output: unknown): string {
  const canonical = canonicalJson(output);
  if (canonical.length > MAX_STEP_OUTPUT_CHARS) throw new Error('Step output exceeds the run-record limit');
  return sha256(canonical);
}

export function digestResolvedManifestSnapshot(manifest: ResolvedRunManifest): string {
  // 非确定性字段必须剔除（2026-08-30 刘总报告「继续后从头重跑」根因）：
  // snapshot 里的 createdAt 是每次 resolve 的当前时间戳，算进 digest 会让
  // 同一场景定义每次 resolve 的 digest 都不同 → resume 判定永远失败 →
  // 每次都 start 新轮从第 1 步重跑。manifestDigest 自身同理（自引用）。
  const { manifestDigest: _manifestDigest, createdAt: _createdAt, ...withoutDigest } = manifest;
  void _manifestDigest;
  void _createdAt;
  return sha256(canonicalJson(withoutDigest));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function derivedExecutionKey(
  baseKey: string,
  workflowIteration: number,
  stepIteration: number,
  attempt: number,
): string {
  if (workflowIteration === 1 && stepIteration === 1 && attempt === 1) return baseKey;
  return sha256(`${baseKey}:${workflowIteration}:${stepIteration}:${attempt}`);
}

function resetStepForReentry(step: ScenarioStepRunRecord, preserveArtifacts = false): void {
  step.status = 'pending';
  step.startedAt = null;
  step.completedAt = null;
  if (!preserveArtifacts) {
    step.output = null;
    step.outputDigest = null;
    step.artifactRefs = [];
  }
  step.errorCode = null;
  step.errorMessage = null;
  step.activeExecutionKey = null;
  step.loopIteration = 0;
}

function topologicalOrder(manifest: ResolvedRunManifest): { order?: string[]; issues: string[] } {
  const steps = manifest.workflow;
  const byId = new Map(steps.map((step) => [step.id, step]));
  const issues: string[] = [];

  if (manifest.truthPolicy !== 'automatic_required') {
    issues.push('Scenario run requires the automatic truth policy');
  }
  if (manifest.definitionRevisions[manifest.scenarioId] !== manifest.scenarioRevision) {
    issues.push('Scenario revision is not bound to the manifest snapshot');
  }
  if (steps.length === 0) issues.push('Executable scenario workflow cannot be empty');
  for (const definitionId of [...manifest.agentIds, ...manifest.skillIds, ...manifest.mcpIds]) {
    if (manifest.definitionRevisions[definitionId] === undefined) {
      issues.push(`Definition revision is missing: ${definitionId}`);
    }
  }

  for (const step of steps) {
    if (step.agentId && !manifest.agentIds.includes(step.agentId)) {
      issues.push(`Step ${step.id} references an agent outside the manifest`);
    }
    if (step.agentId && manifest.definitionRevisions[step.agentId] === undefined) {
      issues.push(`Step ${step.id} agent revision is missing`);
    }
    for (const skillId of step.skillIds) {
      if (!manifest.skillIds.includes(skillId) || manifest.definitionRevisions[skillId] === undefined) {
        issues.push(`Step ${step.id} references an unbound skill: ${skillId}`);
      }
    }
    for (const mcpId of step.mcpIds) {
      if (!manifest.mcpIds.includes(mcpId) || manifest.definitionRevisions[mcpId] === undefined) {
        issues.push(`Step ${step.id} references an unbound MCP server: ${mcpId}`);
      }
    }
    for (const toolId of step.toolIds) {
      if (!manifest.allowedTools.includes(toolId)) {
        issues.push(`Step ${step.id} references a tool outside the manifest: ${toolId}`);
      }
    }
    if (step.maxTurns > manifest.maxTurns) {
      issues.push(`Step ${step.id} exceeds the manifest turn budget`);
    }
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) issues.push(`Step ${step.id} dependency is missing: ${dependency}`);
    }
  }
  if (issues.length > 0) return { issues };

  const indegree = new Map<string, number>();
  const dependants = new Map<string, string[]>();
  for (const step of steps) {
    indegree.set(step.id, step.dependsOn.length);
    for (const dependency of step.dependsOn) {
      const children = dependants.get(dependency) ?? [];
      children.push(step.id);
      dependants.set(dependency, children);
    }
  }
  const originalIndex = new Map(steps.map((step, index) => [step.id, index]));
  const ready = steps.filter((step) => step.dependsOn.length === 0).map((step) => step.id);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) => (originalIndex.get(left) ?? 0) - (originalIndex.get(right) ?? 0));
    const stepId = ready.shift();
    if (!stepId) break;
    order.push(stepId);
    for (const child of dependants.get(stepId) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) ready.push(child);
    }
  }
  if (order.length !== steps.length) return { issues: ['Workflow contains a dependency cycle'] };
  return { order, issues: [] };
}

function dependencyClosure(manifest: ResolvedRunManifest, failedIds: Set<string>): Set<string> {
  const blocked = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of manifest.workflow) {
      if (blocked.has(step.id) || failedIds.has(step.id)) continue;
      if (step.dependsOn.some((dependency) => failedIds.has(dependency) || blocked.has(dependency))) {
        blocked.add(step.id);
        changed = true;
      }
    }
  }
  return blocked;
}

function validateManifest(raw: unknown): { manifest?: ResolvedRunManifest; order?: string[]; issues: string[] } {
  const parsed = ResolvedRunManifestSchema.safeParse(raw);
  if (!parsed.success) return { issues: ['Manifest failed strict schema validation'] };
  let digest: string;
  try {
    digest = digestResolvedManifestSnapshot(parsed.data);
  } catch {
    return { issues: ['Manifest is not canonically serializable'] };
  }
  if (digest !== parsed.data.manifestDigest) return { issues: ['Manifest digest mismatch'] };
  const topology = topologicalOrder(parsed.data);
  return topology.order
    ? { manifest: parsed.data, order: topology.order, issues: [] }
    : { issues: topology.issues };
}

/** Returns the exact stable order used by the coordinator, or undefined for an invalid manifest. */
export function resolveScenarioExecutionOrder(raw: unknown): string[] | undefined {
  return validateManifest(raw).order;
}

const NON_TERMINAL_SCENARIO_RUN_STATUSES = ['running', 'interrupted', 'paused'] as const;

export type ScenarioStoredControlResult =
  | { ok: true; record: ScenarioRunRecord }
  | { ok: false; code: 'invalid_record'; issues: string[] };

/**
 * Persisted-control primitive for runs that are not currently executing
 * (paused or crash-interrupted records): flips a non-terminal stored record to
 * `paused` / terminal `cancelled` without touching completed step evidence.
 * The caller is responsible for persisting the returned record.
 */
export function terminateStoredScenarioRun(
  rawRecord: unknown,
  status: 'paused' | 'cancelled',
  options: { now?: () => number } = {},
): ScenarioStoredControlResult {
  const parsed = ScenarioRunRecordSchema.safeParse(rawRecord);
  if (!parsed.success) return { ok: false, code: 'invalid_record', issues: ['Run record failed strict validation'] };
  if (!NON_TERMINAL_SCENARIO_RUN_STATUSES.includes(parsed.data.status as (typeof NON_TERMINAL_SCENARIO_RUN_STATUSES)[number])) {
    return {
      ok: false,
      code: 'invalid_record',
      issues: [`Only non-terminal scenario runs can be ${status}; ${parsed.data.status} is final`],
    };
  }
  const record = cloneJson(parsed.data);
  const now = options.now ? options.now() : Date.now();
  record.status = status;
  record.updatedAt = now;
  if (status === 'cancelled') record.completedAt = now;
  try {
    return { ok: true, record: ScenarioRunRecordSchema.parse(record) };
  } catch {
    return { ok: false, code: 'invalid_record', issues: ['Controlled run record failed strict validation'] };
  }
}

export class ScenarioRunCoordinator {
  readonly #executor: ScenarioStepExecutor;
  readonly #now: () => number;
  readonly #onCheckpoint?: (record: ScenarioRunRecord) => void;
  readonly #onCheckpointSaved?: (record: ScenarioRunRecord) => void;
  readonly #evaluateStepCondition?: ScenarioRunCoordinatorOptions['evaluateStepCondition'];
  readonly #evaluateWorkflowLoop?: ScenarioRunCoordinatorOptions['evaluateWorkflowLoop'];
  readonly #onRuntimeEvent?: ScenarioRunCoordinatorOptions['onRuntimeEvent'];

  constructor(options: ScenarioRunCoordinatorOptions) {
    this.#executor = options.executor;
    this.#now = options.now ?? Date.now;
    this.#onCheckpoint = options.onCheckpoint;
    this.#onCheckpointSaved = options.onCheckpointSaved;
    this.#evaluateStepCondition = options.evaluateStepCondition;
    this.#evaluateWorkflowLoop = options.evaluateWorkflowLoop;
    this.#onRuntimeEvent = options.onRuntimeEvent;
  }

  async start(request: StartScenarioRunRequest): Promise<ScenarioRunStartResult> {
    const runIdResult = SafeRunIdSchema.safeParse(request.runId);
    if (!runIdResult.success) return { ok: false, code: 'invalid_snapshot', issues: ['Invalid run ID'] };
    const validation = validateManifest(request.manifest);
    if (!validation.manifest || !validation.order) {
      const code = validation.issues.some((issue) => issue.includes('cycle') || issue.includes('dependency'))
        ? 'invalid_dag'
        : 'invalid_manifest';
      return { ok: false, code, issues: validation.issues };
    }

    const startedAt = this.#now();
    const record: ScenarioRunRecord = ScenarioRunRecordSchema.parse({
      recordVersion: RUN_RECORD_VERSION,
      runId: runIdResult.data,
      manifestSnapshot: cloneJson(validation.manifest),
      manifestDigest: validation.manifest.manifestDigest,
      status: 'running',
      startedAt,
      updatedAt: startedAt,
      completedAt: null,
      executionOrder: validation.order,
      steps: validation.manifest.workflow.map((step) => {
        const stepSnapshot = cloneJson(step);
        const stepSnapshotDigest = sha256(canonicalJson(stepSnapshot));
        return {
          stepId: step.id,
          executionKey: sha256(`${runIdResult.data}:${validation.manifest?.manifestDigest}:${stepSnapshotDigest}`),
          stepSnapshot,
          stepSnapshotDigest,
          status: 'pending' as const,
          startedAt: null,
          completedAt: null,
          output: null,
          outputDigest: null,
          artifactRefs: [],
          errorCode: null,
          errorMessage: null,
          activeExecutionKey: null,
          attempts: 0,
          loopIteration: 0,
          validationHistory: [],
          toolCallSummary: [],
        };
      }),
      failureStepIds: [],
      workflowIteration: 1,
      workflowIterationsCompleted: 0,
      totalStepExecutions: 0,
      backtrackCount: 0,
    });
    return this.#execute(record, request);
  }

  async resume(rawRecord: unknown, control: ScenarioRunControlSignals = {}): Promise<ScenarioRunStartResult> {
    const { signal, pauseSignal, cancelSignal } = control;
    const parsed = ScenarioRunRecordSchema.safeParse(rawRecord);
    if (!parsed.success) return { ok: false, code: 'invalid_record', issues: ['Run record failed strict validation'] };
    const record = cloneJson(parsed.data);
    const validation = validateManifest(record.manifestSnapshot);
    if (!validation.manifest || !validation.order || record.manifestDigest !== validation.manifest.manifestDigest) {
      return { ok: false, code: 'invalid_record', issues: validation.issues.length > 0 ? validation.issues : ['Run manifest binding mismatch'] };
    }
    if (!['interrupted', 'paused', 'running', 'failed'].includes(record.status)) {
      // `cancelled` is terminal by contract and can never be resumed.
      // `failed` 带 completed 进度的记录可恢复（2026-08-30 刘总报告：31 步
      // 跑到 30 步最后一步失败，「继续」必须能只重跑失败步骤而不是从头）。
      return { ok: false, code: 'invalid_record', issues: ['Only interrupted, paused, running or failed records can resume'] };
    }
    if (record.executionOrder.join('\u0000') !== validation.order.join('\u0000')) {
      return { ok: false, code: 'invalid_record', issues: ['Run execution order mismatch'] };
    }
    const manifestSteps = new Map(record.manifestSnapshot.workflow.map((step) => [step.id, step]));
    if (record.steps.length !== manifestSteps.size) {
      return { ok: false, code: 'invalid_record', issues: ['Run step set does not match the manifest'] };
    }
    const actualFailureIds = record.steps.filter((step) => step.status === 'failed').map((step) => step.stepId).sort();
    if (actualFailureIds.join('\u0000') !== [...record.failureStepIds].sort().join('\u0000')) {
      return { ok: false, code: 'invalid_record', issues: ['Run failure index does not match step records'] };
    }
    const expectedBlockedIds = dependencyClosure(record.manifestSnapshot, new Set(actualFailureIds));
    for (const blockedStep of record.steps.filter((step) => step.status === 'blocked')) {
      if (!expectedBlockedIds.has(blockedStep.stepId)) {
        return { ok: false, code: 'invalid_record', issues: [`Blocked step has no failed dependency: ${blockedStep.stepId}`] };
      }
    }
    for (const stepRecord of record.steps) {
      const manifestStep = manifestSteps.get(stepRecord.stepId);
      if (!manifestStep || canonicalJson(manifestStep) !== canonicalJson(stepRecord.stepSnapshot)) {
        return { ok: false, code: 'invalid_record', issues: [`Step is not bound to the manifest: ${stepRecord.stepId}`] };
      }
      const actualStepDigest = sha256(canonicalJson(stepRecord.stepSnapshot));
      if (actualStepDigest !== stepRecord.stepSnapshotDigest) {
        return { ok: false, code: 'invalid_record', issues: [`Step snapshot mismatch: ${stepRecord.stepId}`] };
      }
      const expectedExecutionKey = sha256(`${record.runId}:${record.manifestDigest}:${actualStepDigest}`);
      if (stepRecord.executionKey !== expectedExecutionKey) {
        return { ok: false, code: 'invalid_record', issues: [`Step execution key mismatch: ${stepRecord.stepId}`] };
      }
      if (stepRecord.status === 'completed') {
        let completedDigest: string;
        try {
          completedDigest = digestScenarioStepOutput(stepRecord.output);
        } catch {
          return { ok: false, code: 'invalid_record', issues: [`Completed step output mismatch: ${stepRecord.stepId}`] };
        }
        if (stepRecord.outputDigest === null || completedDigest !== stepRecord.outputDigest) {
          return { ok: false, code: 'invalid_record', issues: [`Completed step output mismatch: ${stepRecord.stepId}`] };
        }
      }
      if (stepRecord.status === 'running') {
        // executionKey is stable across retries; real executors must use it as their
        // idempotency key before repeating an uncertain, crash-interrupted operation.
        stepRecord.status = 'pending';
        stepRecord.startedAt = null;
      }
    }
    // Failed 记录恢复：失败步骤重置为 pending 重跑（completed 步骤不动），
    // 失败索引随之清空——「继续」只重做失败的那一步，不推翻已有成果。
    if (record.status === 'failed') {
      for (const stepRecord of record.steps) {
        if (stepRecord.status === 'failed') {
          stepRecord.status = 'pending';
          stepRecord.startedAt = null;
        }
      }
      record.failureStepIds = [];
    }
    record.status = 'running';
    record.completedAt = null;
    return this.#execute(record, { signal, pauseSignal, cancelSignal });
  }

  async #execute(record: ScenarioRunRecord, control: ScenarioRunControlSignals): Promise<ScenarioRunStartResult> {
    const { signal, pauseSignal, cancelSignal } = control;
    // Cancellation wins over pause, and both win over a plain interrupt: a
    // cancelled run must never be downgraded into recoverable work.
    const controlStop = (): ScenarioRunStartResult | undefined => {
      if (cancelSignal?.aborted) return this.#terminate(record, 'cancelled');
      if (pauseSignal?.aborted) return this.#terminate(record, 'paused');
      if (signal?.aborted) return this.#interrupt(record);
      return undefined;
    };
    const manifest = record.manifestSnapshot;
    const initialCheckpoint = this.#checkpoint(record);
    if (initialCheckpoint) return initialCheckpoint;
    const maxTotalExecutions = manifest.workflowGovernance?.maxTotalStepExecutions ?? 10_000;
    let terminalStatus: ScenarioRunRecord['status'] = 'completed';
    // 终末输出计划步骤识别（2026-08-31 机制修正）：线性链场景中最终装配
    // 步骤只声明直接前驱，信息饥饿导致定稿残缺（生产实证）。携带输出计划
    // 的终末步骤（无任何下游依赖的步骤）获得全部已完成上游产出的预算化
    // 视图。与服务端 configuredFinalStepId 的判定同规。
    const terminalPlanStepId = (() => {
      if (!manifest.output.plan) return null;
      const dependedOn = new Set(manifest.workflow.flatMap((step) => step.dependsOn));
      const terminal = manifest.workflow.filter((step) => !dependedOn.has(step.id));
      return terminal.length === 1 ? terminal[0]!.id : null;
    })();

    workflowPass: while (true) {
      const stepById = new Map(record.steps.map((step) => [step.stepId, step]));
      let index = 0;
      while (index < record.executionOrder.length) {
        const stepId = record.executionOrder[index];
        if (!stepId) {
          index += 1;
          continue;
        }
        const stepRecord = stepId ? stepById.get(stepId) : undefined;
        if (!stepRecord || ['completed', 'failed', 'blocked', 'skipped'].includes(stepRecord.status)) {
          index += 1;
          continue;
        }
        const boundaryStop = controlStop();
        if (boundaryStop) return boundaryStop;

        const failedIds = new Set(record.steps.filter((step) => step.status === 'failed').map((step) => step.stepId));
        if (dependencyClosure(manifest, failedIds).has(stepId)) {
          stepRecord.status = 'blocked';
          stepRecord.completedAt = this.#now();
          stepRecord.errorCode = 'dependency_failed';
          stepRecord.errorMessage = 'A required upstream step failed';
          index += 1;
          continue;
        }

        const dependencies: Record<string, unknown> = Object.fromEntries(stepRecord.stepSnapshot.dependsOn.map((dependencyId) => {
          const dependency = stepById.get(dependencyId);
          return [dependencyId, dependency?.output ?? null];
        }));
        if (terminalPlanStepId === stepId) {
          // 终末计划步骤的上游预算化注入：直接依赖原样保留；其余已完成步骤
          // 产出按新近优先注入，总量预算 100k 字符（须与系统提示、历史和
          // 输出上限共存于模型上下文内）；放不下的显式列入 _omittedUpstream
          // 清单——模型必须知道哪些上游产出它看不到，绝不静默丢弃。
          const directDeps = new Set(stepRecord.stepSnapshot.dependsOn);
          let upstreamBudget = 100_000;
          const omitted: string[] = [];
          for (const upstream of [...record.steps].reverse()) {
            if (upstream.stepId === stepId || directDeps.has(upstream.stepId)) continue;
            if (upstream.status !== 'completed') continue;
            const upstreamOutput = upstream.output as { text?: unknown } | null;
            const upstreamText = upstreamOutput && typeof upstreamOutput.text === 'string' ? upstreamOutput.text : '';
            if (!upstreamText) continue;
            if (upstreamText.length > upstreamBudget) {
              omitted.push(`${upstream.stepId} "${upstream.stepSnapshot.name}" (${upstreamText.length} chars)`);
              continue;
            }
            upstreamBudget -= upstreamText.length;
            dependencies[upstream.stepId] = cloneJson(upstream.output);
          }
          if (omitted.length > 0) dependencies._omittedUpstream = omitted;
        }
        if (stepRecord.stepSnapshot.condition && stepRecord.loopIteration === 0) {
          if (!this.#evaluateStepCondition) {
            this.#failStep(record, stepRecord, 'condition_evaluator_unavailable', 'Conditional workflow step has no runtime evaluator');
            index += 1;
            continue;
          }
          try {
            const decision = await this.#evaluateStepCondition({
              record: cloneJson(record),
              step: cloneJson(stepRecord.stepSnapshot),
              dependencyOutputs: cloneJson(dependencies),
            });
            if (!decision.run) {
              stepRecord.status = 'skipped';
              stepRecord.completedAt = this.#now();
              stepRecord.errorCode = null;
              stepRecord.errorMessage = decision.reason.slice(0, 4_000);
              record.updatedAt = stepRecord.completedAt;
              const checkpointFailure = this.#checkpoint(record);
              if (checkpointFailure) return checkpointFailure;
              index += 1;
              continue;
            }
          } catch (error) {
            this.#failStep(record, stepRecord, 'condition_evaluation_failed', error instanceof Error ? error.message : 'Condition evaluation failed');
            index += 1;
            continue;
          }
        }

        let failureAttempt = 0;
        // 恢复/重试时把最近一次完成度评审的缺陷清单带给下一轮（2026-08-31
        // 机制修正）：此前评审意见只落 validationHistory、不进提示词，失败
        // 恢复后的修订轮等于盲改。运行内的循环路径（validation_failed 分支）
        // 会自行覆盖本值，这里只处理跨进程恢复后的首次执行。
        const lastValidation = stepRecord.validationHistory.at(-1);
        let runtimeInstruction = stepRecord.attempts > 0 && lastValidation && !lastValidation.satisfied
          ? `对上一轮产出做一次修订：校验给出了以下缺陷清单，请逐项修正（清单未提及的内容保持原样，不要全量重写）：\n${lastValidation.reason}`
          : '';
        let backtrackIndex: number | null = null;
        let stepFinished = false;
        while (!stepFinished) {
          const iterationStop = controlStop();
          if (iterationStop) return iterationStop;
          if (record.totalStepExecutions >= maxTotalExecutions) {
            this.#failStep(record, stepRecord, 'execution_limit_exceeded', 'Workflow exceeded its configured total step execution limit');
            break;
          }
          const stepIteration = stepRecord.loopIteration + 1;
          if (!stepRecord.activeExecutionKey) {
            stepRecord.attempts += 1;
            record.totalStepExecutions += 1;
            stepRecord.activeExecutionKey = derivedExecutionKey(
              stepRecord.executionKey,
              record.workflowIteration,
              stepIteration,
              stepRecord.attempts,
            );
          }
          stepRecord.status = 'running';
          stepRecord.startedAt ??= this.#now();
          record.updatedAt = this.#now();
          const runningCheckpointFailure = this.#checkpoint(record);
          if (runningCheckpointFailure) return runningCheckpointFailure;

          let rawResult: unknown;
          try {
            rawResult = await this.#executor({
              runId: record.runId,
              executionKey: stepRecord.activeExecutionKey,
              sessionId: manifest.sessionId,
              projectId: manifest.projectId,
              scenarioId: manifest.scenarioId,
              manifestDigest: manifest.manifestDigest,
              step: cloneJson(stepRecord.stepSnapshot),
              dependencyOutputs: cloneJson(dependencies),
              workflowIteration: record.workflowIteration,
              stepIteration,
              attempt: stepRecord.attempts,
              previousIterationOutput: cloneJson(stepRecord.output),
              runtimeInstruction,
              signal,
            });
          } catch (error) {
            rawResult = {
              ok: false,
              code: 'executor_error',
              message: error instanceof Error ? error.message.slice(0, 4_000) : 'Step executor failed',
            };
          }
          // Late provider results must never revive a controlled run: the
          // executor outcome is discarded when cancellation or pause arrived
          // while the step was in flight.
          const postExecutionStop = controlStop();
          if (postExecutionStop) return postExecutionStop;
          stepRecord.activeExecutionKey = null;
          failureAttempt += 1;

          const parsedResult = ScenarioStepExecutionResultSchema.safeParse(rawResult);
          let failure: { code: string; message: string } | undefined;
          let success: z.infer<typeof ScenarioStepExecutionSuccessSchema> | undefined;
          if (!parsedResult.success) {
            failure = { code: 'invalid_executor_result', message: 'Step executor returned an invalid result' };
          } else if (!parsedResult.data.ok) {
            failure = { code: parsedResult.data.code, message: parsedResult.data.message };
          } else {
            success = parsedResult.data;
            try {
              const actualDigest = digestScenarioStepOutput(success.output);
              if (actualDigest !== success.outputDigest) {
                failure = { code: 'output_digest_mismatch', message: 'Step output digest did not match the returned output' };
                success = undefined;
              }
            } catch {
              failure = { code: 'invalid_step_output', message: 'Step output is not bounded canonical JSON' };
              success = undefined;
            }
          }

          if (failure) {
            const directive = await this.#runtimeDirective({
              event: 'tool_failed', runId: record.runId, stepId, workflowIteration: record.workflowIteration,
              stepIteration, code: failure.code, message: failure.message,
            });
            const configuredPolicy = stepRecord.stepSnapshot.failurePolicy;
            const automaticRecovery = !configuredPolicy || configuredPolicy.action === 'stop';
            const requestedAction = directive?.action === 'auto_fix' || directive?.action === 'execute_prompt'
              ? 'retry'
              : directive?.action ?? (automaticRecovery ? 'retry' : configuredPolicy.action);
            runtimeInstruction = directive?.instruction ?? configuredPolicy?.instruction ?? '';
            const retryLimit = Math.max(
              configuredPolicy?.retryLimit ?? 0,
              automaticRecovery ? SYSTEM_FAILURE_RETRY_LIMIT : 0,
              directive ? 1 : 0,
            );
            if (requestedAction === 'retry' && failureAttempt <= retryLimit) {
              stepRecord.status = 'pending';
              stepRecord.errorCode = failure.code;
              stepRecord.errorMessage = failure.message;
              const checkpointFailure = this.#checkpoint(record);
              if (checkpointFailure) return checkpointFailure;
              continue;
            }
            if (requestedAction === 'skip') {
              stepRecord.status = 'skipped';
              stepRecord.completedAt = this.#now();
              stepRecord.errorCode = failure.code;
              stepRecord.errorMessage = failure.message;
              break;
            }
            if (requestedAction === 'pause' || requestedAction === 'pause_for_user') {
              stepRecord.status = 'pending';
              stepRecord.errorCode = failure.code;
              stepRecord.errorMessage = failure.message;
              return this.#interrupt(record);
            }
            if (requestedAction === 'backtrack') {
              const target = directive?.targetStepId ?? configuredPolicy?.backtrackStepId;
              backtrackIndex = target ? this.#resetFrom(record, target) : null;
              if (backtrackIndex !== null) {
                record.backtrackCount += 1;
                await this.#runtimeDirective({
                  event: 'workflow_adjusted', runId: record.runId, stepId: target ?? null,
                  workflowIteration: record.workflowIteration, stepIteration: null, code: 'backtrack',
                  message: `Workflow backtracked to ${target}`,
                });
                break;
              }
            }
            this.#failStep(record, stepRecord, failure.code, failure.message);
            break;
          }

          const actualDigest = success!.outputDigest;
          stepRecord.output = cloneJson(success!.output);
          stepRecord.outputDigest = actualDigest;
          stepRecord.artifactRefs = cloneJson(success!.artifactRefs);
          stepRecord.toolCallSummary.push(...cloneJson(success!.toolCallSummary ?? []));
          stepRecord.loopIteration = stepIteration;
          const hasCompletionCriteria = (stepRecord.stepSnapshot.completionCriteria?.length ?? 0) > 0;
          const loop = stepRecord.stepSnapshot.loop?.enabled
            ? stepRecord.stepSnapshot.loop
            : hasCompletionCriteria
              ? {
                  enabled: true,
                  maxIterations: SYSTEM_COMPLETION_MAX_ITERATIONS,
                  stopCondition: stepRecord.stepSnapshot.completionCriteria!.join('\n'),
                  evaluator: 'completion_criteria' as const,
                  // 耗尽即放行（2026-08-28 刘总决策）：隐式完成标准循环到上限后
                  // 标注 errorCode='loop_exhausted' 继续推进，而不是回退到步骤
                  // 自身形成"重跑→不过→再重跑"的永动机（曾 70+ 分钟卡在第 1 步）。
                  // 显式配置了 backtrackStepId 的作者循环不受影响。
                  onExhausted: 'continue' as const,
                }
              : undefined;
          const assessment = success!.completionAssessment ?? (hasCompletionCriteria
            ? {
                satisfied: false,
                reason: 'The runtime did not return a completion assessment for this step',
              }
            : undefined);
          if (assessment) {
            stepRecord.validationHistory.push({
              workflowIteration: record.workflowIteration,
              stepIteration,
              satisfied: assessment.satisfied,
              reason: assessment.reason,
              occurredAt: this.#now(),
            });
          }
          if (!loop || assessment?.satisfied) {
            stepRecord.status = 'completed';
            stepRecord.completedAt = this.#now();
            stepRecord.errorCode = null;
            stepRecord.errorMessage = null;
            record.updatedAt = stepRecord.completedAt;
            const completedCheckpointFailure = this.#checkpoint(record);
            if (completedCheckpointFailure) return completedCheckpointFailure;
            break;
          }

          const validationReason = assessment?.reason ?? 'Step Loop requires a completion assessment from the executor';
          const directive = await this.#runtimeDirective({
            event: 'validation_failed', runId: record.runId, stepId, workflowIteration: record.workflowIteration,
            stepIteration, code: 'completion_not_satisfied', message: validationReason,
          });
          if (directive?.action === 'pause') {
            stepRecord.status = 'pending';
            stepRecord.errorCode = 'validation_failed';
            stepRecord.errorMessage = validationReason;
            return this.#interrupt(record);
          }
          if (directive?.action === 'backtrack') {
            backtrackIndex = directive.targetStepId ? this.#resetFrom(record, directive.targetStepId) : null;
            if (backtrackIndex !== null) {
              record.backtrackCount += 1;
              break;
            }
          }
          runtimeInstruction = directive?.instruction
            ?? `对上一轮产出做一次修订：校验给出了以下缺陷清单，请逐项修正（清单未提及的内容保持原样，不要全量重写）：\n${validationReason}`;
          if (stepIteration < loop.maxIterations) {
            stepRecord.status = 'pending';
            stepRecord.errorCode = 'validation_failed';
            stepRecord.errorMessage = validationReason;
            await this.#runtimeDirective({
              event: 'loop_iteration', runId: record.runId, stepId, workflowIteration: record.workflowIteration,
              stepIteration, code: null, message: `Step Loop iteration ${stepIteration} did not satisfy its stop condition`,
            });
            const loopCheckpointFailure = this.#checkpoint(record);
            if (loopCheckpointFailure) return loopCheckpointFailure;
            continue;
          }
          if (loop.onExhausted === 'continue') {
            stepRecord.status = 'completed';
            stepRecord.completedAt = this.#now();
            stepRecord.errorCode = 'loop_exhausted';
            stepRecord.errorMessage = validationReason;
            break;
          }
          if (loop.onExhausted === 'pause_for_user') {
            stepRecord.status = 'pending';
            stepRecord.errorCode = 'loop_exhausted';
            stepRecord.errorMessage = validationReason;
            return this.#interrupt(record);
          }
          if (loop.onExhausted === 'backtrack') {
            backtrackIndex = loop.backtrackStepId ? this.#resetFrom(record, loop.backtrackStepId) : null;
            if (backtrackIndex !== null) {
              record.backtrackCount += 1;
              break;
            }
          }
          this.#failStep(record, stepRecord, 'loop_exhausted', validationReason);
          stepFinished = true;
        }

        const checkpointFailure = this.#checkpoint(record);
        if (checkpointFailure) return checkpointFailure;
        if (backtrackIndex !== null) {
          index = backtrackIndex;
          continue;
        }
        index += 1;
      }

      const stepByIdAfterPass = new Map(record.steps.map((step) => [step.stepId, step]));
      const failedIds = new Set(record.steps.filter((step) => step.status === 'failed').map((step) => step.stepId));
      for (const blockedId of dependencyClosure(manifest, failedIds)) {
        const step = stepByIdAfterPass.get(blockedId);
        if (step && step.status === 'pending') {
          step.status = 'blocked';
          step.completedAt = this.#now();
          step.errorCode = 'dependency_failed';
          step.errorMessage = 'A required upstream step failed';
        }
      }
      record.failureStepIds = record.steps.filter((step) => step.status === 'failed').map((step) => step.stepId);
      if (record.failureStepIds.length > 0) {
        terminalStatus = 'failed';
        break workflowPass;
      }

      const workflowLoop = manifest.workflowLoop;
      if (!workflowLoop?.enabled) break workflowPass;
      record.workflowIterationsCompleted = record.workflowIteration;
      let loopDecision = { complete: false, reason: 'Workflow stop condition was not evaluated' };
      if (this.#evaluateWorkflowLoop) {
        try {
          loopDecision = await this.#evaluateWorkflowLoop({ record: cloneJson(record), stopCondition: workflowLoop.stopCondition });
        } catch (error) {
          terminalStatus = 'failed';
          const terminal = record.steps.at(-1);
          if (terminal) this.#failStep(record, terminal, 'workflow_loop_evaluation_failed', error instanceof Error ? error.message : 'Workflow Loop evaluation failed');
          break workflowPass;
        }
      }
      if (loopDecision.complete) break workflowPass;
      if (record.workflowIteration < workflowLoop.maxIterations) {
        const reentryStepId = workflowLoop.reentryStepId ?? record.executionOrder[0];
        if (!reentryStepId || this.#resetFrom(record, reentryStepId, workflowLoop.carryArtifacts === true) === null) {
          terminalStatus = 'failed';
          break workflowPass;
        }
        await this.#runtimeDirective({
          event: 'loop_iteration', runId: record.runId, stepId: null, workflowIteration: record.workflowIteration,
          stepIteration: null, code: null, message: loopDecision.reason,
        });
        record.workflowIteration += 1;
        record.updatedAt = this.#now();
        const loopCheckpointFailure = this.#checkpoint(record);
        if (loopCheckpointFailure) return loopCheckpointFailure;
        continue workflowPass;
      }
      if (workflowLoop.onExhausted === 'fail') terminalStatus = 'failed';
      if (workflowLoop.onExhausted === 'pause_for_user') return this.#interrupt(record);
      break workflowPass;
    }

    record.failureStepIds = record.steps.filter((step) => step.status === 'failed').map((step) => step.stepId);
    record.status = terminalStatus === 'failed' || record.failureStepIds.length > 0 ? 'failed' : 'completed';
    record.completedAt = this.#now();
    record.updatedAt = record.completedAt;
    const finalCheckpointFailure = this.#checkpoint(record);
    if (finalCheckpointFailure) return finalCheckpointFailure;
    return { ok: true, record: ScenarioRunRecordSchema.parse(record) };
  }

  async #runtimeDirective(event: ScenarioRuntimeEvent): Promise<ScenarioRuntimeDirective | undefined> {
    if (!this.#onRuntimeEvent) return undefined;
    try {
      return (await this.#onRuntimeEvent(event)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  #failStep(record: ScenarioRunRecord, step: ScenarioStepRunRecord, code: string, message: string): void {
    step.status = 'failed';
    step.errorCode = code.slice(0, 128).replace(/[^a-z0-9_]/gu, '_') || 'step_failed';
    step.errorMessage = message.slice(0, 4_000);
    step.completedAt = this.#now();
    step.activeExecutionKey = null;
    record.updatedAt = step.completedAt;
    if (!record.failureStepIds.includes(step.stepId)) record.failureStepIds.push(step.stepId);
  }

  #resetFrom(record: ScenarioRunRecord, targetStepId: string, preserveArtifacts = false): number | null {
    const targetIndex = record.executionOrder.indexOf(targetStepId);
    if (targetIndex < 0) return null;
    const resetIds = new Set(record.executionOrder.slice(targetIndex));
    for (const step of record.steps) {
      if (resetIds.has(step.stepId)) resetStepForReentry(step, preserveArtifacts);
    }
    record.failureStepIds = record.failureStepIds.filter((stepId) => !resetIds.has(stepId));
    return targetIndex;
  }

  #interrupt(record: ScenarioRunRecord): ScenarioRunStartResult {
    record.status = 'interrupted';
    record.updatedAt = this.#now();
    const checkpointFailure = this.#checkpoint(record);
    return checkpointFailure ?? { ok: true, record: ScenarioRunRecordSchema.parse(record) };
  }

  /** Durable pause/cancel terminalization; the checkpoint is written before the caller observes the result. */
  #terminate(record: ScenarioRunRecord, status: 'paused' | 'cancelled'): ScenarioRunStartResult {
    record.status = status;
    record.updatedAt = this.#now();
    if (status === 'cancelled') record.completedAt = record.updatedAt;
    const checkpointFailure = this.#checkpoint(record);
    return checkpointFailure ?? { ok: true, record: ScenarioRunRecordSchema.parse(record) };
  }

  #checkpoint(record: ScenarioRunRecord): ScenarioRunStartResult | undefined {
    if (!this.#onCheckpoint) return undefined;
    try {
      this.#onCheckpoint(cloneJson(ScenarioRunRecordSchema.parse(record)));
      this.#onCheckpointSaved?.(cloneJson(ScenarioRunRecordSchema.parse(record)));
      return undefined;
    } catch {
      return {
        ok: false,
        code: 'invalid_record',
        issues: ['Run checkpoint persistence failed'],
      };
    }
  }
}
