import { describe, it, expect } from 'vitest';
import { downloadRequestHeaders } from '../../electron/BrowserService.js';

describe('downloadRequestHeaders (anti-leech download fix)', () => {
  it('replays the page URL as Referer', () => {
    const h = downloadRequestHeaders(
      { url: 'https://publisher.example.com/files/paper.pdf', pageUrl: 'https://publisher.example.com/article/123' },
      null,
    );
    expect(h.Referer).toBe('https://publisher.example.com/article/123');
  });

  it('falls back to the file origin when pageUrl is missing or invalid', () => {
    const h = downloadRequestHeaders({ url: 'https://cdn.example.com/x.pdf', pageUrl: '' }, null);
    expect(h.Referer).toBe('https://cdn.example.com/');
    const h2 = downloadRequestHeaders({ url: 'https://cdn.example.com/x.pdf', pageUrl: 'not-a-url' }, null);
    expect(h2.Referer).toBe('https://cdn.example.com/');
  });

  it('sends a real browser User-Agent and Accept header', () => {
    const h = downloadRequestHeaders({ url: 'https://x.example.com/a.pdf' }, null);
    expect(h['User-Agent']).toMatch(/Mozilla\/5\.0 .*Chrome\//);
    expect(h.Accept).toContain('application/pdf');
  });

  it('includes cookies when present and omits them when absent', () => {
    const withCookie = downloadRequestHeaders({ url: 'https://x.example.com/a.pdf' }, 'session=abc');
    expect(withCookie.Cookie).toBe('session=abc');
    const without = downloadRequestHeaders({ url: 'https://x.example.com/a.pdf' }, null);
    expect(without.Cookie).toBeUndefined();
  });
});

// ─── resolveDownloadTitle (F5) ───────────────────────────────

import { resolveDownloadTitle } from '../../electron/BrowserService.js';

describe('resolveDownloadTitle', () => {
  it('prefers page metadata title', () => {
    expect(resolveDownloadTitle('Attention Is All You Need', '页面标题', 'a.pdf')).toBe('Attention Is All You Need');
  });
  it('falls back to live page title, then filename stem', () => {
    expect(resolveDownloadTitle(undefined, '论文页面', 'paper.pdf')).toBe('论文页面');
    expect(resolveDownloadTitle('', '  ', 'paper.pdf')).toBe('paper');
    expect(resolveDownloadTitle(undefined, undefined, 'report.PDF')).toBe('report');
  });
  it('never returns an empty title', () => {
    expect(resolveDownloadTitle(undefined, undefined, '.pdf')).toBe('download');
  });
});

// ─── scoreTitleOverlap (O2 multi-source enrichment) ────────

import { scoreTitleOverlap } from '../../electron/BrowserService.js';

describe('scoreTitleOverlap (O2 title-similarity gate)', () => {
  it('returns 1.0 for identical titles', () => {
    expect(scoreTitleOverlap('Attention Is All You Need', 'Attention Is All You Need')).toBe(1);
  });
  it('returns high overlap for a close match', () => {
    const s = scoreTitleOverlap('Attention Is All You Need', 'Attention is All You Need');
    expect(s).toBeGreaterThanOrEqual(0.6);
  });
  it('returns low overlap for unrelated titles', () => {
    const s = scoreTitleOverlap('Attention Is All You Need', 'A Survey of Graph Neural Networks');
    expect(s).toBeLessThan(0.6);
  });
  it('returns 0 when either side has no significant tokens', () => {
    expect(scoreTitleOverlap('a b', 'Attention Is All You Need')).toBe(0);
    expect(scoreTitleOverlap('Attention Is All You Need', '   ')).toBe(0);
  });
});
