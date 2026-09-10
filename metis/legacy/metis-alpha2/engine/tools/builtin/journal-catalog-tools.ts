import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';
import {
  getJournalCatalogDetail,
  JOURNAL_CATALOG_SOURCES,
  searchJournalCatalog,
  type JournalCatalogSource,
} from '../../research/JournalCatalog.js';

/**
 * Fixed journal-directory skills: LetPub for international (SCI/SSCI) journals
 * and Wanwei Shukan for Chinese journals. The two-step flow mirrors how the
 * directories are organised: pick a subject/category, scan the list, then open
 * the chosen journal for submission channels (URL, email, phone) and metrics.
 */

export const JOURNAL_DIRECTORY_SEARCH_TOOL: ToolSpec = {
  name: 'journal_directory_search',
  description: [
    'Search a curated journal directory to find candidate journals for a manuscript.',
    'Two sources: "letpub" for international SCI/SSCI journals (search by English journal-name keyword, or browse a Chinese subject field), "eshukan" for Chinese journals (browse a Chinese subject category).',
    'Returns journals with id, ISSN, submission-channel label, and detail ids for journal_directory_detail.',
    'If field does not match exactly, returns fieldCandidates — call again with one of them.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', enum: ['letpub', 'eshukan'], description: 'letpub = international/SCI journals; eshukan = Chinese journals.' },
      field: { type: 'string', description: 'Subject/category name in Chinese, e.g. 社会学, 临床医学, 自然科学综合.' },
      keyword: { type: 'string', description: 'Journal-name keyword, LetPub only, e.g. "rural sociology" or "education".' },
      firstLetter: { type: 'string', description: 'Optional A-Z filter on journal initial (LetPub field browsing only).' },
      page: { type: 'number', description: 'Page number starting at 1 (default 1).' },
    },
    required: ['source'],
  },
  examples: [
    { input: { source: 'eshukan', field: '劳动与人才' }, output: '{"source":"eshukan","field":{"id":"66","name":"劳动与人才"},"journals":[{"id":"1234","name":"中国劳动","submissionLabel":"官网投稿"}]}' },
    { input: { source: 'letpub', keyword: 'sociology' }, output: '{"source":"letpub","keyword":"sociology","journals":[{"id":"11374","name":"Annual Review of Sociology","issn":"0360-0572"}]}' },
  ],
};

export const JOURNAL_DIRECTORY_DETAIL_TOOL: ToolSpec = {
  name: 'journal_directory_detail',
  description: [
    'Fetch full submission information for one journal from a directory (use the id returned by journal_directory_search).',
    'Returns official website, submission URL/email/phone, CN/ISSN, publisher, review cycle and acceptance ratio (crowd-shared), article processing charges, warning-list status, and the Chinese submission-notice text when available.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', enum: ['letpub', 'eshukan'], description: 'Which directory the id belongs to.' },
      id: { type: 'string', description: 'Directory journal id from journal_directory_search results.' },
    },
    required: ['source', 'id'],
  },
  examples: [
    { input: { source: 'eshukan', id: '6744' }, output: '{"source":"eshukan","id":"6744","submissionUrl":"https://...","submissionEmails":["edit@example.edu.cn"]}' },
  ],
};

function asSource(value: unknown): JournalCatalogSource | null {
  return typeof value === 'string' && (JOURNAL_CATALOG_SOURCES as readonly string[]).includes(value)
    ? value as JournalCatalogSource
    : null;
}

export const journalDirectorySearchHandler: ToolHandler = async (args) => {
  const source = asSource(args.source);
  if (!source) return 'Error: source must be "letpub" (international/SCI) or "eshukan" (Chinese journals).';
  try {
    const result = await searchJournalCatalog({
      source,
      field: typeof args.field === 'string' ? args.field : undefined,
      keyword: typeof args.keyword === 'string' ? args.keyword : undefined,
      firstLetter: typeof args.firstLetter === 'string' ? args.firstLetter : undefined,
      page: typeof args.page === 'number' && Number.isFinite(args.page) ? args.page : 1,
    });
    return JSON.stringify(result, null, 2);
  } catch (err) {
    return `Journal directory search failed: ${err instanceof Error ? err.message : String(err)}. Try again later.`;
  }
};

export const journalDirectoryDetailHandler: ToolHandler = async (args) => {
  const source = asSource(args.source);
  if (!source) return 'Error: source must be "letpub" or "eshukan".';
  const id = String(args.id ?? '').trim();
  if (!id) return 'Error: id is required (from journal_directory_search).';
  try {
    const detail = await getJournalCatalogDetail(source, id);
    return JSON.stringify(detail, null, 2);
  } catch (err) {
    return `Journal directory detail failed: ${err instanceof Error ? err.message : String(err)}. Try again later.`;
  }
};

export const JOURNAL_CATALOG_TOOL_SPECS: ToolSpec[] = [
  JOURNAL_DIRECTORY_SEARCH_TOOL,
  JOURNAL_DIRECTORY_DETAIL_TOOL,
];
