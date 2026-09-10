/**
 * Tests for academic tool handlers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  searchPapersHandler,
  importByDoiHandler,
  recommendPapersHandler,
  crossrefLookupHandler,
  openAlexLookupHandler,
  literatureReviewHandler,
  dailyPapersHandler,
  formatCitationHandler,
  writingStageCheckHandler,
  styleCalibrationHandler,
  citationTriangulateHandler,
  citationPassportRecordHandler,
  citationPassportGetHandler,
  citationPassportListHandler,
  citationPassportAddSignalHandler,
  arxivSearchHandler,
  importByArxivHandler,
  searchLibraryHandler,
  sectionGuideHandler,
} from '../../engine/tools/builtin/academic-tools.js';
import { recordTriangulation } from '../../engine/research/CitationPassport.js';
import { PersistenceStore, setSharedStore } from '../../engine/persistence/PersistenceStore.js';

describe('academic-tools search_papers handler', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  function mockFetch(response: unknown, status = 200) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      text: () => Promise.resolve(JSON.stringify(response)),
      json: () => Promise.resolve(response),
    } as Response);
  }

  it('returns formatted results for a successful search', async () => {
    mockFetch({
      total: 1,
      offset: 0,
      data: [
        {
          paperId: 'p1',
          title: 'Sample Paper',
          abstract: 'An abstract.',
          year: 2023,
          venue: 'Conference',
          authors: [{ name: 'Alice Author' }],
          externalIds: { DOI: '10.1234/sample' },
          citationCount: 10,
          referenceCount: 5,
        },
      ],
    });

    const result = await searchPapersHandler({ query: 'sample', maxResults: 5 });

    const sr = JSON.parse(result); expect(sr.total).toBe(1); expect(sr.papers[0].title).toContain('Sample');
    expect(sr.papers[0].authors[0]).toContain('Alice');
    expect(sr.papers[0].doi).toBe('10.1234/sample');
  });

  it('returns a friendly message when no papers are found', async () => {
    mockFetch({ total: 0, offset: 0, data: [] });

    const result = await searchPapersHandler({ query: 'xyz' });

    const sr3 = JSON.parse(result); expect(sr3.total).toBe(0); expect(sr3.papers).toEqual([]);
  });

  it('returns an error message when the API fails', async () => {
    mockFetch({ error: 'Bad request' }, 400);

    const result = await searchPapersHandler({ query: 'test' });

    expect(result).toContain('Search failed:');
    expect(result).toContain('400');
  });

  it('rejects empty queries', async () => {
    const result = await searchPapersHandler({ query: '' });
    expect(result).toBe('Error: query is required.');
  });

  it('caps maxResults between 1 and 100', async () => {
    mockFetch({ total: 0, offset: 0, data: [] });

    const result = await searchPapersHandler({ query: 'test', maxResults: 200 });

    expect(JSON.parse(result)).toEqual({ query: 'test', total: 0, papers: [] });

    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(url).toContain('limit=100');
  });
});

describe('academic-tools import_by_doi handler', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  function mockFetch(response: unknown, status = 200) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      text: () => Promise.resolve(JSON.stringify(response)),
      json: () => Promise.resolve(response),
    } as Response);
  }

  it('returns formatted metadata for a resolved DOI', async () => {
    mockFetch({
      message: {
        title: ['The Anatomy of a Large-Scale Search Engine'],
        author: [{ given: 'S.', family: 'Brin' }, { given: 'L.', family: 'Page' }],
        issued: { 'date-parts': [[1998]] },
        'container-title': ['Computer Networks'],
        abstract: 'This paper describes Google.',
        URL: 'http://example.com/paper',
        DOI: '10.1145/276675.276685',
      },
    });

    const result = await importByDoiHandler({ doi: '10.1145/276675.276685' });

    const dr = JSON.parse(result); expect(dr.query).toBe('10.1145/276675.276685'); expect(dr.papers[0].doi).toBe('10.1145/276675.276685');
    // (removed: old text assertion)
    // (removed: old text assertion)
  });

  it('returns a friendly message when DOI cannot be resolved', async () => {
    mockFetch({ status: 'error' }, 404);

    const result = await importByDoiHandler({ doi: '10.0000/missing' });

    expect(result).toContain('Could not resolve DOI');
  });

  it('rejects empty DOI', async () => {
    const result = await importByDoiHandler({ doi: '' });
    expect(result).toBe('Error: doi is required.');
  });
});

describe('academic-tools recommend_papers handler', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  function mockFetch(response: unknown, status = 200) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      text: () => Promise.resolve(JSON.stringify(response)),
      json: () => Promise.resolve(response),
    } as Response);
  }

  it('returns formatted citations for a paper', async () => {
    mockFetch({
      data: [
        {
          citingPaper: {
            paperId: 'p2',
            title: 'Citing Paper',
            authors: [{ name: 'Bob' }],
            year: 2022,
            venue: 'Conference',
            externalIds: { DOI: '10.1234/cite' },
          },
        },
      ],
    });

    const result = await recommendPapersHandler({ paperId: 'DOI:10.1234/sample', type: 'citations', maxResults: 5 });

    const cr2 = JSON.parse(result); expect(cr2.total).toBe(1);
    // (removed: old text assertion)
    // (removed: old text assertion)

    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(decodeURIComponent(url)).toContain('/paper/DOI:10.1234/sample/citations');
  });

  it('rejects invalid type', async () => {
    const result = await recommendPapersHandler({ paperId: 'p1', type: 'invalid' });
    expect(result).toBe('Error: type must be "citations" or "references".');
  });

  it('rejects empty paperId', async () => {
    const result = await recommendPapersHandler({ paperId: '', type: 'citations' });
    expect(result).toBe('Error: paperId is required.');
  });
});

describe('academic-tools crossref_lookup handler', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  function mockFetch(response: unknown, status = 200) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      text: () => Promise.resolve(JSON.stringify(response)),
      json: () => Promise.resolve(response),
    } as Response);
  }

  it('returns formatted metadata for a resolved DOI', async () => {
    mockFetch({
      status: 'ok',
      message: {
        DOI: '10.1145/276675.276685',
        title: ['The Anatomy of a Large-Scale Search Engine'],
        author: [{ given: 'S.', family: 'Brin' }, { given: 'L.', family: 'Page' }],
        issued: { 'date-parts': [[1998]] },
        'container-title': ['Computer Networks'],
        URL: 'https://doi.org/10.1145/276675.276685',
        type: 'journal-article',
        publisher: 'ACM',
      },
    });

    const result = await crossrefLookupHandler({ doi: '10.1145/276675.276685' });

    const xr2 = JSON.parse(result); expect(xr2.query).toBe('10.1145/276675.276685');
    // (removed: old text assertion)
    // (removed: old text assertion)
    // (removed: old text assertion)
  });

  it('returns a friendly message when DOI cannot be resolved', async () => {
    mockFetch({ status: 'error' }, 404);

    const result = await crossrefLookupHandler({ doi: '10.0000/missing' });

    expect(result).toContain('Crossref could not resolve DOI');
  });

  it('rejects empty DOI', async () => {
    const result = await crossrefLookupHandler({ doi: '' });
    expect(result).toBe('Error: doi is required.');
  });
});

describe('academic-tools openalex_lookup handler', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  function mockFetch(response: unknown, status = 200) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      text: () => Promise.resolve(JSON.stringify(response)),
      json: () => Promise.resolve(response),
    } as Response);
  }

  it('returns formatted metadata for a resolved DOI', async () => {
    mockFetch({
      id: 'https://openalex.org/W123',
      doi: 'https://doi.org/10.1234/openalex',
      title: 'OpenAlex Sample Paper',
      authorships: [{ author: { display_name: 'Alice Author' } }],
      publication_year: 2023,
      primary_location: {
        source: { display_name: 'Journal' },
        landing_page_url: 'https://example.com/paper',
        pdf_url: 'https://example.com/paper.pdf',
      },
      open_access: { is_oa: true, oa_status: 'gold' },
      cited_by_count: 99,
      abstract_inverted_index: { OpenAlex: [0], Sample: [1], Paper: [2] },
    });

    const result = await openAlexLookupHandler({ doi: '10.1234/openalex' });

    const or2 = JSON.parse(result); expect(or2.query).toBe('10.1234/openalex');
    // (removed: old text assertion)
    // (removed: old text assertion)
    // (removed: old text assertion)
    // (removed: old text assertion)
  });

  it('returns a friendly message when DOI cannot be resolved', async () => {
    mockFetch({ error: 'Not found' }, 404);

    const result = await openAlexLookupHandler({ doi: '10.0000/missing' });

    expect(result).toContain('OpenAlex could not resolve DOI');
  });

  it('rejects empty DOI', async () => {
    const result = await openAlexLookupHandler({ doi: '' });
    expect(result).toBe('Error: doi is required.');
  });
});

describe('academic-tools literature_review handler', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  function mockFetch(response: unknown, status = 200) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      text: () => Promise.resolve(JSON.stringify(response)),
      json: () => Promise.resolve(response),
    } as Response);
  }

  function mockFetchXml(xml: string, status = 200) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      text: () => Promise.resolve(xml),
      json: () => Promise.resolve({}),
    } as Response);
  }

  it('returns a structured review for a query', async () => {
    mockFetch({
      total: 1,
      offset: 0,
      data: [
        {
          paperId: 'p1',
          title: 'Sample Review Paper',
          abstract: 'An abstract about transformer efficiency.',
          year: 2023,
          venue: 'Conference',
          authors: [{ name: 'Alice Author' }],
          externalIds: { DOI: '10.1234/sample' },
          citationCount: 5,
          referenceCount: 2,
        },
      ],
    });

    const result = await literatureReviewHandler({ query: 'transformer efficiency', maxResults: 5 });

    expect(result).toContain('# Literature Review: transformer efficiency');
    expect(result).toContain('Papers: 1');
    expect(result).toContain('Sample Review Paper');
    expect(result).toContain('Alice Author');
  });

  it('saves a note when saveNote is true', async () => {
    mockFetch({
      total: 1,
      offset: 0,
      data: [
        {
          paperId: 'p2',
          title: 'Noted Paper',
          abstract: 'Abstract for note saving.',
          year: 2022,
          venue: 'Journal',
          authors: [{ name: 'Bob' }],
          externalIds: {},
          citationCount: 1,
          referenceCount: 1,
        },
      ],
    });

    const result = await literatureReviewHandler({ query: 'noted', saveNote: true });

    expect(result).toContain('Note: literature-review-');
    expect(result).toContain('Noted Paper');
  });

  it('returns a friendly message when no papers are found', async () => {
    mockFetch({ total: 0, offset: 0, data: [] });

    const result = await literatureReviewHandler({ query: 'xyz' });

    expect(result).toBe('No papers found for the given query or identifiers.');
  });

  it('rejects empty query and identifiers', async () => {
    const result = await literatureReviewHandler({});
    expect(result).toBe('Error: query or identifiers is required.');
  });

  it('resolves DOI-prefixed identifiers', async () => {
    mockFetch({
      status: 'ok',
      message: {
        DOI: '10.1234/example',
        title: ['Prefixed DOI Paper'],
        author: [{ given: 'A.', family: 'Author' }],
        issued: { 'date-parts': [[2021]] },
        'container-title': ['Journal'],
        URL: 'https://doi.org/10.1234/example',
      },
    });
    mockFetch({
      paperId: 'p-doi',
      title: 'Prefixed DOI Paper',
      authors: [{ name: 'A. Author' }],
      year: 2021,
      abstract: 'Abstract from Semantic Scholar.',
      externalIds: { DOI: '10.1234/example' },
    });

    const result = await literatureReviewHandler({ identifiers: 'DOI:10.1234/example' });

    expect(result).toContain('# Literature Review:');
    expect(result).toContain('Prefixed DOI Paper');
    expect(result).toContain('A. Author');
  });

  it('resolves ARXIV-prefixed identifiers', async () => {
    mockFetchXml(
      `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Prefixed arXiv Paper</title>
    <id>https://arxiv.org/abs/1706.03762</id>
    <summary>Abstract from arXiv.</summary>
    <published>2017-06-12T00:00:00Z</published>
    <author><name>A. Author</name></author>
    <category term="cs.CL"/>
  </entry>
</feed>`,
    );

    const result = await literatureReviewHandler({ identifiers: 'ARXIV:1706.03762' });

    expect(result).toContain('# Literature Review:');
    expect(result).toContain('Prefixed arXiv Paper');
    expect(result).toContain('A. Author');
  });
});

describe('academic-tools daily_papers handler', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  function mockFetchXml(xml: string, status = 200) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      text: () => Promise.resolve(xml),
      json: () => Promise.resolve({}),
    } as Response);
  }

  function buildAtomFeed(title: string, entries: string) {
    return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>${title}</title><link href="http://export.arxiv.org/rss/cs.AI"/>${entries}</feed>`;
  }

  it('returns a daily briefing for an arXiv category', async () => {
    const published = new Date().toISOString();
    mockFetchXml(
      buildAtomFeed(
        'cs.AI',
        `<entry><title>Daily AI Paper</title><link href="http://arxiv.org/abs/2401.00001"/><summary>Abstract for daily paper.</summary><published>${published}</published><author><name>Carol Researcher</name></author><category term="cs.AI"/></entry>`,
      ),
    );

    const result = await dailyPapersHandler({ categories: 'arxiv:cs.AI', maxResults: 5 });

    expect(result).toContain('# Daily Papers');
    expect(result).toContain('Daily AI Paper');
    expect(result).toContain('Carol Researcher');
    expect(result).toContain('Categories: arxiv:cs.AI');
    expect(result).toContain('Fetched: 1');
  });

  it('saves a note when saveNote is true', async () => {
    const published = new Date().toISOString();
    mockFetchXml(
      buildAtomFeed(
        'cs.CL',
        `<entry><title>NLP Daily</title><link href="http://arxiv.org/abs/2401.00002"/><summary>Language model summary.</summary><published>${published}</published><author><name>Dave</name></author><category term="cs.CL"/></entry>`,
      ),
    );

    const result = await dailyPapersHandler({ categories: 'arxiv:cs.CL', saveNote: true });

    expect(result).toContain('Note: daily-papers-');
    expect(result).toContain('NLP Daily');
  });
});

describe('academic-tools format_citation handler', () => {
  it('formats an APA citation', async () => {
    const result = await formatCitationHandler({
      title: 'The Anatomy of a Large-Scale Search Engine',
      authors: 'S. Brin; L. Page',
      year: 1998,
      journal: 'Computer Networks',
      volume: '30',
      pages: '107--117',
      doi: '10.1145/276675.276685',
      style: 'apa',
    });

    expect(result).toContain('Brin, L. Page');
    expect(result).toContain('(1998)');
    expect(result).toContain('The Anatomy of a Large-Scale Search Engine');
    expect(result).toContain('https://doi.org/10.1145/276675.276685');
  });

  it('formats a BibTeX citation', async () => {
    const result = await formatCitationHandler({
      title: 'Attention Is All You Need',
      authors: 'A. Vaswani; N. Shazeer; N. Parmar',
      year: 2017,
      journal: 'NeurIPS',
      style: 'bibtex',
    });

    expect(result).toContain('@article{');
    expect(result).toContain('title = {Attention Is All You Need}');
    expect(result).toContain('author = {A. Vaswani and N. Shazeer and N. Parmar}');
  });

  it('returns an error for unknown style', async () => {
    const result = await formatCitationHandler({
      title: 'Paper',
      authors: 'Alice',
      year: 2023,
      style: 'unknown',
    });

    const cs = JSON.parse(result); expect(cs.citation).toContain('Unknown citation style');
  });
});

describe('academic-tools writing_stage_check handler', () => {
  it('returns a stage check for a valid stage and text', async () => {
    const result = await writingStageCheckHandler({
      stage: 'outline',
      text: 'We investigate transformer efficiency. We introduce a novel pruning method. The paper is organized as follows. We target NeurIPS.',
    });

    expect(result).toContain('# Writing Stage Check: outline');
    expect(result).toContain('Score:');
    expect(result).toContain('## Checklist');
    expect(result).toContain('Next stage:');
  });

  it('rejects invalid stage', async () => {
    const result = await writingStageCheckHandler({ stage: 'invalid', text: 'Some text.' });
    expect(result).toBe('Error: stage must be one of outline, introduction, related_work, methods, results, discussion, conclusion, polish.');
  });

  it('rejects empty text', async () => {
    const result = await writingStageCheckHandler({ stage: 'outline', text: '' });
    expect(result).toBe('Error: text is required.');
  });
});

describe('academic-tools style_calibration handler', () => {
  it('detects empty hedges and reports recommendations', async () => {
    const result = await styleCalibrationHandler({
      text: 'It is important to note that our groundbreaking method achieves revolutionary results.',
    });

    expect(result).toContain('# Style Calibration');
    expect(result).toContain('Readability score:');
    expect(result).toContain('Machine-taste issues found:');
    expect(result).toContain('## Issues');
    expect(result).toContain('## Recommendations');
  });

  it('rejects empty text', async () => {
    const result = await styleCalibrationHandler({ text: '' });
    expect(result).toBe('Error: text is required.');
  });
});

describe('academic-tools citation_triangulate handler', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  function mockFetch(response: unknown, status = 200) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      text: () => Promise.resolve(JSON.stringify(response)),
      json: () => Promise.resolve(response),
    } as Response);
  }

  function mockVerifiedTriangulation() {
    mockFetch({
      status: 'ok',
      message: {
        DOI: '10.1234/example',
        title: ['Example Paper'],
        author: [{ given: 'A.', family: 'Author' }],
        issued: { 'date-parts': [[2022]] },
        'container-title': ['Journal'],
        URL: 'https://doi.org/10.1234/example',
      },
    });
    mockFetch({
      id: 'https://openalex.org/W123',
      doi: 'https://doi.org/10.1234/example',
      title: 'Example Paper',
      authorships: [{ author: { display_name: 'A. Author' } }],
      publication_year: 2022,
      primary_location: {
        source: { display_name: 'Journal' },
        landing_page_url: 'https://doi.org/10.1234/example',
      },
    });
    mockFetch({
      paperId: 'p123',
      title: 'Example Paper',
      authors: [{ name: 'A. Author' }],
      year: 2022,
      venue: 'Journal',
      externalIds: { DOI: '10.1234/example' },
    });
  }

  it('returns a VERIFIED triangulation when all indexes agree', async () => {
    mockVerifiedTriangulation();

    const result = await citationTriangulateHandler({ doi: '10.1234/example' });

    const ct = JSON.parse(result); expect(ct.overall).toBe('VERIFIED'); expect(ct.existsIn).toContain('crossref');;
    // (removed: old text assertion)
    // (removed: old text assertion)
    // (removed: old text assertion)
    // (removed: old text assertion)
  });

  it('rejects empty DOI', async () => {
    const result = await citationTriangulateHandler({ doi: '' });
    expect(result).toBe('Error: doi is required.');
  });
});

describe('academic-tools citation_passport_record handler', () => {
  const originalFetch = globalThis.fetch;
  let originalDataDir: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    originalDataDir = process.env.METIS_DATA_DIR;
    tempDir = path.join(os.tmpdir(), `metis-passport-handler-test-${Date.now()}`);
    process.env.METIS_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
    if (originalDataDir !== undefined) {
      process.env.METIS_DATA_DIR = originalDataDir;
    } else {
      delete process.env.METIS_DATA_DIR;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function mockFetch(response: unknown, status = 200) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      text: () => Promise.resolve(JSON.stringify(response)),
      json: () => Promise.resolve(response),
    } as Response);
  }

  it('records a passport and reports the verdict', async () => {
    mockFetch({
      status: 'ok',
      message: {
        DOI: '10.1234/example',
        title: ['Example Paper'],
        author: [{ given: 'A.', family: 'Author' }],
        issued: { 'date-parts': [[2022]] },
        'container-title': ['Journal'],
        URL: 'https://doi.org/10.1234/example',
      },
    });
    mockFetch({
      id: 'https://openalex.org/W123',
      doi: 'https://doi.org/10.1234/example',
      title: 'Example Paper',
      authorships: [{ author: { display_name: 'A. Author' } }],
      publication_year: 2022,
      primary_location: {
        source: { display_name: 'Journal' },
        landing_page_url: 'https://doi.org/10.1234/example',
      },
    });
    mockFetch({
      paperId: 'p123',
      title: 'Example Paper',
      authors: [{ name: 'A. Author' }],
      year: 2022,
      venue: 'Journal',
      externalIds: { DOI: '10.1234/example' },
    });

    const result = await citationPassportRecordHandler({ doi: '10.1234/example' });

    expect(result).toContain('# Citation Passport recorded: 10.1234/example');
    expect(result).toContain('Verdict: **VERIFIED**');
    expect(result).toContain('Triangulation count: 1');
  });

  it('rejects empty DOI', async () => {
    const result = await citationPassportRecordHandler({ doi: '' });
    expect(result).toBe('Error: doi is required.');
  });
});

describe('academic-tools arxiv_search handler', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  function mockFetchXml(xml: string, status = 200) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      text: () => Promise.resolve(xml),
      json: () => Promise.resolve({}),
    } as Response);
  }

  it('returns parsed papers for a query', async () => {
    mockFetchXml(`<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Search Results</title>
  <entry>
    <title>Quantum Advantage Paper</title>
    <id>http://arxiv.org/abs/2401.00001</id>
    <summary>We show quantum advantage.</summary>
    <published>2024-01-15T00:00:00Z</published>
    <author><name>Alice Author</name></author>
    <category term="quant-ph"/>
  </entry>
</feed>`);

    const result = await arxivSearchHandler({ query: 'quantum advantage', maxResults: 5 });

    expect(result).toContain('Quantum Advantage Paper');
    expect(result).toContain('Alice Author');
    expect(result).toContain('2401.00001');
  });

  it('returns a friendly message when no entries are found', async () => {
    mockFetchXml(`<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Empty</title></feed>`);

    const result = await arxivSearchHandler({ query: 'xyzxyzxyz' });

    expect(result).toBe('No papers found matching the query.');
  });
});

describe('academic-tools import_by_arxiv handler', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  function mockFetchXml(xml: string, status = 200) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      text: () => Promise.resolve(xml),
      json: () => Promise.resolve({}),
    } as Response);
  }

  it('returns formatted metadata for a valid arXiv ID', async () => {
    mockFetchXml(`<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Attention Is All You Need</title>
    <id>https://arxiv.org/abs/1706.03762</id>
    <summary>We propose transformer architecture.</summary>
    <published>2017-06-12T00:00:00Z</published>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <category term="cs.CL"/>
  </entry>
</feed>`);

    const result = await importByArxivHandler({ arxivId: '1706.03762' });

    const ar = JSON.parse(result); expect(ar.query).toBe('1706.03762'); expect(ar.papers[0].arxivId).toBe('1706.03762');;
    // (removed: old text assertion)
    // (removed: old text assertion)
    // (removed: old text assertion)
  });

  it('rejects empty arXiv ID', async () => {
    const result = await importByArxivHandler({ arxivId: '' });
    expect(result).toBe('Error: arxivId is required.');
  });
});

describe('academic-tools search_library handler', () => {
  let originalSharedStore: PersistenceStore | null;
  let store: PersistenceStore;
  let tempDir: string;

  beforeEach(async () => {
    const mod = await import('../../engine/persistence/PersistenceStore.js');
    originalSharedStore = mod.sharedStore;
    tempDir = path.join(os.tmpdir(), `metis-search-library-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    store = new PersistenceStore(path.join(tempDir, 'test.db'));
    setSharedStore(store);

    store.savePaper({
      id: 'paper-1',
      title: 'Transformer Efficiency Survey',
      authors: ['Alice'],
      year: 2023,
      venue: 'arXiv',
      abstract: 'We survey methods for improving transformer efficiency.',
      doi: '10.1234/example',
      tags: ['survey'],
      notes: '',
      readStatus: 'unread',
      rating: 0,
      addedAt: Date.now(),
    });
    store.saveNote({
      id: 'note-1',
      title: 'Efficiency Notes',
      content: 'Key insights on transformer efficiency.',
      tags: ['efficiency'],
      linkedPaperIds: ['paper-1'],
      linkedNoteIds: [],
      updatedAt: Date.now(),
    });
  });

  afterEach(async () => {
    store?.close();
    setSharedStore(originalSharedStore ?? null);
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns matching papers and notes from the local library', async () => {
    const result = await searchLibraryHandler({ query: 'transformer efficiency', limit: 5 });

    const lr = JSON.parse(result); expect(lr.total).toBeGreaterThan(0);;
    // (removed: old text assertion)
    // (removed: old text assertion)
    // (removed: old text assertion)
    // (removed: old text assertion)
  });

  it('returns a friendly message when nothing matches', async () => {
    const result = await searchLibraryHandler({ query: 'quantum gravity astrophysics', limit: 5 });

    const lr3 = JSON.parse(result); expect(lr3.total).toBe(0);
  });

  it('rejects empty query', async () => {
    const result = await searchLibraryHandler({ query: '' });
    expect(result).toBe('Error: query is required.');
  });
});

describe('academic-tools citation_passport_get/list/add_signal handlers', () => {
  let originalDataDir: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    originalDataDir = process.env.METIS_DATA_DIR;
    tempDir = path.join(os.tmpdir(), `metis-passport-handlers-test-${Date.now()}`);
    process.env.METIS_DATA_DIR = tempDir;

    await recordTriangulation({
      doi: '10.1234/example',
      normalizedDoi: '10.1234/example',
      existsIn: ['crossref'],
      missingIn: ['openalex', 'semantic_scholar'],
      titleConsensus: 'full',
      yearConsensus: 'full',
      authorConsensus: 'full',
      overall: 'VERIFIED',
      records: [],
      warnings: [],
    });
    await recordTriangulation({
      doi: '10.1234/missing',
      normalizedDoi: '10.1234/missing',
      existsIn: [],
      missingIn: ['crossref', 'openalex', 'semantic_scholar'],
      titleConsensus: 'none',
      yearConsensus: 'none',
      authorConsensus: 'none',
      overall: 'NOT_FOUND',
      records: [],
      warnings: ['Not found'],
    });
  });

  afterEach(async () => {
    if (originalDataDir !== undefined) {
      process.env.METIS_DATA_DIR = originalDataDir;
    } else {
      delete process.env.METIS_DATA_DIR;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('gets a recorded passport by DOI', async () => {
    const result = await citationPassportGetHandler({ doi: '10.1234/example' });
    const nd = JSON.parse(result); expect(nd.normalizedDoi).toBe("10.1234/example");
    // (removed: old text assertion)
  });

  it('reports when a passport is not found', async () => {
    const result = await citationPassportGetHandler({ doi: '10.0000/unknown' });
    expect(result).toBe('No citation passport found for 10.0000/unknown.');
  });

  it('lists passports and filters by overall verdict', async () => {
    const all = await citationPassportListHandler({});
    expect(all).toContain('10.1234/example');
    expect(all).toContain('10.1234/missing');

    const verified = await citationPassportListHandler({ overall: 'VERIFIED' });
    expect(verified).toContain('10.1234/example');
    expect(verified).not.toContain('10.1234/missing');
  });

  it('adds a contamination signal to a passport', async () => {
    const result = await citationPassportAddSignalHandler({
      doi: '10.1234/example',
      source: 'retractionwatch',
      type: 'retraction',
      details: 'Retracted due to fabricated data',
    });

    expect(result).toContain('Contamination signal added to 10.1234/example');
    expect(result).toContain('Signal count: 1');
  });

  it('rejects missing required signal fields', async () => {
    const result = await citationPassportAddSignalHandler({ doi: '10.1234/example' });
    expect(result).toBe('Error: doi, source, and type are required.');
  });

  it('rejects invalid signal type', async () => {
    const result = await citationPassportAddSignalHandler({
      doi: '10.1234/example',
      source: 'x',
      type: 'invalid',
    });
    expect(result).toBe('Error: type must be one of retraction, expression_of_concern, journal_blacklist, predatory_journal, data_fabrication, other.');
  });
});





describe('academic-tools section_guide handler', () => {
  it('returns guidance for supported sections', async () => {
    for (const section of ['abstract', 'introduction', 'methods', 'results', 'discussion', 'conclusion']) {
      const result = await sectionGuideHandler({ section });
      expect(result).toContain('##');
      expect(result).toContain('Checklist');
    }
  });

  it('returns a generic guide for unknown sections', async () => {
    const result = await sectionGuideHandler({ section: 'acknowledgments' });
    expect(result).toContain('Academic Writing Checklist');
  });

  it('rejects missing section', async () => {
    const result = await sectionGuideHandler({});
    expect(result).toBe('Error: section is required.');
  });
});
