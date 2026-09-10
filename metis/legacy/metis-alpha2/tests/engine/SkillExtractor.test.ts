/**
 * SkillExtractor — generate a skill from a conversation.
 */

import { describe, it, expect } from 'vitest';
import { SkillExtractor } from '../../engine/skills/SkillExtractor.js';
import { FakeProvider } from '../../engine/providers/FakeProvider.js';
import type { ChatMessage } from '../../engine/core/types.js';

function user(text: string): ChatMessage { return { role: 'user', content: text }; }
function assistant(text: string): ChatMessage { return { role: 'assistant', content: text }; }

const SAMPLE_CONVO: ChatMessage[] = [
  user('帮我查找 arXiv 上关于 RAG 的最新论文，然后写一份综述'),
  assistant('好的，我会先用 arxiv_search 搜索 RAG 相关论文，筛选高引用的，然后用 literature_review 工具归纳主题，最后生成综述。'),
];

describe('SkillExtractor', () => {
  it('returns null for too-short conversations', async () => {
    const extractor = new SkillExtractor();
    const result = await extractor.extract({ messages: [user('hi')] });
    expect(result).toBeNull();
  });

  it('produces a deterministic fallback skill without a provider', async () => {
    const extractor = new SkillExtractor();
    const result = await extractor.extract({ messages: SAMPLE_CONVO, userIntent: 'RAG 文献综述' });
    expect(result).not.toBeNull();
    expect(result!.systemPrompt.length).toBeGreaterThan(0);
    expect(result!.maxTurns).toBeGreaterThanOrEqual(4);
    // "RAG 文献综述" slugifies to "rag" (Chinese chars stripped, RAG kept).
    expect(result!.id).toBe('rag');
  });

  it('parses a provider-generated skill from JSON', async () => {
    const provider = new FakeProvider({
      response: JSON.stringify({
        id: 'rag-literature-review',
        name: 'RAG 文献综述',
        description: '搜索 RAG 论文并生成结构化综述',
        systemPrompt: '# RAG 文献综述\n\n1. 用 arxiv_search 搜索 RAG\n2. 用 literature_review 归纳\n3. 生成综述',
        allowedTools: ['arxiv_search', 'literature_review', 'read_pdf'],
        maxTurns: 15,
        rationale: '从对话中识别出 RAG 综述工作流',
      }),
    });
    const extractor = new SkillExtractor(provider);
    const result = await extractor.extract({
      messages: SAMPLE_CONVO,
      knownTools: ['arxiv_search', 'literature_review', 'read_pdf', 'web_search'],
    });
    expect(result).not.toBeNull();
    expect(result!.id).toBe('rag-literature-review');
    expect(result!.name).toBe('RAG 文献综述');
    expect(result!.allowedTools).toContain('arxiv_search');
    expect(result!.maxTurns).toBe(15);
  });

  it('filters out unknown tools from the allow-list', async () => {
    const provider = new FakeProvider({
      response: JSON.stringify({
        id: 'test-skill', name: 'Test', description: 'd',
        systemPrompt: 'steps', allowedTools: ['arxiv_search', 'nonexistent_tool', 'literature_review'],
        maxTurns: 10, rationale: 'r',
      }),
    });
    const extractor = new SkillExtractor(provider);
    const result = await extractor.extract({
      messages: SAMPLE_CONVO,
      knownTools: ['arxiv_search', 'literature_review'],
    });
    expect(result!.allowedTools).toEqual(['arxiv_search', 'literature_review']);
  });

  it('parses fenced JSON output', async () => {
    const provider = new FakeProvider({
      response: '```json\n{"id":"fenced","name":"F","description":"d","systemPrompt":"steps","allowedTools":[],"maxTurns":8,"rationale":"r"}\n```',
    });
    const extractor = new SkillExtractor(provider);
    const result = await extractor.extract({ messages: SAMPLE_CONVO });
    expect(result!.id).toBe('fenced');
  });

  it('degrades to deterministic on malformed provider output', async () => {
    const provider = new FakeProvider({ response: '抱歉我无法处理。' });
    const extractor = new SkillExtractor(provider);
    const result = await extractor.extract({ messages: SAMPLE_CONVO, userIntent: '综述' });
    expect(result).not.toBeNull();
    expect(result!.rationale).toContain('无 AI 模型可用');
  });

  it('clamps maxTurns into range', async () => {
    const provider = new FakeProvider({
      response: JSON.stringify({
        id: 'x', name: 'X', description: 'd', systemPrompt: 's',
        allowedTools: [], maxTurns: 999, rationale: 'r',
      }),
    });
    const extractor = new SkillExtractor(provider);
    const result = await extractor.extract({ messages: SAMPLE_CONVO });
    expect(result!.maxTurns).toBe(30);
  });
});
