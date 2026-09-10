import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import type { ChatMessage, NormalizedResponse, ProviderCapabilities, StreamChunk, ToolSpec } from '../../engine/core/types.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import { OutcomeAssistantService } from '../../electron/OutcomeAssistantService.js';
import { OutcomeProjectContextService } from '../../electron/OutcomeProjectContextService.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';

class ControlledProvider extends BaseProvider {
  readonly calls: Array<{ messages: ChatMessage[]; tools: ToolSpec[] }> = [];
  constructor(
    private readonly response: string,
    private readonly onComplete?: () => void,
  ) { super(); }

  capabilities(): ProviderCapabilities {
    return {
      providerType: 'ControlledProvider', model: 'outcome-assistant-test-model', nativeToolCalling: false,
      jsonSchemaOutput: false, streaming: false, thinking: false, maxContextTokens: 32_000,
      maxOutputTokens: 4_096, retryableStatusCodes: [],
    };
  }

  async complete(messages: ChatMessage[], tools?: ToolSpec[]): Promise<NormalizedResponse> {
    this.calls.push({ messages: messages.map((message) => ({ ...message })), tools: [...(tools ?? [])] });
    this.onComplete?.();
    return {
      content: this.response,
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 12, completionTokens: 24, totalTokens: 36 },
    };
  }

  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> { /* non-streaming test provider */ }
}

function createLoop(provider: ControlledProvider): AgentLoop {
  const registry = new ToolRegistry();
  return new AgentLoop({ provider, registry, dispatcher: new ToolDispatcher(registry) });
}

describe('OutcomeAssistantService', () => {
  let db: Database.Database;
  let repository: OutcomeRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO projects (id,title,original_intent,research_question,lifecycle,methodology,discipline,metadata,created_at,updated_at,version,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('project-a', '成果项目', '', '', 'active', '', '', '{}', 1, 1, 1, 'user');
    db.prepare('INSERT INTO projects (id,title,original_intent,research_question,lifecycle,methodology,discipline,metadata,created_at,updated_at,version,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('project-b', '隔离项目', '', '', 'active', '', '', '{}', 1, 1, 1, 'user');
    repository = new OutcomeRepository(db);
  });

  afterEach(() => { if (db) db.close(); });

  function createWord() {
    return repository.create({
      projectId: 'project-a', categoryId: null, title: '研究报告', kind: 'word', note: '创建成果',
      content: {
        type: 'word',
        blocks: [{ id: 'p-1', kind: 'paragraph', text: '原始段落', style: { fontSize: 12 } }],
        page: {}, header: '', footer: '',
      },
    });
  }

  function createPpt() {
    return repository.create({
      projectId: 'project-a', categoryId: null, title: '研究汇报', kind: 'ppt', note: '创建 PPT 成果',
      content: {
        type: 'ppt', ratio: '16:9', theme: { primary: '#102A43' }, templateId: null, generationSkillId: null,
        pages: [{
          id: 'slide-1', title: '研究发现', pageType: 'content', humanModified: false, status: 'complete',
          elements: [
            { id: 'focus-title', type: 'text', x: 3, y: 2, width: 18, height: 2, locked: false, props: { text: '原始研究标题', fontSize: 28 } },
            { id: 'evidence', type: 'rect', x: 3, y: 6, width: 20, height: 6, locked: false, props: { fill: '#EAF2F8', label: '证据卡片不能被本次修改' } },
          ],
        }],
      },
    });
  }

  it('runs the real AgentLoop, persists scoped messages, and commits a validated Word AI version', async () => {
    const created = createWord();
    const provider = new ControlledProvider(JSON.stringify({
      answer: '已将该段落改为更清晰的表述。',
      edit: {
        kind: 'word',
        replacements: [{ blockId: 'p-1', text: '更新后的学术段落。', style: { bold: true } }],
        note: '精炼首段表述',
      },
    }));
    const service = new OutcomeAssistantService({
      repository,
      agentLoop: createLoop(provider),
      modelName: provider.capabilities().model,
      providerProfileBinding: {
        source: 'project_override',
        profileId: 'profile-outcome-project',
        model: provider.capabilities().model,
        systemPrompt: 'project outcome system prompt',
      },
    });

    const result = await service.chat({
      projectId: 'project-a', outcomeId: created.outcome.id, instruction: '精炼当前段落。',
      selection: { type: 'word_block', blockId: 'p-1', start: 0, end: 4 },
    });

    expect(result.status).toBe('completed');
    expect(result).toMatchObject({
      model: 'outcome-assistant-test-model',
      answer: '已将该段落改为更清晰的表述。',
      applied: { version: { version: 2, createdBy: 'ai', note: '精炼首段表述' } },
    });
    expect(repository.get('project-a', created.outcome.id)?.version.content).toMatchObject({
      type: 'word', blocks: [{ id: 'p-1', text: '更新后的学术段落。', style: { fontSize: 12, bold: true } }],
    });
    expect(repository.listConversation({ projectId: 'project-a', scope: 'outcome', outcomeId: created.outcome.id, scenarioId: null }))
      .toMatchObject([
        { role: 'user', content: '精炼当前段落。' },
        { role: 'assistant', content: '已将该段落改为更清晰的表述。' },
      ]);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.tools).toEqual([]);
    expect(provider.calls[0]?.messages.some((message) => message.content.includes('原始段落'))).toBe(true);
    const systemMessage = provider.calls[0]?.messages[0];
  expect(systemMessage?.role).toBe('system');
  expect(systemMessage?.content).toContain('METIS 成果协同助手');
  expect(systemMessage?.content).toContain('project outcome system prompt');
  });

  it('keeps a genuine non-protocol model reply as conversation text without fabricating an edit', async () => {
    const created = createWord();
    const provider = new ControlledProvider('这是模型的真实自然语言回答，不是编辑协议 JSON。');
    const service = new OutcomeAssistantService({ repository, agentLoop: createLoop(provider), modelName: 'controlled' });

    const result = await service.chat({ projectId: 'project-a', outcomeId: created.outcome.id, instruction: '解释一下怎么改。' });

    expect(result).toMatchObject({
      status: 'completed', answer: '这是模型的真实自然语言回答，不是编辑协议 JSON。',
      diagnostics: [{ code: 'model_response_not_structured' }],
    });
    expect('applied' in result).toBe(false);
    expect(repository.get('project-a', created.outcome.id)?.outcome.currentVersion).toBe(1);
    expect(repository.listConversation({ projectId: 'project-a', scope: 'outcome', outcomeId: created.outcome.id, scenarioId: null }))
      .toMatchObject([{ role: 'user' }, { role: 'assistant', content: '这是模型的真实自然语言回答，不是编辑协议 JSON。' }]);
  });

  it('extracts the edit protocol from a mixed reasoning-plus-JSON reply and applies it', async () => {
    const created = createWord();
    const protocol = JSON.stringify({
      answer: '已完成改写。',
      edit: { kind: 'word', replacements: [{ blockId: 'p-1', text: '改写后的段落。' }], note: '按用户要求改写' },
    });
    const mixed = `我先分析一下这段文字的问题：原句表达冗长，术语使用不准确。\n经过权衡，我决定保留术语但压缩修饰。\n${protocol}`;
    const provider = new ControlledProvider(mixed);
    const service = new OutcomeAssistantService({ repository, agentLoop: createLoop(provider), modelName: 'controlled' });

    const result = await service.chat({
      projectId: 'project-a', outcomeId: created.outcome.id, instruction: '改写所选段落。',
      selection: { type: 'word_block', blockId: 'p-1', start: 0, end: 4 },
    });

    expect(result.status).toBe('completed');
    expect(result).toMatchObject({ answer: '已完成改写。', applied: { version: { version: 2, createdBy: 'ai' } } });
    expect(repository.get('project-a', created.outcome.id)?.version.content).toMatchObject({
      blocks: [{ id: 'p-1', text: '改写后的段落。' }],
    });
  });

  it('clips an overlong reasoning-only reply so the local popover stays readable', async () => {
    const created = createWord();
    const provider = new ControlledProvider(`这段选文的论证结构需要推敲。${'模型继续展开了很多没有结论的思考内容。'.repeat(80)}`);
    const service = new OutcomeAssistantService({ repository, agentLoop: createLoop(provider), modelName: 'controlled' });

    const result = await service.chat({ projectId: 'project-a', outcomeId: created.outcome.id, instruction: '改写所选段落。' });

    expect(result.status).toBe('completed');
    expect('applied' in result).toBe(false);
    expect(result.answer.length).toBeLessThanOrEqual(640);
    expect(result.answer).toContain('回答过长已截断');
    expect(result.diagnostics?.some((item) => item.code === 'model_response_not_structured')).toBe(true);
    expect(repository.get('project-a', created.outcome.id)?.outcome.currentVersion).toBe(1);
  });

  it('does not overwrite a human version created while the real model call is in flight', async () => {
    const created = createWord();
    const provider = new ControlledProvider(JSON.stringify({
      answer: '我准备应用修改。',
      edit: { kind: 'word', replacements: [{ blockId: 'p-1', text: 'AI 稿' }], note: 'AI 修改' },
    }), () => {
      repository.save({
        projectId: 'project-a', outcomeId: created.outcome.id, baseVersion: 1,
        content: { type: 'word', blocks: [{ id: 'p-1', kind: 'paragraph', text: '人工新稿' }], page: {}, header: '', footer: '' },
        note: '人工保存', actor: 'human', sources: [],
      });
    });
    const service = new OutcomeAssistantService({ repository, agentLoop: createLoop(provider), modelName: 'controlled' });

    const result = await service.chat({ projectId: 'project-a', outcomeId: created.outcome.id, instruction: '改写正文。' });

    expect(result).toMatchObject({ status: 'completed', diagnostics: [{ code: 'outcome_version_conflict' }] });
    expect('applied' in result).toBe(false);
    expect(repository.get('project-a', created.outcome.id)?.version.content).toMatchObject({
      type: 'word', blocks: [{ id: 'p-1', text: '人工新稿' }],
    });
  });

  it('rejects a stale selection before dispatching a provider call or creating a conversation message', async () => {
    const created = createWord();
    const provider = new ControlledProvider('{"answer":"不应被调用","edit":null}');
    const service = new OutcomeAssistantService({ repository, agentLoop: createLoop(provider), modelName: 'controlled' });

    const result = await service.chat({
      projectId: 'project-a', outcomeId: created.outcome.id, instruction: '改写。',
      selection: { type: 'word_block', blockId: 'missing-block' },
    });

    expect(result).toMatchObject({ status: 'error', code: 'edit_target_not_found' });
    expect(provider.calls).toHaveLength(0);
    expect(repository.listConversation({ projectId: 'project-a', scope: 'outcome', outcomeId: created.outcome.id, scenarioId: null })).toEqual([]);
  });

  it('resolves the persisted PPT element into the real AgentLoop prompt and commits only that element', async () => {
    const created = createPpt();
    const provider = new ControlledProvider(JSON.stringify({
      answer: '已将选中的标题改为更清晰的表述。',
      edit: {
        kind: 'ppt',
        replacePage: {
          pageId: 'slide-1',
          elements: [
            { id: 'focus-title', type: 'text', x: 3, y: 2, width: 18, height: 2, locked: false, props: { text: '更新后的研究标题', fontSize: 28 } },
            { id: 'evidence', type: 'rect', x: 3, y: 6, width: 20, height: 6, locked: false, props: { fill: '#EAF2F8', label: '证据卡片不能被本次修改' } },
          ],
        },
        note: '精炼标题',
      },
    }));
    const service = new OutcomeAssistantService({ repository, agentLoop: createLoop(provider), modelName: 'controlled' });

    const result = await service.chat({
      projectId: 'project-a', outcomeId: created.outcome.id, instruction: '精炼这个标题。',
      selection: { type: 'ppt_element', pageId: 'slide-1', elementId: 'focus-title' },
    });

    expect(result).toMatchObject({
      status: 'completed',
      applied: { version: { version: 2, createdBy: 'ai' } },
    });
    expect(result.sources.some((source) => source.kind === 'selection' && source.id === 'focus-title')).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.messages.some((message) => message.content.includes('当前选区（PPT page slide-1，element focus-title）'))).toBe(true);
    expect(provider.calls[0]?.messages.some((message) => message.content.includes('原始研究标题'))).toBe(true);
    expect(repository.get('project-a', created.outcome.id)?.version.content).toMatchObject({
      type: 'ppt', pages: [{ elements: [
        { id: 'focus-title', props: { text: '更新后的研究标题' } },
        { id: 'evidence', props: { label: '证据卡片不能被本次修改' } },
      ] }],
    });
  });

  it('rejects a page-level PPT edit when the request selected a single persisted element', async () => {
    const created = createPpt();
    const provider = new ControlledProvider(JSON.stringify({
      answer: '我尝试重写整页。',
      edit: { kind: 'ppt', replacePage: { pageId: 'slide-1', title: '不应被改写的整页标题' }, note: '错误整页修改' },
    }));
    const service = new OutcomeAssistantService({ repository, agentLoop: createLoop(provider), modelName: 'controlled' });

    const result = await service.chat({
      projectId: 'project-a', outcomeId: created.outcome.id, instruction: '只改这个标题。',
      selection: { type: 'ppt_element', pageId: 'slide-1', elementId: 'focus-title' },
    });

    expect(result).toMatchObject({ status: 'completed', diagnostics: [{ code: 'edit_target_unsupported' }] });
    expect('applied' in result).toBe(false);
    expect(repository.get('project-a', created.outcome.id)?.outcome.currentVersion).toBe(1);
    const content2 = repository.get('project-a', created.outcome.id)?.version.content;
    expect(content2).toMatchObject({ type: 'ppt' });
    const page2 = content2?.pages.find((page) => page.id === 'slide-1');
    expect(page2?.title).toBe('研究发现');
    expect(page2?.elements.some((element) => element.id === 'focus-title' && element.props?.text === '原始研究标题')).toBe(true);
  });

  it('rejects a PPT element request whose proposed page also changes an unselected element', async () => {
    const created = createPpt();
    const provider = new ControlledProvider(JSON.stringify({
      answer: '我同时改了标题和证据卡片。',
      edit: {
        kind: 'ppt',
        replacePage: {
          pageId: 'slide-1',
          elements: [
            { id: 'focus-title', type: 'text', x: 3, y: 2, width: 18, height: 2, locked: false, props: { text: '更新后的研究标题', fontSize: 28 } },
            { id: 'evidence', type: 'rect', x: 3, y: 6, width: 20, height: 6, locked: false, props: { fill: '#EAF2F8', label: '不应变化的证据卡片' } },
          ],
        },
        note: '越权修改多个元素',
      },
    }));
    const service = new OutcomeAssistantService({ repository, agentLoop: createLoop(provider), modelName: 'controlled' });

    const result = await service.chat({
      projectId: 'project-a', outcomeId: created.outcome.id, instruction: '只改这个标题。',
      selection: { type: 'ppt_element', pageId: 'slide-1', elementId: 'focus-title' },
    });

    expect(result).toMatchObject({ status: 'completed', diagnostics: [{ code: 'edit_target_unsupported' }] });
    expect('applied' in result).toBe(false);
    expect(repository.get('project-a', created.outcome.id)?.outcome.currentVersion).toBe(1);
    const content3 = repository.get('project-a', created.outcome.id)?.version.content;
    expect(content3).toMatchObject({ type: 'ppt' });
    expect(content3?.pages.some((page) => page.elements.some((element) => element.id === 'evidence' && element.props?.label === '证据卡片不能被本次修改'))).toBe(true);
  });

  it('rejects a missing PPT element before dispatching a provider call or writing conversation history', async () => {
    const created = createPpt();
    const provider = new ControlledProvider('{"answer":"不应被调用","edit":null}');
    const service = new OutcomeAssistantService({ repository, agentLoop: createLoop(provider), modelName: 'controlled' });

    const result = await service.chat({
      projectId: 'project-a', outcomeId: created.outcome.id, instruction: '改写。',
      selection: { type: 'ppt_element', pageId: 'slide-1', elementId: 'missing-element' },
    });

    expect(result).toMatchObject({ status: 'error', code: 'edit_target_not_found' });
    expect(provider.calls).toHaveLength(0);
    expect(repository.listConversation({ projectId: 'project-a', scope: 'outcome', outcomeId: created.outcome.id, scenarioId: null })).toEqual([]);
  });

  it('adds only explicitly requested, same-project durable contexts to the real AgentLoop prompt and persisted sources', async () => {
    const current = createWord();
    repository.save({
      projectId: 'project-a', outcomeId: current.outcome.id, baseVersion: 1,
      content: { type: 'word', blocks: [{ id: 'p-1', kind: 'paragraph', text: '当前稿：需要综合项目资料。' }], page: {}, header: '', footer: '' },
      note: '人工更新当前稿', actor: 'human', sources: [],
    });
    const peer = repository.create({
      projectId: 'project-a', categoryId: null, title: '访谈编码结论', kind: 'word', note: '同项目成果',
      content: { type: 'word', blocks: [{ id: 'peer-p', kind: 'paragraph', text: '同项目关键结论：访谈显示制度信任影响参与。' }], page: {}, header: '', footer: '' },
    });
    const foreign = repository.create({
      projectId: 'project-b', categoryId: null, title: '跨项目秘密成果', kind: 'word', note: '不应读取',
      content: { type: 'word', blocks: [{ id: 'foreign-p', kind: 'paragraph', text: '跨项目秘密文本，绝不能出现在项目 A。' }], page: {}, header: '', footer: '' },
    });
    db.prepare('INSERT INTO research_artifacts (id,project_id,title,artifact_type,review_status,content_ref,input_hash,provenance,metadata,version,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)')
      .run('artifact-a-1','project-a','项目访谈摘要','report','draft',null,null,'{}','{}',1,1,11);
    db.prepare('INSERT INTO artifact_versions (artifact_id,version,manifest,content,content_hash,thumbnail_ref,created_at,created_by,branch_from_version) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('artifact-a-1',1,'{}','项目资料原文：样本访谈的共同主题是制度信任。','hash-a',null,11,'user',null);
    db.prepare('INSERT INTO research_artifacts (id,project_id,title,artifact_type,review_status,content_ref,input_hash,provenance,metadata,version,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)')
      .run('artifact-b-1','project-b','跨项目秘密资料','report','draft',null,null,'{}','{}',1,1,12);
    db.prepare('INSERT INTO artifact_versions (artifact_id,version,manifest,content,content_hash,thumbnail_ref,created_at,created_by,branch_from_version) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('artifact-b-1',1,'{}','跨项目秘密资料正文，绝不能出现在项目 A。','hash-b',null,12,'user',null);
    const provider = new ControlledProvider(JSON.stringify({
      answer: '已综合同项目材料。',
      edit: { kind: 'word', replacements: [{ blockId: 'p-1', text: '综合同项目访谈资料后的当前稿。' }], note: '综合项目上下文' },
    }));
    const service = new OutcomeAssistantService({ repository, agentLoop: createLoop(provider), modelName: 'controlled' });

    const result = await service.chat({
      projectId: 'project-a', outcomeId: current.outcome.id,
      instruction: '请结合项目资料、其他成果和历史版本，改写当前段落。',
    });

    expect(result).toMatchObject({ status: 'completed', applied: { version: { version: 3, createdBy: 'ai' } } });
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'outcome_version', id: current.outcome.id, version: 1 }),
      expect.objectContaining({ kind: 'outcome_version', id: peer.outcome.id, version: 1 }),
    ]));
    expect(result.sources.some((source) => source.id === foreign.outcome.id || source.id === 'artifact-b-1')).toBe(false);
    // 任务2（Artifact Context，2026-09-05 刘总规格书）：成果助手入口没有显式
    // artifact 选择通道——即使指令包含「项目资料」，也不得暗中按最近更新抓取
    // artifact 替代用户选择；必须如实产出「无选中成果」诊断且零 artifact 来源。
    expect(result.sources.some((source) => source.kind === 'artifact')).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'project_context_unavailable',
        message: expect.stringContaining('没有选中的项目资料'),
      }),
    ]));
    expect(provider.calls).toHaveLength(1);
    const prompt = provider.calls[0]?.messages.map((message) => message.content).join('\n') ?? '';
    expect(prompt).toContain('同项目关键结论：访谈显示制度信任影响参与。');
    expect(prompt).toContain('原始段落');
    expect(prompt).not.toContain('跨项目秘密成果');
    expect(prompt).not.toContain('跨项目秘密资料正文');
    expect(prompt).not.toContain('项目资料原文：样本访谈的共同主题是制度信任。');
    expect(repository.get('project-a', current.outcome.id)?.version.content).toMatchObject({ type: 'word', blocks: [{ id: 'p-1', text: '综合同项目访谈资料后的当前稿。' }] });
    expect(repository.get('project-b', foreign.outcome.id)?.outcome.currentVersion).toBe(1);
    expect(repository.listConversation({ projectId:'project-a', scope:'outcome', outcomeId:current.outcome.id, scenarioId:null })[0]?.sources)
      .toEqual(expect.not.arrayContaining([expect.objectContaining({ kind: 'artifact' })]));
  });

  it('caps explicitly requested peer-outcome context while including a verified Project Metis.md source', async () => {
    const current = createWord();
    const peers = Array.from({ length: 9 }, (_, index) => repository.create({
      projectId:'project-a', categoryId:null, title:`同项目成果 ${index}`, kind:'word', note:'项目成果',
      content:{ type:'word', blocks:[{ id:`peer-${index}`, kind:'paragraph', text:`同项目资料 ${index}` }], page:{}, header:'', footer:'' },
    }));
    const provider = new ControlledProvider('{"answer":"已按可读取范围说明。","edit":null}');
    const projectContext = new OutcomeProjectContextService(repository, {
      read: (projectId) => projectId === 'project-a'
        ? { status: 'available' as const, markdown: '# Project Metis.md 内容\n只使用同项目的访谈资料。', revision: 4 }
        : { status: 'unavailable' as const },
    });
    const service = new OutcomeAssistantService({ repository, agentLoop: createLoop(provider), modelName:'controlled', projectContext });

    const result = await service.chat({ projectId:'project-a', outcomeId:current.outcome.id, instruction:'请参考其他成果和 Project Metis.md 后说明。' });

    expect(result.status).toBe('completed');
    const peerSources = result.sources.filter((source) => source.id !== current.outcome.id);
    expect(peerSources.length).toBeLessThanOrEqual(6);
    expect(peerSources.length).toBeGreaterThan(0);
    expect(peerSources.length).toBeLessThan(peers.length);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code:'project_context_truncated' }),
    ]));
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind:'project_metis', id:'project-a', version:4, label:'Project Metis.md v4' }),
    ]));
    const prompt = provider.calls[0]?.messages.map((message) => message.content).join('\n') ?? '';
    expect(prompt).toContain('Project Metis.md 内容');
  });

  function createWordWithTable() {
    return repository.create({
      projectId: 'project-a', categoryId: null, title: '申报表', kind: 'word', note: '创建成果',
      content: {
        type: 'word',
        blocks: [
          { id: 'p-1', kind: 'paragraph', text: '申报说明' },
          { id: 'tbl-1', kind: 'table', rows: [['项目名称', '原始项目名称'], ['负责人', '张三']] },
        ],
        page: {}, header: '', footer: '',
      },
    });
  }

  it('resolves a word_table_cell selection and applies a cell-level AI replacement', async () => {
    const created = createWordWithTable();
    const provider = new ControlledProvider(JSON.stringify({
      answer: '已更新单元格内容。',
      edit: {
        kind: 'word',
        replacements: [{ blockId: 'tbl-1', row: 0, column: 1, text: '更新后的项目名称' }],
        note: '更新表格单元格',
      },
    }));
    const service = new OutcomeAssistantService({ repository, agentLoop: createLoop(provider), modelName: 'controlled' });

    const result = await service.chat({
      projectId: 'project-a', outcomeId: created.outcome.id, instruction: '把项目名称改得更正式。',
      selection: { type: 'word_table_cell', blockId: 'tbl-1', row: 0, column: 1, start: 0, end: 6 },
    });

    expect(result.status).toBe('completed');
    expect(result.applied?.version.version).toBe(2);
    const content = repository.get('project-a', created.outcome.id)?.version.content;
    expect(content).toMatchObject({
      type: 'word',
      blocks: [
        { id: 'p-1', text: '申报说明' },
        { id: 'tbl-1', rows: [['项目名称', '更新后的项目名称'], ['负责人', '张三']] },
      ],
    });
    const prompt = provider.calls[0]?.messages.map((message) => message.content).join('\n') ?? '';
    expect(prompt).toContain('第 1 行第 2 列单元格');
    expect(prompt).toContain('"row":0,"column":1');
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'selection', id: 'tbl-1' }),
    ]));
  });

  it('rejects a cell replacement whose coordinates do not exist', async () => {
    const created = createWordWithTable();
    const provider = new ControlledProvider(JSON.stringify({
      answer: '尝试修改不存在的单元格。',
      edit: {
        kind: 'word',
        replacements: [{ blockId: 'tbl-1', row: 9, column: 9, text: '不存在' }],
        note: '无效坐标',
      },
    }));
    const service = new OutcomeAssistantService({ repository, agentLoop: createLoop(provider), modelName: 'controlled' });

    const result = await service.chat({
      projectId: 'project-a', outcomeId: created.outcome.id, instruction: '改一下表格。',
      selection: { type: 'word_table_cell', blockId: 'tbl-1', row: 0, column: 0 },
    });

    expect(result.status).toBe('completed');
    expect(result.applied).toBeUndefined();
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'edit_target_not_found' }),
    ]));
    // 未应用任何修改：仍为初始版本。
    expect(repository.get('project-a', created.outcome.id)?.version.version).toBe(1);
  });

  it('rejects a word_table_cell selection pointing at a non-table block', async () => {
    const created = createWordWithTable();
    const provider = new ControlledProvider('{"answer":"不会执行。","edit":null}');
    const service = new OutcomeAssistantService({ repository, agentLoop: createLoop(provider), modelName: 'controlled' });

    const result = await service.chat({
      projectId: 'project-a', outcomeId: created.outcome.id, instruction: '改一下。',
      selection: { type: 'word_table_cell', blockId: 'p-1', row: 0, column: 0 },
    });

    expect(result.status).toBe('error');
    expect(provider.calls).toHaveLength(0);
  });
});
