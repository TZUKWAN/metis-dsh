import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import type { ChatMessage, NormalizedResponse, ProviderCapabilities, StreamChunk, ToolSpec } from '../../engine/core/types.js';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { OutcomePptGenerationService } from '../../electron/OutcomePptGenerationService.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';

class ControlledProvider extends BaseProvider {
  readonly calls: Array<{ messages: ChatMessage[]; tools: ToolSpec[] }> = [];
  constructor(private readonly response: string, private readonly onComplete?: () => void) { super(); }
  capabilities(): ProviderCapabilities {
    return { providerType: 'ppt-generation-test', model: 'ppt-generation-test-model', nativeToolCalling: false, jsonSchemaOutput: false, streaming: false, thinking: false, maxContextTokens: 32_000, maxOutputTokens: 4_096, retryableStatusCodes: [] };
  }
  async complete(messages: ChatMessage[], tools?: ToolSpec[]): Promise<NormalizedResponse> {
    this.calls.push({ messages: messages.map((message) => ({ ...message })), tools: [...(tools ?? [])] });
    this.onComplete?.();
    return { content: this.response, toolCalls: [], finishReason: 'stop', usage: { promptTokens: 40, completionTokens: 80, totalTokens: 120 } };
  }
  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> { /* deterministic non-streaming provider */ }
}

const skill = { id: 'skill-1', name: '证据型答辩', narrative: 'argument_evidence' as const, contentDensity: 'balanced' as const, audience: '评审专家', instructions: '先呈现问题与证据，再给出结论。' };
const template = { id: 'template-1', name: '学院答辩模板', definition: { theme: { primary: '#124D72', font: 'Aptos' } }, createdAt: 1, updatedAt: 1 };

function createLoop(provider: ControlledProvider): AgentLoop {
  const registry = new ToolRegistry();
  return new AgentLoop({ provider, registry, dispatcher: new ToolDispatcher(registry) });
}

describe('OutcomePptGenerationService', () => {
  let db: Database.Database;
  let repository: OutcomeRepository;
  beforeEach(() => {
    db = new Database(':memory:'); db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO projects (id,title,original_intent,research_question,lifecycle,methodology,discipline,metadata,created_at,updated_at,version,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('project-ppt', 'PPT 生成测试项目', '', '', 'active', '', '', '{}', 1, 1, 1, 'user');
    repository = new OutcomeRepository(db);
  });
  afterEach(() => db?.close());
  function createPpt(ratio: '16:9' | '4:3' = '16:9') {
    return repository.create({
      projectId: 'project-ppt', categoryId: null, title: '研究汇报', kind: 'ppt', note: '创建 PPT',
      content: { type: 'ppt', ratio, theme: { primary: '#000000' }, templateId: null, generationSkillId: null, pages: [{ id: 'slide-1', title: '封面', pageType: 'cover', humanModified: false, status: 'draft', elements: [] }] },
    });
  }
  function request(outcomeId: string, baseVersion = 1) {
    return { projectId: 'project-ppt', outcomeId, baseVersion, generationSkillId: skill.id, templateId: template.id, instruction: '围绕当前研究形成一页问题—证据—结论，并追加方法页。' };
  }
  function service(provider: ControlledProvider) {
    return new OutcomePptGenerationService({
      repository,
      agentLoop: createLoop(provider),
      modelName: provider.capabilities().model,
      providerProfileBinding: {
        source: 'project_override',
        profileId: 'profile-ppt-project',
        model: provider.capabilities().model,
        systemPrompt: 'project ppt system prompt',
      },
      skill,
      template,
    });
  }

  it('runs AgentLoop with the stored skill and template, then commits a constrained immutable AI PPT version', async () => {
    const created = createPpt();
    const provider = new ControlledProvider(JSON.stringify({
      answer: '已生成封面内容并补充方法页。',
      patch: {
        replacePages: [{ pageId: 'slide-1', title: '研究问题与核心证据', elements: [{ id: 'title-1', type: 'text', x: 3, y: 2, width: 20, height: 2, locked: false, props: { text: '研究问题与核心证据' } }] }],
        appendPages: [{ id: 'slide-2', title: '研究方法', pageType: 'method', elements: [{ id: 'method-1', type: 'text', x: 3, y: 3, width: 18, height: 3, locked: false, props: { text: '样本、方法与检验策略' } }] }],
        theme: { accent: '#F28E2B' }, note: '生成问题证据页与方法页',
      },
    }));

    const result = await service(provider).execute(request(created.outcome.id));

    expect(result).toMatchObject({ status: 'completed', model: 'ppt-generation-test-model', answer: '已生成封面内容并补充方法页。', applied: { version: { version: 2, createdBy: 'ai', note: '生成问题证据页与方法页' }, skill: { id: skill.id }, template: { id: template.id } } });
    if (result.status !== 'completed') throw new Error('PPT generation should complete');
    expect(result.applied.version.content).toMatchObject({
      type: 'ppt', templateId: template.id, generationSkillId: skill.id,
      theme: { primary: '#124D72', font: 'Aptos', accent: '#F28E2B' },
      pages: [
        { id: 'slide-1', title: '研究问题与核心证据', status: 'complete', elements: [{ id: 'title-1' }] },
        { id: 'slide-2', title: '研究方法', pageType: 'method', humanModified: false, status: 'complete', elements: [{ id: 'method-1' }] },
      ],
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.tools).toEqual([]);
    expect(provider.calls[0]?.messages.some((message) => message.content.includes('证据型答辩'))).toBe(true);
    const systemMessage = provider.calls[0]?.messages[0];
  expect(systemMessage?.role).toBe('system');
  expect(systemMessage?.content).toContain('PPT Generation Skill 执行器');
  expect(systemMessage?.content).toContain('project ppt system prompt');
    expect(provider.calls[0]?.messages.some((message) => message.content.includes('学院答辩模板'))).toBe(true);
    expect(repository.get('project-ppt', created.outcome.id)?.outcome.currentVersion).toBe(2);
    expect(repository.listConversation({ projectId: 'project-ppt', scope: 'outcome', outcomeId: created.outcome.id, scenarioId: null })).toMatchObject([
      { role: 'user', content: '围绕当前研究形成一页问题—证据—结论，并追加方法页。' },
      { role: 'assistant', content: '已生成封面内容并补充方法页。' },
    ]);
  });

  it('returns the real model protocol error without fabricating a PPT version', async () => {
    const created = createPpt(); const provider = new ControlledProvider('模型只返回自然语言，未提供 JSON patch。');
    const result = await service(provider).execute(request(created.outcome.id));
    expect(result).toMatchObject({ status: 'error', code: 'model_response_contract_error' });
    expect(repository.get('project-ppt', created.outcome.id)?.outcome.currentVersion).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });

  it('never overwrites a concurrent human version after the real model call', async () => {
    const created = createPpt();
    const provider = new ControlledProvider(JSON.stringify({ answer: 'AI PPT patch', patch: { replacePages: [{ pageId: 'slide-1', title: '不应覆盖' }], appendPages: [], note: 'AI 生成' } }), () => {
      repository.save({ projectId: 'project-ppt', outcomeId: created.outcome.id, baseVersion: 1, note: '人工保存', actor: 'human', sources: [], content: { type: 'ppt', ratio: '16:9', theme: {}, templateId: null, generationSkillId: null, pages: [{ id: 'slide-1', title: '人工新稿', pageType: 'cover', humanModified: true, status: 'complete', elements: [] }] } });
    });
    const result = await service(provider).execute(request(created.outcome.id));
    expect(result).toMatchObject({ status: 'error', code: 'outcome_version_conflict' });
    expect(repository.get('project-ppt', created.outcome.id)?.version.content).toMatchObject({ type: 'ppt', pages: [{ id: 'slide-1', title: '人工新稿' }] });
  });

  it('rejects a stale base version before calling the Provider or creating conversation history', async () => {
    const created = createPpt(); const provider = new ControlledProvider('{"answer":"不应调用","patch":{"theme":{},"note":"不应调用"}}');
    const result = await service(provider).execute(request(created.outcome.id, 2));
    expect(result).toMatchObject({ status: 'error', code: 'outcome_version_conflict' });
    expect(provider.calls).toHaveLength(0);
    expect(repository.listConversation({ projectId: 'project-ppt', scope: 'outcome', outcomeId: created.outcome.id, scenarioId: null })).toEqual([]);
  });

  it('uses the 4:3 24×18 grid in the actual prompt and rejects an overflowing model patch', async () => {
    const created = createPpt('4:3');
    const provider = new ControlledProvider(JSON.stringify({
      answer: '生成了一页。',
      patch: { replacePages: [{ pageId: 'slide-1', elements: [{ id: 'overflow-1', type: 'text', x: 20, y: 2, width: 6, height: 2, locked: false, props: { text: '会被裁切' } }] }], appendPages: [], note: '越界测试' },
    }));
    const result = await service(provider).execute(request(created.outcome.id));
    expect(result).toMatchObject({ status: 'error', code: 'model_response_contract_error' });
    expect(repository.get('project-ppt', created.outcome.id)?.outcome.currentVersion).toBe(1);
    expect(provider.calls[0]?.messages.some((message) => message.content.includes('24×18 PPT Grid'))).toBe(true);
  });

  // 回归（2026-08-22 外部 Provider E2E 实证）：真实推理模型自然输出小数
  // 坐标（如 height:1.4）。产品保持整数 Grid 不变式，模型提议由服务对齐：
  // 四舍五入 + 夹紧边界后再走契约校验，而不是整体拒绝合法 patch。
  it('snaps real-model fractional and out-of-range coordinates onto the integer grid', async () => {
    const created = createPpt();
    const provider = new ControlledProvider(JSON.stringify({
      answer: '已新增研究方法与预期结论两页。',
      patch: {
        replacePages: [],
        appendPages: [
          { id: 'slide-method', title: '研究方法', pageType: 'content', elements: [
            { id: 'method-title', type: 'text', x: 2, y: 1, width: 28, height: 1.4, locked: false, props: { text: '研究方法' } },
          ] },
          { id: 'slide-conclusion', title: '预期结论', pageType: 'content', elements: [
            { id: 'conclusion-body', type: 'text', x: 1.6, y: 2.5, width: 29.8, height: 0.4, locked: false, props: { text: '预期结论' } },
          ] },
        ],
        note: '真实模型小数坐标对齐',
      },
    }));
    const result = await service(provider).execute(request(created.outcome.id));
    expect(result).toMatchObject({ status: 'completed' });
    if (result.status !== 'completed') throw new Error('PPT generation should complete');
    const stored = repository.get('project-ppt', created.outcome.id)?.version.content;
    expect(stored).toMatchObject({
      type: 'ppt',
      pages: [
        { id: 'slide-1' },
        { id: 'slide-method', elements: [{ id: 'method-title', x: 2, y: 1, width: 28, height: 1 }] },
        { id: 'slide-conclusion', elements: [{ id: 'conclusion-body', x: 2, y: 3, width: 30, height: 1 }] },
      ],
    });
    expect(stored?.type === 'ppt' && stored.pages.every((page) => page.elements.every((element) => Number.isInteger(element.x) && Number.isInteger(element.y) && Number.isInteger(element.width) && Number.isInteger(element.height)))).toBe(true);
  });
});
