/**
 * @vitest-environment node
 * Live check: SkillExtractor against the real Qwen gateway. Gated behind RUN_LIVE.
 */
import { describe, it, expect } from 'vitest';
import { SkillExtractor } from '../../engine/skills/SkillExtractor.js';
import { OpenAICompatProvider } from '../../engine/providers/OpenAICompatProvider.js';

describe('SkillExtractor live (Qwen)', { timeout: 120_000 }, () => {
  it.skipIf(!process.env.RUN_LIVE || !process.env.QWEN_KEY)('extracts a real skill from a conversation', async () => {
    const provider = new OpenAICompatProvider({
      baseUrl: process.env.QWEN_BASE_URL ?? 'http://218.197.140.7:3001/v1',
      apiKey: process.env.QWEN_KEY!, model: process.env.QWEN_MODEL ?? 'Qwen3.5-122B-A10B',
      timeout: 90_000, maxRetries: 3, retryBackoffSeconds: 2,
    });
    const extractor = new SkillExtractor(provider);
    const result = await extractor.extract({
      messages: [
        { role: 'user', content: '帮我找 arXiv 上关于 retrieval augmented generation 的最新论文，筛选高引用的，然后写一份结构化综述' },
        { role: 'assistant', content: '好的，我先搜索 arxiv，然后用 literature_review 工具归纳主题，最后生成综述。' },
      ],
      userIntent: 'RAG 文献综述',
      knownTools: ['arxiv_search', 'literature_review', 'read_pdf', 'crossref_lookup'],
    });
    console.log('id:', result?.id);
    console.log('name:', result?.name);
    console.log('systemPrompt:\n', result?.systemPrompt);
    console.log('allowedTools:', result?.allowedTools);
    expect(result).not.toBeNull();
    expect(result!.systemPrompt.length).toBeGreaterThan(50);
  });
});
