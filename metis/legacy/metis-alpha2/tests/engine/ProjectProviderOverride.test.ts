/**
 * O13 — per-project provider/model 覆盖。
 *
 * 覆盖三层语义：
 *   1. resolveProviderProfileBinding 纯函数：override 生效 / 不生效 / 部分字段。
 *   2. ResearchRepository：覆盖在 projects.metadata 中的持久化 roundtrip。
 *   3. GoalEngine 运行时绑定：override 生效时 run 记录与步骤请求绑定
 *      project_override profile；不生效时保持全局默认绑定。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  decodeProjectProviderOverride,
  resolveProviderProfileBinding,
  resolveProviderProfileRuntime,
  type ProjectProviderOverride,
  type ProviderProfileBinding,
} from '../../engine/runtime/ProviderProfileContract.js';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import type { Project } from '../../engine/persistence/researchModel.js';
import { GoalEngine } from '../../engine/goal/GoalEngine.js';
import type { AgentLoop } from '../../engine/core/AgentLoop.js';
import type { AgentRunRequest, AgentRunResult } from '../../engine/core/types.js';

const PROFILE_A = '0f6b2c6e-3f0a-4b1c-9a2b-1d2e3f4a5b6c';
const PROFILE_B = '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f';

// ─── 纯函数：resolveProviderProfileBinding ────────────────────

describe('resolveProviderProfileBinding', () => {
  const globalRef = { profileId: PROFILE_A, model: 'deepseek-chat' };

  it('无 override 时返回全局绑定', () => {
    const binding = resolveProviderProfileBinding(globalRef, null);
    expect(binding).toEqual({ source: 'global', profileId: PROFILE_A, model: 'deepseek-chat' });
  });

  it('空 override（无任何有效字段）视为全局绑定', () => {
    const binding = resolveProviderProfileBinding(globalRef, undefined);
    expect(binding.source).toBe('global');
    expect(binding.profileId).toBe(PROFILE_A);
  });

  it('profile override 生效：绑定覆盖 profile 及其模型', () => {
    const override: ProjectProviderOverride = { providerProfileId: PROFILE_B };
    const binding = resolveProviderProfileBinding(globalRef, override, 'qwen-max');
    expect(binding).toEqual({ source: 'project_override', profileId: PROFILE_B, model: 'qwen-max' });
  });

  it('仅覆盖模型：沿用全局 profile 但换模型', () => {
    const binding = resolveProviderProfileBinding(globalRef, { model: 'glm-4.6' });
    expect(binding).toEqual({ source: 'project_override', profileId: PROFILE_A, model: 'glm-4.6' });
  });

  it('override.model 优先于覆盖 profile 自身模型', () => {
    const override: ProjectProviderOverride = { providerProfileId: PROFILE_B, model: 'custom-model' };
    const binding = resolveProviderProfileBinding(globalRef, override, 'qwen-max');
    expect(binding.model).toBe('custom-model');
    expect(binding.profileId).toBe(PROFILE_B);
  });

  it('systemPrompt 随绑定携带', () => {
    const binding = resolveProviderProfileBinding(globalRef, { systemPrompt: '你是严谨的学术助手' });
    expect(binding.source).toBe('project_override');
    expect(binding.systemPrompt).toBe('你是严谨的学术助手');
    expect(binding.profileId).toBe(PROFILE_A);
  });
});

describe('resolveProviderProfileRuntime', () => {
  const global = { profileId: PROFILE_A, model: 'global-model', available: true };
  const profiles = [
    { id: PROFILE_A, model: 'global-model', available: true },
    { id: PROFILE_B, model: 'project-model', available: true },
  ];

  it('uses the global binding only when metadata is absent and global is available', () => {
    expect(resolveProviderProfileRuntime({ global, profiles })).toEqual({
      status: 'ready', binding: { source: 'global', profileId: PROFILE_A, model: 'global-model' },
    });
  });

  it('propagates a valid project profile without falling back to global', () => {
    expect(resolveProviderProfileRuntime({ global, profiles, projectOverride: { providerProfileId: PROFILE_B, systemPrompt: 'project-only' } })).toEqual({
      status: 'ready', binding: { source: 'project_override', profileId: PROFILE_B, model: 'project-model', systemPrompt: 'project-only' },
    });
  });

  it('fails closed for invalid, missing, or unavailable project overrides', () => {
    expect(resolveProviderProfileRuntime({ global, profiles, projectOverride: { providerProfileId: 'bad' } })).toMatchObject({ status: 'pending', reason: 'project_override_invalid' });
    expect(resolveProviderProfileRuntime({ global, profiles, projectOverride: { providerProfileId: '11111111-1111-4111-8111-111111111111' } })).toMatchObject({ status: 'pending', reason: 'project_profile_not_found' });
    expect(resolveProviderProfileRuntime({ global, profiles: profiles.map((profile) => profile.id === PROFILE_B ? { ...profile, available: false } : profile), projectOverride: { providerProfileId: PROFILE_B } })).toMatchObject({ status: 'pending', reason: 'project_profile_unavailable' });
  });

  it('fails closed when the global profile is unavailable', () => {
    expect(resolveProviderProfileRuntime({ global: { ...global, available: false }, profiles })).toMatchObject({ status: 'pending', reason: 'global_profile_unavailable' });
  });
});

describe('decodeProjectProviderOverride', () => {
  it('接受合法 override', () => {
    expect(decodeProjectProviderOverride({ providerProfileId: PROFILE_B })).toEqual({ providerProfileId: PROFILE_B });
    expect(decodeProjectProviderOverride({ model: 'm', systemPrompt: 's' })).toEqual({ model: 'm', systemPrompt: 's' });
  });

  it('空对象 / 非法输入 / 损坏数据一律返回 null', () => {
    expect(decodeProjectProviderOverride({})).toBeNull();
    expect(decodeProjectProviderOverride(null)).toBeNull();
    expect(decodeProjectProviderOverride('junk')).toBeNull();
    expect(decodeProjectProviderOverride({ providerProfileId: 'not-a-uuid' })).toBeNull();
    expect(decodeProjectProviderOverride({ unknownField: 1 })).toBeNull();
  });
});

// ─── 持久化：ResearchRepository roundtrip ─────────────────────

function makeProject(id: string): Project {
  const now = Date.now();
  return {
    id,
    title: `Project ${id}`,
    originalIntent: '',
    researchQuestion: '',
    lifecycle: 'draft',
    methodology: '',
    discipline: '',
    metadata: {},
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    version: 1,
    source: 'user',
    deletedAt: null,
  };
}

describe('ResearchRepository project provider override', () => {
  let dir: string;
  let store: PersistenceStore;
  let repo: ResearchRepository;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-o13-'));
    store = new PersistenceStore(path.join(dir, 'test.db'));
    repo = new ResearchRepository(store.raw);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('设置 → 读取 roundtrip；清除后恢复为 null', () => {
    repo.createProject(makeProject('proj-1'));
    expect(repo.getProjectProviderOverride('proj-1')).toBeNull();

    const override: ProjectProviderOverride = { providerProfileId: PROFILE_B, systemPrompt: 'SP' };
    expect(repo.setProjectProviderOverride('proj-1', override)).toBe(true);
    expect(repo.getProjectProviderOverride('proj-1')).toEqual(override);

    expect(repo.setProjectProviderOverride('proj-1', null)).toBe(true);
    expect(repo.getProjectProviderOverride('proj-1')).toBeNull();
  });

  it('不存在的项目按 absent 处理（孤儿 Goal 回退全局），只有损坏元数据才 invalid', () => {
    // 回归锁定（2026-08-22 goal-recovery 阻塞根因）：项目缺失曾被误判为
    // invalid → fail-closed 拒绝执行；正确语义是无项目即无覆盖元数据。
    expect(repo.getProjectProviderOverrideState('missing-project')).toEqual({ status: 'absent' });
    repo.createProject(makeProject('proj-del'));
    repo.softDeleteProject('proj-del', Date.now());
    expect(repo.getProjectProviderOverrideState('proj-del')).toEqual({ status: 'absent' });
    // 对照：项目存在但覆盖元数据损坏仍然 fail-closed。
    repo.createProject(makeProject('proj-corrupt'));
    store.raw.prepare(
      "UPDATE projects SET metadata = ? WHERE id = 'proj-corrupt'",
    ).run(JSON.stringify({ providerOverride: { providerProfileId: 'not-a-uuid' } }));
    expect(repo.getProjectProviderOverrideState('proj-corrupt').status).toBe('invalid');
  });

  it('拒绝非法 override；不存在的项目返回 false', () => {
    repo.createProject(makeProject('proj-2'));
    expect(repo.setProjectProviderOverride('proj-2', { providerProfileId: 'bad' } as unknown as ProjectProviderOverride)).toBe(false);
    expect(repo.setProjectProviderOverride('missing', { model: 'm' })).toBe(false);
  });

  it('覆盖写入不影响 metadata 中既有的其他键', () => {
    const project = makeProject('proj-3');
    project.metadata = { discipline: 'nlp', nested: { a: 1 } };
    repo.createProject(project);
    repo.setProjectProviderOverride('proj-3', { model: 'm' });
    const stored = repo.getProject('proj-3');
    expect(stored?.metadata.discipline).toBe('nlp');
    expect(stored?.metadata.nested).toEqual({ a: 1 });
    expect(repo.getProjectProviderOverride('proj-3')).toEqual({ model: 'm' });
  });
});

// ─── 运行时：GoalEngine 绑定生效 / 不生效 ─────────────────────

function planWorkflowJson(): string {
  return JSON.stringify({
    id: 'wf_o13',
    name: 'O13 test',
    description: '',
    version: '1.0',
    steps: [
      { id: 's1', name: 'S1', description: '', prompt: 'Do S1', inputFrom: [], tools: [], maxTurns: 3 },
    ],
    dependencies: { s1: [] },
  });
}

function makeResult(text: string): AgentRunResult {
  return {
    status: 'completed',
    finalText: text,
    finalVerified: true,
    messages: [{ role: 'assistant', content: text }],
    turnsUsed: 1,
    toolResults: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    errors: [],
    traceEvents: [],
  };
}

/** 规划走 globalAgent；执行请求记录到 captured。 */
function makeAgent(captured: AgentRunRequest[], text = '步骤完成'): AgentLoop {
  return {
    run: vi.fn(async (req: AgentRunRequest) => {
      if (req.sessionId.startsWith('plan-')) return makeResult(planWorkflowJson());
      captured.push(req);
      return makeResult(text);
    }),
  } as unknown as AgentLoop;
}

describe('GoalEngine provider binding (O13)', () => {
  it('override 生效：使用 agentOverride 执行，请求携带绑定与系统提示，run 记录 project_override', async () => {
    const globalRequests: AgentRunRequest[] = [];
    const overrideRequests: AgentRunRequest[] = [];
    const globalAgent = makeAgent(globalRequests);
    const overrideAgent = makeAgent(overrideRequests, '覆盖模型输出');
    const engine = new GoalEngine(globalAgent);

    const goal = engine.createGoal('调研 O13', undefined, 'proj-x');
    await engine.generatePlan(goal.id);

    const binding: ProviderProfileBinding = {
      source: 'project_override',
      profileId: PROFILE_B,
      model: 'qwen-max',
      systemPrompt: '项目专属提示',
    };
    const run = await engine.executeGoal(goal.id, undefined, { providerBinding: binding, agentOverride: overrideAgent });

    // 覆盖执行器被调用，全局执行器只收到规划请求
    expect(overrideRequests).toHaveLength(1);
    expect(globalRequests).toHaveLength(0);
    // 请求携带绑定 + 项目作用域 + 系统提示注入在消息最前
    const request = overrideRequests[0]!;
    expect(request.providerProfileBinding).toEqual(binding);
    expect(request.projectId).toBe('proj-x');
    expect(request.messages[0]).toEqual({ role: 'system', content: '项目专属提示' });
    // run 记录绑定（持久化审计）
    expect(run.providerBinding).toEqual(binding);
    expect(run.stepResults.s1?.output).toBe('覆盖模型输出');
  });

  it('override 不生效（无 options）：全局 agent 执行，run 无绑定记录', async () => {
    const globalRequests: AgentRunRequest[] = [];
    const engine = new GoalEngine(makeAgent(globalRequests));

    const goal = engine.createGoal('调研默认');
    await engine.generatePlan(goal.id);
    const run = await engine.executeGoal(goal.id);

    expect(globalRequests).toHaveLength(1);
    expect(globalRequests[0]!.providerProfileBinding).toBeUndefined();
    expect(run.providerBinding).toBeUndefined();
  });

  it('全局默认绑定：显式 global binding 透传到请求与 run 记录', async () => {
    const globalRequests: AgentRunRequest[] = [];
    const engine = new GoalEngine(makeAgent(globalRequests));

    const goal = engine.createGoal('调研全局绑定');
    await engine.generatePlan(goal.id);
    const globalBinding: ProviderProfileBinding = { source: 'global', profileId: PROFILE_A, model: 'deepseek-chat' };
    const run = await engine.executeGoal(goal.id, undefined, { providerBinding: globalBinding });

    expect(globalRequests[0]!.providerProfileBinding).toEqual(globalBinding);
    expect(run.providerBinding).toEqual(globalBinding);
  });
});
