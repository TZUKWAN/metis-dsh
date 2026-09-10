/**
 * Literature 核心 + Provider 单元测试（Phase 11-13 / 任务清单 11.4、12.3、13.2）。
 * 真实网络的 live 验证放在 Phase 14 集成测试（tests/integration）。
 */

import { describe, expect, it, vi } from 'vitest';
import { LiteratureRegistry } from '../../plugins/literature/src/registry.ts';
import { normalizeDoi, ProviderUnavailableError, SEARCH_HARD_CAP } from '../../plugins/literature/src/domain.ts';
import { CrossrefProvider, crossrefWorkToRecord } from '../../plugins/literature-crossref/src/index.ts';
import { openalexWorkToRecord } from '../../plugins/literature-openalex/src/index.ts';

describe('normalizeDoi', () => {
  it('strips url prefixes and lowercases', () => {
    expect(normalizeDoi('https://doi.org/10.1145/276675.276685')).toBe('10.1145/276675.276685');
    expect(normalizeDoi(' 10.1000/ABC ')).toBe('10.1000/abc');
    expect(normalizeDoi('')).toBeUndefined();
  });
});

describe('LiteratureRegistry', () => {
  const providerA = { name: 'a', capabilities: { search: true, getByDoi: false }, search: vi.fn() };

  it('rejects duplicate provider registration (T11-021)', () => {
    const registry = new LiteratureRegistry();
    registry.registerProvider(providerA);
    expect(() => registry.registerProvider(providerA)).toThrow(/已注册/);
  });

  it('fails loud when resolving with no providers or unknown filter (T11-040)', () => {
    const registry = new LiteratureRegistry();
    expect(() => registry.resolveProviders()).toThrow(/没有任何已注册/);
    registry.registerProvider(providerA);
    expect(() => registry.resolveProviders(['nope'])).toThrow(/指定的 provider 不存在/);
  });

  it('merges multi-provider results with DOI-first dedupe (T11-026)', () => {
    const registry = new LiteratureRegistry();
    const merged = registry.merge([
      { id: '1', title: 'Same work via crossref', authors: [], year: 2024, doi: '10.1/x', source: 'crossref', sourceId: 'c1' },
      { id: '2', title: 'Same work via openalex', authors: [], year: 2024, doi: '10.1/X', source: 'openalex', sourceId: 'o1' },
      { id: '3', title: 'Distinct work without DOI', authors: [], year: 2023, source: 'openalex', sourceId: 'o2' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.doi).toBe('10.1/x');
  });

  it('exposes the search hard cap', () => {
    expect(SEARCH_HARD_CAP).toBe(50);
  });
});

describe('CrossrefProvider normalization', () => {
  it('maps a Crossref work to the canonical record (fixture-shaped)', () => {
    const record = crossrefWorkToRecord({
      DOI: '10.1000/Example',
      title: ['Generative AI and knowledge workers'],
      author: [
        { given: 'Ada', family: 'Lee' },
        { name: '集体作者' },
      ],
      'container-title': ['Journal of X'],
      abstract: '<jats:p>Abstract with <jats:italic>tags</jats:italic>.</jats:p>',
      URL: 'https://example.org/work',
      issued: { 'date-parts': [[2024, 3]] },
      'is-referenced-by-count': 12,
    });
    expect(record.doi).toBe('10.1000/example');
    expect(record.title).toBe('Generative AI and knowledge workers');
    expect(record.authors).toEqual([{ name: 'Ada Lee' }, { name: '集体作者' }]);
    expect(record.journal).toBe('Journal of X');
    expect(record.abstract).toBe('Abstract with tags.');
    expect(record.year).toBe(2024);
    expect(record.citationCount).toBe(12);
  });

  it('provider failures surface as ProviderUnavailableError (fail-loud, no fake results)', () => {
    const provider = new CrossrefProvider();
    // mock fetch 返回 429 → ProviderUnavailableError。
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 429 }));
    return expect(provider.search({ query: 'x' })).rejects.toThrow(ProviderUnavailableError).finally(() => fetchMock.mockRestore());
  });
});

describe('OpenAlexProvider normalization', () => {
  it('reconstructs the abstract from the inverted index (legacy semantics)', () => {
    const record = openalexWorkToRecord({
      id: 'https://openalex.org/w1',
      doi: 'https://doi.org/10.1000/OA',
      display_name: 'OpenAlex work',
      authorships: [{ author: { display_name: 'Alice' } }, { author: { display_name: 'Bob' } }],
      publication_year: 2023,
      primary_location: { source: { display_name: 'Venue Y' } },
      abstract_inverted_index: { 'Abstract': [0], 'text': [1], 'reconstructed': [2] },
      cited_by_count: 7,
    });
    expect(record.abstract).toBe('Abstract text reconstructed');
    expect(record.doi).toBe('10.1000/oa');
    expect(record.authors).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
    expect(record.year).toBe(2023);
    expect(record.citationCount).toBe(7);
  });
});
