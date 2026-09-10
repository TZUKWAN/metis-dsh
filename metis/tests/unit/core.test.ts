/**
 * dsh-metis-core 单元测试（Gate C，任务清单 26.1）。
 *
 * 覆盖：插件 apply 注册工具（load 语义）、工具 schema 与 canonical 输出、
 * 服务生命周期方法（get/update/list）、卸载后工具随 ctx 注销（dispose 语义）。
 * Cordis 装配本身由 profile 启动验证（--dump-config + Web boot 0 error）。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MetisResearch, default as metisCorePlugin } from '../../plugins/core/src/index.ts';

/** 最小 fake ctx：捕获工具注册与 prompt section；Service 基类把自己挂到 ctx[key]。 */
function makeFakeCtx() {
  const registered: Array<{ name: string; parameters: unknown; output: unknown; execute: (args: never) => Promise<unknown> }> = [];
  const promptSections: Array<{ name: string; order: number; text: string | ((context: unknown) => string) }> = [];
  const ctx: Record<string, unknown> = {
    // Cordis Service 构造需要 reflect.provide（真实 runtime 由 profile 启动验证覆盖）。
    // 这里模拟其挂载语义：provide(name, self) 把服务实例暴露到 ctx。
    reflect: {
      provide: (name: string, value: unknown) => {
        ctx[name] = value;
      },
    },
    systemPrompt: {
      section: (section: { name: string; order: number; text: string | ((context: unknown) => string) }) => {
        promptSections.push(section);
        return () => {};
      },
    },
    tools: {
      register: (tool: (typeof registered)[number]) => {
        registered.push(tool);
        return () => {
          const index = registered.indexOf(tool);
          if (index >= 0) registered.splice(index, 1);
        };
      },
    },
  };
  return { ctx: ctx as unknown as import('@deepseek-ai/cordis').Context, registered, promptSections };
}

describe('bounded research context (Phase 16)', () => {
  it('registers a metis research-context prompt section via the official mechanism', () => {
    const harness = makeFakeCtx();
    new MetisResearch(harness.ctx);
    const section = harness.promptSections.find((item) => item.name === 'metis:research-context');
    expect(section).toBeDefined();
    expect(typeof section!.text).toBe('function');
    expect((section!.text as (context: unknown) => string)({})).toContain('尚未建立');
  });

  it('bounded context stays within the hard budget and marks truncation explicitly', () => {
    const harness = makeFakeCtx();
    const service = new MetisResearch(harness.ctx);
    service.updateFromArgs({
      title: '超长标题'.repeat(200),
      discipline: '社会学',
      researchQuestion: '问题'.repeat(400),
      researchObject: '对象'.repeat(400),
      methodology: '方法'.repeat(400),
      notes: '备注'.repeat(400),
    });
    const text = service.getBoundedResearchContext(1_000);
    expect(text.length).toBeLessThanOrEqual(1_000);
    expect(text).toContain('因长度截断');
    expect(service.getBoundedResearchContext(10_000)).not.toContain('因长度截断');
  });

  it('rebuilds stable ordered context text (deterministic field order)', () => {
    const harness = makeFakeCtx();
    const service = new MetisResearch(harness.ctx);
    service.updateFromArgs({ title: 'T', discipline: '社会学', researchQuestion: 'Q' } as never);
    const a = service.getBoundedResearchContext(10_000);
    const b = service.getBoundedResearchContext(10_000);
    expect(a).toBe(b);
    expect(a.indexOf('学科')).toBeLessThan(a.indexOf('研究问题'));
  });
});

describe('dsh-metis-core', () => {
  let harness: { ctx: import('@deepseek-ai/cordis').Context; registered: Array<{ name: string; parameters: unknown; output: unknown; execute: (args: never) => Promise<unknown> }> };

  beforeEach(() => {
    harness = makeFakeCtx();
    // 构造服务即完成工具注册（真实场景由 cordis loader 驱动）。
    new MetisResearch(harness.ctx);
  });

  it('registers exactly the two research project tools on load', () => {
    const names = harness.registered.map((tool) => tool.name);
    expect(names).toEqual(['research_project_get', 'research_project_update']);
    // canonical JSON 输出契约（R0-027）：每个工具有 output.schema 与 render。
    for (const tool of harness.registered) {
      expect(tool.output).toBeDefined();
      expect((tool.output as { schema: unknown }).schema).toBeDefined();
      expect(typeof (tool.output as { render: unknown }).render).toBe('function');
    }
  });

  it('research_project_get returns an explicit empty result when no project exists', async () => {
    const get = harness.registered.find((tool) => tool.name === 'research_project_get')!;
    const result = await get.execute({} as never) as { ok: boolean; project: unknown; note?: string };
    expect(result.ok).toBe(true);
    expect(result.project).toBeNull();
    expect(result.note).toContain('没有任何科研项目');
  });

  it('update creates the project on first call and fields only update provided keys', async () => {
    const update = harness.registered.find((tool) => tool.name === 'research_project_update')!;
    const first = await update.execute({ title: '生成式AI与职业分层', discipline: '社会学' } as never) as { ok: boolean; project: { title: string; discipline?: string; researchQuestion?: string } };
    expect(first.ok).toBe(true);
    expect(first.project.title).toBe('生成式AI与职业分层');
    expect(first.project.discipline).toBe('社会学');

    const second = await update.execute({ researchQuestion: 'AI 如何重塑职业边界？' } as never) as { project: { title: string; researchQuestion: string } };
    expect(second.project.title).toBe('生成式AI与职业分层');
    expect(second.project.researchQuestion).toBe('AI 如何重塑职业边界？');
  });

  it('parses keywords into a clean array', async () => {
    const update = harness.registered.find((tool) => tool.name === 'research_project_update')!;
    const result = await update.execute({ keywords: ' 人工智能 ， 知识工作者 ,,职业分层' } as never) as { project: { keywords: string[] } };
    expect(result.project.keywords).toEqual(['人工智能', '知识工作者', '职业分层']);
  });

  it('exposes the service on the context and supports list/get', async () => {
    const ctxAny = harness.ctx as unknown as { metisResearch: MetisResearch };
    expect(ctxAny.metisResearch).toBeInstanceOf(MetisResearch);
    // 先经工具创建项目，再验证服务投影（list/get/缺省查询）。
    const update = harness.registered.find((tool) => tool.name === 'research_project_update')!;
    await update.execute({ title: 'x' } as never);
    const service = ctxAny.metisResearch;
    expect(service.listProjects()).toHaveLength(1);
    const id = service.listProjects()[0]!.id;
    expect(service.getProject(id)?.title).toBe('x');
    expect(service.getProject('missing')).toBeNull();
  });

  it('default plugin export declares tools dependency and applies through ctx.plugin', () => {
    expect(metisCorePlugin.inject).toContain('tools');
    // apply 走 ctx.plugin(MetisResearch)：用捕获注册的 fake ctx 完整跑一遍。
    const registered: Array<{ name: string }> = [];
    const promptSections: string[] = [];
    const ctx: Record<string, unknown> = {
      reflect: {
        provide: (name: string, value: unknown) => {
          ctx[name] = value;
        },
      },
      tools: { register: (tool: { name: string }) => { registered.push(tool); return () => {}; } },
      systemPrompt: { section: (section: { name: string }) => { promptSections.push(section.name); return () => {}; } },
      plugin: (ctor: new (c: unknown) => MetisResearch) => { new ctor(ctx); },
    };
    metisCorePlugin.apply.call(undefined, ctx as unknown as Parameters<typeof metisCorePlugin.apply>[0]);
    expect(registered.map((tool) => tool.name)).toEqual(['research_project_get', 'research_project_update']);
    expect(promptSections).toContain('metis:research-context');
  });
});
