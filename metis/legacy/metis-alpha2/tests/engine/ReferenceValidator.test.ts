import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReferenceValidator } from '../../engine/evidence/ReferenceValidator.js';

function installDoiFetch(title = 'Exact Evidence Title', authors = [{ given: 'Alice', family: 'Smith' }], year = 2024) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('doi.org/api/handles')) {
      return new Response(JSON.stringify({ responseCode: 1 }), { status: 200 });
    }
    return new Response(JSON.stringify({
      message: { title: [title], author: authors, issued: { 'date-parts': [[year]] } },
    }), { status: 200 });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ReferenceValidator truth cache', () => {
  it('keys cached DOI checks by expected metadata and rejects same-surname/title-substring mismatches', async () => {
    const fetchMock = installDoiFetch('Different Study on Markets', [{ given: 'Alice', family: 'Smith' }], 2024);
    const validator = new ReferenceValidator({ cacheTtlMs: 60_000 });
    const first = await validator.validateDoi('10.1234/cache');
    const second = await validator.validateDoi('10.1234/cache', {
      expectedTitle: 'Study',
      expectedAuthors: ['Bob Smith'],
      expectedYear: 2024,
    });
    expect(first.consistency).toBeUndefined();
    expect(second.consistency).toEqual({
      titleMatch: false,
      authorMatch: false,
      yearMatch: true,
      overallMatch: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('expires cached results after the configured TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fetchMock = installDoiFetch();
    const validator = new ReferenceValidator({ cacheTtlMs: 1_000 });
    const options = { expectedTitle: 'Exact Evidence Title', expectedAuthors: ['Alice Smith'], expectedYear: 2024 };
    await validator.validateDoi('10.1234/ttl', options);
    await validator.validateDoi('10.1234/ttl', options);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    await validator.validateDoi('10.1234/ttl', options);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('uses HTTPS for the arXiv validation endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<feed>No results</feed>', { status: 200 }));
    await new ReferenceValidator().validateArxiv('2401.00001');
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/^https:\/\/export\.arxiv\.org\//u);
  });
});
