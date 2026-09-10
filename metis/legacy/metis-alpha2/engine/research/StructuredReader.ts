/**
 * METIS 结构化 Reader(2026-09-05 刘总要求,任务7 Web Research 3.1)。
 *
 * web_fetch 过去只做"去 HTML 标签的一长串文本"。本模块把 HTML 提升为
 * 结构化文档:标题/作者/发布时间/canonical URL/JSON-LD 元数据/标题层级/
 * 主内容段落。纯函数(输入 HTML 字符串),供 web_fetch 与 Web Research 引擎复用。
 */

export interface StructuredReadResult {
  title: string;
  author: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  canonicalUrl: string | null;
  language: string | null;
  siteName: string | null;
  documentType: string | null;
  jsonLd: Array<Record<string, unknown>>;
  headings: Array<{ level: number; text: string }>;
  paragraphs: string[];
  mainText: string;
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, '')
    .replace(/<style[\s\S]*?<\/style>/giu, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

function matchMeta(html: string, attribute: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+${attribute}="([^"]+)"[^>]*>`, 'iu'),
    new RegExp(`<meta[^>]+content="([^"]+)"[^>]*${attribute}="([^"]+)"[^>]*>`, 'iu'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) {
      const value = (match[2] ?? match[1] ?? '').trim();
      if (value) return value.slice(0, 500);
    }
  }
  return null;
}

/** 把(已抓取的)HTML 解析为结构化阅读结果。 */
export function parseStructuredDocument(html: string, sourceUrl?: string): StructuredReadResult {
  const title =
    /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1]?.trim()
    ?? matchMeta(html, 'og:title')
    ?? '';
  const author =
    matchMeta(html, 'article:author')
    ?? matchMeta(html, 'name="author"')
    ?? /"author"[^}]*?"name"\s*:\s*"([^"]+)"/iu.exec(html)?.[1]
    ?? null;
  const publishedAt = matchMeta(html, 'article:published_time') ?? matchMeta(html, 'name="date"') ?? matchMeta(html, 'pubdate');
  const updatedAt = matchMeta(html, 'article:modified_time');
  const canonicalUrl = /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/iu.exec(html)?.[1] ?? sourceUrl ?? null;
  const language = /<html[^>]+lang="([^"]+)"/iu.exec(html)?.[1] ?? matchMeta(html, 'content-language');
  const siteName = matchMeta(html, 'og:site_name');
  const documentType = matchMeta(html, 'og:type');

  const jsonLd: Array<Record<string, unknown>> = [];
  for (const match of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/giu)) {
    try {
      const parsed = JSON.parse(match[1] ?? '{}') as unknown;
      if (Array.isArray(parsed)) jsonLd.push(...parsed.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null));
      else if (typeof parsed === 'object' && parsed !== null) jsonLd.push(parsed as Record<string, unknown>);
    } catch { /* 非 JSON-LD script 忽略 */ }
  }

  const headings: Array<{ level: number; text: string }> = [];
  for (const match of html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/giu)) {
    const text = stripTags(match[2] ?? '');
    if (text) headings.push({ level: Number(match[1]), text: text.slice(0, 300) });
  }

  const paragraphs: string[] = [];
  for (const match of html.matchAll(/<(?:p|blockquote)[^>]*>([\s\S]*?)<\/(?:p|blockquote)>/giu)) {
    const text = stripTags(match[1] ?? '');
    if (text.length >= 20) paragraphs.push(text.slice(0, 2000));
    if (paragraphs.length >= 200) break;
  }

  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/iu.exec(html);
  const mainText = stripTags(bodyMatch?.[1] ?? html).slice(0, 100_000);

  return {
    title: title.slice(0, 500),
    author,
    publishedAt,
    updatedAt,
    canonicalUrl: canonicalUrl?.slice(0, 2000) ?? null,
    language,
    siteName,
    documentType,
    jsonLd: jsonLd.slice(0, 10),
    headings: headings.slice(0, 60),
    paragraphs: paragraphs.slice(0, 200),
    mainText,
  };
}

/** 把结构化结果渲染为面向模型的可读文本(结构优先,不只是一长串文字)。 */
export function formatStructuredRead(result: StructuredReadResult, limit = 12_000): string {
  const lines: string[] = [];
  if (result.title) lines.push(`# ${result.title}`);
  const meta: string[] = [];
  if (result.author) meta.push(`作者: ${result.author}`);
  if (result.publishedAt) meta.push(`发布: ${result.publishedAt}`);
  if (result.updatedAt) meta.push(`更新: ${result.updatedAt}`);
  if (result.siteName) meta.push(`站点: ${result.siteName}`);
  if (result.language) meta.push(`语言: ${result.language}`);
  if (result.canonicalUrl) meta.push(`URL: ${result.canonicalUrl}`);
  if (meta.length > 0) lines.push(meta.join(' | '));
  if (result.headings.length > 0) {
    lines.push(`结构(${result.headings.length} 个标题): ${result.headings.slice(0, 20).map((heading) => heading.text).join(' / ')}`);
  }
  lines.push('');
  const budget = limit - lines.join('\n').length - 200;
  if (result.paragraphs.length > 0) {
    let used = 0;
    for (const paragraph of result.paragraphs) {
      lines.push(paragraph);
      used += paragraph.length;
      if (used >= budget) {
        lines.push('…(内容截断)');
        break;
      }
    }
  } else {
    lines.push(result.mainText.slice(0, Math.max(1000, budget)));
  }
  return lines.join('\n').slice(0, limit);
}
