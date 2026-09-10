/**
 * Built-in web tools — DuckDuckGo search + arbitrary URL content fetch.
 *
 * DuckDuckGo Instant Answer API is free and requires no API key. The fetch
 * tool downloads a URL and returns readable text (HTML stripped). Both are
 * outbound-only; no local network is exposed.
 */

import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

/** Use the system proxy when set (curl works but node fetch times out without it). */
function getFetchOptions(): { dispatcher?: InstanceType<typeof ProxyAgent> } {
  const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!proxyUrl) return {};
  try {
    return { dispatcher: new ProxyAgent(proxyUrl) };
  } catch {
    return {};
  }
}

// ─── Bing CN fallback（国内直连可达；DDG 被墙时的免费兜底） ──────

/** 从 cn.bing.com 结果页提取 b_algo 条目（标题/链接/摘要）。导出仅为测试。 */
export function parseBingCnResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const strip = (raw: string) => raw.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const itemRe = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)(?=<li class="b_algo"|<\/ol|$)/gi;
  for (const match of html.matchAll(itemRe)) {
    if (results.length >= maxResults) break;
    const url = match[1];
    const titleRaw = match[2];
    const tail = match[3];
    if (url === undefined || titleRaw === undefined || tail === undefined) continue;
    const title = strip(titleRaw);
    if (!title) continue;
    const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/.exec(tail);
    results.push({ url, title, snippet: snippetMatch && snippetMatch[1] !== undefined ? strip(snippetMatch[1]).slice(0, 300) : '' });
  }
  return results;
}

async function bingCnSearch(query: string, maxResults: number): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string }> {
  const response = await undiciFetch('https://cn.bing.com/search?q=' + encodeURIComponent(query), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Accept: 'text/html',
    },
    signal: AbortSignal.timeout(15_000),
    ...getFetchOptions(),
  });
  if (!response.ok) return { ok: false, error: `Bing CN returned ${response.status}` };
  const html = await response.text();
  const results = parseBingCnResults(html, maxResults);
  if (results.length === 0) return { ok: false, error: 'Bing CN returned no parseable results' };
  return { ok: true, result: { query, source: 'bing_cn', results } };
}

// onLine 仅在浏览器/渲染端是可靠布尔值；Node 22+ 存在 navigator 但无 onLine。
function isOffline(): boolean {
  const nav = typeof navigator !== 'undefined' ? (navigator as unknown as { onLine?: boolean }) : undefined;
  return nav !== undefined && typeof nav.onLine === 'boolean' && !nav.onLine;
}

// ─── DuckDuckGo Search ────────────────────────────────────────

// 任务7 Web Research 3.1(2026-09-05 刘总要求):结构化读取——标题/作者/时间/
// canonical/JSON-LD/标题层级/段落结构,而非去标签一长串文本。
import { formatStructuredRead, parseStructuredDocument } from '../../research/StructuredReader.js';
import { buildSearchPlan } from '../../research/QueryPlanner.js';

export const webSearchSpec: ToolSpec = {
  name: 'web_search',
  description: 'Search the web (DuckDuckGo with automatic cn.bing.com fallback; no API key required). Returns instant answers, related topics, or result titles/links/snippets. Use for current events, facts, definitions, or when you need information beyond the local library.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'number', description: 'Maximum number of results to return (default 10)', default: 10 },
    },
    required: ['query'],
  },
};

export const webSearchHandler: ToolHandler = async (args) => {
  const query = String(args.query ?? '').trim();
  if (!query) return JSON.stringify({ ok: false, error: 'query is required' });
  if (isOffline()) {
    return JSON.stringify({ ok: false, error: 'offline', offline: true });
  }
  const maxResults = Math.min(Math.max(1, Number(args.maxResults) || 10), 50);

  // 主源 DuckDuckGo；不可达（如境内直连被墙）时自动落到 cn.bing.com 免费兜底。
  try {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      no_html: '1',
      skip_disambig: '1',
    });
    const response = await undiciFetch(`https://api.duckduckgo.com/?${params}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      ...getFetchOptions(),
    });
    if (!response.ok) {
      throw new Error(`DuckDuckGo API returned ${response.status}`);
    }
    const data = await response.json() as Record<string, unknown>;

    // Extract the most useful fields.
    const abstract = String(data.Abstract ?? '');
    const abstractUrl = String(data.AbstractURL ?? '');
    const answer = String(data.Answer ?? '');
    const answerType = String(data.AnswerType ?? '');

    const relatedTopics = Array.isArray(data.RelatedTopics)
      ? (data.RelatedTopics as Array<Record<string, unknown>>)
          .filter((t) => t.Text)
          .slice(0, maxResults)
          .map((t) => ({
            text: String(t.Text),
            url: String(t.FirstURL ?? ''),
          }))
      : [];

    const useful = Boolean(answer || abstract || relatedTopics.length > 0);
    if (!useful) throw new Error('duckduckgo_empty_results');
    return JSON.stringify({
      ok: true,
      result: {
        source: 'duckduckgo',
        query,
        answer: answer || undefined,
        answerType: answerType || undefined,
        abstract: abstract || undefined,
        abstractUrl: abstractUrl || undefined,
        relatedTopics: relatedTopics.length > 0 ? relatedTopics : undefined,
      },
    });
  } catch {
    // DDG 传输失败 → Bing CN 兜底
  }
  try {
    const fallback = await bingCnSearch(query, maxResults);
    return JSON.stringify(fallback);
  } catch (err) {
    return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'Search failed (duckduckgo + bing_cn)' });
  }
};

// ─── Web Fetch ────────────────────────────────────────────────

export const webResearchPlanSpec: ToolSpec = {
  name: 'web_research_plan',
  description: 'Plan a social-science web research: expand a research question into a multi-source, multi-language query set (Chinese/English core concepts, theory lenses, contrasting views, primary sources) with a coverage checklist. Call web_search for each planned query, then audit coverage before answering.',
  parameters: {
    type: 'object',
    properties: {
      researchQuestion: { type: 'string', description: 'The research question or topic to plan searches for.' },
    },
    required: ['researchQuestion'],
  },
};

export const webResearchPlanHandler: ToolHandler = async (args) => {
  const question = String(args.researchQuestion ?? '').trim();
  if (!question) return JSON.stringify({ ok: false, error: 'researchQuestion is required' });
  const plan = buildSearchPlan(question);
  return JSON.stringify({ ok: true, plan }, null, 2);
};

export const webFetchSpec: ToolSpec = {
  name: 'web_fetch',
  description: 'Fetch and read the content of a URL (web page, article, API response). HTML is stripped to readable text. Use when you have a specific link to read or an API endpoint to call.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch (http or https)' },
      maxLength: { type: 'number', description: 'Maximum characters to return (default 5000)', default: 5000 },
      format: { type: 'string', description: '"text" (default, HTML stripped) or "raw" (raw HTML/JSON)', enum: ['text', 'raw'], default: 'text' },
    },
    required: ['url'],
  },
};

export const webFetchHandler: ToolHandler = async (args) => {
  const url = String(args.url ?? '').trim();
  if (!url) return JSON.stringify({ ok: false, error: 'url is required' });
  if (isOffline()) {
    return JSON.stringify({ ok: false, error: 'offline', offline: true });
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return JSON.stringify({ ok: false, error: 'url must start with http:// or https://' });
  }
  const maxLength = Math.min(Math.max(100, Number(args.maxLength) || 5000), 50_000);
  const format = String(args.format ?? 'text');

  try {
    const response = await undiciFetch(url, {
      headers: {
        'Accept': 'text/html,application/json,application/xml,text/plain,*/*',
        'User-Agent': 'Metis-Workbench/0.1 (research tool)',
      },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
      ...getFetchOptions(),
    });
    if (!response.ok) {
      return JSON.stringify({ ok: false, error: `HTTP ${response.status}: ${response.statusText}` });
    }
    const contentType = response.headers.get('content-type') ?? '';
    let text = await response.text();

    // Web Research 3.1(任务7):HTML 页面走结构化读取(标题/元数据/层级/段落),
    // 其余类型保留原文;raw 格式行为不变。
    if (format !== 'raw' && (contentType.includes('html') || text.startsWith('<'))) {
      const structured = parseStructuredDocument(text, response.url);
      text = formatStructuredRead(structured, maxLength);
    }

    return JSON.stringify({
      ok: true,
      result: {
        url: response.url,
        status: response.status,
        contentType,
        text: text.slice(0, maxLength),
        truncated: text.length > maxLength,
      },
    });
  } catch (err) {
    return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'Fetch failed' });
  }
};

// ─── Registration ─────────────────────────────────────────────

export function getWebToolSpecs(): ToolSpec[] {
  return [webSearchSpec, webFetchSpec, webResearchPlanSpec];
}

export function getWebToolHandlers(): Map<string, ToolHandler> {
  return new Map([
    ['web_search', webSearchHandler],
    ['web_fetch', webFetchHandler],
    ['web_research_plan', webResearchPlanHandler],
  ]);
}
