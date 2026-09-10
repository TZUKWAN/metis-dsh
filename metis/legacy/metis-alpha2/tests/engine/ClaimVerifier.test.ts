/**
 * Tests for ClaimVerifier.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { verifyClaim, findRelevantPassages, judgeClaimSemantically } from '../../engine/evidence/ClaimVerifier.js';
import { resolveDoi } from '../../engine/research/DoiResolver.js';
import { getPdfReader } from '../../engine/research/PdfReader.js';
import { downloadFile } from '../../engine/research/PdfDownloader.js';
import { FakeProvider } from '../../engine/providers/FakeProvider.js';

describe('findRelevantPassages', () => {
  it('returns passages ranked by keyword overlap', () => {
    const text = 'The sky is clearly blue during daytime. The grass is green in summer. Blue light scatters more strongly in the atmosphere than red light.';
    const result = findRelevantPassages('the sky is blue', text, 2);

    expect(result).toHaveLength(2);
    expect(result[0]?.text).toContain('sky is clearly blue');
    expect(result[0]?.score).toBeGreaterThan(result[1]?.score ?? 0);
  });

  it('returns empty array when claim has no usable tokens', () => {
    const result = findRelevantPassages('a an the', 'Some text here.');
    expect(result).toHaveLength(0);
  });

  it('flags contradictory passages', () => {
    const text = 'The sky is not blue at night. The sky appears blue during the day.';
    const result = findRelevantPassages('the sky is blue', text, 5);

    const contradiction = result.find((p) => p.text.includes('not blue'));
    expect(contradiction).toBeDefined();
  });
});

describe('verifyClaim', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns SUPPORTED when PDF contains a matching passage', async () => {
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

    const result = await verifyClaim({
      claim: 'The proposed method improves accuracy over the baseline',
      doi: '10.1234/example',
    });

    expect(result.verdict).toBe('SUPPORTED');
    expect(result.pdfDownloaded).toBe(true);
    expect(result.topPassages[0]?.text).toContain('improves accuracy');
  });

  it('returns NO_TEXT_AVAILABLE when no PDF URL is found', async () => {
    vi.mocked(resolveDoi).mockResolvedValue({
      doi: '10.1234/example',
      title: 'Example Paper',
      authors: ['Alice'],
      year: 2023,
      venue: 'Journal',
      abstract: '',
    });

    const result = await verifyClaim({
      claim: 'The proposed method improves accuracy',
      doi: '10.1234/example',
    });

    expect(result.verdict).toBe('NO_TEXT_AVAILABLE');
  });

  it('returns ERROR for unresolvable identifier', async () => {
    vi.mocked(resolveDoi).mockResolvedValue(null);

    const result = await verifyClaim({
      claim: 'Something',
      doi: '10.0000/missing',
    });

    expect(result.verdict).toBe('ERROR');
  });

  it('returns INSUFFICIENT_EVIDENCE when overlap is low', async () => {
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
        pages: [{ pageNumber: 1, text: 'We study quantum effects in low temperature regimes.' }],
      }),
    } as unknown as ReturnType<typeof getPdfReader>);

    const result = await verifyClaim({
      claim: 'The proposed method improves accuracy over the baseline',
      doi: '10.1234/example',
    });

    expect(result.verdict).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('returns CONTRADICTED when a passage negates the claim', async () => {
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

    const result = await verifyClaim({
      claim: 'The proposed method improves accuracy over the baseline',
      doi: '10.1234/example',
    });

    expect(result.verdict).toBe('CONTRADICTED');
  });

  it('uses LLM semantic judgment when a provider is supplied', async () => {
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
        reasoning: 'The passage directly states that accuracy improves over the baseline.',
        supportingPassageIndices: [1],
      }),
    });

    const result = await verifyClaim({
      claim: 'The proposed method improves accuracy over the baseline',
      doi: '10.1234/example',
      provider,
    });

    expect(result.verdict).toBe('SUPPORTED');
    expect(result.keywordVerdict).toBe('SUPPORTED');
    expect(result.semantic).toBeDefined();
    expect(result.semantic?.verdict).toBe('SUPPORTED');
    expect(result.semantic?.confidence).toBe(0.95);
    expect(result.reasoning).toContain('LLM judgment');
  });

  it('falls back to keyword verdict when LLM judgment fails', async () => {
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
        pages: [{ pageNumber: 1, text: 'We study quantum effects in low temperature regimes.' }],
      }),
    } as unknown as ReturnType<typeof getPdfReader>);

    const provider = new FakeProvider({ response: 'not valid json' });

    const result = await verifyClaim({
      claim: 'The proposed method improves accuracy over the baseline',
      doi: '10.1234/example',
      provider,
    });

    expect(result.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.semantic).toBeUndefined();
  });
});

describe('judgeClaimSemantically', () => {
  it('returns null when no passages are provided', async () => {
    const provider = new FakeProvider({ response: '{}' });
    const result = await judgeClaimSemantically(provider, 'any claim', []);
    expect(result).toBeNull();
  });

  it('parses a valid LLM JSON judgment', async () => {
    const provider = new FakeProvider({
      response: '```json\n' + JSON.stringify({
        verdict: 'CONTRADICTED',
        confidence: 0.88,
        reasoning: 'The text explicitly denies the claim.',
        supportingPassageIndices: [1],
      }) + '\n```',
    });

    const result = await judgeClaimSemantically(provider, 'The sky is blue', [
      { text: 'The sky is not blue at night.', score: 0.9 },
    ]);

    expect(result).not.toBeNull();
    expect(result?.verdict).toBe('CONTRADICTED');
    expect(result?.confidence).toBe(0.88);
    expect(result?.reasoning).toContain('denies');
  });
});
