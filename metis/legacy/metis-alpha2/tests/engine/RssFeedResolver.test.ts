import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchRssFeed } from '../../engine/research/RssFeedResolver.js';

describe('RssFeedResolver', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  function mockFetch(xml: string, status = 200) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      text: () => Promise.resolve(xml),
    } as Response);
  }

  const atomFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>arXiv.org: cs.AI updates</title>
  <link href="http://arxiv.org/"/>
  <entry>
    <title>Sample AI Paper</title>
    <link href="http://arxiv.org/abs/2401.00001"/>
    <summary>We study AI.</summary>
    <author><name>Alice Author</name></author>
    <author><name>Bob Author</name></author>
    <published>2024-01-15T00:00:00Z</published>
    <category term="cs.AI"/>
  </entry>
</feed>`;

  it('parses an Atom feed', async () => {
    mockFetch(atomFeed);
    const feed = await fetchRssFeed('http://export.arxiv.org/rss/cs.AI');
    expect(feed).not.toBeNull();
    expect(feed?.title).toBe('arXiv.org: cs.AI updates');
    expect(feed?.entries).toHaveLength(1);
    expect(feed?.entries[0]?.title).toBe('Sample AI Paper');
    expect(feed?.entries[0]?.link).toBe('http://arxiv.org/abs/2401.00001');
    expect(feed?.entries[0]?.authors).toEqual(['Alice Author', 'Bob Author']);
    expect(feed?.entries[0]?.publishedAt).toBe(Date.parse('2024-01-15T00:00:00Z'));
    expect(feed?.entries[0]?.categories).toContain('cs.AI');
  });

  const rssFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Journal RSS</title>
    <link>https://journal.example</link>
    <description>Latest articles</description>
    <item>
      <title>Sample Article</title>
      <link>https://journal.example/article/1</link>
      <description>An article about science.</description>
      <pubDate>Mon, 15 Jan 2024 00:00:00 GMT</pubDate>
      <author>journal@example (Carol Author)</author>
      <category>Biology</category>
    </item>
  </channel>
</rss>`;

  it('parses an RSS 2.0 feed', async () => {
    mockFetch(rssFeed);
    const feed = await fetchRssFeed('https://journal.example/rss');
    expect(feed).not.toBeNull();
    expect(feed?.title).toBe('Journal RSS');
    expect(feed?.entries).toHaveLength(1);
    expect(feed?.entries[0]?.title).toBe('Sample Article');
    expect(feed?.entries[0]?.authors).toEqual(['journal@example (Carol Author)']);
  });

  it('returns null for empty URL', async () => {
    const feed = await fetchRssFeed('   ');
    expect(feed).toBeNull();
  });

  it('returns null on fetch failure', async () => {
    mockFetch('Not found', 404);
    const feed = await fetchRssFeed('https://journal.example/rss');
    expect(feed).toBeNull();
  });
});
