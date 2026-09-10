import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../research/CitationPassport.js', () => ({ getPassport: vi.fn() }));
vi.mock('../../research/RetractionWatchMirror.js', () => ({ loadMirror: vi.fn(), lookupDoi: vi.fn() }));
vi.mock('../../research/JournalIntegrityMirror.js', () => ({ loadIndex: vi.fn(), lookupVenue: vi.fn() }));

import { getPassport } from '../../research/CitationPassport.js';
import { loadMirror, lookupDoi } from '../../research/RetractionWatchMirror.js';
import { loadIndex, lookupVenue } from '../../research/JournalIntegrityMirror.js';
import { resolveCitationTruthAttestation } from '../CitationTruthResolver.js';

describe('CitationTruthResolver', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getPassport).mockResolvedValue({
      overall: 'VERIFIED',
      lastTriangulatedAt: Date.now(),
    } as never);
    vi.mocked(loadMirror).mockResolvedValue({ updatedAt: Date.now() } as never);
    vi.mocked(lookupDoi).mockResolvedValue(undefined);
    vi.mocked(loadIndex).mockResolvedValue({ updatedAt: Date.now() } as never);
    vi.mocked(lookupVenue).mockResolvedValue([]);
  });

  it('derives a release-trusted attestation only when every backing subsystem is clear', async () => {
    const result = await resolveCitationTruthAttestation({
      sourceId: 's1', citationKeys: ['smith2024'], identifierType: 'doi',
      identifier: '10.1234/example', locator: 'p. 9', venue: 'Journal',
    });
    expect(result).toMatchObject({
      triangulation: 'VERIFIED', passport: 'verified', retraction: 'clear', journalIntegrity: 'trusted',
    });
  });

  it('fails closed when mirrors are absent or a retraction is present', async () => {
    vi.mocked(loadMirror).mockResolvedValue(null);
    vi.mocked(loadIndex).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    vi.mocked(lookupDoi).mockResolvedValue([{ retractionNature: 'Retraction' }] as never);
    const result = await resolveCitationTruthAttestation({
      sourceId: 's1', citationKeys: ['smith2024'], identifierType: 'doi',
      identifier: '10.1234/example', locator: 'p. 9', venue: 'Journal',
    });
    expect(result.retraction).toBe('retracted');
    expect(result.journalIntegrity).toBe('unknown');
  });
});
