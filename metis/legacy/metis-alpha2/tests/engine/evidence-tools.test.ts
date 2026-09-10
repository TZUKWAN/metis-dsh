/**
 * Tests for evidence tool handlers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../engine/research/DoiResolver.js', () => ({
  resolveDoi: vi.fn(),
}));

vi.mock('../../engine/research/ArxivResolver.js', () => ({
  resolveArxiv: vi.fn(),
}));

vi.mock('../../engine/research/OpenAlexClient.js', () => ({
  getWorkByDoi: vi.fn(),
}));

vi.mock('../../engine/research/PdfReader.js', () => ({
  getPdfReader: vi.fn(),
}));

vi.mock('../../engine/research/PdfDownloader.js', () => ({
  downloadFile: vi.fn(),
}));

import { claimManifestVerifyHandler } from '../../engine/tools/builtin/evidence-tools.js';
import { resolveDoi } from '../../engine/research/DoiResolver.js';
import { getPdfReader } from '../../engine/research/PdfReader.js';
import { downloadFile } from '../../engine/research/PdfDownloader.js';
import { FakeProvider } from '../../engine/providers/FakeProvider.js';
import { loadManifest } from '../../engine/manifest/ClaimManifest.js';

describe('claimManifestVerifyHandler', () => {
  let originalDataDir: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    originalDataDir = process.env.METIS_DATA_DIR;
    tempDir = path.join(os.tmpdir(), `metis-evidence-tools-test-${Date.now()}`);
    process.env.METIS_DATA_DIR = tempDir;
    vi.resetAllMocks();
  });

  afterEach(async () => {
    if (originalDataDir !== undefined) {
      process.env.METIS_DATA_DIR = originalDataDir;
    } else {
      delete process.env.METIS_DATA_DIR;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates a new manifest entry with LLM semantic verdict', async () => {
    vi.mocked(resolveDoi).mockResolvedValue({
      doi: '10.1234/example',
      title: 'Example Paper',
      authors: ['Alice'],
      year: 2023,
      venue: 'Journal',
      abstract: '',
      pdfUrl: 'https://example.com/paper.pdf',
    });
    vi.mocked(downloadFile).mockResolvedValue(undefined);
    vi.mocked(getPdfReader).mockReturnValue({
      readFile: vi.fn().mockResolvedValue({
        pages: [{ pageNumber: 1, text: 'The proposed method significantly improves accuracy over the baseline.' }],
      }),
    } as unknown as ReturnType<typeof getPdfReader>);

    const provider = new FakeProvider({
      response: JSON.stringify({
        verdict: 'SUPPORTED',
        confidence: 0.95,
        reasoning: 'The passage directly supports the claim.',
        supportingPassageIndices: [1],
      }),
    });

    const result = await claimManifestVerifyHandler(
      {
        claim: 'The proposed method improves accuracy over the baseline',
        doi: '10.1234/example',
      },
      { sessionId: 'test', workspace: '.', turnIndex: 0, provider },
    );

    expect(result).toContain('Manifest status: verified');
    expect(result).toContain('Final verdict: SUPPORTED');

    const manifest = await loadManifest();
    expect(manifest.claims).toHaveLength(1);
    expect(manifest.claims[0]?.status).toBe('verified');
    expect(manifest.claims[0]?.evidenceArtifacts?.some((a) => a.startsWith('DOI:'))).toBe(true);
  });

  it('updates an existing manifest entry when claimId is provided', async () => {
    const { addClaim } = await import('../../engine/manifest/ClaimManifest.js');
    const entry = await addClaim({
      claim: 'The proposed method improves accuracy over the baseline',
      status: 'proposed',
      doi: '10.1234/example',
    });

    vi.mocked(resolveDoi).mockResolvedValue({
      doi: '10.1234/example',
      title: 'Example Paper',
      authors: ['Alice'],
      year: 2023,
      venue: 'Journal',
      abstract: '',
      pdfUrl: 'https://example.com/paper.pdf',
    });
    vi.mocked(downloadFile).mockResolvedValue(undefined);
    vi.mocked(getPdfReader).mockReturnValue({
      readFile: vi.fn().mockResolvedValue({
        pages: [{ pageNumber: 1, text: 'The proposed method does not improve accuracy over the baseline.' }],
      }),
    } as unknown as ReturnType<typeof getPdfReader>);

    const provider = new FakeProvider({
      response: JSON.stringify({
        verdict: 'CONTRADICTED',
        confidence: 0.92,
        reasoning: 'The passage explicitly denies the claim.',
        supportingPassageIndices: [1],
      }),
    });

    const result = await claimManifestVerifyHandler(
      { claimId: entry.id, doi: '10.1234/example' },
      { sessionId: 'test', workspace: '.', turnIndex: 0, provider },
    );

    expect(result).toContain('Manifest status: contradicted');

    const manifest = await loadManifest();
    expect(manifest.claims[0]?.status).toBe('contradicted');
    expect(manifest.claims[0]?.gapReason).toContain('contradicts');
  });
});
