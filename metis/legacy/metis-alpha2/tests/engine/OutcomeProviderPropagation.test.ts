import { describe, expect, it } from 'vitest';
import type { AgentRunRequest, AgentRunResult } from '../../engine/core/types.js';
import type { ProviderProfileBinding } from '../../engine/runtime/ProviderProfileContract.js';
import type { OutcomeRepository } from '../../electron/OutcomeRepository.js';
import { OutcomeAssistantService } from '../../electron/OutcomeAssistantService.js';
import { OutcomePptGenerationService } from '../../electron/OutcomePptGenerationService.js';
import type { OutcomeDocument, OutcomeSource } from '../../engine/runtime/OutcomeRuntimeContract.js';

const binding: ProviderProfileBinding = {
  source: 'project_override',
  profileId: '11111111-1111-4111-8111-111111111111',
  model: 'project-model',
  systemPrompt: '仅用于项目成果的系统提示',
};

function completed(finalText: string): AgentRunResult {
  return {
    status: 'completed',
    finalText,
    finalVerified: true,
    messages: [],
    turnsUsed: 1,
    toolResults: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    errors: [],
    traceEvents: [],
  };
}

function fakeRepository(detail: ReturnType<OutcomeRepository['get']>, saved?: ReturnType<OutcomeRepository['get']>): OutcomeRepository {
  const messages: Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; sources: OutcomeSource[]; createdAt: number }> = [];
  return {
    get: () => detail,
    listConversation: () => messages,
    appendConversation: (input) => {
      const message = { id: `message-${messages.length + 1}`, role: input.role, content: input.content, sources: input.sources, createdAt: 1 };
      messages.push(message);
      return message;
    },
    save: () => saved ?? detail,
  } as unknown as OutcomeRepository;
}

function wordDetail(): NonNullable<ReturnType<OutcomeRepository['get']>> {
  return {
    outcome: {
      id: 'outcome-word', projectId: 'project-a', categoryId: null, title: 'Word 成果', kind: 'word', status: 'draft',
      currentVersion: 1, finalVersion: null, createdAt: 1, updatedAt: 1,
    },
    version: {
      outcomeId: 'outcome-word', version: 1,
      content: { type: 'word', blocks: [{ id: 'paragraph-1', kind: 'paragraph', text: '原文' }], page: {}, header: '', footer: '' },
      note: '创建', createdBy: 'human', parentVersion: null, sources: [], createdAt: 1,
    },
  };
}

function pptDetail(version = 1): NonNullable<ReturnType<OutcomeRepository['get']>> {
  const content: OutcomeDocument = {
    type: 'ppt', ratio: '16:9', theme: {}, templateId: null, generationSkillId: null,
    pages: [{ id: 'slide-1', title: '原页', pageType: 'content', humanModified: false, status: 'complete', elements: [] }],
  };
  return {
    outcome: {
      id: 'outcome-ppt', projectId: 'project-a', categoryId: null, title: 'PPT 成果', kind: 'ppt', status: 'draft',
      currentVersion: version, finalVersion: null, createdAt: 1, updatedAt: version,
    },
    version: { outcomeId: 'outcome-ppt', version, content, note: '版本', createdBy: version === 1 ? 'human' : 'ai', parentVersion: version === 1 ? null : 1, sources: [], createdAt: version },
  };
}

function runner(response: string, calls: AgentRunRequest[]): Pick<import('../../engine/core/AgentLoop.js').AgentLoop, 'run'> {
  return {
    run: async (request) => {
      calls.push(request);
      return completed(response);
    },
  };
}

describe('Outcome provider binding propagation', () => {
  it('passes the project binding and system prompt through OutcomeAssistantService', async () => {
    const calls: AgentRunRequest[] = [];
    const detail = wordDetail();
    const service = new OutcomeAssistantService({
      repository: fakeRepository(detail),
      agentLoop: runner(JSON.stringify({ answer: '真实回答', edit: null }), calls),
      modelName: binding.model,
      providerProfileBinding: binding,
    });

    const result = await service.chat({ projectId: 'project-a', outcomeId: 'outcome-word', instruction: '解释当前成果。' });

    expect(result).toMatchObject({ status: 'completed', model: 'project-model', answer: '真实回答' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.providerProfileBinding).toEqual(binding);
    expect(calls[0]?.messages[0]).toEqual({ role: 'system', content: binding.systemPrompt });
    expect(calls[0]?.skillPrompt).toContain('Word 成果');
  });

  it('passes the project binding through OutcomePptGenerationService and keeps the project scope', async () => {
    const calls: AgentRunRequest[] = [];
    const detail = pptDetail();
    const saved = pptDetail(2);
    const skill = { id: 'ppt-skill-1', name: '证据型答辩', narrative: 'argument_evidence' as const, contentDensity: 'balanced' as const, audience: '评审', instructions: '先证据后结论' };
    const service = new OutcomePptGenerationService({
      repository: fakeRepository(detail, saved),
      agentLoop: runner(JSON.stringify({ answer: '已生成', patch: { replacePages: [{ pageId: 'slide-1', title: '新页' }], appendPages: [], note: '生成' } }), calls),
      modelName: binding.model,
      providerProfileBinding: binding,
      skill,
      template: null,
    });

    const result = await service.execute({
      projectId: 'project-a', outcomeId: 'outcome-ppt', baseVersion: 1, generationSkillId: skill.id, templateId: null, instruction: '生成当前项目的 PPT。',
    });

    expect(result).toMatchObject({ status: 'completed', model: 'project-model', answer: '已生成' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.providerProfileBinding).toEqual(binding);
    expect(calls[0]?.projectId).toBe('project-a');
    expect(calls[0]?.messages[0]).toEqual({ role: 'system', content: binding.systemPrompt });
    expect(calls[0]?.skillPrompt).toContain('PPT 成果');
  });
});
