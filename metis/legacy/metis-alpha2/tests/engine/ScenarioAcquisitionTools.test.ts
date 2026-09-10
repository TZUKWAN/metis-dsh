import { describe, expect, it } from 'vitest';
import {
  SCENARIO_INSTALL_LIMIT,
  SCENARIO_MARKET_SEARCH_TOOL_NAME,
  SCENARIO_INSTALL_EXTENSION_TOOL_NAME,
  createScenarioMarketSearchRouter,
  createScenarioInstallRouter,
  type ScenarioInstallerBinding,
} from '../../engine/tools/builtin/scenario-acquisition-tools.js';
import { buildScenarioPhasePrompt } from '../../engine/personalization/ScenarioHarnessCompiler.js';
import type { ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';

function contextOf(sessionId: string): { sessionId: string } {
  return { sessionId };
}

describe('scenario_market_search tool', () => {
  it('returns compact items on success', async () => {
    const router = createScenarioMarketSearchRouter(async () => ({
      ok: true,
      items: [{ name: 'x'.repeat(300), owner: 'o', repo: 'r', description: 'd'.repeat(500), url: 'https://github.com/o/r', installable: true, stars: '5', source: 'github' }],
    }));
    const raw = await router.handler({ kind: 'mcp', query: 'scraper' }, contextOf('s1'));
    const parsed = JSON.parse(raw) as { ok: boolean; items: Array<Record<string, unknown>> };
    expect(parsed.ok).toBe(true);
    expect((parsed.items[0]!.description as string).length).toBeLessThanOrEqual(300);
    expect(typeof parsed.items[0]!.stars).toBe('number');
  });

  it('falls back across sources and reports failure honestly when all fail', async () => {
    const tried: string[] = [];
    const router = createScenarioMarketSearchRouter(async (_kind, _query, source) => {
      tried.push(source);
      return { ok: false, code: 'not_found' };
    });
    const raw = await router.handler({ kind: 'skill', query: 'latex', source: 'skillsmp' }, contextOf('s1'));
    const parsed = JSON.parse(raw) as { ok: boolean; sourcesTried: string[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.sourcesTried).toContain('skillsmp');
    expect(tried.length).toBeGreaterThan(1);
  });

  it('rejects empty queries without calling the service', async () => {
    let called = 0;
    const router = createScenarioMarketSearchRouter(async () => { called += 1; return { ok: true, items: [] }; });
    const raw = await router.handler({ kind: 'skill', query: '   ' }, contextOf('s1'));
    expect(JSON.parse(raw).ok).toBe(false);
    expect(called).toBe(0);
  });
});

describe('scenario_install_extension tool', () => {
  function okApply(): { binding: ScenarioInstallerBinding; calls: Array<Record<string, unknown>> } {
    const calls: Array<Record<string, unknown>> = [];
    const binding: ScenarioInstallerBinding = {
      apply: async (request) => {
        calls.push(request);
        return { ok: true, mode: String(request.mode), definition: { id: 'user:skills/new-skill', name: '新技能' } };
      },
      notifications: new Map(),
    };
    return { binding, calls };
  }

  it('rejects non-https URLs before touching the installer', async () => {
    const { binding, calls } = okApply();
    const router = createScenarioInstallRouter(binding);
    const raw = await router.handler({ kind: 'skill', url: 'http://github.com/o/r' }, contextOf('s1'));
    expect(JSON.parse(raw).error).toBe('https_only');
    expect(calls.length).toBe(0);
  });

  it('installs a skill via skill_url with evidence context and reports the definition id', async () => {
    const { binding, calls } = okApply();
    const router = createScenarioInstallRouter(binding);
    const raw = await router.handler({ kind: 'skill', url: 'https://github.com/owner/repo', reason: '步骤2需要' }, contextOf('s1'));
    const parsed = JSON.parse(raw) as { ok: boolean; definition: { id: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.definition.id).toContain('new-skill');
    const request = calls[0]!;
    expect(request.mode).toBe('skill_url');
    expect(request.evidenceContext).toBeTruthy();
  });

  it('builds a managed mcp_url request with url:mcp/ identity for manifests', async () => {
    const { binding, calls } = okApply();
    const router = createScenarioInstallRouter(binding);
    const raw = await router.handler({ kind: 'mcp', url: 'https://example.com/packages/demo/manifest.json' }, contextOf('s1'));
    const parsed = JSON.parse(raw) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(String(calls[0]!.definitionId)).toMatch(/^url:mcp\//u);
    expect(calls[0]!.manifestUrl).toBe('https://example.com/packages/demo/manifest.json');
  });

  it('enforces the per-session install limit', async () => {
    const { binding } = okApply();
    const router = createScenarioInstallRouter(binding);
    for (let index = 0; index < SCENARIO_INSTALL_LIMIT; index += 1) {
      const raw = await router.handler({ kind: 'skill', url: `https://github.com/o/r${index}` }, contextOf('limit-session'));
      expect(JSON.parse(raw).ok).toBe(true);
    }
    const overflow = await router.handler({ kind: 'skill', url: 'https://github.com/o/extra' }, contextOf('limit-session'));
    expect(JSON.parse(overflow).error).toBe('install_limit_reached');
    // 其他会话不受影响。
    const otherSession = await router.handler({ kind: 'skill', url: 'https://github.com/o/other-session' }, contextOf('another'));
    expect(JSON.parse(otherSession).ok).toBe(true);
  });

  it('routes installation notifications and counter cleanup to only the matching compile session', async () => {
    const { binding } = okApply();
    const router = createScenarioInstallRouter(binding);
    const notificationsA: string[] = [];
    const notificationsB: string[] = [];
    const listenerA = (message: { installedId: string }) => { notificationsA.push(message.installedId); };
    const listenerB = (message: { installedId: string }) => { notificationsB.push(message.installedId); };
    binding.notifications.set('session-a', listenerA);
    binding.notifications.set('session-b', listenerB);

    const [resultA, resultB] = await Promise.all([
      router.handler({ kind: 'skill', url: 'https://github.com/o/a' }, contextOf('session-a')),
      router.handler({ kind: 'skill', url: 'https://github.com/o/b' }, contextOf('session-b')),
    ]);
    expect(JSON.parse(resultA).ok).toBe(true);
    expect(JSON.parse(resultB).ok).toBe(true);
    expect(notificationsA).toEqual(['user:skills/new-skill']);
    expect(notificationsB).toEqual(['user:skills/new-skill']);

    // A's completion only removes A's callback and counter; B remains capped and notified.
    for (let index = 1; index < SCENARIO_INSTALL_LIMIT; index += 1) {
      expect(JSON.parse(await router.handler({ kind: 'skill', url: `https://github.com/o/b-${index}` }, contextOf('session-b'))).ok).toBe(true);
    }
    if (binding.notifications.get('session-a') === listenerA) binding.notifications.delete('session-a');
    router.clearSessionCounter('session-a');
    expect(JSON.parse(await router.handler({ kind: 'skill', url: 'https://github.com/o/a-again' }, contextOf('session-a'))).ok).toBe(true);
    expect(JSON.parse(await router.handler({ kind: 'skill', url: 'https://github.com/o/b-overflow' }, contextOf('session-b'))).error).toBe('install_limit_reached');
    expect(notificationsA).toEqual(['user:skills/new-skill']);
    expect(notificationsB).toHaveLength(SCENARIO_INSTALL_LIMIT);
  });

  it('reports installer failure codes verbatim', async () => {
    const binding: ScenarioInstallerBinding = {
      apply: async () => ({ ok: false, code: 'digest_mismatch', detailCode: 'sha256' }),
      notifications: new Map(),
    };
    const router = createScenarioInstallRouter(binding);
    const raw = await router.handler({ kind: 'skill', url: 'https://github.com/o/r' }, contextOf('s1'));
    const parsed = JSON.parse(raw) as { ok: boolean; code: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('digest_mismatch');
  });

  it('exposes stable tool names', () => {
    expect(SCENARIO_MARKET_SEARCH_TOOL_NAME).toBe('scenario_market_search');
    expect(SCENARIO_INSTALL_EXTENSION_TOOL_NAME).toBe('scenario_install_extension');
  });
});

describe('buildScenarioPhasePrompt', () => {
  const definitions: never[] = [];
  const base = {
    instruction: '构建一个博士后基金申报书场景',
    definitions,
    materialContext: [],
  };

  function fakeScenario(): ScenarioDefinition {
    return { id: 'user:scenario/x', kind: 'scenario', workflow: [] } as unknown as ScenarioDefinition;
  }

  it('contains research-before-writing policy in every phase', () => {
    for (const phase of ['basics', 'deliverable', 'workflow', 'rules', 'output_plan'] as const) {
      const prompt = buildScenarioPhasePrompt({ ...base, phase, current: fakeScenario() });
      expect(prompt.system).toContain('RESEARCH-BEFORE-WRITING');
      expect(prompt.system).toContain('web_search');
    }
  });

  it('contains acquisition + install policy', () => {
    const prompt = buildScenarioPhasePrompt({ ...base, phase: 'workflow', current: fakeScenario() });
    expect(prompt.system).toContain('scenario_market_search');
    expect(prompt.system).toContain('scenario_install_extension');
    expect(prompt.system).toContain('Never invent IDs');
  });

  it('states the phase goal and includes catalog + current scenario', () => {
    const prompt = buildScenarioPhasePrompt({ ...base, phase: 'rules', current: fakeScenario() });
    expect(prompt.system).toContain('场景规则');
    expect(prompt.system).toContain('scenarioMetis.markdown');
    expect(prompt.user).toContain('Installed resource catalog');
    expect(prompt.user).toContain('rules');
  });

  it('includes uploaded materials when provided', () => {
    const prompt = buildScenarioPhasePrompt({
      ...base, phase: 'basics', current: fakeScenario(),
      materialContext: [{ name: '指南.pdf', text: '申报书要求正文不少于 7500 字。' }],
    });
    expect(prompt.user).toContain('指南.pdf');
  });
});
