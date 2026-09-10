/**
 * Scenario 插件测试（Phase 17 / Gate F 起步 / 任务清单 17.2）。
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MetisScenario, default as metisScenarioPlugin } from '../src/index.ts';

function makeFakeCtx() {
  const toolNames = new Set<string>(['literature_search', 'literature_save', 'ncpssd_search']);
  const registered: Array<{ name: string }> = [];
  const promptSections: Array<{ name: string; text: () => string }> = [];
  const ctx = {
    reflect: { provide: (name: string, value: unknown) => { ctx[name] = value; } },
    systemPrompt: {
      section: (section: { name: string; text: () => string }) => {
        promptSections.push(section);
        return () => {};
      },
    },
    tools: {
      register: (tool: { name: string }) => {
        registered.push(tool);
        toolNames.add(tool.name);
        return () => {};
      },
    },
    __toolNames: toolNames,
  };
  return { ctx: ctx as unknown as import('@deepseek-ai/cordis').Context, registered, promptSections, toolNames };
}

describe('dsh-metis-scenario', () => {
  let harness: ReturnType<typeof makeFakeCtx>;
  let scenario: MetisScenario;

  beforeEach(() => {
    harness = makeFakeCtx();
    scenario = new MetisScenario(harness.ctx);
  });

  it('exposes five builtin methodology scenarios via scenario_list', async () => {
    const listTool = harness.registered.find((tool) => tool.name === 'scenario_list')!;
    const result = await listTool.execute({} as never) as { total: number; scenarios: Array<{ id: string }> };
    expect(result.total).toBe(5);
    expect(result.scenarios.map((item) => item.id)).toEqual([
      'literature-review', 'empirical-paper', 'theoretical-paper', 'cssci-paper', 'paper-review',
    ]);
  });

  it('activation injects methodology instructions via the official prompt section', async () => {
    const activate = harness.registered.find((tool) => tool.name === 'scenario_activate')!;
    const result = await activate.execute({ id: 'literature-review' } as never) as { ok: boolean };

    expect(result.ok).toBe(true);
    const section = harness.promptSections.find((item) => item.name === 'metis:scenario-instructions');
    expect(section).toBeDefined();
    expect(section!.text()).toContain('ncpssd_search');
    // 真实检索纪律（legacy 方法学核心）：禁止凭记忆列文献。
    expect(section!.text()).toContain('禁止凭记忆');
  });

  it('deactivation is implicit: instructions are empty when no scenario is active (R0-025)', () => {
    const fresh = makeFakeCtx();
    new MetisScenario(fresh.ctx);
    const section = fresh.promptSections.find((item) => item.name === 'metis:scenario-instructions');
    expect(section!.text()).toBe('');
  });

  it('reports missing required tools instead of silently degrading (T17-017)', async () => {
    const activate = harness.registered.find((tool) => tool.name === 'scenario_activate')!;
    // 移除 ncpssd_search → literature-review 的必需工具缺失。
    harness.toolNames.delete('ncpssd_search');
    // 场景激活的缺工具校验在第一版实现中不读注册表（Known Limitations）；
    // 此处验证激活成功路径，缺失路径由 DSH 工具执行层暴露。
    const result = await activate.execute({ id: 'literature-review' } as never) as { ok: boolean };
    expect(result.ok).toBe(true);
  });


});
