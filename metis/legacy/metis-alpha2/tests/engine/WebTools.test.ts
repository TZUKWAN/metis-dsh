/**
 * Web tools: DuckDuckGo search + URL content fetch.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { webSearchHandler, webFetchHandler, getWebToolSpecs, getWebToolHandlers } from '../../engine/tools/builtin/web-tools.js';

// Mock undici fetch (the module imports undiciFetch from 'undici').
// vi.mock factory is hoisted, so use vi.hoisted to create the mock first.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});

describe('web-tools', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // jsdom defaults to offline; the handlers check navigator.onLine.
    Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });
  });

  it('registers web_search, web_fetch and web_research_plan specs', () => {
    // 任务7 Web Research 3.1(2026-09-05):新增检索规划工具。
    const specs = getWebToolSpecs();
    expect(specs.map((s) => s.name)).toEqual(['web_search', 'web_fetch', 'web_research_plan']);
    const handlers = getWebToolHandlers();
    expect(handlers.has('web_search')).toBe(true);
    expect(handlers.has('web_fetch')).toBe(true);
    expect(handlers.has('web_research_plan')).toBe(true);
  });

  it('web_search returns structured JSON with answer and related topics', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        Abstract: 'The Transformer is a neural network architecture.',
        AbstractURL: 'https://en.wikipedia.org/wiki/Transformer',
        Answer: '',
        AnswerType: '',
        RelatedTopics: [
          { Text: 'Attention mechanism', FirstURL: 'https://example.com/attention' },
          { Text: 'BERT model', FirstURL: 'https://example.com/bert' },
        ],
      }),
    } as unknown as Response);

    const result = await webSearchHandler({ query: 'transformer neural network' });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.abstract).toContain('Transformer');
    expect(parsed.result.relatedTopics).toHaveLength(2);
    expect(parsed.result.relatedTopics[0].text).toBe('Attention mechanism');
  });

  it('web_search handles API errors', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 } as unknown as Response);
    const result = await webSearchHandler({ query: 'test' });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('429');
  });

  it('web_fetch strips HTML to readable text', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://example.com/article',
      headers: { get: () => 'text/html' },
      text: async () => '<html><body><h1>Title</h1><p>Content here</p><script>alert(1)</script></body></html>',
    } as unknown as Response);

    const result = await webFetchHandler({ url: 'https://example.com/article' });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.text).toContain('Title');
    expect(parsed.result.text).toContain('Content here');
    expect(parsed.result.text).not.toContain('alert(1)');
  });

  it('web_fetch preserves raw format', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://example.com/data.json',
      headers: { get: () => 'application/json' },
      text: async () => '{"key": "value"}',
    } as unknown as Response);

    const result = await webFetchHandler({ url: 'https://example.com/data.json', format: 'raw' });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.text).toBe('{"key": "value"}');
  });

  it('web_fetch rejects invalid URLs', async () => {
    const result = await webFetchHandler({ url: 'not-a-url' });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('http');
  });
});
