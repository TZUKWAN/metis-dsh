/**
 * Tests for UnpaywallClient (O3): open-access PDF resolution + multi-source
 * candidate collection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolvePdf, collectPdfCandidates } from '../../engine/research/UnpaywallClient.js';

describe('UnpaywallClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  function mockJson(response: unknown, status = 200) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      json: () => Promise.resolve(response),
      text: () => Promise.resolve(JSON.stringify(response)),
    } as Response);
  }

  describe('resolvePdf', () => {
    it('returns the best OA PDF url when Unpaywall knows the DOI', async () => {
      mockJson({
        doi: '10.1000/xyz',
        is_oa: true,
        oa_status: 'green',
        best_oa_location: { url_for_pdf: 'https://repo.example.org/paper.pdf', host_type: 'repository', version: 'submittedVersion' },
        oa_locations: [{ url_for_pdf: 'https://repo.example.org/paper.pdf', host_type: 'repository', version: 'submittedVersion' }],
      });

      const result = await resolvePdf('10.1000/xyz', 'test@example.com');
      expect(result?.bestPdfUrl).toBe('https://repo.example.org/paper.pdf');
      expect(result?.isOA).toBe(true);
      expect(result?.oaStatus).toBe('green');
      expect(result?.locations).toHaveLength(1);
    });

    it('returns null for a non-DOI input without throwing', async () => {
      const result = await resolvePdf('not-a-doi', 'test@example.com');
      expect(result).toBeNull();
    });

    it('returns null when Unpaywall responds 404', async () => {
      mockJson({ error: 'Not found' }, 404);
      const result = await resolvePdf('10.9999/unknown', 'test@example.com');
      expect(result).toBeNull();
    });

    it('returns null when no OA location exists', async () => {
      mockJson({
        doi: '10.1000/closed',
        is_oa: false,
        oa_status: 'closed',
        best_oa_location: null,
        oa_locations: [],
      });
      const result = await resolvePdf('10.1000/closed', 'test@example.com');
      expect(result?.bestPdfUrl).toBeNull();
      expect(result?.isOA).toBe(false);
    });
  });

  describe('collectPdfCandidates', () => {
    it('combines Unpaywall, arXiv, and existing pdfUrl, de-duplicated, Unpaywall first', async () => {
      mockJson({
        doi: '10.1000/xyz',
        is_oa: true,
        oa_status: 'gold',
        best_oa_location: { url_for_pdf: 'https://publisher.example.org/oa.pdf', host_type: 'publisher', version: 'publishedVersion' },
        oa_locations: [
          { url_for_pdf: 'https://publisher.example.org/oa.pdf', host_type: 'publisher' },
          { url_for_pdf: 'https://repo.example.org/paper.pdf', host_type: 'repository' },
        ],
      });

      const candidates = await collectPdfCandidates({
        doi: '10.1000/xyz',
        arxivId: '2401.00001',
        pdfUrl: 'https://semantic.example.org/pdf',
        email: 'test@example.com',
      });

      // Unpaywall best first, then its second location, then arXiv, then existing.
      expect(candidates[0]).toBe('https://publisher.example.org/oa.pdf');
      expect(candidates).toContain('https://repo.example.org/paper.pdf');
      expect(candidates).toContain('https://arxiv.org/pdf/2401.00001.pdf');
      expect(candidates).toContain('https://semantic.example.org/pdf');
      // De-duplicated.
      expect(new Set(candidates).size).toBe(candidates.length);
    });

    it('falls through to arXiv + pdfUrl when Unpaywall has no record', async () => {
      mockJson({ error: 'Not found' }, 404);
      const candidates = await collectPdfCandidates({
        doi: '10.9999/unknown',
        arxivId: '2401.00002',
        pdfUrl: 'https://semantic.example.org/pdf',
        email: 'test@example.com',
      });
      expect(candidates).toEqual([
        'https://arxiv.org/pdf/2401.00002.pdf',
        'https://semantic.example.org/pdf',
      ]);
    });

    it('returns only pdfUrl when neither DOI nor arXivId is present', async () => {
      const candidates = await collectPdfCandidates({
        pdfUrl: 'https://only.example.org/paper.pdf',
        email: 'test@example.com',
      });
      expect(candidates).toEqual(['https://only.example.org/paper.pdf']);
    });

    it('returns empty array when nothing is available', async () => {
      const candidates = await collectPdfCandidates({ email: 'test@example.com' });
      expect(candidates).toEqual([]);
    });
  });
});
