/**
 * Generic RSS/Atom feed resolver for tracking new academic papers.
 *
 * Supports RSS 2.0 and Atom feeds (e.g. arXiv category RSS).
 */

export interface RssFeedEntry {
  id: string;
  title: string;
  link: string;
  summary: string;
  authors: string[];
  publishedAt?: number;
  categories: string[];
}

export interface RssFeed {
  title: string;
  link: string;
  description: string;
  entries: RssFeedEntry[];
}

function extractText(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  return match?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ?? '';
}

function parseDate(dateStr: string): number | undefined {
  const ts = Date.parse(dateStr);
  return Number.isNaN(ts) ? undefined : ts;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseRss2(xml: string): RssFeed {
  const title = decodeEntities(extractText(xml, 'title'));
  const link = extractText(xml, 'link');
  const description = decodeEntities(extractText(xml, 'description'));
  const entries: RssFeedEntry[] = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1]!;
    const entryTitle = decodeEntities(extractText(item, 'title')) || 'Untitled';
    const entryLink = extractText(item, 'link') || extractText(item, 'guid');
    const summary = decodeEntities(extractText(item, 'description'));
    const pubDate = extractText(item, 'pubDate');
    const author = extractText(item, 'author');
    const categories: string[] = [];
    const catRegex = /<category[^>]*>([\s\S]*?)<\/category>/gi;
    let catMatch: RegExpExecArray | null;
    while ((catMatch = catRegex.exec(item)) !== null) {
      const cat = catMatch[1]?.replace(/<[^>]+>/g, '').trim();
      if (cat) categories.push(cat);
    }
    entries.push({
      id: entryLink || `${entryTitle}-${entries.length}`,
      title: entryTitle,
      link: entryLink,
      summary,
      authors: author ? [author] : [],
      publishedAt: parseDate(pubDate),
      categories,
    });
  }
  return { title, link, description, entries };
}

function parseAtom(xml: string): RssFeed {
  const feedTitle = decodeEntities(extractText(xml, 'title'));
  const linkMatch = xml.match(/<link[^>]+href="([^"]+)"/i);
  const feedLink = linkMatch?.[1] ?? '';
  const subtitle = decodeEntities(extractText(xml, 'subtitle'));
  const entries: RssFeedEntry[] = [];
  const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1]!;
    const entryTitle = decodeEntities(extractText(entry, 'title')) || 'Untitled';
    const entryLinkMatch = entry.match(/<link[^>]+href="([^"]+)"/i);
    const entryLink = entryLinkMatch?.[1] ?? '';
    const summary = decodeEntities(extractText(entry, 'summary')) || decodeEntities(extractText(entry, 'content'));
    const published = extractText(entry, 'published') || extractText(entry, 'updated');
    const authors: string[] = [];
    const authorRegex = /<author[^>]*>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/author>/gi;
    let authorMatch: RegExpExecArray | null;
    while ((authorMatch = authorRegex.exec(entry)) !== null) {
      authors.push(authorMatch[1]!.trim());
    }
    const categories: string[] = [];
    const catRegex = /<category[^>]+term="([^"]+)"/gi;
    let catMatch: RegExpExecArray | null;
    while ((catMatch = catRegex.exec(entry)) !== null) {
      categories.push(catMatch[1]!);
    }
    entries.push({
      id: entryLink || `${entryTitle}-${entries.length}`,
      title: entryTitle,
      link: entryLink,
      summary,
      authors,
      publishedAt: parseDate(published),
      categories,
    });
  }
  return { title: feedTitle, link: feedLink, description: subtitle, entries };
}

export async function fetchRssFeed(url: string, timeoutMs = 15000): Promise<RssFeed | null> {
  const trimmed = url.trim();
  if (!trimmed) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(trimmed, {
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const xml = await response.text();
    if (xml.includes('<feed')) return parseAtom(xml);
    return parseRss2(xml);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
