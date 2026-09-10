/**
 * Academic research tools — arxiv search, BibTeX parsing, citation formatting.
 *
 * These tools are registered into the ToolRegistry and exposed to the agent
 * during research-focused sessions.
 */

import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';
import { searchPapers, getPaperRecommendations, recommendationToPlain } from '../../research/SemanticScholarClient.js';
import { resolveDoi } from '../../research/DoiResolver.js';
import { resolveArxiv } from '../../research/ArxivResolver.js';
import { getWorkByDoi as getCrossrefWorkByDoi } from '../../research/CrossrefClient.js';
import { getWorkByDoi as getOpenAlexWorkByDoi } from '../../research/OpenAlexClient.js';
import {
  checkStage,
  calibrateStyle,
  stageResultToPlain,
  styleResultToPlain,
} from '../../writing/WritingPipeline.js';
import { auditLaTeX, cleanupResultToPlain } from '../../writing/LaTeXAuditor.js';
import { auditFigures, figureAuditResultToPlain } from '../../writing/FigureAuditor.js';
import { auditTables, tableAuditResultToPlain } from '../../writing/TableAuditor.js';
import { runLaTeXIntegrityReport, integrityReportToPlain } from '../../writing/LaTeXIntegrityReporter.js';
import { auditMath, mathAuditResultToPlain } from '../../writing/MathAuditor.js';
import { auditSections, sectionAuditResultToPlain } from '../../writing/SectionAuditor.js';
import { getSectionGuide } from '../../writing/SectionGuide.js';
import { checkFigureReferences, figureReferenceResultToPlain } from '../../writing/FigureReferenceChecker.js';
import { sharedStore, type PersistenceStore } from '../../persistence/PersistenceStore.js';
import { triangulateDoi, triangulationResultToPlain } from '../../research/CitationTriangulator.js';
import {
  recordTriangulation,
  getPassport,
  listPassports,
  addContaminationSignal,
  passportToPlain,
} from '../../research/CitationPassport.js';
import { scanDoi, scanAllPassports, scanResultToPlain } from '../../research/ContaminationScanner.js';
import { updateMirror, lookupDoi, loadMirror, entryToPlain, mirrorStatsToPlain } from '../../research/RetractionWatchMirror.js';
import {
  updateMirror as updateJournalIntegrityMirror,
  updateAllMirrors,
  lookupVenue,
  loadIndex,
  entryToPlain as journalEntryToPlain,
  indexStatsToPlain,
  type JournalIntegrityType,
} from '../../research/JournalIntegrityMirror.js';
import { auditBibTeX, auditResultToPlain } from '../../research/BibTeXAuditor.js';
import { saveReview, listReviews, getReviewMarkdown } from '../../manifest/ReviewStore.js';
import { initWorkspace, readWorkspaceManifest, DEFAULT_DIRECTORIES } from '../../workspace/WorkspaceInitializer.js';
import { addFinding, listFindings, exportFindings } from '../../workspace/FindingsLog.js';
import { loadManifest, listClaims } from '../../manifest/ClaimManifest.js';
import {
  generateLiteratureReview,
  literatureReviewToPlain,
} from '../../research/LiteratureReviewEngine.js';
import {
  generateDailyPapersBriefing,
  dailyPapersToPlain,
} from '../../research/DailyPapersEngine.js';

export const ARXIV_SEARCH_TOOL: ToolSpec = {
  name: 'arxiv_search',
  description: 'Search arXiv for papers by query string, author, or category.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (title, abstract, keywords)' },
      author: { type: 'string', description: 'Filter by author name (optional)' },
      category: { type: 'string', description: 'arXiv category (e.g., cs.AI, cs.CL) (optional)' },
      maxResults: { type: 'number', description: 'Maximum results to return (default 10)' },
      sortBy: { type: 'string', enum: ['relevance', 'lastUpdatedDate', 'submittedDate'], description: 'Sort order' },
    },
    required: ['query'],
  },
  examples: [
    { input: { query: 'transformer attention mechanism', maxResults: 5 }, output: 'Found 5 papers. [1] "Attention Is All You Need" by Vaswani et al. (2017)...' },
    { input: { query: 'diffusion models', category: 'cs.CV', sortBy: 'submittedDate' }, output: 'Found papers sorted by date. Most recent: "High-Resolution Image Synthesis..."' },
  ],
};

export const PARSE_BIBTEX_TOOL: ToolSpec = {
  name: 'parse_bibtex',
  description: 'Parse BibTeX entries into structured paper metadata. Supports importing .bib files.',
  parameters: {
    type: 'object',
    properties: {
      bibtex: { type: 'string', description: 'BibTeX string to parse' },
      filePath: { type: 'string', description: 'Path to .bib file to import (optional, use bibtex or filePath)' },
    },
  },
};

export const BIBTEX_AUDIT_TOOL: ToolSpec = {
  name: 'bibtex_audit',
  description: 'Audit a BibTeX file against LaTeX citation usage and academic indexes. Detects orphan citations, duplicate keys, missing DOIs/arXiv IDs, and verifies each reference via Crossref/OpenAlex/Semantic Scholar or arXiv.',
  parameters: {
    type: 'object',
    properties: {
      bibtex: { type: 'string', description: 'BibTeX string to audit' },
      filePath: { type: 'string', description: 'Path to .bib file to audit (optional if bibtex is provided)' },
      texDir: { type: 'string', description: 'Directory containing .tex files to scan for citation usage (optional)' },
    },
  },
};

export const LATEX_CLEANUP_TOOL: ToolSpec = {
  name: 'latex_cleanup',
  description: 'Pre-submission audit of a LaTeX project. Detects broken citations, undefined or duplicate labels, empty cite/ref commands, TODO/FIXME comments, draft artifacts, empty sections, and common style issues. Optionally cross-checks citation keys against a .bib file.',
  parameters: {
    type: 'object',
    properties: {
      texDir: { type: 'string', description: 'Directory containing .tex files to audit' },
      bibPath: { type: 'string', description: 'Optional path to .bib file for citation cross-check' },
    },
    required: ['texDir'],
  },
};

export const FIGURE_AUDIT_TOOL: ToolSpec = {
  name: 'figure_audit',
  description: 'Audit figures in a LaTeX project. Detects missing files, raster plots, raster-in-PDF wrappers, oversized/low-resolution bitmaps, duplicate figures, and missing captions/labels.',
  parameters: {
    type: 'object',
    properties: {
      texDir: { type: 'string', description: 'Directory containing .tex files to scan for \\\\includegraphics' },
    },
    required: ['texDir'],
  },
};

export const TABLE_AUDIT_TOOL: ToolSpec = {
  name: 'table_audit',
  description: 'Audit tables in a LaTeX project. Detects missing captions/labels, vertical rules, missing booktabs rules, numeric columns without siunitx alignment, empty cells, overly wide tables, and duplicate tables.',
  parameters: {
    type: 'object',
    properties: {
      texDir: { type: 'string', description: 'Directory containing .tex files to scan for tables' },
    },
    required: ['texDir'],
  },
};

export const LATEX_INTEGRITY_REPORT_TOOL: ToolSpec = {
  name: 'latex_integrity_report',
  description: 'Run a unified pre-submission integrity report over a LaTeX project. Aggregates latex_cleanup, figure_audit, table_audit, and optional bibtex_audit into a single severity-ranked report.',
  parameters: {
    type: 'object',
    properties: {
      texDir: { type: 'string', description: 'Directory containing .tex files to audit' },
      bibPath: { type: 'string', description: 'Optional path to .bib file for reference integrity check' },
    },
    required: ['texDir'],
  },
};

export const MATH_AUDIT_TOOL: ToolSpec = {
  name: 'math_audit',
  description: 'Audit LaTeX math usage. Flags deprecated $$...$$ display math, deprecated eqnarray environments, unlabeled numbered equations, display-style commands inside inline math, and non-ASCII characters in inline math.',
  parameters: {
    type: 'object',
    properties: {
      texDir: { type: 'string', description: 'Directory containing .tex files to audit' },
    },
    required: ['texDir'],
  },
};
export const SECTION_AUDIT_TOOL: ToolSpec = {
  name: 'section_audit',
  description: 'Audit the structure of a LaTeX academic paper. Detects missing expected sections (Introduction, Related Work, Methods, Results, Discussion, Conclusion), out-of-order sections, empty sections, excessive subsections, deep nesting, and abstract length issues.',
  parameters: {
    type: 'object',
    properties: {
      texDir: { type: 'string', description: 'Directory containing .tex files to audit' },
    },
    required: ['texDir'],
  },
};

export const SECTION_GUIDE_TOOL: ToolSpec = {
  name: 'section_guide',
  description: 'Return section-specific writing guidance for a research paper stage. Supported stages match the paper-writing pipeline: outline, introduction, related_work, methods, results, discussion, conclusion, polish. An abstract guide is also available (abstract is not a gated stage but a real section). Use before drafting a stage to avoid generic structure mistakes.',
  parameters: {
    type: 'object',
    properties: {
      section: { type: 'string', description: 'Paper stage/section. Pipeline stages: outline, introduction, related_work, methods, results, discussion, conclusion, polish. Also accepts abstract.' },
    },
    required: ['section'],
  },
  examples: [
    { input: { section: 'outline' }, output: 'Outline Checklist with research question, contributions, section overview, venue constraints, and risk register.' },
    { input: { section: 'introduction' }, output: 'Introduction Checklist with hook, gap, contributions, and roadmap guidance.' },
    { input: { section: 'methods' }, output: 'Methods Checklist emphasizing reproducibility and notation.' },
    { input: { section: 'polish' }, output: 'Polish Checklist with AI-Tell scan, tense/voice consistency, citation hygiene, and AI disclosure.' },
  ],
};

export const FORMAT_CITATION_TOOL: ToolSpec = {
  name: 'format_citation',
  description: 'Format a paper reference into a citation style (APA, MLA, Chicago, IEEE, BibTeX native).',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      authors: { type: 'string', description: 'Semicolon-separated author names' },
      year: { type: 'number' },
      journal: { type: 'string', description: 'Journal or venue name (optional)' },
      volume: { type: 'string', description: 'Volume (optional)' },
      pages: { type: 'string', description: 'Page range (optional)' },
      doi: { type: 'string', description: 'DOI (optional)' },
      style: { type: 'string', enum: ['apa', 'mla', 'chicago', 'ieee', 'bibtex'], description: 'Citation style' },
    },
    required: ['title', 'authors', 'year', 'style'],
  },
};

export const READ_PDF_TOOL: ToolSpec = {
  name: 'read_pdf',
  description: 'Extract text content from a PDF file (paper reading).',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to the PDF file' },
      pages: { type: 'string', description: 'Page range (e.g., "1-5" or "3") (optional, all pages if omitted)' },
    },
    required: ['filePath'],
  },
  examples: [
    { input: { filePath: '/papers/attention.pdf', pages: '1-3' }, output: '[Page 1] Attention Is All You Need... [Page 2] The dominant sequence transduction... [Page 3] We propose a new simple network architecture...' },
    { input: { filePath: '/papers/gpt4.pdf' }, output: '[Page 1] GPT-4 Technical Report. Abstract: We report the development of GPT-4... (all pages extracted)' },
  ],
};

/** T2：本地文献库全文检索（题录+摘要+PDF 全文+笔记），供基于证据的问答与综述使用。 */
export const SEARCH_PAPER_TEXT_TOOL: ToolSpec = {
  name: 'search_paper_text',
  description: 'Search the local METIS library FULL TEXT (titles, abstracts, extracted PDF text, notes). Use this to ground answers and literature reviews in the user\'s own imported papers; returns per-paper hit snippets with page markers.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms (Chinese or English); multiple words are AND-ish scored.' },
      limit: { type: 'number', description: 'Maximum papers to return (1-20, default 8).' },
    },
    required: ['query'],
  },
};

export const SEMANTIC_SCHOLAR_SEARCH_TOOL: ToolSpec = {
  name: 'search_papers',
  description: 'Search for academic papers across all disciplines using Semantic Scholar. Returns title, authors, year, venue, abstract, DOI, arXiv ID, citation counts, and open access PDF links.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (title, abstract, keywords, author)' },
      maxResults: { type: 'number', description: 'Maximum results to return (default 10, max 100)' },
      offset: { type: 'number', description: 'Offset for pagination (default 0)' },
    },
    required: ['query'],
  },
  examples: [
    { input: { query: 'transformer attention mechanism', maxResults: 5 }, output: 'Found 5 papers. [1] "Attention Is All You Need" by Vaswani et al. (2017)...' },
    { input: { query: 'diffusion models', maxResults: 3 }, output: 'Found 3 papers. Most cited: "Denoising Diffusion Probabilistic Models" (2020)...' },
  ],
};

export const IMPORT_BY_DOI_TOOL: ToolSpec = {
  name: 'import_by_doi',
  description: 'Resolve a DOI to paper metadata using CrossRef and import it into the paper library. Returns title, authors, year, venue, abstract, and URL.',
  parameters: {
    type: 'object',
    properties: {
      doi: { type: 'string', description: 'DOI string (e.g., 10.1145/276675.276685 or https://doi.org/10.1145/276675.276685)' },
    },
    required: ['doi'],
  },
  examples: [
    { input: { doi: '10.1145/276675.276685' }, output: 'Imported: "The Anatomy of a Large-Scale Search Engine" by Brin, Page (1998)...' },
  ],
};

export const CROSSREF_LOOKUP_TOOL: ToolSpec = {
  name: 'crossref_lookup',
  description: 'Look up a DOI in Crossref, the authoritative DOI registration source. Returns title, authors, year, venue, publisher, type, citation counts, and URL.',
  parameters: {
    type: 'object',
    properties: {
      doi: { type: 'string', description: 'DOI string (e.g., 10.1145/276675.276685 or https://doi.org/10.1145/276675.276685)' },
    },
    required: ['doi'],
  },
  examples: [
    { input: { doi: '10.1145/276675.276685' }, output: 'Crossref: "The Anatomy of a Large-Scale Search Engine" by Brin, Page (1998)...' },
  ],
};

export const OPENALEX_LOOKUP_TOOL: ToolSpec = {
  name: 'openalex_lookup',
  description: 'Look up a DOI in OpenAlex, an open bibliographic database. Returns title, authors, year, venue, open-access status, PDF URL, cited-by count, and reconstructed abstract.',
  parameters: {
    type: 'object',
    properties: {
      doi: { type: 'string', description: 'DOI string (e.g., 10.1145/276675.276685 or https://doi.org/10.1145/276675.276685)' },
    },
    required: ['doi'],
  },
  examples: [
    { input: { doi: '10.1145/276675.276685' }, output: 'OpenAlex: "The Anatomy of a Large-Scale Search Engine" by Brin, Page (1998)...' },
  ],
};

export const RECOMMEND_PAPERS_TOOL: ToolSpec = {
  name: 'recommend_papers',
  description: 'Get related papers from Semantic Scholar by paper ID, DOI, or arXiv ID. Returns papers that cite this paper (citations) or papers this paper references (references).',
  parameters: {
    type: 'object',
    properties: {
      paperId: { type: 'string', description: 'Semantic Scholar paper ID, DOI (prefix with DOI:), or arXiv ID (prefix with ARXIV:)' },
      type: { type: 'string', enum: ['citations', 'references'], description: 'Relationship type' },
      maxResults: { type: 'number', description: 'Maximum results to return (default 10, max 100)' },
      offset: { type: 'number', description: 'Offset for pagination (default 0)' },
    },
    required: ['paperId', 'type'],
  },
  examples: [
    { input: { paperId: 'DOI:10.1145/276675.276685', type: 'citations', maxResults: 5 }, output: 'Found 5 papers that cite this work...' },
  ],
};

export const LITERATURE_REVIEW_TOOL: ToolSpec = {
  name: 'literature_review',
  description: 'Generate a structured literature review from a query or a list of DOI/arXiv/Semantic-Scholar identifiers. Clusters papers by theme, detects potential conflicts, flags research gaps, reports publication trends, and optionally expands along the citation network (citations + references).',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Free-text search query (used if identifiers is empty)' },
      identifiers: { type: 'string', description: 'Comma-separated DOIs, arXiv IDs, or Semantic Scholar paper IDs to use as seeds (optional)' },
      maxResults: { type: 'number', description: 'Maximum papers to include (default 15, max 50)' },
      saveNote: { type: 'boolean', description: 'Whether to save the review as a note (default false)' },
      expandNetwork: { type: 'boolean', description: 'Whether to expand each seed along citations and references (default false)' },
    },
  },
  examples: [
    { input: { query: 'transformer efficiency in language models', maxResults: 10 }, output: 'Structured literature review with clusters, conflicts, gaps, and references.' },
  ],
};

export const DAILY_PAPERS_TOOL: ToolSpec = {
  name: 'daily_papers',
  description: 'Fetch and rank the latest submissions from arXiv, bioRxiv, and medRxiv for one or more categories and produce a daily briefing. Supports cross-source trend boosting, keyword boosting, and saving the result as a note. Use prefixes like arxiv:cs.AI, biorxiv:MBIOC, medrxiv:HSCI.',
  parameters: {
    type: 'object',
    properties: {
      categories: { type: 'string', description: 'Comma-separated categories with optional source prefix (default arxiv:cs.AI, arxiv:cs.CL, arxiv:cs.CV, arxiv:cs.LG)' },
      keywords: { type: 'string', description: 'Comma-separated keywords to boost in ranking (optional)' },
      maxResults: { type: 'number', description: 'Maximum papers to highlight (default 10, max 50)' },
      saveNote: { type: 'boolean', description: 'Whether to save the briefing as a note (default false)' },
    },
  },
  examples: [
    { input: { categories: 'arxiv:cs.AI,arxiv:cs.CL,biorxiv:MBIOC', keywords: 'transformer,efficiency', maxResults: 5 }, output: 'Daily briefing with ranked papers from arXiv and bioRxiv.' },
  ],
};

export const WEB_IMPORT_TOOL: ToolSpec = {
  name: 'web_import',
  description: 'Fetch a web page (publisher page, arXiv abstract, preprint server, etc.) and extract bibliographic metadata. If a DOI is found, it cross-checks Crossref for complete metadata. Returns a BibTeX entry and can optionally save the paper to the local library.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Web page URL to import (required)' },
      saveToLibrary: { type: 'boolean', description: 'Save the extracted paper to the local library (default false)' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags to apply when saveToLibrary is true' },
    },
    required: ['url'],
  },
  examples: [
    { input: { url: 'https://doi.org/10.1234/example' }, output: 'BibTeX entry for the paper.' },
    { input: { url: 'https://arxiv.org/abs/2301.00001', saveToLibrary: true, tags: ['nlp'] }, output: 'Imported arXiv paper into local library.' },
  ],
};

export const FULLTEXT_SEARCH_TOOL: ToolSpec = {
  name: 'fulltext_search',
  description: 'Full-text search across the local paper library. Searches titles, authors, abstracts, extracted PDF text, and paper notes. Supports inclusion terms and exclusion terms prefixed with "-" (e.g., "transformer -medical"). Returns ranked results with relevance scores and text snippets.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (required)' },
      limit: { type: 'number', description: 'Maximum number of results (default 20)' },
      includeSnippet: { type: 'boolean', description: 'Include matching text snippets (default true)' },
    },
    required: ['query'],
  },
  examples: [
    { input: { query: 'attention mechanism' }, output: 'Ranked list of matching papers.' },
    { input: { query: 'transformer -medical', limit: 10 }, output: 'Top 10 transformer papers excluding medical contexts.' },
  ],
};

// ─── Tool Handlers ────────────────────────────────────────────

export const arxivSearchHandler: ToolHandler = async (args) => {
  const query = String(args.query ?? '');
  const author = args.author ? String(args.author) : '';
  const category = args.category ? String(args.category) : '';
  const maxResults = Number(args.maxResults ?? 10);
  const sortBy = String(args.sortBy ?? 'relevance');

  // Build arXiv API URL
  let url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}`;
  if (author) url += `+AND+au:${encodeURIComponent(author)}`;
  if (category) url += `+AND+cat:${encodeURIComponent(category)}`;
  url += `&start=0&max_results=${maxResults}&sortBy=${sortBy}`;

  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/atom+xml' },
    });
    const xml = await response.text();

    // Simple XML parsing for arXiv Atom feed
    const entries = xml.split('<entry>').slice(1);
    if (entries.length === 0) return 'No papers found matching the query.';

    const papers = entries.map((entry) => {
      const extract = (tag: string) => {
        const match = entry.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
        return match?.[1]?.trim() ?? '';
      };

      const authors: string[] = [];
      const authorMatches = entry.match(/<author>[^]*?<name>([^<]*)<\/name>[^]*?<\/author>/g);
      if (authorMatches) {
        for (const am of authorMatches) {
          const nm = am.match(/<name>([^<]*)<\/name>/);
          if (nm?.[1]) authors.push(nm[1].trim());
        }
      }

      const published = extract('published');
      const year = published ? new Date(published).getFullYear() : 0;

      return {
        id: extract('id').split('/abs/').pop() ?? '',
        title: extract('title').replace(/\s+/g, ' '),
        authors,
        year: Number.isFinite(year) && year > 0 ? year : 0,
        venue: extract('category'),
        arxivId: extract('id').split('/abs/').pop() ?? '',
        url: `https://arxiv.org/abs/${extract('id').split('/abs/').pop() ?? ''}`,
        abstract: extract('summary').replace(/\s+/g, ' ').slice(0, 500),
      };
    });

    return JSON.stringify({ query, total: papers.length, papers }, null, 2);
  } catch (err) {
    return `arXiv search failed: ${err instanceof Error ? err.message : String(err)}. Try again later.`;
  }
};

export const parseBibtexHandler: ToolHandler = async (args) => {
  const bibtex = args.bibtex ? String(args.bibtex) : '';
  if (!bibtex) return 'No BibTeX content provided.';

  try {
    const entries = parseBibtexString(bibtex);
    return JSON.stringify({ entries }, null, 2);
  } catch (err) {
    return `BibTeX parsing failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const bibtexAuditHandler: ToolHandler = async (args) => {
  const bibtex = args.bibtex ? String(args.bibtex) : undefined;
  const filePath = args.filePath ? String(args.filePath) : undefined;
  const texDir = args.texDir ? String(args.texDir) : undefined;

  if (!bibtex && !filePath) {
    return 'Error: bibtex or filePath is required.';
  }

  try {
    const result = await auditBibTeX({ bibtex, filePath, texDir });
    const plain = auditResultToPlain(result);

    const lines = [
      `# BibTeX Audit Report`,
      `Entries: ${result.summary.entryCount}`,
      `Cited in LaTeX: ${result.summary.citedCount}`,
      `Verified: ${result.summary.verifiedCount}`,
      `Not found: ${result.summary.notFoundCount}`,
      `Orphan .bib entries: ${result.summary.orphanBibEntries}`,
      `Orphan citations: ${result.summary.orphanCitations}`,
      `Duplicate keys: ${result.summary.duplicateKeys}`,
      `Duplicate DOIs: ${result.summary.duplicateDois}`,
      `Missing identifiers: ${result.summary.missingIdentifierCount}`,
      '',
    ];

    if (result.recommendations.length > 0) {
      lines.push('## Recommendations');
      for (const rec of result.recommendations) {
        lines.push(`- ${rec}`);
      }
      lines.push('');
    }

    if (result.entries.length > 0) {
      lines.push('## Entry details');
      for (const entry of result.entries) {
        const icon = entry.status === 'verified' ? '[通过]' : entry.status === 'not_found' ? '[失败]' : '[警告]';
        lines.push(`- ${icon} **${entry.key}** (${entry.status}) — ${entry.title || '(no title)'} ${entry.year ? `(${entry.year})` : ''}`);
        if (entry.doi) lines.push(`  DOI: ${entry.doi}`);
        if (entry.arxivId) lines.push(`  arXiv: ${entry.arxivId}`);
        for (const issue of entry.issues) {
          lines.push(`  - ${issue}`);
        }
      }
      lines.push('');
    }

    lines.push('## Raw JSON', JSON.stringify(plain, null, 2));
    return lines.join('\n');
  } catch (err) {
    return `BibTeX audit failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const latexCleanupHandler: ToolHandler = async (args) => {
  const texDir = String(args.texDir ?? '');
  if (!texDir.trim()) return 'Error: texDir is required.';

  const bibPath = args.bibPath ? String(args.bibPath) : undefined;

  try {
    const result = await auditLaTeX({ texDir, bibPath });
    const plain = cleanupResultToPlain(result);

    const lines = [
      `# LaTeX Cleanup Report`,
      `Files scanned: ${result.filesScanned}`,
      `Total issues: ${result.issues.length}`,
      '',
    ];

    const issueTypes = Object.entries(result.issueCounts).filter(([, count]) => count > 0);
    if (issueTypes.length > 0) {
      lines.push('## Issue counts');
      for (const [type, count] of issueTypes) {
        lines.push(`- ${type}: ${count}`);
      }
      lines.push('');
    }

    if (result.recommendations.length > 0) {
      lines.push('## Recommendations');
      for (const rec of result.recommendations) {
        lines.push(`- ${rec}`);
      }
      lines.push('');
    }

    if (result.issues.length > 0) {
      lines.push('## Issues');
      for (const issue of result.issues) {
        lines.push(`- [${issue.type}] ${issue.file}:${issue.line} — ${issue.message}`);
      }
      lines.push('');
    }

    lines.push('## Raw JSON', JSON.stringify(plain, null, 2));
    return lines.join('\n');
  } catch (err) {
    return `LaTeX cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const figureAuditHandler: ToolHandler = async (args) => {
  const texDir = String(args.texDir ?? '');
  if (!texDir.trim()) return 'Error: texDir is required.';

  try {
    const result = await auditFigures(texDir);
    const plain = figureAuditResultToPlain(result);

    const lines = [
      `# Figure Audit Report`,
      `Figures found: ${result.figures.length}`,
      `Total issues: ${result.totalIssues}`,
      '',
    ];

    const issueTypes = Object.entries(result.issueCounts).filter(([, count]) => count > 0);
    if (issueTypes.length > 0) {
      lines.push('## Issue counts');
      for (const [type, count] of issueTypes) {
        lines.push(`- ${type}: ${count}`);
      }
      lines.push('');
    }

    if (result.recommendations.length > 0) {
      lines.push('## Recommendations');
      for (const rec of result.recommendations) {
        lines.push(`- ${rec}`);
      }
      lines.push('');
    }

    if (result.figures.length > 0) {
      lines.push('## Figure details');
      for (const fig of result.figures) {
        const statusIcon = fig.issues.length === 0 ? '[通过]' : '[警告]';
        lines.push(`- ${statusIcon} **${fig.includePath}** (${fig.format ?? 'unknown'}) in ${fig.sourceFile}:${fig.line}`);
        if (fig.width && fig.height) lines.push(`  Dimensions: ${fig.width}x${fig.height}`);
        if (fig.fileSize) lines.push(`  Size: ${(fig.fileSize / 1024).toFixed(1)} KB`);
        for (const issue of fig.issues) {
          lines.push(`  - [${issue.type}] ${issue.message}`);
        }
      }
      lines.push('');
    }

    lines.push('## Raw JSON', JSON.stringify(plain, null, 2));
    return lines.join('\n');
  } catch (err) {
    return `Figure audit failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const tableAuditHandler: ToolHandler = async (args) => {
  const texDir = String(args.texDir ?? '');
  if (!texDir.trim()) return 'Error: texDir is required.';

  try {
    const result = await auditTables(texDir);
    const plain = tableAuditResultToPlain(result);

    const lines = [
      `# Table Audit Report`,
      `Tables found: ${result.tables.length}`,
      `Total issues: ${result.totalIssues}`,
      '',
    ];

    const issueTypes = Object.entries(result.issueCounts).filter(([, count]) => count > 0);
    if (issueTypes.length > 0) {
      lines.push('## Issue counts');
      for (const [type, count] of issueTypes) {
        lines.push(`- ${type}: ${count}`);
      }
      lines.push('');
    }

    if (result.recommendations.length > 0) {
      lines.push('## Recommendations');
      for (const rec of result.recommendations) {
        lines.push(`- ${rec}`);
      }
      lines.push('');
    }

    if (result.tables.length > 0) {
      lines.push('## Table details');
      for (const table of result.tables) {
        const statusIcon = table.issues.length === 0 ? '[通过]' : '[警告]';
        lines.push(`- ${statusIcon} **${table.environment}** in ${table.sourceFile}:${table.line}`);
        if (table.columnSpec) lines.push(`  Columns: \`${table.columnSpec}\` (${table.columnCount ?? '?'} cols, ${table.rowCount ?? '?'} rows)`);
        if (table.caption) lines.push(`  Caption: ${table.caption}`);
        for (const issue of table.issues) {
          lines.push(`  - [${issue.type}] ${issue.message}`);
        }
      }
      lines.push('');
    }

    lines.push('## Raw JSON', JSON.stringify(plain, null, 2));
    return lines.join('\n');
  } catch (err) {
    return `Table audit failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const latexIntegrityReportHandler: ToolHandler = async (args) => {
  const texDir = String(args.texDir ?? '');
  const bibPath = args.bibPath ? String(args.bibPath) : undefined;
  if (!texDir.trim()) return 'Error: texDir is required.';

  try {
    const report = await runLaTeXIntegrityReport({ texDir, bibPath });
    const plain = integrityReportToPlain(report);

    const lines = [
      `# LaTeX Integrity Report`,
      `Project: ${report.texDir}`,
      `Total issues: ${report.severity.total}`,
      `Severity — critical: ${report.severity.critical}, high: ${report.severity.high}, medium: ${report.severity.medium}, low: ${report.severity.low}`,
      '',
    ];

    if (report.filesWithIssues.length > 0) {
      lines.push('## Files with issues');
      for (const file of report.filesWithIssues.slice(0, 20)) {
        lines.push(`- ${file.file}: ${file.count} issue(s) [${file.types.join(', ')}]`);
      }
      if (report.filesWithIssues.length > 20) {
        lines.push(`- ... and ${report.filesWithIssues.length - 20} more files`);
      }
      lines.push('');
    }

    lines.push('## Section summaries');
    lines.push(`- LaTeX cleanup: ${report.sections.latex.issues.length} issues across ${report.sections.latex.filesScanned} files`);
    lines.push(`- Figure audit: ${report.sections.figures.totalIssues} issues in ${report.sections.figures.figures.length} figures`);
    lines.push(`- Table audit: ${report.sections.tables.totalIssues} issues in ${report.sections.tables.tables.length} tables`);
    if (report.sections.bib) {
      lines.push(`- BibTeX audit: ${report.sections.bib.summary.entryCount} entries, ${report.sections.bib.summary.orphanCitations} orphan citations, ${report.sections.bib.summary.notFoundCount} not found`);
    }
    lines.push('');

    if (report.recommendations.length > 0) {
      lines.push('## Recommendations');
      for (const rec of report.recommendations) {
        lines.push(`- ${rec}`);
      }
      lines.push('');
    }

    lines.push('## Raw JSON', JSON.stringify(plain, null, 2));
    return lines.join('\n');
  } catch (err) {
    return `LaTeX integrity report failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const mathAuditHandler: ToolHandler = async (args) => {
  const texDir = String(args.texDir ?? '');
  if (!texDir.trim()) return 'Error: texDir is required.';

  try {
    const result = await auditMath(texDir);
    const plain = mathAuditResultToPlain(result);

    const lines = [
      '# Math Audit Report',
      `Math environments checked: ${result.environments.length}`,
      `Total issues: ${result.totalIssues}`,
      '',
    ];

    const issueTypes = Object.entries(result.issueCounts).filter(([, count]) => count > 0);
    if (issueTypes.length > 0) {
      lines.push('## Issue counts');
      for (const [type, count] of issueTypes) {
        lines.push(`- ${type}: ${count}`);
      }
      lines.push('');
    }

    if (result.recommendations.length > 0) {
      lines.push('## Recommendations');
      for (const rec of result.recommendations) {
        lines.push(`- ${rec}`);
      }
      lines.push('');
    }

    if (result.environments.length > 0) {
      lines.push('## Environment details');
      for (const env of result.environments) {
        const statusIcon = env.issues.length === 0 ? '[通过]' : '[警告]';
        lines.push(`- ${statusIcon} \\begin{${env.environment}} in ${env.sourceFile}:${env.line}`);
        for (const issue of env.issues) {
          lines.push(`  - [${issue.type}] ${issue.message}`);
        }
      }
      lines.push('');
    }

    if (result.inlineIssues.length > 0) {
      lines.push('## Inline issues');
      for (const issue of result.inlineIssues.slice(0, 20)) {
        lines.push(`- [${issue.type}] ${issue.message} at ${issue.file}:${issue.line}`);
      }
      if (result.inlineIssues.length > 20) {
        lines.push(`- ... and ${result.inlineIssues.length - 20} more`);
      }
      lines.push('');
    }

    lines.push('## Raw JSON', JSON.stringify(plain, null, 2));
    return lines.join('\n');
  } catch (err) {
    return `Math audit failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const sectionAuditHandler: ToolHandler = async (args) => {
  const texDir = String(args.texDir ?? '');
  if (!texDir.trim()) return 'Error: texDir is required.';

  try {
    const result = await auditSections(texDir);
    const plain = sectionAuditResultToPlain(result);

    const lines = [
      '# Section Structure Audit Report',
      `Sections found: ${result.sections.length}`,
      `Total issues: ${result.totalIssues}`,
      '',
    ];

    if (result.abstract) {
      lines.push(`Abstract: ${result.abstract.wordCount} words at ${result.abstract.sourceFile}:${result.abstract.line}`);
      lines.push('');
    }

    const issueTypes = Object.entries(result.issueCounts).filter(([, count]) => count > 0);
    if (issueTypes.length > 0) {
      lines.push('## Issue counts');
      for (const [type, count] of issueTypes) {
        lines.push(`- ${type}: ${count}`);
      }
      lines.push('');
    }

    if (result.recommendations.length > 0) {
      lines.push('## Recommendations');
      for (const rec of result.recommendations) {
        lines.push(`- ${rec}`);
      }
      lines.push('');
    }

    const topLevel = result.sections.filter((s) => s.level === 1);
    if (topLevel.length > 0) {
      lines.push('## Top-level sections');
      for (const sec of topLevel) {
        const icon = sec.hasContent ? '[通过]' : '[空]';
        lines.push(`- ${icon} ${sec.title} (${sec.sourceFile}:${sec.line})`);
      }
      lines.push('');
    }

    lines.push('## Raw JSON', JSON.stringify(plain, null, 2));
    return lines.join('\n');
  } catch (err) {
    return `Section audit failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const sectionGuideHandler: ToolHandler = async (args) => {
  const section = String(args.section ?? '');
  if (!section.trim()) return 'Error: section is required.';

  return getSectionGuide(section);
};

export const formatCitationHandler: ToolHandler = async (args) => {
  const title = String(args.title ?? '');
  const authors = String(args.authors ?? '').split(';').map((a) => a.trim()).filter(Boolean);
  const year = Number(args.year ?? 0);
  const journal = args.journal ? String(args.journal) : undefined;
  const volume = args.volume ? String(args.volume) : undefined;
  const pages = args.pages ? String(args.pages) : undefined;
  const doi = args.doi ? String(args.doi) : undefined;
  const style = String(args.style ?? 'apa');

  const validStyles = ['apa', 'mla', 'chicago', 'ieee', 'bibtex'] as const;
  if (!validStyles.includes(style as typeof validStyles[number])) {
    return JSON.stringify({ style, citation: `Unknown citation style: ${style}` });
  }

  const citation = ((): string => {
    switch (style) {
      case 'apa': return formatAPA(authors, year, title, journal, volume, pages, doi);
      case 'mla': return formatMLA(authors, year, title, journal, volume, pages);
      case 'chicago': return formatChicago(authors, year, title, journal, volume, pages);
      case 'ieee': return formatIEEE(authors, year, title, journal, volume, pages, doi);
      case 'bibtex': return formatBibtexNative(authors, year, title, journal, volume, pages, doi);
      default: return `Unknown citation style: ${style}`;
    }
  })();
  return JSON.stringify({ style, citation });
};
export const readPdfHandler: ToolHandler = async (args) => {
  const filePath = String(args.filePath ?? '');
  if (!filePath) throw new Error('No file path provided.');

  try {
    const { getPdfReader } = await import('../../research/PdfReader.js');
    const reader = getPdfReader();
    const result = await reader.readFile(filePath, {
      pages: args.pages ? String(args.pages) : undefined,
    });

    const pageTexts = result.pages.map((page) => page.text || '[No text content on this page]');

    return JSON.stringify({
      title: result.metadata.title || undefined,
      author: result.metadata.author || undefined,
      totalPages: result.totalPages,
      extractedPages: result.pages.length,
      keywords: result.metadata.keywords.length > 0 ? result.metadata.keywords : undefined,
      pageTexts,
    });
  } catch (err) {
    throw new Error(`PDF reading failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
};

// ─── BibTeX Parser ────────────────────────────────────────────

interface BibEntry {
  type: string;
  key: string;
  title: string;
  authors: string[];
  year: number;
  journal?: string;
  volume?: string;
  pages?: string;
  doi?: string;
  url?: string;
}

function parseBibtexString(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const regex = /@(\w+)\s*\{([^,]*),\s*([\s\S]*?)\n\}/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const type = match[1]?.toLowerCase() ?? '';
    const key = match[2]?.trim() ?? '';
    const fields = match[3] ?? '';

    const extract = (field: string): string => {
      const re = new RegExp(`${field}\\s*=\\s*[{"]([^}"]*)[}"]`, 'i');
      const m = fields.match(re);
      return m?.[1]?.trim() ?? '';
    };

    const authors = extract('author')
      .split(/\s+and\s+/)
      .map((a) => a.trim())
      .filter(Boolean);

    const entry: BibEntry = {
      type,
      key,
      title: extract('title'),
      authors,
      year: parseInt(extract('year'), 10) || 0,
      journal: extract('journal') || extract('booktitle') || undefined,
      volume: extract('volume') || undefined,
      pages: extract('pages') || undefined,
      doi: extract('doi') || undefined,
      url: extract('url') || undefined,
    };

    entries.push(entry);
  }

  return entries;
}

// ─── Citation Formatters ──────────────────────────────────────

function formatAPA(authors: string[], year: number, title: string, journal?: string, volume?: string, pages?: string, doi?: string): string {
  const authorStr = authors.length > 0 ? authors.join(', ') + ` (${year}).` : `(${year}).`;
  let citation = `${authorStr} ${title}.`;
  if (journal) citation += ` ${journal}`;
  if (volume) citation += `, ${volume}`;
  if (pages) citation += `, ${pages.replace(/--/g, '-')}`;
  if (doi) citation += `. https://doi.org/${doi}`;
  return citation;
}

function formatMLA(authors: string[], year: number, title: string, journal?: string, volume?: string, pages?: string): string {
  const authorStr = authors.length > 0 ? `${authors.join(', ')}. ` : '';
  let citation = `${authorStr}"${title}."`;
  if (journal) citation += ` ${journal}`;
  if (volume) citation += `, vol. ${volume}`;
  if (year) citation += `, ${year}`;
  if (pages) citation += `, pp. ${pages.replace(/--/g, '-')}`;
  return citation;
}

function formatChicago(authors: string[], year: number, title: string, journal?: string, volume?: string, pages?: string): string {
  const authorStr = authors.length > 0 ? `${authors.join(', ')}. ` : '';
  let citation = `${authorStr}"${title}."`;
  if (journal) citation += ` ${journal}`;
  if (volume) citation += ` ${volume}`;
  if (year) citation += ` (${year})`;
  if (pages) citation += `: ${pages.replace(/--/g, '-')}`;
  return citation;
}

function formatIEEE(authors: string[], year: number, title: string, journal?: string, volume?: string, pages?: string, doi?: string): string {
  const authorStr = authors.map((a) => {
    const parts = a.split(' ');
    if (parts.length >= 2) return `${parts[0]?.[0] ?? ''}. ${parts.slice(1).join(' ')}`;
    return a;
  }).join(', ');
  let citation = `${authorStr}, "${title},"`;
  if (journal) citation += ` ${journal}`;
  if (volume) citation += `, vol. ${volume}`;
  if (pages) citation += `, pp. ${pages.replace(/--/g, '-')}`;
  if (year) citation += `, ${year}`;
  if (doi) citation += `, doi: ${doi}`;
  return citation;
}

function formatBibtexNative(authors: string[], year: number, title: string, journal?: string, volume?: string, pages?: string, doi?: string): string {
  const key = authors.length > 0
    ? `${authors[0]?.split(' ').pop()?.toLowerCase() ?? 'author'}${year}`
    : `ref${year}`;
  let bib = `@article{${key},\n`;
  bib += `  title = {${title}},\n`;
  if (authors.length > 0) bib += `  author = {${authors.join(' and ')}},\n`;
  if (journal) bib += `  journal = {${journal}},\n`;
  if (year) bib += `  year = {${year}},\n`;
  if (volume) bib += `  volume = {${volume}},\n`;
  if (pages) bib += `  pages = {${pages}},\n`;
  if (doi) bib += `  doi = {${doi}},\n`;
  bib += '}';
  return bib;
}

// ─── Semantic Scholar search handler ──────────────────────────

/** T2：本地文献库全文检索 handler（确定性 SQL 检索，零模型调用）。 */
export const searchPaperTextHandler: ToolHandler = async (args, context) => {
  const query = String(args.query ?? '').trim();
  if (!query) return 'Error: query is required.';
  const limit = Math.min(Math.max(Number(args.limit ?? 8), 1), 20);
  if (!sharedStore) {
    return JSON.stringify({ query, available: false, results: [], note: '本地文献库不可用（持久化未初始化）。' });
  }
  // 任务2 上下文隔离：按运行 scope 排除归属其他项目的文献（含 PDF 全文），
  // 防止 A 项目会话检索读出 B 项目文献片段。
  const hits = sharedStore.searchLibrary(query, limit, { projectId: context?.projectId })
    .filter((hit) => hit.type === 'paper');
  return JSON.stringify({
    query,
    available: true,
    total: hits.length,
    note: hits.length === 0
      ? '本地文献库没有命中。可提示用户在资料模式检索导入，或 PDF 尚未抽取全文。'
      : '命中片段来自用户自己的文献库（含 PDF 全文），引用时使用返回的 title/year/doi。',
    results: hits.map((hit) => ({
      paperId: hit.id,
      title: hit.title,
      authors: hit.authors,
      year: hit.year,
      identifier: hit.sourceId,
      snippet: hit.snippet,
      score: hit.score,
    })),
  });
};

export const searchPapersHandler: ToolHandler = async (args) => {
  const query = String(args.query ?? '');
  if (!query.trim()) return 'Error: query is required.';

  const limit = Math.min(Math.max(Number(args.maxResults ?? 10), 1), 100);
  const offset = Math.max(Number(args.offset ?? 0), 0);

  try {
    const result = await searchPapers({ query, limit, offset });
    if (result.data.length === 0) return JSON.stringify({ query, total: 0, papers: [] });

    const papers = result.data.map((paper) => ({
      id: paper.paperId,
      title: paper.title,
      authors: (paper.authors ?? []).map((a) => a.name),
      year: paper.year ?? 0,
      venue: paper.venue ?? '',
      doi: paper.externalIds?.DOI,
      arxivId: paper.externalIds?.ArXiv,
      url: paper.url,
      pdfUrl: paper.openAccessPdf?.url,
      abstract: paper.abstract ?? '',
    }));

    return JSON.stringify({ query, total: result.total, papers }, null, 2);
  } catch (err) {
    return `Search failed: ${err instanceof Error ? err.message : String(err)}. Try again later.`;
  }
};

// ─── arXiv import handler ─────────────────────────────────────

export const ARXIV_IMPORT_TOOL: ToolSpec = {
  name: 'import_by_arxiv',
  description: 'Import paper metadata from an arXiv ID or arXiv URL.',
  parameters: {
    type: 'object',
    properties: {
      arxivId: { type: 'string', description: 'arXiv ID (e.g., 1706.03762) or URL' },
    },
    required: ['arxivId'],
  },
  examples: [
    { input: { arxivId: '1706.03762' }, output: 'Imported "Attention Is All You Need" by Vaswani et al. (2017)...' },
  ],
};

export const importByArxivHandler: ToolHandler = async (args) => {
  const arxivId = String(args.arxivId ?? '');
  if (!arxivId.trim()) return 'Error: arxivId is required.';

  try {
    const metadata = await resolveArxiv(arxivId);
    if (!metadata) return `Could not resolve arXiv ID: ${arxivId}. Please check the ID and try again.`;

    const paper = {
      id: metadata.arxivId,
      title: metadata.title,
      authors: metadata.authors,
      year: metadata.year,
      venue: metadata.venue,
      doi: metadata.doi,
      arxivId: metadata.arxivId,
      url: metadata.url,
      pdfUrl: metadata.pdfUrl,
      abstract: metadata.abstract,
    };

    return JSON.stringify({ query: arxivId, total: 1, papers: [paper] }, null, 2);
  } catch (err) {
    return `arXiv import failed: ${err instanceof Error ? err.message : String(err)}. Try again later.`;
  }
};

// ─── DOI import handler ───────────────────────────────────────

export const importByDoiHandler: ToolHandler = async (args) => {
  const doi = String(args.doi ?? '');
  if (!doi.trim()) return 'Error: doi is required.';

  try {
    const metadata = await resolveDoi(doi);
    if (!metadata) return `Could not resolve DOI: ${doi}. Please check the DOI and try again.`;

    const paper = {
      id: metadata.doi,
      title: metadata.title,
      authors: metadata.authors,
      year: metadata.year,
      venue: metadata.venue,
      doi: metadata.doi,
      arxivId: metadata.arxivId,
      url: metadata.url,
      pdfUrl: metadata.pdfUrl,
      abstract: metadata.abstract,
    };

    return JSON.stringify({ query: doi, total: 1, papers: [paper] }, null, 2);
  } catch (err) {
    return `DOI import failed: ${err instanceof Error ? err.message : String(err)}. Try again later.`;
  }
};

// ─── Crossref lookup handler ──────────────────────────────────

export const crossrefLookupHandler: ToolHandler = async (args) => {
  const doi = String(args.doi ?? '');
  if (!doi.trim()) return 'Error: doi is required.';

  try {
    const metadata = await getCrossrefWorkByDoi(doi);
    if (!metadata) return `Crossref could not resolve DOI: ${doi}. The DOI may be unregistered or malformed.`;

    const paper = {
      id: metadata.doi,
      title: metadata.title,
      authors: metadata.authors,
      year: metadata.year,
      venue: metadata.venue,
      doi: metadata.doi,
      url: metadata.url,
      abstract: metadata.abstract,
    };

    return JSON.stringify({ query: doi, total: 1, papers: [paper] }, null, 2);
  } catch (err) {
    return `Crossref lookup failed: ${err instanceof Error ? err.message : String(err)}. Try again later.`;
  }
};

// ─── OpenAlex lookup handler ──────────────────────────────────

export const openAlexLookupHandler: ToolHandler = async (args) => {
  const doi = String(args.doi ?? '');
  if (!doi.trim()) return 'Error: doi is required.';

  try {
    const metadata = await getOpenAlexWorkByDoi(doi);
    if (!metadata) return `OpenAlex could not resolve DOI: ${doi}. The DOI may not be indexed or may be malformed.`;

    const paper = {
      id: metadata.id,
      title: metadata.title,
      authors: metadata.authors,
      year: metadata.year,
      venue: metadata.venue,
      doi: metadata.doi,
      url: metadata.url,
      pdfUrl: metadata.pdfUrl,
      abstract: metadata.abstract,
    };

    return JSON.stringify({ query: doi, total: 1, papers: [paper] }, null, 2);
  } catch (err) {
    return `OpenAlex lookup failed: ${err instanceof Error ? err.message : String(err)}. Try again later.`;
  }
};

// ─── Paper recommendations handler ────────────────────────────

export const recommendPapersHandler: ToolHandler = async (args) => {
  const paperId = String(args.paperId ?? '');
  const type = String(args.type ?? 'citations') as 'citations' | 'references';
  if (!paperId.trim()) return 'Error: paperId is required.';
  if (type !== 'citations' && type !== 'references') return 'Error: type must be "citations" or "references".';

  const limit = Math.min(Math.max(Number(args.maxResults ?? 10), 1), 100);
  const offset = Math.max(Number(args.offset ?? 0), 0);

  try {
    const result = await getPaperRecommendations({ paperId, type, limit, offset });
    if (result.data.length === 0) return JSON.stringify({ query: paperId, total: 0, papers: [] });

    const papers = result.data.map(recommendationToPlain).filter((p): p is Record<string, unknown> => p !== null).map((paper) => ({
      id: String(paper.paperId ?? `${paperId}-${type}-${paper.title}`),
      title: String(paper.title ?? 'Untitled'),
      authors: Array.isArray(paper.authors) ? paper.authors.map(String) : [],
      year: typeof paper.year === 'number' ? paper.year : 0,
      venue: typeof paper.venue === 'string' ? paper.venue : '',
      doi: typeof paper.doi === 'string' ? paper.doi : undefined,
      arxivId: typeof paper.arxivId === 'string' ? paper.arxivId : undefined,
      url: typeof paper.url === 'string' ? paper.url : undefined,
      pdfUrl: typeof paper.openAccessPdf === 'string' ? paper.openAccessPdf : undefined,
      abstract: '',
    }));

    return JSON.stringify({ query: paperId, total: papers.length, papers }, null, 2);
  } catch (err) {
    return `Recommendations failed: ${err instanceof Error ? err.message : String(err)}. Try again later.`;
  }
};

export const literatureReviewHandler: ToolHandler = async (args) => {
  const query = args.query ? String(args.query) : undefined;
  const identifiers = args.identifiers
    ? String(args.identifiers)
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  if (!query?.trim() && (!identifiers || identifiers.length === 0)) {
    return 'Error: query or identifiers is required.';
  }

  const maxResults = Math.min(Math.max(Number(args.maxResults ?? 15), 1), 50);
  const saveNote = args.saveNote === true;
  const expandNetwork = args.expandNetwork === true;

  try {
    const result = await generateLiteratureReview({ query, identifiers, maxResults, saveNote, expandNetwork });
    if (result.papers.length === 0) {
      return 'No papers found for the given query or identifiers.';
    }

    const header = [
      `# Literature Review: ${result.query || 'Untitled'}`,
      `Papers: ${result.papers.length} | Themes: ${result.clusters.length} | Conflicts: ${result.conflicts.length} | Gaps: ${result.gaps.length} | Network: ${result.networkStats.seeds} seeds + ${result.networkStats.expanded} expanded${result.noteId ? ` | Note: ${result.noteId}` : ''}`,
      '',
    ].join('\n');

    return `${header}${result.markdown}\n\n## Raw JSON\n${JSON.stringify(literatureReviewToPlain(result), null, 2)}`;
  } catch (err) {
    return `Literature review failed: ${err instanceof Error ? err.message : String(err)}. Try again later.`;
  }
};

export const dailyPapersHandler: ToolHandler = async (args) => {
  const categories = args.categories
    ? String(args.categories)
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const keywords = args.keywords
    ? String(args.keywords)
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const maxResults = Math.min(Math.max(Number(args.maxResults ?? 10), 1), 50);
  const saveNote = args.saveNote === true;

  try {
    const result = await generateDailyPapersBriefing({ categories, keywords, maxResults, saveNote });
    const header = [
      `# Daily Papers — ${result.date}`,
      `Categories: ${result.categories.join(', ')} | Fetched: ${result.totalFetched} | Highlighted: ${result.papers.length}${result.noteId ? ` | Note: ${result.noteId}` : ''}`,
      '',
    ].join('\n');

    return `${header}${result.markdown}\n\n## Raw JSON\n${JSON.stringify(dailyPapersToPlain(result), null, 2)}`;
  } catch (err) {
    return `Daily papers failed: ${err instanceof Error ? err.message : String(err)}. Try again later.`;
  }
};

export const webImportHandler: ToolHandler = async (args) => {
  const url = String(args.url ?? '').trim();
  if (!url) return 'Error: url is required.';

  try {
    const { importFromUrl } = await import('../../research/WebImport.js');
    const result = await importFromUrl(url);

    const paper = {
      id: url,
      title: result.title,
      authors: result.authors,
      year: result.year,
      venue: result.venue,
      doi: result.doi,
      arxivId: result.arxivId,
      url: result.url,
      abstract: result.abstract,
    };

    if (args.saveToLibrary === true) {
      if (!sharedStore) {
        return `Error: saveToLibrary is true but local library store is not initialized.`;
      }

      const paperId = `paper-${crypto.randomUUID()}`;
      sharedStore.savePaper({
        id: paperId,
        title: result.title,
        authors: result.authors,
        year: result.year,
        venue: result.venue,
        abstract: result.abstract,
        doi: result.doi,
        arxivId: result.arxivId,
        pdfUrl: result.url,
        tags: Array.isArray(args.tags) ? args.tags.map((t) => String(t)) : [],
        notes: '',
        readStatus: 'unread',
        rating: 0,
        addedAt: Date.now(),
      });
    }

    return JSON.stringify({ query: url, total: 1, papers: [paper] }, null, 2);
  } catch (err) {
    return `Web import failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const fulltextSearchHandler: ToolHandler = async (args) => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  const query = String(args.query ?? '').trim();
  if (!query) return 'Error: query is required.';

  try {
    const limit = typeof args.limit === 'number' ? args.limit : undefined;
    const includeSnippet = typeof args.includeSnippet === 'boolean' ? args.includeSnippet : undefined;
    const results = sharedStore.fullTextSearch(query, { limit, includeSnippet });

    if (results.length === 0) {
      return `No local papers matched the query "${query}".`;
    }

    const payload = {
      query,
      total: results.length,
      matches: results.map((r) => ({
        id: String(r.paper.id),
        title: r.paper.title,
        score: r.score,
        matchedFields: r.matchedFields,
        snippet: r.snippet,
      })),
    };

    return JSON.stringify(payload);
  } catch (err) {
    return `Full-text search failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Writing stage check handler ──────────────────────────────

export const writingStageCheckHandler: ToolHandler = async (args) => {
  const stage = String(args.stage ?? '');
  const text = String(args.text ?? '');

  const validStages = ['outline', 'introduction', 'related_work', 'methods', 'results', 'discussion', 'conclusion', 'polish'];
  if (!validStages.includes(stage)) {
    return `Error: stage must be one of ${validStages.join(', ')}.`;
  }
  if (!text.trim()) return 'Error: text is required.';

  try {
    const result = checkStage(stage as Parameters<typeof checkStage>[0], text);
    const plain = stageResultToPlain(result);

    const lines = [
      `# Writing Stage Check: ${result.stage}`,
      `Score: ${plain.score} / 1.00`,
      `Advice: ${result.advice}`,
      '',
      '## Checklist',
      ...result.items.map((i) => `- [${i.present ? 'x' : ' '}] ${i.criterion}${i.evidence ? ` — ${i.evidence}` : ''}`),
    ];

    if (result.nextStage) {
      lines.push('', `Next stage: **${result.nextStage}**`);
    }

    lines.push('', '## Raw JSON', JSON.stringify(plain, null, 2));
    return lines.join('\n');
  } catch (err) {
    return `Writing stage check failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const styleCalibrationHandler: ToolHandler = async (args) => {
  const text = String(args.text ?? '');
  if (!text.trim()) return 'Error: text is required.';

  try {
    const result = calibrateStyle(text);
    const plain = styleResultToPlain(result);

    const lines = [
      '# Style Calibration',
      `Readability score: ${plain.readabilityScore} / 1.00`,
      `Machine-taste issues found: ${result.issues.length}`,
    ];

    if (result.issues.length > 0) {
      lines.push('', '## Issues');
      for (const issue of result.issues) {
        lines.push(`- **${issue.type}**: "${issue.snippet}" — ${issue.suggestion}`);
      }
    }

    if (result.recommendations.length > 0) {
      lines.push('', '## Recommendations');
      for (const rec of result.recommendations) {
        lines.push(`- ${rec}`);
      }
    }

    lines.push('', '## Raw JSON', JSON.stringify(plain, null, 2));
    return lines.join('\n');
  } catch (err) {
    return `Style calibration failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Library search handler ───────────────────────────────────

export const searchLibraryHandler: ToolHandler = async (args, context) => {
  const query = String(args.query ?? '');
  if (!query.trim()) return 'Error: query is required.';

  const limit = Math.min(Math.max(Number(args.limit ?? 5), 1), 20);

  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  try {
    // 任务2 上下文隔离：按运行 scope 排除归属其他项目的文献/笔记。
    const results = sharedStore.searchLibrary(query, limit, { projectId: context?.projectId });
    const items = results.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      year: item.year,
      authors: item.authors,
      sourceId: item.sourceId,
      snippet: item.snippet,
    }));

    return JSON.stringify({ query, total: results.length, items }, null, 2);
  } catch (err) {
    return `Library search failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const findLibraryDuplicatesHandler: ToolHandler = async () => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  try {
    const groups = sharedStore.findDuplicatePapers().map((group) => ({
      type: group.type,
      key: group.key,
      papers: group.papers.map((paper) => ({
        id: paper.id,
        title: paper.title,
        authors: paper.authors,
        year: paper.year,
      })),
    }));

    return JSON.stringify({ totalGroups: groups.length, groups }, null, 2);
  } catch (err) {
    return `Find library duplicates failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const deleteLibraryDuplicatesHandler: ToolHandler = async (args) => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  const keepId = String(args.keepId ?? '');
  const dryRun = Boolean(args.dryRun ?? false);

  try {
    const duplicateGroups = sharedStore.findDuplicatePapers();

    if (duplicateGroups.length === 0) {
      return 'No duplicate papers found in the local library.';
    }

    let deletions: ReturnType<PersistenceStore['deleteDuplicatePapers']>;
    if (dryRun) {
      deletions = duplicateGroups.map((group) => {
        const kept = group.papers[0]!;
        return {
          type: group.type,
          key: group.key,
          keptId: keepId && group.papers.some((p) => p.id === keepId) ? keepId : kept.id,
          deletedIds: group.papers.filter((p) => p.id !== (keepId && group.papers.some((q) => q.id === keepId) ? keepId : kept.id)).map((p) => p.id),
        };
      });
    } else {
      deletions = sharedStore.deleteDuplicatePapers(keepId || undefined);
    }

    const totalDeleted = deletions.reduce((sum: number, d: { deletedIds: string[] }) => sum + d.deletedIds.length, 0);

    if (totalDeleted === 0) {
      return 'No duplicate papers were removed (each group already has a single entry).';
    }

    const lines = [
      dryRun ? '# Local Library Duplicate Cleanup (dry run)' : '# Local Library Duplicate Cleanup',
      `Duplicate groups processed: ${deletions.length}`,
      `Papers ${dryRun ? 'that would be deleted' : 'deleted'}: ${totalDeleted}`,
      '',
    ];

    for (const deletion of deletions) {
      lines.push(`[${deletion.type.toUpperCase()}] "${deletion.key}"`);
      lines.push(`  Kept: ${deletion.keptId}`);
      for (const id of deletion.deletedIds) {
        lines.push(`  Deleted: ${id}`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    return `Delete library duplicates failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const libraryStatsHandler: ToolHandler = async () => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  try {
    const stats = sharedStore.getLibraryStats();

    const formatDistribution = (dist: Record<string | number, number>, empty = 'None') => {
      const entries = Object.entries(dist).sort((a, b) => Number(b[1]) - Number(a[1]));
      if (entries.length === 0) return empty;
      return entries.map(([key, count]) => `  ${key}: ${count}`).join('\n');
    };

    const lines = [
      '# Local Library Statistics',
      `Total papers: ${stats.totalPapers}`,
      '',
      '## Read status',
      formatDistribution(stats.readStatusCounts, '  No data'),
      '',
      '## Year distribution',
      formatDistribution(stats.yearDistribution, '  No data'),
      '',
      '## Top tags',
      formatDistribution(stats.tagDistribution, '  No tags'),
      '',
      '## Top venues',
      stats.venueTopN.length === 0
        ? '  No data'
        : stats.venueTopN.map((v) => `  ${v.venue}: ${v.count}`).join('\n'),
      '',
      '## Metadata completeness',
      `  With DOI: ${stats.metadataCompleteness.withDoi}`,
      `  With arXiv ID: ${stats.metadataCompleteness.withArxivId}`,
      `  With PDF text: ${stats.metadataCompleteness.withPdfText}`,
      `  With abstract: ${stats.metadataCompleteness.withAbstract}`,
      `  With venue: ${stats.metadataCompleteness.withVenue}`,
      '',
      `## Duplicate groups: ${stats.duplicateGroupCount}`,
      '',
      '## Raw JSON',
      JSON.stringify(stats, null, 2),
    ];

    return lines.join('\n');
  } catch (err) {
    return `Library stats failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const exportLibraryHandler: ToolHandler = async (args) => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  const format = String(args.format ?? '');
  if (format !== 'bibtex' && format !== 'json') {
    return 'Error: format must be "bibtex" or "json".';
  }

  const paperIds = Array.isArray(args.paperIds) ? args.paperIds.map((id) => String(id)) : undefined;
  const filePath = args.filePath ? String(args.filePath) : undefined;

  try {
    const result = sharedStore.exportPapers(format, paperIds);

    if (filePath) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(filePath, result.content, 'utf-8');
      return `Exported ${result.count} papers to ${filePath} (${format}).`;
    }

    return `# Local Library Export (${format})\nPapers: ${result.count}\n\n${result.content}`;
  } catch (err) {
    return `Export library failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const importPapersHandler: ToolHandler = async (args) => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  const source = String(args.source ?? '');
  if (source !== 'bibtex' && source !== 'json') {
    return 'Error: source must be "bibtex" or "json".';
  }

  const sharedTags = Array.isArray(args.tags) ? args.tags.map((t) => String(t)) : [];

  try {
    let content = '';
    if (args.bibtex) {
      content = String(args.bibtex);
    } else if (args.filePath) {
      const { readFileSync } = await import('node:fs');
      content = readFileSync(String(args.filePath), 'utf-8');
    } else {
      return 'Error: bibtex or filePath is required.';
    }

    let papers: Parameters<PersistenceStore['importPapers']>[0] = [];

    if (source === 'bibtex') {
      const entries = parseBibtexString(content);
      papers = entries.map((entry) => ({
        title: entry.title,
        authors: entry.authors,
        year: entry.year,
        venue: entry.journal,
        doi: entry.doi,
        pdfUrl: entry.url,
        tags: sharedTags,
      }));
    } else {
      const parsed = JSON.parse(content);
      const rawPapers = Array.isArray(parsed) ? parsed : parsed.papers ?? [];
      papers = rawPapers.map((paper: Record<string, unknown>) => ({
        title: String(paper.title ?? ''),
        authors: Array.isArray(paper.authors) ? paper.authors.map((a) => String(a)) : [],
        year: Number(paper.year ?? 0),
        venue: paper.venue ? String(paper.venue) : undefined,
        abstract: paper.abstract ? String(paper.abstract) : undefined,
        doi: paper.doi ? String(paper.doi) : undefined,
        arxivId: paper.arxivId ? String(paper.arxivId) : undefined,
        pdfUrl: paper.pdfUrl ? String(paper.pdfUrl) : undefined,
        tags: [...sharedTags, ...(Array.isArray(paper.tags) ? paper.tags.map((t) => String(t)) : [])],
      })).filter((p: { title: string }) => p.title.trim() !== '');
    }

    if (papers.length === 0) {
      return 'No papers found to import.';
    }

    const result = sharedStore.importPapers(papers);

    return JSON.stringify({
      source,
      total: result.total,
      imported: result.imported,
      skipped: result.skipped,
      items: result.items,
    }, null, 2);
  } catch (err) {
    return `Import papers failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const experimentStatsHandler: ToolHandler = async () => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  try {
    const stats = sharedStore.getExperimentStats();

    const formatDistribution = (dist: Record<string, number>, empty = 'None') => {
      const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
      if (entries.length === 0) return empty;
      return entries.map(([key, count]) => `  ${key}: ${count}`).join('\n');
    };

    const lines = [
      '# Experiment Statistics',
      `Total experiments: ${stats.totalExperiments}`,
      '',
      '## Status distribution',
      formatDistribution(stats.statusCounts, '  No data'),
      '',
      '## Script coverage',
      `  With script: ${stats.withScript}`,
      `  Without script: ${stats.withoutScript}`,
      '',
      '## Tag distribution',
      formatDistribution(stats.tagDistribution, '  No tags'),
      '',
      '## Recorded metric keys',
      stats.metricKeys.length === 0 ? '  None' : stats.metricKeys.map((k) => `  - ${k}`).join('\n'),
      '',
      '## Recently updated',
      stats.recentlyUpdated.length === 0
        ? '  None'
        : stats.recentlyUpdated.map((e) => `  - ${e.id}: "${e.name}" (${e.status})`).join('\n'),
      '',
      '## Raw JSON',
      JSON.stringify(stats, null, 2),
    ];

    return lines.join('\n');
  } catch (err) {
    return `Experiment stats failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const experimentCompareHandler: ToolHandler = async (args) => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  const ids = Array.isArray(args.experimentIds) ? args.experimentIds.map((id) => String(id)) : [];
  if (ids.length < 2) {
    return 'Error: at least two experimentIds are required for comparison.';
  }

  try {
    const result = sharedStore.compareExperiments(ids);

    if (result.experiments.length === 0) {
      return 'No experiments found with the provided IDs.';
    }

    const lines = [
      '# Experiment Comparison',
      `Selected: ${result.experiments.length} of ${ids.length} requested`,
      '',
      '## Experiments',
      ...result.experiments.map((e) => `  - ${e.id}: "${e.name}" (${e.status})`),
      '',
      '## Varying parameters',
      result.varyingParameters.length === 0
        ? '  None'
        : result.varyingParameters.map((k) => `  - ${k}`).join('\n'),
      '',
      '## Varying metrics',
      result.varyingMetrics.length === 0
        ? '  None'
        : result.varyingMetrics.map((k) => `  - ${k}`).join('\n'),
      '',
      '## Parameter table',
      result.parameterKeys.length === 0
        ? '  No parameters recorded'
        : result.parameterKeys.map((key) => {
            const values = result.experiments.map((e) => e.parameters[key] ?? '-').join(' | ');
            return `  ${key}: ${values}`;
          }).join('\n'),
      '',
      '## Metric table',
      result.metricKeys.length === 0
        ? '  No metrics recorded'
        : result.metricKeys.map((key) => {
            const values = result.experiments.map((e) => e.metrics[key] ?? '-').join(' | ');
            return `  ${key}: ${values}`;
          }).join('\n'),
      '',
      '## Raw JSON',
      JSON.stringify(result, null, 2),
    ];

    return lines.join('\n');
  } catch (err) {
    return `Experiment compare failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const experimentExportHandler: ToolHandler = async (args) => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  const ids = Array.isArray(args.experimentIds) ? args.experimentIds.map((id) => String(id)) : undefined;
  const filePath = args.filePath ? String(args.filePath) : undefined;

  try {
    const result = sharedStore.exportExperiments(ids);

    if (filePath) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(filePath, result.content, 'utf-8');
      return `Exported ${result.count} experiments to ${filePath}.`;
    }

    return `# Experiment Export\nExperiments: ${result.count}\n\n${result.content}`;
  } catch (err) {
    return `Experiment export failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const collectionStatsHandler: ToolHandler = async () => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  try {
    const stats = sharedStore.getCollectionStats();

    const lines = [
      '# Collection Statistics',
      `Total collections: ${stats.totalCollections}`,
      `Papers in collections: ${stats.totalPapersInCollections}`,
      `Empty collections: ${stats.emptyCollections}`,
      '',
      '## Collections',
    ];

    if (stats.collections.length === 0) {
      lines.push('  No collections found.');
    } else {
      for (const collection of stats.collections) {
        lines.push(`  - ${collection.name} (${collection.paperCount} papers)`);
      }
    }

    lines.push('', '## Raw JSON', JSON.stringify(stats, null, 2));
    return lines.join('\n');
  } catch (err) {
    return `Collection stats failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const noteStatsHandler: ToolHandler = async () => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  try {
    const stats = sharedStore.getNoteStats();

    const formatDistribution = (dist: Record<string, number>, empty = 'None') => {
      const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
      if (entries.length === 0) return empty;
      return entries.map(([key, count]) => `  ${key}: ${count}`).join('\n');
    };

    const lines = [
      '# Note Statistics',
      `Total notes: ${stats.totalNotes}`,
      `Linked papers: ${stats.totalLinkedPapers}`,
      `Linked notes: ${stats.totalLinkedNotes}`,
      `Orphan notes: ${stats.orphanNotes}`,
      '',
      '## Tag distribution',
      formatDistribution(stats.tagDistribution, '  No tags'),
      '',
      '## Recently updated',
      stats.recentlyUpdated.length === 0
        ? '  None'
        : stats.recentlyUpdated.map((n) => `  - ${n.id}: "${n.title}"`).join('\n'),
      '',
      '## Raw JSON',
      JSON.stringify(stats, null, 2),
    ];

    return lines.join('\n');
  } catch (err) {
    return `Note stats failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const tagsAuditHandler: ToolHandler = async () => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  try {
    const audit = sharedStore.auditTags();

    const formatDistribution = (dist: Record<string, number>, empty = 'None') => {
      const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
      if (entries.length === 0) return empty;
      return entries.map(([key, count]) => `  ${key}: ${count}`).join('\n');
    };

    const lines = [
      '# Tags Audit',
      `Unique tags: ${audit.totalUniqueTags}`,
      `Empty tag occurrences: ${audit.emptyTags}`,
      '',
      '## Tag counts',
      formatDistribution(audit.tagCounts, '  No tags'),
      '',
      '## Case conflicts',
      audit.caseConflicts.length === 0
        ? '  None'
        : audit.caseConflicts.map((c) => `  - ${c.canonical}: ${c.variants.join(', ')}`).join('\n'),
      '',
      '## Similar tags',
      audit.similarTags.length === 0
        ? '  None'
        : audit.similarTags.map((s) => `  - "${s.tagA}" vs "${s.tagB}" (${s.reason})`).join('\n'),
      '',
      '## Tags by type',
      '  Papers:',
      formatDistribution(audit.tagsByType.papers, '    No tags'),
      '  Notes:',
      formatDistribution(audit.tagsByType.notes, '    No tags'),
      '  Experiments:',
      formatDistribution(audit.tagsByType.experiments, '    No tags'),
      '',
      '## Raw JSON',
      JSON.stringify(audit, null, 2),
    ];

    return lines.join('\n');
  } catch (err) {
    return `Tags audit failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const tagsMergeHandler: ToolHandler = async (args) => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  try {
    const mapping: Record<string, string> = {};
    const rawMappings = args.mappings;
    if (Array.isArray(rawMappings)) {
      for (const entry of rawMappings) {
        if (entry && typeof entry === 'object' && 'sourceTag' in entry && 'targetTag' in entry) {
          const source = String(entry.sourceTag).trim();
          const target = String(entry.targetTag).trim();
          if (source && source !== target) {
            mapping[source] = target;
          }
        }
      }
    } else {
      const sourceTag = String(args.sourceTag ?? '').trim();
      const targetTag = String(args.targetTag ?? '').trim();
      if (!sourceTag) return 'Error: sourceTag is required when mappings is not provided.';
      if (!targetTag) return 'Error: targetTag is required when mappings is not provided.';
      if (sourceTag === targetTag) return 'Error: sourceTag and targetTag must be different.';
      mapping[sourceTag] = targetTag;
    }

    if (Object.keys(mapping).length === 0) {
      return 'Error: no valid tag mappings provided.';
    }

    const dryRun = Boolean(args.dryRun);
    const result = sharedStore.mergeTags(mapping, dryRun);

    const lines = [
      '# Tags Merge Report',
      `Mode: ${dryRun ? 'dry run (no changes written)' : 'applied'}`,
      `Entities updated: ${result.merged}`,
      `  Papers: ${result.papersUpdated}`,
      `  Notes: ${result.notesUpdated}`,
      `  Experiments: ${result.experimentsUpdated}`,
      '',
      '## Mappings',
      ...Object.entries(mapping).map(([source, target]) => `  "${source}" -> "${target}"`),
      '',
      '## Details',
      result.details.length === 0
        ? '  No changes.'
        : result.details.map((d) => `  [${d.entityType}] ${d.entityId}: [${d.oldTags.join(', ')}] -> [${d.newTags.join(', ')}]`).join('\n'),
      '',
      '## Raw JSON',
      JSON.stringify(result, null, 2),
    ];

    return lines.join('\n');
  } catch (err) {
    return `Tags merge failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const citationNetworkHandler: ToolHandler = async (args) => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  try {
    const options: Parameters<PersistenceStore['getLocalPaperNetwork']>[0] = {};
    if (typeof args.minWeight === 'number') options.minWeight = args.minWeight;
    if (typeof args.includeSharedTags === 'boolean') options.includeSharedTags = args.includeSharedTags;
    if (typeof args.includeSharedAuthors === 'boolean') options.includeSharedAuthors = args.includeSharedAuthors;
    if (typeof args.includeCollectionCooccurrence === 'boolean') {
      options.includeCollectionCooccurrence = args.includeCollectionCooccurrence;
    }

    const network = sharedStore.getLocalPaperNetwork(options);

    const lines = [
      '# Local Paper Network Analysis',
      `Nodes (papers): ${network.nodeCount}`,
      `Edges (associations): ${network.edgeCount}`,
      `Isolated papers: ${network.isolatedNodes.length}`,
      `Connected components: ${network.components.length}`,
      '',
      '## Connected components',
      network.components.length === 0
        ? '  No components.'
        : network.components.map((c, i) => `  ${i + 1}. size ${c.size}: ${c.nodes.slice(0, 5).join(', ')}${c.nodes.length > 5 ? '...' : ''}`).join('\n'),
      '',
      '## Top connected papers',
      network.topNodes.length === 0
        ? '  No papers.'
        : network.topNodes.map((n, i) => `  ${i + 1}. ${n.title} (degree ${n.degree}, weighted ${n.weightedDegree})`).join('\n'),
      '',
      '## Strongest edges',
      network.edges.slice(0, 10).length === 0
        ? '  No edges.'
        : network.edges.slice(0, 10).map((e) => `  ${e.source} <-> ${e.target}: weight ${e.weight} (${e.reasons.join('; ')})`).join('\n'),
      '',
      '## Raw JSON',
      JSON.stringify(network, null, 2),
    ];

    return lines.join('\n');
  } catch (err) {
    return `Network analysis failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Literature triage handler ───────────────────────────────

export const literatureTriageHandler: ToolHandler = async (args) => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  try {
    const options: Parameters<PersistenceStore['triageLiterature']>[0] = {};
    if (Array.isArray(args.paperIds)) options.paperIds = args.paperIds.map(String);
    if (typeof args.query === 'string' && args.query.trim()) options.query = String(args.query);
    if (typeof args.limit === 'number') options.limit = Math.max(1, Math.min(50, Math.floor(args.limit)));

    const result = sharedStore.triageLiterature(options);

    if (result.matrix.length === 0) {
      return options.query
        ? `No papers matched the query "${options.query}" in the local library.`
        : 'No papers in the local library to triage.';
    }

    const header = `| # | Citation | Question | Method | Data | Claim | Evidence | Limitation | Relevance | Where to use |`;
    const sep = `|---|----------|----------|--------|------|-------|----------|------------|------------|--------------|`;
    const rows = result.matrix.map((row, i) => {
      const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ').slice(0, 120);
      return `| ${i + 1} | ${cell(row.citation)} | ${cell(row.question)} | ${cell(row.method)} | ${cell(row.data)} | ${cell(row.claim)} | ${row.evidenceType} | ${cell(row.limitation)} | ${row.relevance.toFixed(2)} | ${cell(row.whereToUse)} |`;
    });

    const lines = [
      '# Literature Triage Matrix',
      `Papers analyzed: ${result.papersAnalyzed}${result.queryUsed ? ` (query: "${result.queryUsed}")` : ''}`,
      '',
      header,
      sep,
      ...rows,
      '',
      '## How to use this matrix',
      '- `limitation` and `where_to_use` are intentionally left as "requires analysis": fill them in after reading the paper or via follow-up reasoning.',
      '- `evidence_type` is a heuristic guess from the abstract; verify against the full paper.',
      '- `relevance` combines rating and query-term overlap; rerun with a `query` to refocus.',
      '',
      '## Raw JSON',
      JSON.stringify(result.matrix, null, 2),
    ];

    return lines.join('\n');
  } catch (err) {
    return `Literature triage failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Review persistence handlers ─────────────────────────────

export const reviewSaveHandler: ToolHandler = async (args) => {
  const scope = String(args.scope ?? '').trim();
  if (!scope) return 'Error: scope is required (e.g. paper title or section name).';

  try {
    const record = await saveReview({
      scope,
      reviewerId: typeof args.reviewerId === 'string' && args.reviewerId.trim() ? String(args.reviewerId) : undefined,
      overallScore: typeof args.overallScore === 'number' ? Number(args.overallScore) : undefined,
      confidence: typeof args.confidence === 'number' ? Number(args.confidence) : undefined,
      summary: typeof args.summary === 'string' ? String(args.summary) : undefined,
      strengths: Array.isArray(args.strengths) ? args.strengths.map(String) : undefined,
      weaknesses: Array.isArray(args.weaknesses) ? args.weaknesses.map(String) : undefined,
      questions: Array.isArray(args.questions) ? args.questions.map(String) : undefined,
      recommendations: Array.isArray(args.recommendations) ? args.recommendations.map(String) : undefined,
      extras: args.extras && typeof args.extras === 'object' ? (args.extras as Record<string, unknown>) : undefined,
    });

    const lines = [
      '# Review Saved',
      `- ID: ${record.id}`,
      `- Scope: ${record.scope}`,
      `- Date: ${new Date(record.createdAt).toISOString()}`,
      record.reviewerId ? `- Reviewer: ${record.reviewerId}` : '',
      typeof record.overallScore === 'number' ? `- Overall score: ${record.overallScore} / 10` : '',
      '',
      'The review has been persisted to `.metis-data/reviews/` and can be recalled in later sessions with `review_list`.',
      '',
      '## Raw JSON',
      JSON.stringify(record, null, 2),
    ].filter((l) => l !== '');
    return lines.join('\n');
  } catch (err) {
    return `Review save failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const reviewListHandler: ToolHandler = async (args) => {
  try {
    const reviews = await listReviews({
      scopeContains: typeof args.scopeContains === 'string' && args.scopeContains.trim() ? String(args.scopeContains) : undefined,
      reviewerId: typeof args.reviewerId === 'string' && args.reviewerId.trim() ? String(args.reviewerId) : undefined,
      limit: typeof args.limit === 'number' ? Math.max(1, Math.min(500, Math.floor(args.limit))) : undefined,
    });

    if (reviews.length === 0) {
      return 'No saved reviews found. Run a review with paper-review and persist it via review_save.';
    }

    const lines = [
      '# Saved Reviews',
      `Total: ${reviews.length}`,
      '',
      '| # | Date | Scope | Reviewer | Score | ID |',
      '|---|------|-------|----------|-------|----|',
      ...reviews.map((r, i) => {
        const date = new Date(r.createdAt).toISOString().slice(0, 10);
        const score = typeof r.overallScore === 'number' ? `${r.overallScore}/10` : '-';
        const reviewer = r.reviewerId ?? '-';
        return `| ${i + 1} | ${date} | ${String(r.scope).slice(0, 50)} | ${reviewer} | ${score} | ${r.id} |`;
      }),
      '',
      'Use `review_get` (or read the markdown file under `.metis-data/reviews/`) to see the full content of a review.',
      '',
      '## Raw JSON',
      JSON.stringify(reviews, null, 2),
    ];
    return lines.join('\n');
  } catch (err) {
    return `Review list failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const reviewGetHandler: ToolHandler = async (args) => {
  const id = String(args.id ?? '').trim();
  if (!id) return 'Error: id is required.';

  try {
    const md = await getReviewMarkdown(id);
    if (md === null) {
      return `No review found with id "${id}". Use review_list to see saved review ids.`;
    }
    return md;
  } catch (err) {
    return `Review get failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Research state aggregation handler ───────────────────────

export const researchStateHandler: ToolHandler = async () => {
  try {
    // Library stats (may be unavailable if store not initialized).
    let libraryStats: ReturnType<PersistenceStore['getLibraryStats']> | null = null;
    if (sharedStore) {
      try {
        libraryStats = sharedStore.getLibraryStats();
      } catch {
        libraryStats = null;
      }
    }

    // Claim manifest (async, durable).
    const manifest = await loadManifest();

    // Reviews (async, durable).
    const recentReviews = await listReviews({ limit: 5 });

    const lines: string[] = ['# Research State', ''];

    if (manifest.projectName || manifest.researchQuestion) {
      lines.push('## Project');
      if (manifest.projectName) lines.push(`- Name: ${manifest.projectName}`);
      if (manifest.researchQuestion) lines.push(`- Research question: ${manifest.researchQuestion}`);
      lines.push('');
    }

    // Library summary.
    lines.push('## Library');
    if (libraryStats) {
      lines.push(`- Papers: ${libraryStats.totalPapers}`);
      lines.push(`- Duplicate groups: ${libraryStats.duplicateGroupCount}`);
      const read = Object.entries(libraryStats.readStatusCounts)
        .map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
      lines.push(`- Read status: ${read}`);
      const topTags = Object.entries(libraryStats.tagDistribution)
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([k, v]) => `${k}(${v})`).join(', ') || 'none';
      lines.push(`- Top tags: ${topTags}`);
    } else {
      lines.push('- Library store not initialized.');
    }
    lines.push('');

    // Claims summary.
    lines.push('## Claims');
    const claimStatusCounts: Record<string, number> = {};
    for (const c of manifest.claims) {
      claimStatusCounts[c.status] = (claimStatusCounts[c.status] ?? 0) + 1;
    }
    lines.push(`- Total: ${manifest.claims.length}`);
    if (manifest.claims.length > 0) {
      const statusSummary = Object.entries(claimStatusCounts).map(([k, v]) => `${k}:${v}`).join(', ');
      lines.push(`- Status: ${statusSummary}`);
      const recentClaim = manifest.claims[manifest.claims.length - 1];
      if (recentClaim) {
        lines.push(`- Latest: "${recentClaim.claim.slice(0, 80)}" [${recentClaim.status}]`);
      }
    }
    lines.push('');

    // Reviews summary.
    lines.push('## Reviews');
    lines.push(`- Saved: ${recentReviews.length === 5 ? '5+' : recentReviews.length} recent`);
    if (recentReviews.length > 0) {
      for (const r of recentReviews) {
        const date = new Date(r.createdAt).toISOString().slice(0, 10);
        const score = typeof r.overallScore === 'number' ? ` (${r.overallScore}/10)` : '';
        lines.push(`  - ${date} ${r.scope}${score}`);
      }
    }
    lines.push('');

    lines.push(
      'Use library_stats for full corpus detail, claim_manifest_list for all claims, and review_list for all reviews.',
      '',
      '## Raw JSON',
      JSON.stringify(
        {
          project: { name: manifest.projectName ?? null, researchQuestion: manifest.researchQuestion ?? null },
          library: libraryStats,
          claims: { total: manifest.claims.length, statusCounts: claimStatusCounts },
          reviews: { recentCount: recentReviews.length, recent: recentReviews },
        },
        null,
        2,
      ),
    );

    return lines.join('\n');
  } catch (err) {
    return `Research state failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Research summary (narrative) handler ────────────────────

export const researchSummaryHandler: ToolHandler = async () => {
  try {
    // Gather all sources.
    const manifest = await loadManifest();
    const findings = await listFindings({ limit: 1000 });
    const recentReviews = await listReviews({ limit: 10 });

    let libraryStats: ReturnType<PersistenceStore['getLibraryStats']> | null = null;
    if (sharedStore) {
      try {
        libraryStats = sharedStore.getLibraryStats();
      } catch {
        libraryStats = null;
      }
    }

    const lines: string[] = [];

    // --- Title + project frame ---
    lines.push('# Research Progress Summary', '');
    if (manifest.projectName || manifest.researchQuestion) {
      lines.push(
        `This project${manifest.projectName ? `, **${manifest.projectName}**,` : ''} is investigating${
          manifest.researchQuestion ? `: _${manifest.researchQuestion}_` : ' an open research question.'
        }`,
        '',
      );
    } else {
      lines.push('No project name or research question has been set yet (use claim manifest meta to add one).', '');
    }

    // --- Corpus narrative ---
    lines.push('## Corpus');
    if (libraryStats && libraryStats.totalPapers > 0) {
      const readPct = Math.round((Object.entries(libraryStats.readStatusCounts).reduce((acc, [k, v]) => k === 'read' ? acc + v : acc, 0) / libraryStats.totalPapers) * 100);
      const topTags = Object.entries(libraryStats.tagDistribution).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k).join(', ');
      lines.push(
        `The local library holds **${libraryStats.totalPapers} paper(s)** (${readPct}% read)${topTags ? `, focused on ${topTags}` : ''}.`,
        libraryStats.duplicateGroupCount > 0 ? `There are ${libraryStats.duplicateGroupCount} duplicate group(s) to clean up.` : 'No duplicates detected.',
        '',
      );
    } else {
      lines.push('The local library is empty or not initialized. Add papers to begin building a corpus.', '');
    }

    // --- Claims narrative ---
    lines.push('## Claims under investigation');
    const claimStatusCounts: Record<string, number> = {};
    for (const c of manifest.claims) {
      claimStatusCounts[c.status] = (claimStatusCounts[c.status] ?? 0) + 1;
    }
    if (manifest.claims.length > 0) {
      const verified = claimStatusCounts.verified ?? 0;
      const gaps = claimStatusCounts.gap ?? 0;
      const proposed = claimStatusCounts.proposed ?? 0;
      const parts: string[] = [];
      if (verified > 0) parts.push(`${verified} verified`);
      if (proposed > 0) parts.push(`${proposed} proposed`);
      if (gaps > 0) parts.push(`${gaps} gap(s)`);
      lines.push(
        `${manifest.claims.length} claim(s) tracked: ${parts.join(', ') || 'various statuses'}.`,
        gaps > 0 ? `There ${gaps === 1 ? 'is 1 open gap' : `are ${gaps} open gaps`} to address.` : 'No open gaps remain.',
        '',
      );
    } else {
      lines.push('No claims have been filed yet.', '');
    }

    // --- Findings narrative ---
    lines.push('## Findings so far');
    if (findings.length > 0) {
      const high = findings.filter((f) => f.confidence === 'high').length;
      const allTags = new Set<string>();
      for (const f of findings) for (const t of f.tags) allTags.add(t);
      lines.push(
        `${findings.length} finding(s) recorded (${high} at high confidence), spanning ${allTags.size} tag(s).`,
        'Most recent:',
        ...findings.slice(0, 3).map((f) => `  - _${f.text.slice(0, 100)}${f.text.length > 100 ? '…' : ''}_ (${f.confidence})`),
        '',
      );
    } else {
      lines.push('No findings recorded yet. Use findings_add or experiment_to_findings to start accumulating discoveries.', '');
    }

    // --- Reviews narrative ---
    lines.push('## Reviews');
    if (recentReviews.length > 0) {
      const avgScore = recentReviews.filter((r) => typeof r.overallScore === 'number').reduce((acc, r) => acc + (r.overallScore ?? 0), 0) / Math.max(1, recentReviews.filter((r) => typeof r.overallScore === 'number').length);
      lines.push(
        `${recentReviews.length} review(s) saved${!Number.isNaN(avgScore) ? ` (avg score ${avgScore.toFixed(1)}/10)` : ''}.`,
        'Latest reviewed:',
        ...recentReviews.slice(0, 3).map((r) => `  - ${r.scope}${typeof r.overallScore === 'number' ? ` (${r.overallScore}/10)` : ''}`),
        '',
      );
    } else {
      lines.push('No reviews saved yet.', '');
    }

    // --- Suggested next steps ---
    lines.push('## Suggested next steps');
    const suggestions: string[] = [];
    if (!manifest.projectName) suggestions.push('Set a project name and research question (claim manifest meta).');
    if (!libraryStats || libraryStats.totalPapers === 0) suggestions.push('Build the corpus: search and add papers.');
    else if (libraryStats.duplicateGroupCount > 0) suggestions.push('Run delete_library_duplicates to clean the corpus.');
    if (manifest.claims.length === 0) suggestions.push('File initial claims from key papers (claim_manifest_verify).');
    if ((claimStatusCounts.gap ?? 0) > 0) suggestions.push('Address open gaps: design experiments or find evidence.');
    if (findings.length === 0) suggestions.push('Convert experiment metrics to findings (experiment_to_findings).');
    if (recentReviews.length === 0) suggestions.push('Review a key paper (paper-review skill) and persist it (review_save).');
    if (suggestions.length === 0) suggestions.push('The project looks well-rounded. Consider exporting findings (findings_export) or drafting the manuscript.');
    for (const s of suggestions) lines.push(`- ${s}`);
    lines.push('');

    lines.push(
      '_This is a narrative summary. For raw structured data use research_state; for export use findings_export._',
    );

    return lines.join('\n');
  } catch (err) {
    return `Research summary failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Interest profile handler ─────────────────────────────────

export const interestProfileHandler: ToolHandler = async (args) => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  try {
    const topN = typeof args.topN === 'number' ? Math.max(1, Math.min(50, Math.floor(args.topN))) : 10;
    const profile = sharedStore.buildInterestProfile({ topN });

    if (profile.paperCount === 0) {
      return 'The local library is empty, so no interest profile could be built. Add some papers first.';
    }

    const lines = [
      '# Interest Profile',
      `Built from ${profile.paperCount} paper(s) in the local library.`,
      '',
      '## Top tags (topic interest)',
      profile.topTags.length === 0
        ? '  No tags found. Tag your papers to enable topic profiling.'
        : profile.topTags
            .map((t, i) => `  ${i + 1}. ${t.tag} — ${t.count} paper(s), avg rating ${t.avgRating}`)
            .join('\n'),
      '',
      '## Top authors',
      profile.topAuthors.length === 0
        ? '  No authors recorded.'
        : profile.topAuthors.map((a, i) => `  ${i + 1}. ${a.author} (${a.count})`).join('\n'),
      '',
      '## Top venues',
      profile.topVenues.length === 0
        ? '  No venues recorded.'
        : profile.topVenues.map((v, i) => `  ${i + 1}. ${v.venue} (${v.count})`).join('\n'),
      '',
      '## Temporal & engagement signals',
      `- Year range: ${profile.yearRange.earliest ?? '?'} – ${profile.yearRange.latest ?? '?'} (median ${profile.yearRange.medianYear ?? '?'})`,
      `- Read ratio: ${profile.readRatio} (${Math.round(profile.readRatio * 100)}% of papers marked read)`,
      `- Average rating: ${profile.avgRating} / 5`,
      `- Recency bias: ${Math.round(profile.recencyBias.since2020Ratio * 100)}% of papers from 2020+; median recency weight ${profile.recencyBias.medianRecencyWeight}`,
      '',
      '## Top collections',
      profile.topCollections.length === 0
        ? '  No collections.'
        : profile.topCollections.map((c, i) => `  ${i + 1}. ${c.name} (${c.paperCount})`).join('\n'),
      '',
      'Use this profile to weight candidate papers when recommending or triaging: tags with higher count/avgRating reflect stronger interest, and the recency bias shows whether the user favors recent work.',
      '',
      '## Raw JSON',
      JSON.stringify(profile, null, 2),
    ];

    return lines.join('\n');
  } catch (err) {
    return `Interest profile failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Candidate ranking handler ────────────────────────────────

export const rankCandidatesHandler: ToolHandler = async (args) => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  try {
    const options: Parameters<PersistenceStore['rankCandidates']>[0] = {};
    if (Array.isArray(args.paperIds)) options.paperIds = args.paperIds.map(String);
    if (typeof args.query === 'string' && args.query.trim()) options.query = String(args.query);
    if (typeof args.limit === 'number') options.limit = Math.max(1, Math.min(100, Math.floor(args.limit)));

    const result = sharedStore.rankCandidates(options);

    if (result.ranked.length === 0) {
      return options.query
        ? `No candidates matched the query "${options.query}".`
        : 'No candidates to rank. Add papers to the library first.';
    }

    const header = '| # | Score | Title | Tags | Authors | Venue | Year | TagOverlap | Author | Venue | Recency | Rating |';
    const sep = '|---|-------|-------|------|---------|-------|------|------------|--------|-------|---------|--------|';
    // Note: we re-fetch paper meta to display venue/year in the table.
    const allPapers = sharedStore.getPapers();
    const byId = new Map(allPapers.map((p) => [p.id, p]));

    const rows = result.ranked.map((r, i) => {
      const p = byId.get(r.id);
      const cell = (s: string) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').slice(0, 60);
      return `| ${i + 1} | ${r.score.toFixed(2)} | ${cell(r.title)} | ${cell((p?.tags ?? []).join(', '))} | ${cell((p?.authors ?? []).slice(0, 2).join(', '))} | ${cell(p?.venue ?? '')} | ${p?.year ?? ''} | ${r.dimensions.tagOverlap.toFixed(2)} | ${r.dimensions.authorOverlap.toFixed(2)} | ${r.dimensions.venueMatch} | ${r.dimensions.recency.toFixed(2)} | ${r.dimensions.ratingSignal.toFixed(2)} |`;
    });

    const lines = [
      '# Candidate Ranking',
      `Ranked ${result.ranked.length} candidate(s) against the interest profile (built from ${result.profilePaperCount} paper(s)).`,
      '',
      header,
      sep,
      ...rows,
      '',
      '## How scores work',
      '- Each candidate is scored 0–1 across 5 dimensions: tagOverlap (0.35), authorOverlap (0.15), venueMatch (0.10), recency (0.20), ratingSignal (0.20).',
      '- tagOverlap rewards candidates whose tags match the user\'s top-weighted tags.',
      '- recency peaks when the year is within 5 of the profile median year, decaying to 0 at 15 years.',
      '- Use interest_profile first to inspect the profile these scores are based on.',
      '',
      '## Raw JSON',
      JSON.stringify(result.ranked, null, 2),
    ];

    return lines.join('\n');
  } catch (err) {
    return `Candidate ranking failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Figure reference consistency handler ─────────────────────

export const figureReferenceCheckHandler: ToolHandler = async (args) => {
  const source = String(args.source ?? '');
  if (!source.trim()) return 'Error: source (LaTeX source string) is required.';

  try {
    const result = checkFigureReferences(source);
    const lines = [
      '# Figure / Table Reference Consistency',
      `Figures/tables/equations with labels: ${result.figures.length}`,
      `In-text references: ${result.references.length}`,
      `Issues found: ${result.totalIssues}`,
      '',
    ];

    if (result.figures.length > 0) {
      lines.push('## Defined labels');
      for (const f of result.figures) {
        const status = f.referenced ? '✓ referenced' : '✗ unreferenced';
        lines.push(`  - L${f.line} [${f.kind}] ${f.label} — ${status}`);
      }
      lines.push('');
    }

    if (result.issues.length > 0) {
      lines.push('## Issues');
      for (const issue of result.issues) {
        const loc = issue.line > 0 ? `L${issue.line}: ` : '';
        lines.push(`  - [${issue.type}] ${loc}${issue.message}`);
      }
      lines.push('');
    }

    if (result.recommendations.length > 0) {
      lines.push('## Recommendations');
      for (const rec of result.recommendations) lines.push(`- ${rec}`);
      lines.push('');
    }

    lines.push('## Raw JSON', JSON.stringify(figureReferenceResultToPlain(result), null, 2));
    return lines.join('\n');
  } catch (err) {
    return `Figure reference check failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Workspace initialization handler ─────────────────────────

export const workspaceInitHandler: ToolHandler = async (args) => {
  const root = String(args.root ?? '').trim();
  if (!root) return 'Error: root (absolute path for the project workspace) is required.';
  const { isAbsolute } = await import('node:path');
  if (!isAbsolute(root)) {
    return `Error: root must be an absolute path (got "${root}").`;
  }

  try {
    const layout = await initWorkspace({
      root,
      projectName: typeof args.projectName === 'string' ? String(args.projectName) : undefined,
      researchQuestion: typeof args.researchQuestion === 'string' ? String(args.researchQuestion) : undefined,
      force: args.force === true,
    });

    const lines = [
      '# Workspace Initialized',
      `Root: ${layout.root}`,
      `Manifest: ${layout.manifestPath}`,
    ];
    if (typeof args.projectName === 'string' && args.projectName.trim()) {
      lines.push(`Project: ${args.projectName}`);
    }
    if (typeof args.researchQuestion === 'string' && args.researchQuestion.trim()) {
      lines.push(`Research question: ${args.researchQuestion}`);
    }
    lines.push(
      `Already initialized: ${layout.alreadyInitialized ? 'yes (use force=true to overwrite)' : 'no'}`,
      `Manifest written this call: ${layout.manifestWritten ? 'yes' : 'no'}`,
      '',
      '## Directories',
      ...layout.directories.map((d) => `  - ${d}`),
      '',
      '## Next steps',
      '- Place PDFs and BibTeX in literature/.',
      '- Put experiment scripts and result snapshots in experiments/.',
      '- Draft the manuscript in manuscripts/.',
      '- Edit research-state.yaml to record milestones and findings as you go.',
      '',
      '## Raw JSON',
      JSON.stringify(layout, null, 2),
    );
    return lines.join('\n');
  } catch (err) {
    return `Workspace init failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const workspaceStatusHandler: ToolHandler = async (args) => {
  const root = String(args.root ?? '').trim();
  if (!root) return 'Error: root (absolute path) is required.';

  try {
    const manifest = await readWorkspaceManifest(root);
    if (!manifest) {
      return `No research-state.yaml found at ${root}. Run workspace_init first.`;
    }
    const lines = [
      '# Workspace Status',
      `Root: ${root}`,
      '',
      '## Manifest',
      ...Object.entries(manifest).map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`),
    ];

    // Quick directory presence check.
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    lines.push('', '## Directories');
    for (const dir of DEFAULT_DIRECTORIES) {
      const full = join(root, dir);
      const exists = existsSync(full);
      lines.push(`  - ${dir}/ ${exists ? '✓' : '✗ missing'}`);
    }
    return lines.join('\n');
  } catch (err) {
    return `Workspace status failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Findings log handlers ────────────────────────────────────

export const findingsAddHandler: ToolHandler = async (args) => {
  const text = String(args.text ?? '').trim();
  if (!text) return 'Error: text (the finding statement) is required.';

  try {
    const confidence = args.confidence === 'low' || args.confidence === 'medium' || args.confidence === 'high'
      ? args.confidence
      : 'medium';
    const finding = await addFinding({
      text,
      tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
      confidence,
      source: typeof args.source === 'string' && args.source.trim() ? String(args.source) : undefined,
      workspaceRoot: typeof args.workspaceRoot === 'string' && args.workspaceRoot.trim() ? String(args.workspaceRoot) : undefined,
    });

    const date = new Date(finding.createdAt).toISOString();
    const lines = [
      '# Finding Logged',
      `- ID: ${finding.id}`,
      `- Text: ${finding.text}`,
      `- Confidence: ${finding.confidence}`,
      `- Tags: ${finding.tags.length > 0 ? finding.tags.join(', ') : '(none)'}`,
      finding.source ? `- Source: ${finding.source}` : '',
      `- Created: ${date}`,
      '',
      args.workspaceRoot
        ? `Appended to ${args.workspaceRoot}/findings.md and the findings index.`
        : 'Saved to the findings index (pass workspaceRoot to also append to findings.md).',
      '',
      '## Raw JSON',
      JSON.stringify(finding, null, 2),
    ].filter((l) => l !== '');
    return lines.join('\n');
  } catch (err) {
    return `Finding add failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const findingsListHandler: ToolHandler = async (args) => {
  try {
    const findings = await listFindings({
      tag: typeof args.tag === 'string' && args.tag.trim() ? String(args.tag) : undefined,
      contains: typeof args.contains === 'string' && args.contains.trim() ? String(args.contains) : undefined,
      confidence: args.confidence === 'low' || args.confidence === 'medium' || args.confidence === 'high' ? args.confidence : undefined,
      limit: typeof args.limit === 'number' ? Math.max(1, Math.min(1000, Math.floor(args.limit))) : undefined,
    });

    if (findings.length === 0) {
      return 'No findings recorded yet. Use findings_add to log a research finding.';
    }

    const lines = [
      '# Findings Log',
      `Showing ${findings.length} finding(s) (most recent first).`,
      '',
      ...findings.map((f, i) => {
        const date = new Date(f.createdAt).toISOString().slice(0, 10);
        const tags = f.tags.length > 0 ? ` [${f.tags.join(', ')}]` : '';
        return `${i + 1}. **[${date}]** ${f.text}${tags} (${f.confidence})`;
      }),
      '',
      '## Raw JSON',
      JSON.stringify(findings, null, 2),
    ];
    return lines.join('\n');
  } catch (err) {
    return `Finding list failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Findings export handler ─────────────────────────────────

export const findingsExportHandler: ToolHandler = async (args) => {
  try {
    const format = args.format === 'markdown' || args.format === 'json' || args.format === 'csv' ? args.format : 'markdown';
    const result = await exportFindings({
      format,
      tag: typeof args.tag === 'string' && args.tag.trim() ? String(args.tag) : undefined,
      confidence: args.confidence === 'low' || args.confidence === 'medium' || args.confidence === 'high' ? args.confidence : undefined,
      contains: typeof args.contains === 'string' && args.contains.trim() ? String(args.contains) : undefined,
      filePath: typeof args.filePath === 'string' && args.filePath.trim() ? String(args.filePath) : undefined,
    });

    if (result.count === 0) {
      return 'No findings match the export filters. Use findings_add to log findings first.';
    }

    if (result.filePath) {
      return [
        '# Findings Exported',
        `Format: ${result.format}`,
        `Count: ${result.count}`,
        `Written to: ${result.filePath}`,
        '',
        'Pass without filePath to get the content inline.',
      ].join('\n');
    }

    return result.content;
  } catch (err) {
    return `Findings export failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Experiment → findings bridge handler ────────────────────

export const experimentToFindingsHandler: ToolHandler = async (args) => {
  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }
  const experimentId = String(args.experimentId ?? '').trim();
  if (!experimentId) return 'Error: experimentId is required.';

  try {
    const experiments = sharedStore.getExperiments();
    const exp = experiments.find((e) => e.id === experimentId);
    if (!exp) {
      return `No experiment found with id "${experimentId}". Use experiment_stats to list experiments.`;
    }

    const metricEntries = Object.entries(exp.metrics ?? {});
    if (metricEntries.length === 0) {
      return `Experiment "${exp.name}" (${exp.id}) has no metrics to convert into findings.`;
    }

    const workspaceRoot = typeof args.workspaceRoot === 'string' && args.workspaceRoot.trim() ? String(args.workspaceRoot) : undefined;
    const confidence = args.confidence === 'low' || args.confidence === 'medium' || args.confidence === 'high' ? args.confidence : 'high';
    const expTag = `exp:${exp.id}`;
    const baseTags = [expTag, ...((exp.tags ?? []).map((t) => t.toLowerCase()))];

    const created: Array<{ metric: string; value: number; findingId: string }> = [];
    for (const [metric, value] of metricEntries) {
      const numValue = typeof value === 'number' && !Number.isNaN(value) ? value : Number(value);
      const text = `Experiment "${exp.name}" (${exp.id}) achieved ${metric} = ${numValue}.`;
      const finding = await addFinding({
        text,
        tags: baseTags,
        confidence,
        source: expTag,
        workspaceRoot,
      });
      created.push({ metric, value: numValue, findingId: finding.id });
    }

    const lines = [
      '# Experiment → Findings',
      `Converted ${created.length} metric(s) from experiment "${exp.name}" (${exp.id}) into findings.`,
      '',
      '## Created findings',
      ...created.map((c, i) => `  ${i + 1}. ${c.metric} = ${c.value} → finding ${c.findingId}`),
      '',
      workspaceRoot
        ? `Findings also appended to ${workspaceRoot}/findings.md.`
        : 'Findings saved to the findings index (pass workspaceRoot to also append to findings.md).',
      '',
      '## Raw JSON',
      JSON.stringify({ experimentId: exp.id, experimentName: exp.name, confidence, created }, null, 2),
    ];
    return lines.join('\n');
  } catch (err) {
    return `Experiment to findings failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Claim → findings bridge handler ─────────────────────────

export const claimToFindingsHandler: ToolHandler = async (args) => {
  try {
    // Optional status filter; default to 'verified' so only confirmed claims
    // enter the findings log (avoids polluting memory with unverified claims).
    const statusFilter = args.status === 'proposed' || args.status === 'verified' || args.status === 'single_index' || args.status === 'gap'
      ? args.status
      : 'verified';

    const claims = await listClaims({ status: statusFilter });
    if (claims.length === 0) {
      return `No claims with status "${statusFilter}" found in the manifest. Use claim_manifest_verify or addClaim first.`;
    }

    const workspaceRoot = typeof args.workspaceRoot === 'string' && args.workspaceRoot.trim() ? String(args.workspaceRoot) : undefined;
    const confidence = args.confidence === 'low' || args.confidence === 'medium' || args.confidence === 'high' ? args.confidence : 'high';

    const created: Array<{ claimId: string; findingId: string; text: string }> = [];
    for (const claim of claims) {
      const sourceId = claim.doi ?? claim.arxivId ?? claim.source ?? claim.id;
      const text = `Verified claim: ${claim.claim}`;
      const finding = await addFinding({
        text,
        tags: ['claim', statusFilter, String(sourceId).toLowerCase()],
        confidence,
        source: `claim:${claim.id}`,
        workspaceRoot,
      });
      created.push({ claimId: claim.id, findingId: finding.id, text });
    }

    const lines = [
      '# Claim → Findings',
      `Converted ${created.length} claim(s) with status "${statusFilter}" into findings.`,
      '',
      '## Created findings',
      ...created.map((c, i) => `  ${i + 1}. [${c.claimId}] ${c.text.slice(0, 80)}${c.text.length > 80 ? '…' : ''} → ${c.findingId}`),
      '',
      workspaceRoot
        ? `Findings also appended to ${workspaceRoot}/findings.md.`
        : 'Findings saved to the findings index (pass workspaceRoot to also append to findings.md).',
      '',
      '## Raw JSON',
      JSON.stringify({ statusFilter, confidence, created }, null, 2),
    ];
    return lines.join('\n');
  } catch (err) {
    return `Claim to findings failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Experiment script execution handler ──────────────────────

export const runExperimentScriptHandler: ToolHandler = async (args) => {
  const experimentId = String(args.experimentId ?? '');
  if (!experimentId.trim()) return 'Error: experimentId is required.';

  if (!sharedStore) {
    return 'Error: local library store is not initialized.';
  }

  try {
    const result = await sharedStore.runExperimentScript(experimentId);
    const lines = [
      `# Experiment Run: ${experimentId}`,
      `Success: ${result.success}`,
      `Exit code: ${result.exitCode ?? 'N/A'}`,
      '',
      '## Parsed metrics',
      JSON.stringify(result.parsedMetrics, null, 2) || 'None',
      '',
      '## Stdout',
      result.stdout.slice(0, 2000) || '(empty)',
    ];
    if (result.stderr) {
      lines.push('', '## Stderr', result.stderr.slice(0, 1000));
    }
    return lines.join('\n');
  } catch (err) {
    return `Experiment run failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Citation triangulation handler ───────────────────────────

export const citationTriangulateHandler: ToolHandler = async (args) => {
  const doi = String(args.doi ?? '');
  if (!doi.trim()) return 'Error: doi is required.';

  try {
    const result = await triangulateDoi(doi);
    return JSON.stringify(triangulationResultToPlain(result));
  } catch (err) {
    return `Citation triangulation failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const citationPassportRecordHandler: ToolHandler = async (args) => {
  const doi = String(args.doi ?? '');
  if (!doi.trim()) return 'Error: doi is required.';

  try {
    const result = await triangulateDoi(doi);
    const entry = await recordTriangulation(result);
    const plain = passportToPlain(entry);

    const lines = [
      `# Citation Passport recorded: ${entry.normalizedDoi}`,
      `Verdict: **${entry.overall}**`,
      `Triangulation count: ${plain.triangulationCount}`,
      `Exists in: ${entry.existsIn.join(', ') || 'none'}`,
      `Missing in: ${entry.missingIn.join(', ') || 'none'}`,
      `Warnings: ${entry.warnings.length > 0 ? entry.warnings.join('; ') : 'none'}`,
      '',
      '## Raw JSON',
      JSON.stringify(plain, null, 2),
    ];
    return lines.join('\n');
  } catch (err) {
    return `Citation passport record failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const citationPassportGetHandler: ToolHandler = async (args) => {
  const doi = String(args.doi ?? '');
  if (!doi.trim()) return 'Error: doi is required.';

  try {
    const entry = await getPassport(doi);
    if (!entry) return `No citation passport found for ${doi}.`;
    return JSON.stringify(passportToPlain(entry));
  } catch (err) {
    return `Citation passport get failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const citationPassportListHandler: ToolHandler = async (args) => {
  const overall = args.overall ? String(args.overall) : undefined;
  try {
    const entries = await listPassports(overall ? { overall: overall as 'VERIFIED' | 'INCONSISTENT' | 'PARTIAL' | 'NOT_FOUND' } : undefined);
    const passports = entries.map(passportToPlain);
    return JSON.stringify({ total: passports.length, passports });
  } catch (err) {
    return `Citation passport list failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const citationPassportAddSignalHandler: ToolHandler = async (args) => {
  const doi = String(args.doi ?? '');
  const source = String(args.source ?? '');
  const type = String(args.type ?? '');
  const details = args.details ? String(args.details) : undefined;
  const url = args.url ? String(args.url) : undefined;

  if (!doi.trim() || !source.trim() || !type.trim()) {
    return 'Error: doi, source, and type are required.';
  }

  const validTypes = ['retraction', 'expression_of_concern', 'journal_blacklist', 'predatory_journal', 'data_fabrication', 'other'];
  if (!validTypes.includes(type)) {
    return `Error: type must be one of ${validTypes.join(', ')}.`;
  }

  try {
    const entry = await addContaminationSignal(doi, { source, type: type as never, details, url });
    if (!entry) return `No citation passport found for ${doi}; run citation_passport_record first.`;
    return `Contamination signal added to ${entry.normalizedDoi}. Signal count: ${entry.contaminationSignals.length}.`;
  } catch (err) {
    return `Citation passport add signal failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const citationPassportScanHandler: ToolHandler = async (args) => {
  const doi = args.doi ? String(args.doi) : undefined;

  try {
    if (doi) {
      const result = await scanDoi(doi);
      return JSON.stringify(scanResultToPlain(result));
    }

    const summary = await scanAllPassports();
    return `Scanned ${summary.scanned} passports. New signals recorded: ${summary.newSignals}. Touched DOIs: ${summary.touched.join(', ') || 'none'}.`;
  } catch (err) {
    return `Contamination scan failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const retractionWatchUpdateHandler: ToolHandler = async () => {
  try {
    const result = await updateMirror();
    return `Retraction Watch mirror updated. Entries: ${result.entryCount}. Updated at: ${new Date(result.updatedAt).toISOString()}.`;
  } catch (err) {
    return `Retraction Watch mirror update failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const retractionWatchLookupHandler: ToolHandler = async (args) => {
  const doi = String(args.doi ?? '');
  if (!doi.trim()) return 'Error: doi is required.';

  try {
    const entries = await lookupDoi(doi);
    if (!entries || entries.length === 0) return `No Retraction Watch entries found for ${doi}.`;
    return JSON.stringify({ doi, entries: entries.map(entryToPlain) });
  } catch (err) {
    return `Retraction Watch lookup failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const retractionWatchStatsHandler: ToolHandler = async () => {
  try {
    const mirror = await loadMirror();
    if (!mirror) return 'No Retraction Watch mirror found. Run retraction_watch_update first.';
    return JSON.stringify(mirrorStatsToPlain(mirror));
  } catch (err) {
    return `Retraction Watch stats failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const journalIntegrityUpdateHandler: ToolHandler = async (args) => {
  const type = String(args.type ?? 'all').toLowerCase();
  try {
    if (type === 'all') {
      const result = await updateAllMirrors();
      return `Journal integrity mirrors updated. DOAJ withdrawn: ${result.doaj.entryCount} entries. Hijacked journals: ${result.hijacked.entryCount} entries.`;
    }
    const validTypes: JournalIntegrityType[] = ['doaj_withdrawn', 'hijacked_journal'];
    if (!validTypes.includes(type as JournalIntegrityType)) {
      return `Error: type must be one of ${validTypes.join(', ')}, or all.`;
    }
    const result = await updateJournalIntegrityMirror(type as JournalIntegrityType);
    return `Journal integrity mirror (${type}) updated. Entries: ${result.entryCount}.`;
  } catch (err) {
    return `Journal integrity update failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const journalIntegrityLookupHandler: ToolHandler = async (args) => {
  const title = args.title ? String(args.title) : undefined;
  const issn = args.issn ? String(args.issn) : undefined;
  if (!title && !issn) return 'Error: title or issn is required.';

  try {
    const entries = await lookupVenue(title, issn);
    const plainEntries = entries.map(journalEntryToPlain);
    return JSON.stringify({ total: plainEntries.length, entries: plainEntries });
  } catch (err) {
    return `Journal integrity lookup failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const journalIntegrityStatsHandler: ToolHandler = async () => {
  try {
    const mirrors: Record<string, unknown>[] = [];
    for (const type of ['doaj_withdrawn', 'hijacked_journal'] as JournalIntegrityType[]) {
      const index = await loadIndex(type);
      if (index) {
        mirrors.push(indexStatsToPlain(index));
      }
    }
    if (mirrors.length === 0) return 'No journal integrity mirrors found. Run journal_integrity_update first.';
    return JSON.stringify({ mirrors });
  } catch (err) {
    return `Journal integrity stats failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Writing stage check tool ─────────────────────────────────

export const WRITING_STAGE_CHECK_TOOL: ToolSpec = {
  name: 'writing_stage_check',
  description: 'Check whether a draft satisfies the criteria for a specific writing stage (outline, introduction, related_work, methods, results, discussion, conclusion, polish). Returns a score, checklist, and advice for the next stage.',
  parameters: {
    type: 'object',
    properties: {
      stage: {
        type: 'string',
        enum: ['outline', 'introduction', 'related_work', 'methods', 'results', 'discussion', 'conclusion', 'polish'],
        description: 'Writing stage to evaluate',
      },
      text: { type: 'string', description: 'Draft text for the stage' },
    },
    required: ['stage', 'text'],
  },
};

export const STYLE_CALIBRATION_TOOL: ToolSpec = {
  name: 'style_calibration',
  description: 'Calibrate academic writing style: detect machine-generated patterns (empty hedges, repetitive openers, unsupported superlatives, generic summaries), compute a readability score, and give concrete recommendations.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to evaluate' },
    },
    required: ['text'],
  },
};

export const SEARCH_LIBRARY_TOOL: ToolSpec = {
  name: 'search_library',
  description: 'Search the local paper and note library for content relevant to a query. Returns matching papers and notes with snippets so the agent can ground answers in the user\'s own library.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Maximum results to return (default 5)' },
    },
    required: ['query'],
  },
};

export const FIND_LIBRARY_DUPLICATES_TOOL: ToolSpec = {
  name: 'find_library_duplicates',
  description: 'Find duplicate papers in the local library by DOI, arXiv ID, or normalized title. Returns duplicate groups with paper IDs and titles. Use before literature reviews, systematic reviews, or corpus cleanup.',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export const DELETE_LIBRARY_DUPLICATES_TOOL: ToolSpec = {
  name: 'delete_library_duplicates',
  description: 'Delete duplicate papers from the local library, keeping the most complete entry in each duplicate group. Use after reviewing find_library_duplicates output. Optionally force a specific paper ID to keep.',
  parameters: {
    type: 'object',
    properties: {
      keepId: { type: 'string', description: 'Optional paper ID to preserve across all duplicate groups it belongs to.' },
      dryRun: { type: 'boolean', description: 'If true, only report what would be deleted without removing anything.' },
    },
  },
};

export const LIBRARY_STATS_TOOL: ToolSpec = {
  name: 'library_stats',
  description: 'Return aggregate statistics about the local paper library: total papers, read status counts, year/tag/venue distributions, metadata completeness, and duplicate group count. Use before literature reviews or corpus cleanup.',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export const EXPORT_LIBRARY_TOOL: ToolSpec = {
  name: 'export_library',
  description: 'Export the local paper library to BibTeX or JSON. Optionally filter by paper IDs; if no IDs are provided, all papers are exported. Returns the generated content.',
  parameters: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['bibtex', 'json'], description: 'Export format' },
      paperIds: { type: 'array', items: { type: 'string' }, description: 'Optional list of paper IDs to export' },
      filePath: { type: 'string', description: 'Optional destination file path. If provided, the content is written to disk and the path is returned.' },
    },
    required: ['format'],
  },
};

export const IMPORT_PAPERS_TOOL: ToolSpec = {
  name: 'import_papers',
  description: 'Import papers into the local library from a BibTeX string/file or a JSON array. Duplicates are skipped based on DOI, arXiv ID, or normalized title. Returns import counts and per-item status.',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', enum: ['bibtex', 'json'], description: 'Source format' },
      bibtex: { type: 'string', description: 'BibTeX string (use this or filePath)' },
      filePath: { type: 'string', description: 'Path to .bib or .json file to import' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags to apply to all imported papers' },
    },
    required: ['source'],
  },
};

export const EXPERIMENT_STATS_TOOL: ToolSpec = {
  name: 'experiment_stats',
  description: 'Return aggregate statistics about tracked experiments: total count, status distribution, script coverage, tag distribution, recorded metric keys, and recently updated experiments.',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export const EXPERIMENT_COMPARE_TOOL: ToolSpec = {
  name: 'experiment_compare',
  description: 'Compare two or more tracked experiments by parameters and metrics. Highlights which parameters and metrics vary across the selected experiments.',
  parameters: {
    type: 'object',
    properties: {
      experimentIds: { type: 'array', items: { type: 'string' }, description: 'List of experiment IDs to compare' },
    },
    required: ['experimentIds'],
  },
};

export const EXPERIMENT_EXPORT_TOOL: ToolSpec = {
  name: 'experiment_export',
  description: 'Export tracked experiments to JSON. Optionally filter by experiment IDs; if none are provided, all experiments are exported. Optionally write to a file path.',
  parameters: {
    type: 'object',
    properties: {
      experimentIds: { type: 'array', items: { type: 'string' }, description: 'Optional list of experiment IDs to export' },
      filePath: { type: 'string', description: 'Optional destination file path. If provided, the JSON is written to disk and the path is returned.' },
    },
  },
};

export const COLLECTION_STATS_TOOL: ToolSpec = {
  name: 'collection_stats',
  description: 'Return aggregate statistics about local paper collections: total collections, total papers assigned to collections, empty collections, and per-collection paper counts.',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export const NOTE_STATS_TOOL: ToolSpec = {
  name: 'note_stats',
  description: 'Return aggregate statistics about local notes: total notes, linked papers/notes, orphan notes, tag distribution, and recently updated notes.',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export const TAGS_AUDIT_TOOL: ToolSpec = {
  name: 'tags_audit',
  description: 'Audit tag consistency across local papers, notes, and experiments. Reports unique tag counts, empty tags, case conflicts (e.g., "ML" vs "ml"), and similar tags (e.g., "machine-learning" vs "machine_learning").',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export const TAGS_MERGE_TOOL: ToolSpec = {
  name: 'tags_merge',
  description: 'Merge or rename tags across local papers, notes, and experiments. Supports a single source->target pair or a batch mapping. Use dryRun=true to preview changes without modifying the database. Typically used after tags_audit to fix case conflicts or near-duplicate tags.',
  parameters: {
    type: 'object',
    properties: {
      sourceTag: { type: 'string', description: 'Single source tag to rename (use either sourceTag/targetTag or mappings)' },
      targetTag: { type: 'string', description: 'Single target tag to rename into (use either sourceTag/targetTag or mappings)' },
      mappings: {
        type: 'array',
        description: 'Batch tag mappings; each entry renames sourceTag to targetTag',
        items: {
          type: 'object',
          properties: {
            sourceTag: { type: 'string' },
            targetTag: { type: 'string' },
          },
          required: ['sourceTag', 'targetTag'],
        },
      },
      dryRun: { type: 'boolean', description: 'If true, return the planned changes without writing to the database' },
    },
  },
};

export const CITATION_NETWORK_TOOL: ToolSpec = {
  name: 'citation_network',
  description: 'Analyze the local paper association network built from shared tags, shared authors, and collection co-occurrence. Returns node/edge counts, connected components, isolated papers, top connected papers, and the strongest edges. This is a local similarity network; true citation edges would require parsed reference lists.',
  parameters: {
    type: 'object',
    properties: {
      minWeight: { type: 'number', description: 'Minimum edge weight threshold (default 0)' },
      includeSharedTags: { type: 'boolean', description: 'Connect papers that share tags (default true)' },
      includeSharedAuthors: { type: 'boolean', description: 'Connect papers that share authors (default true)' },
      includeCollectionCooccurrence: { type: 'boolean', description: 'Connect papers that appear in the same collection (default true)' },
    },
  },
};

export const LITERATURE_TRIAGE_TOOL: ToolSpec = {
  name: 'literature_triage',
  description: 'Build a structured literature triage matrix comparing local papers across 9 columns: citation, question, method, data, claim, evidence_type, limitation, relevance, where_to_use. Use it to scan many papers at a glance before a deep read. Pass paperIds to triage a specific set, or a query to filter by topic; otherwise all papers are triaged (up to limit). limitation and where_to_use are left as "requires analysis" on purpose, since they need close reading rather than heuristic extraction.',
  parameters: {
    type: 'object',
    properties: {
      paperIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific paper IDs to triage. If omitted, all papers (filtered by query) are used.',
      },
      query: { type: 'string', description: 'Optional topic query used to select and rank papers by relevance.' },
      limit: { type: 'number', description: 'Maximum papers to triage (default 10, capped at 50).' },
    },
  },
};

export const REVIEW_SAVE_TOOL: ToolSpec = {
  name: 'review_save',
  description: 'Persist a structured paper review to disk so it survives across sessions, following the .review/ pattern. The review is stored under .metis-data/reviews/ as both a dated markdown file and an index entry. Use after paper-review or any heuristic review to create a durable record. scope (e.g. paper title or section) is required; overallScore is 1-10; confidence is 1-5.',
  parameters: {
    type: 'object',
    properties: {
      scope: { type: 'string', description: 'What was reviewed: paper title, section name, or "full-paper".' },
      reviewerId: { type: 'string', description: 'Reviewer persona or agent id that produced the review.' },
      overallScore: { type: 'number', description: 'Overall review score 1-10.' },
      confidence: { type: 'number', description: 'Reviewer confidence 1-5.' },
      summary: { type: 'string', description: 'One-paragraph review summary.' },
      strengths: { type: 'array', items: { type: 'string' }, description: 'List of strengths.' },
      weaknesses: { type: 'array', items: { type: 'string' }, description: 'List of weaknesses.' },
      questions: { type: 'array', items: { type: 'string' }, description: 'Open questions for the authors.' },
      recommendations: { type: 'array', items: { type: 'string' }, description: 'Actionable recommendations.' },
    },
    required: ['scope'],
  },
};

export const REVIEW_LIST_TOOL: ToolSpec = {
  name: 'review_list',
  description: 'List previously persisted reviews (most recent first), optionally filtered by scope substring or reviewerId. Returns a table plus raw JSON. Use at the start of a session to recall what has already been reviewed.',
  parameters: {
    type: 'object',
    properties: {
      scopeContains: { type: 'string', description: 'Optional substring to filter reviews by scope.' },
      reviewerId: { type: 'string', description: 'Optional exact reviewerId filter.' },
      limit: { type: 'number', description: 'Maximum reviews to return (default 50, capped at 500).' },
    },
  },
};

export const REVIEW_GET_TOOL: ToolSpec = {
  name: 'review_get',
  description: 'Read the full markdown content of a previously saved review by its id. Use after review_list to inspect a specific review.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Review id returned by review_save or review_list.' },
    },
    required: ['id'],
  },
};

export const RESEARCH_STATE_TOOL: ToolSpec = {
  name: 'research_state',
  description: 'Aggregate the cross-session research state into one summary: project name/research question (from the claim manifest), library stats (papers, read status, top tags), claim totals by status, and the 5 most recent saved reviews. Call this at the start of a session to recover context without re-reading everything, or to snapshot progress. Returns a readable summary plus raw JSON.',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export const RESEARCH_SUMMARY_TOOL: ToolSpec = {
  name: 'research_summary',
  description: 'Generate a human-readable narrative summary of research progress, weaving together project meta, corpus state, claims, findings, and reviews into a coherent story with suggested next steps. Distinct from research_state (structured data) — this produces prose a user or a fresh agent can read to understand where the project stands and what to do next.',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export const INTEREST_PROFILE_TOOL: ToolSpec = {
  name: 'interest_profile',
  description: 'Build an interest profile from the local library: the user\'s top tags (with average rating per tag), top authors, top venues, year range, read ratio, average rating, and a recency-bias signal (how much of the library is from 2020+). Use this to understand what the user cares about before recommending papers or ranking candidates (research-assist style profiling). Returns a readable profile plus raw JSON.',
  parameters: {
    type: 'object',
    properties: {
      topN: { type: 'number', description: 'How many entries to return per category (tags/authors/venues/collections). Default 10, capped at 50.' },
    },
  },
};

export const RANK_CANDIDATES_TOOL: ToolSpec = {
  name: 'rank_candidates',
  description: 'Rank candidate papers against the user\'s interest profile (built from the local library). Scores each candidate 0–1 across 5 dimensions: tag overlap with profile top tags (weight 0.35), author overlap (0.15), venue match (0.10), recency proximity to profile median year (0.20), and the candidate\'s own rating (0.20). Pass paperIds to rank a specific set, a query to filter, or nothing to rank the whole library. Use after interest_profile to surface which papers best match the user\'s established interests.',
  parameters: {
    type: 'object',
    properties: {
      paperIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific candidate paper IDs to rank.',
      },
      query: { type: 'string', description: 'Optional topic query to filter candidates before ranking.' },
      limit: { type: 'number', description: 'Maximum candidates to return (default 20, capped at 100).' },
    },
  },
};

export const FIGURE_REFERENCE_CHECK_TOOL: ToolSpec = {
  name: 'figure_reference_check',
  description: 'Check three-way consistency between LaTeX figures/tables/equations, their \\label definitions, and in-text \\ref/\\cref/\\autoref/\\eqref references. Reports: unreferenced labels (defined but never cited), dangling references (\\ref to a non-existent label), figures/tables without labels, non-continuous figure numbering, inconsistent callout styles (Figure vs Fig.), and too-short captions. Complements figure_audit (which checks per-figure file health). Pass the LaTeX source as a string.',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'LaTeX source code to check.' },
    },
    required: ['source'],
  },
};

export const WORKSPACE_INIT_TOOL: ToolSpec = {
  name: 'workspace_init',
  description: 'Initialize a structured research workspace at an absolute path: creates standard directories (literature/, experiments/, notes/, data/, figures/, manuscripts/) and writes a research-state.yaml manifest with project name, research question, and status. Idempotent — refuses to overwrite an existing manifest unless force=true. Use at the start of a new research project to establish a consistent layout.',
  parameters: {
    type: 'object',
    properties: {
      root: { type: 'string', description: 'Absolute path for the project workspace root.' },
      projectName: { type: 'string', description: 'Project name written into the manifest.' },
      researchQuestion: { type: 'string', description: 'Research question written into the manifest.' },
      force: { type: 'boolean', description: 'If true, overwrite an existing research-state.yaml. Default false.' },
    },
    required: ['root'],
  },
};

export const WORKSPACE_STATUS_TOOL: ToolSpec = {
  name: 'workspace_status',
  description: 'Read the research-state.yaml manifest at a workspace root and report its contents plus which standard directories exist. Use to check whether a workspace is initialized and recover its metadata.',
  parameters: {
    type: 'object',
    properties: {
      root: { type: 'string', description: 'Absolute path of the workspace root.' },
    },
    required: ['root'],
  },
};

export const FINDINGS_ADD_TOOL: ToolSpec = {
  name: 'findings_add',
  description: 'Append a research finding to the durable findings log (the lab-notebook of the project). Each finding is a concise factual statement with optional tags, confidence (low/medium/high), and a source pointer (claim id, paper id, review id). If workspaceRoot is given, also appends a human-readable line to <workspaceRoot>/findings.md. Findings persist across sessions and feed the autonomous research loop.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The finding statement (concise, factual).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional topic tags.' },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Confidence in the finding (default medium).' },
      source: { type: 'string', description: 'Origin of the finding: a claim id, paper id, review id, or "manual".' },
      workspaceRoot: { type: 'string', description: 'Optional workspace root; if set, also appends to findings.md there.' },
    },
    required: ['text'],
  },
};

export const FINDINGS_LIST_TOOL: ToolSpec = {
  name: 'findings_list',
  description: 'List recorded research findings, most recent first, with optional filters (by tag, text substring, or confidence level). Use to recall what has been discovered across sessions before continuing an autonomous research loop.',
  parameters: {
    type: 'object',
    properties: {
      tag: { type: 'string', description: 'Only findings with this tag.' },
      contains: { type: 'string', description: 'Only findings whose text contains this substring.' },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Only findings at this confidence.' },
      limit: { type: 'number', description: 'Maximum findings to return (default 100, capped at 1000).' },
    },
  },
};

export const FINDINGS_EXPORT_TOOL: ToolSpec = {
  name: 'findings_export',
  description: 'Export research findings to a portable format: markdown (grouped-by-tag report), json (raw array), or csv (id,date,confidence,source,tags,text). Supports the same tag/confidence/contains filters as findings_list. Pass filePath to write to disk; otherwise returns content inline. Use to share findings with collaborators or import into a paper draft.',
  parameters: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['markdown', 'json', 'csv'], description: 'Export format (default markdown).' },
      tag: { type: 'string', description: 'Only export findings with this tag.' },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Only export findings at this confidence.' },
      contains: { type: 'string', description: 'Only export findings whose text contains this substring.' },
      filePath: { type: 'string', description: 'Optional absolute path to write the export to disk.' },
    },
  },
};

export const EXPERIMENT_TO_FINDINGS_TOOL: ToolSpec = {
  name: 'experiment_to_findings',
  description: 'Convert an experiment\'s metrics into durable research findings, bridging the experiment tracker and the findings log. For each metric (e.g. accuracy=0.92), creates a finding "Experiment X (id) achieved metric = value" with the experiment tag, the experiment id as source, and the given confidence (default high). Pass workspaceRoot to also append to findings.md. Use after an experiment completes to feed its results into the autonomous research loop memory.',
  parameters: {
    type: 'object',
    properties: {
      experimentId: { type: 'string', description: 'ID of the experiment whose metrics to convert.' },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Confidence for the generated findings (default high).' },
      workspaceRoot: { type: 'string', description: 'Optional workspace root to also append to findings.md.' },
    },
    required: ['experimentId'],
  },
};

export const CLAIM_TO_FINDINGS_TOOL: ToolSpec = {
  name: 'claim_to_findings',
  description: 'Convert verified claims from the claim manifest into durable research findings, bridging claim verification and the findings log. By default only claims with status "verified" are converted (to avoid polluting memory with unverified claims); pass status to select a different status (proposed/verified/single_index/gap). Each claim becomes a finding "Verified claim: <text>" tagged with claim + status + source id, sourced to claim:<id>. Pass workspaceRoot to also append to findings.md.',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['proposed', 'verified', 'single_index', 'gap'], description: 'Only convert claims with this status (default verified).' },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Confidence for generated findings (default high).' },
      workspaceRoot: { type: 'string', description: 'Optional workspace root to also append to findings.md.' },
    },
  },
};

export const RUN_EXPERIMENT_SCRIPT_TOOL: ToolSpec = {
  name: 'run_experiment_script',
  description: 'Run the script associated with an experiment. Supports Python (.py), Node.js (.js/.mjs/.cjs), and shell (.sh) scripts. Captures stdout/stderr, parses METRIC:<key>=<value> lines into experiment metrics, and updates the experiment status.',
  parameters: {
    type: 'object',
    properties: {
      experimentId: { type: 'string', description: 'Experiment ID' },
    },
    required: ['experimentId'],
  },
};

export const CITATION_TRIANGULATE_TOOL: ToolSpec = {
  name: 'citation_triangulate',
  description: 'Cross-check a DOI against Crossref, OpenAlex, and Semantic Scholar to detect inconsistent or hallucinated references. Returns a consensus report with VERIFIED / INCONSISTENT / PARTIAL / NOT_FOUND verdict.',
  parameters: {
    type: 'object',
    properties: {
      doi: { type: 'string', description: 'DOI to triangulate (e.g., 10.1145/276675.276685)' },
    },
    required: ['doi'],
  },
};

export const CITATION_PASSPORT_RECORD_TOOL: ToolSpec = {
  name: 'citation_passport_record',
  description: 'Triangulate a DOI and persist the result as a Citation Passport entry. Creates or updates the passport and returns the verdict plus triangulation history count.',
  parameters: {
    type: 'object',
    properties: {
      doi: { type: 'string', description: 'DOI to triangulate and record (e.g., 10.1145/276675.276685)' },
    },
    required: ['doi'],
  },
};

export const CITATION_PASSPORT_GET_TOOL: ToolSpec = {
  name: 'citation_passport_get',
  description: 'Retrieve the persisted Citation Passport for a DOI.',
  parameters: {
    type: 'object',
    properties: {
      doi: { type: 'string', description: 'DOI to look up' },
    },
    required: ['doi'],
  },
};

export const CITATION_PASSPORT_LIST_TOOL: ToolSpec = {
  name: 'citation_passport_list',
  description: 'List all recorded Citation Passports, optionally filtered by overall verdict.',
  parameters: {
    type: 'object',
    properties: {
      overall: { type: 'string', enum: ['VERIFIED', 'INCONSISTENT', 'PARTIAL', 'NOT_FOUND'], description: 'Filter by verdict (optional)' },
    },
  },
};

export const CITATION_PASSPORT_ADD_SIGNAL_TOOL: ToolSpec = {
  name: 'citation_passport_add_signal',
  description: 'Add a contamination signal (retraction, expression of concern, journal blacklist, etc.) to a Citation Passport.',
  parameters: {
    type: 'object',
    properties: {
      doi: { type: 'string', description: 'DOI of the passport' },
      source: { type: 'string', description: 'Source of the signal (e.g., retractionwatch, crossref)' },
      type: { type: 'string', enum: ['retraction', 'expression_of_concern', 'journal_blacklist', 'predatory_journal', 'data_fabrication', 'other'], description: 'Type of contamination signal' },
      details: { type: 'string', description: 'Human-readable details (optional)' },
      url: { type: 'string', description: 'URL to the signal source (optional)' },
    },
    required: ['doi', 'source', 'type'],
  },
};

export const CITATION_PASSPORT_SCAN_TOOL: ToolSpec = {
  name: 'citation_passport_scan',
  description: 'Automatically scan a DOI (or all recorded Citation Passports) for contamination signals such as retractions, expressions of concern, or predatory journals. Returns discovered signals and records them into passports.',
  parameters: {
    type: 'object',
    properties: {
      doi: { type: 'string', description: 'DOI to scan (optional; if omitted, scans all passports)' },
    },
  },
};

export const RETRACTION_WATCH_UPDATE_TOOL: ToolSpec = {
  name: 'retraction_watch_update',
  description: 'Download the latest Retraction Watch CSV from Crossref Labs and build a local DOI-indexed mirror for fast offline contamination lookups.',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export const RETRACTION_WATCH_LOOKUP_TOOL: ToolSpec = {
  name: 'retraction_watch_lookup',
  description: 'Look up a DOI in the local Retraction Watch mirror. Returns retraction / expression-of-concern / correction records with reason metadata.',
  parameters: {
    type: 'object',
    properties: {
      doi: { type: 'string', description: 'DOI to look up' },
    },
    required: ['doi'],
  },
};

export const RETRACTION_WATCH_STATS_TOOL: ToolSpec = {
  name: 'retraction_watch_stats',
  description: 'Show statistics for the local Retraction Watch mirror (entry count, unique DOI count, last update time).',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export const JOURNAL_INTEGRITY_UPDATE_TOOL: ToolSpec = {
  name: 'journal_integrity_update',
  description: 'Download/update the DOAJ withdrawn-journals list and/or the Retraction Watch Hijacked Journal Checker local mirrors.',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['doaj_withdrawn', 'hijacked_journal', 'all'], description: 'Which mirror to update (default all)' },
    },
  },
};

export const JOURNAL_INTEGRITY_LOOKUP_TOOL: ToolSpec = {
  name: 'journal_integrity_lookup',
  description: 'Look up a journal title or ISSN in the local integrity mirrors (DOAJ withdrawn, hijacked journals).',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Journal title (optional)' },
      issn: { type: 'string', description: 'Journal ISSN (optional)' },
    },
  },
};

export const JOURNAL_INTEGRITY_STATS_TOOL: ToolSpec = {
  name: 'journal_integrity_stats',
  description: 'Show statistics for the local journal integrity mirrors.',
  parameters: {
    type: 'object',
    properties: {},
  },
};

// ─── All academic tools ───────────────────────────────────────

export const ACADEMIC_TOOL_SPECS: ToolSpec[] = [
  ARXIV_SEARCH_TOOL,
  ARXIV_IMPORT_TOOL,
  SEMANTIC_SCHOLAR_SEARCH_TOOL,
  IMPORT_BY_DOI_TOOL,
  CROSSREF_LOOKUP_TOOL,
  OPENALEX_LOOKUP_TOOL,
  RECOMMEND_PAPERS_TOOL,
  LITERATURE_REVIEW_TOOL,
  DAILY_PAPERS_TOOL,
  WEB_IMPORT_TOOL,
  FULLTEXT_SEARCH_TOOL,
  PARSE_BIBTEX_TOOL,
  BIBTEX_AUDIT_TOOL,
  LATEX_CLEANUP_TOOL,
  FIGURE_AUDIT_TOOL,
  TABLE_AUDIT_TOOL,
  LATEX_INTEGRITY_REPORT_TOOL,
  MATH_AUDIT_TOOL,
  SECTION_AUDIT_TOOL,
  SECTION_GUIDE_TOOL,
  FORMAT_CITATION_TOOL,
  READ_PDF_TOOL,
  WRITING_STAGE_CHECK_TOOL,
  STYLE_CALIBRATION_TOOL,
  SEARCH_LIBRARY_TOOL,
  FIND_LIBRARY_DUPLICATES_TOOL,
  DELETE_LIBRARY_DUPLICATES_TOOL,
  LIBRARY_STATS_TOOL,
  EXPORT_LIBRARY_TOOL,
  IMPORT_PAPERS_TOOL,
  EXPERIMENT_STATS_TOOL,
  EXPERIMENT_COMPARE_TOOL,
  EXPERIMENT_EXPORT_TOOL,
  COLLECTION_STATS_TOOL,
  NOTE_STATS_TOOL,
  TAGS_AUDIT_TOOL,
  TAGS_MERGE_TOOL,
  CITATION_NETWORK_TOOL,
  LITERATURE_TRIAGE_TOOL,
  REVIEW_SAVE_TOOL,
  REVIEW_LIST_TOOL,
  REVIEW_GET_TOOL,
  RESEARCH_STATE_TOOL,
  RESEARCH_SUMMARY_TOOL,
  INTEREST_PROFILE_TOOL,
  RANK_CANDIDATES_TOOL,
  FIGURE_REFERENCE_CHECK_TOOL,
  WORKSPACE_INIT_TOOL,
  WORKSPACE_STATUS_TOOL,
  FINDINGS_ADD_TOOL,
  FINDINGS_LIST_TOOL,
  FINDINGS_EXPORT_TOOL,
  EXPERIMENT_TO_FINDINGS_TOOL,
  CLAIM_TO_FINDINGS_TOOL,
  RUN_EXPERIMENT_SCRIPT_TOOL,
  CITATION_TRIANGULATE_TOOL,
  CITATION_PASSPORT_RECORD_TOOL,
  CITATION_PASSPORT_GET_TOOL,
  CITATION_PASSPORT_LIST_TOOL,
  CITATION_PASSPORT_ADD_SIGNAL_TOOL,
  CITATION_PASSPORT_SCAN_TOOL,
  RETRACTION_WATCH_UPDATE_TOOL,
  RETRACTION_WATCH_LOOKUP_TOOL,
  RETRACTION_WATCH_STATS_TOOL,
  JOURNAL_INTEGRITY_UPDATE_TOOL,
  JOURNAL_INTEGRITY_LOOKUP_TOOL,
  JOURNAL_INTEGRITY_STATS_TOOL,
];
