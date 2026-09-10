/**
 * Unified Source Service (METIS-403).
 *
 * One interface for ALL material types a researcher handles: papers, books, PDFs, web pages,
 * archives, images, audio, structured data. Each type has a normalizer that maps its native
 * shape into the unified Source record (METIS-401), unifying metadata / file location /
 * text layer / page-or-timestamp / tags / external identifiers.
 *
 * "Reading, analysis, and writing no longer each maintain their own copy of materials"
 * (METIS-403 completion) — every consumer goes through this service.
 */

import type { Source, SourceKind, IdentifierType } from '../persistence/researchModel.js';

// ─── Normalized inputs per type ───────────────────────────────

export interface PaperInput {
  title: string;
  authors?: string[];
  year?: number | null;
  venue?: string;
  doi?: string;
  arxivId?: string;
  abstract?: string;
  pdfPath?: string;
  pdfUrl?: string;
  tags?: string[];
}
export interface BookInput {
  title: string;
  authors?: string[];
  year?: number | null;
  publisher?: string;
  isbn?: string;
  tags?: string[];
}
export interface PdfInput {
  filePath: string;
  title?: string;
  pageCount?: number;
  tags?: string[];
}
export interface WebInput {
  url: string;
  title?: string;
  accessedAt?: number;
  tags?: string[];
}
export interface ArchiveInput {
  filePath: string;
  title?: string;
  archiveType?: string; // e.g. '明清地方志', '民国报纸'
  tags?: string[];
}
export interface ImageInput {
  filePath: string;
  title?: string;
  caption?: string;
  tags?: string[];
}
export interface AudioInput {
  filePath: string;
  title?: string;
  durationSec?: number;
  transcriptPath?: string;
  tags?: string[];
}
export interface DataInput {
  filePath: string;
  title?: string;
  format?: string; // csv/json/xlsx/parquet
  rowCount?: number;
  tags?: string[];
}

export type SourceInput =
  | { kind: 'paper'; data: PaperInput }
  | { kind: 'book'; data: BookInput }
  | { kind: 'pdf'; data: PdfInput }
  | { kind: 'web'; data: WebInput }
  | { kind: 'archive'; data: ArchiveInput }
  | { kind: 'image'; data: ImageInput }
  | { kind: 'audio'; data: AudioInput }
  | { kind: 'data'; data: DataInput };

// ─── Identifier normalization ─────────────────────────────────

function normalizeDoi(doi?: string): string {
  return (doi ?? '').toLowerCase().replace(/^https?:\/\/doi\.org\//, '').replace(/^doi:\s*/, '').trim();
}
function normalizeArxiv(id?: string): string {
  return (id ?? '').toLowerCase().replace(/^arxiv:\s*/, '').replace(/^https?:\/\/arxiv\.org\/abs\//, '').trim();
}
function normalizeIsbn(isbn?: string): string {
  return (isbn ?? '').replace(/[-\s]/g, '').toUpperCase();
}

// ─── Normalizers (per type → unified Source) ──────────────────

export interface NormalizeOptions {
  generateId?: (kind: SourceKind) => string;
  now?: () => number;
}

export function normalizeSource(projectId: string, input: SourceInput, opts: NormalizeOptions = {}): Source {
  const generateId = opts.generateId ?? ((kind) => `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const now = opts.now ?? (() => Date.now());
  const base = {
    id: generateId(input.kind),
    projectId,
    createdAt: now(),
    updatedAt: now(),
    deletedAt: null,
    authors: [] as string[],
    year: null as number | null,
    venue: '',
    identifier: '',
    identifierType: 'other' as IdentifierType,
    filePath: null as string | null,
    externalUrl: null as string | null,
    tags: [] as string[],
    metadata: {} as Record<string, unknown>,
    sourceVersionHash: null as string | null,
    provenance: {} as Record<string, unknown>,
  };

  switch (input.kind) {
    case 'paper': {
      const d = input.data;
      const doi = normalizeDoi(d.doi);
      const arxiv = normalizeArxiv(d.arxivId);
      const identifier = doi || arxiv || '';
      const identifierType: IdentifierType = doi ? 'doi' : arxiv ? 'arxiv' : 'other';
      return {
        ...base, kind: 'paper',
        title: d.title,
        authors: d.authors ?? [],
        year: d.year ?? null,
        venue: d.venue ?? '',
        identifier, identifierType,
        filePath: d.pdfPath ?? null,
        externalUrl: d.pdfUrl ?? null,
        tags: d.tags ?? [],
        metadata: { abstract: d.abstract ?? '', ...(doi ? { doi } : {}), ...(arxiv ? { arxivId: arxiv } : {}) },
        provenance: { origin: 'search-or-import' },
      };
    }
    case 'book': {
      const d = input.data;
      const isbn = normalizeIsbn(d.isbn);
      return {
        ...base, kind: 'book',
        title: d.title,
        authors: d.authors ?? [],
        year: d.year ?? null,
        venue: d.publisher ?? '',
        identifier: isbn,
        identifierType: isbn ? 'isbn' : 'other',
        tags: d.tags ?? [],
        metadata: { publisher: d.publisher ?? '' },
        provenance: { origin: 'manual' },
      };
    }
    case 'pdf': {
      const d = input.data;
      return {
        ...base, kind: 'pdf',
        title: d.title ?? d.filePath.split(/[\\/]/).pop() ?? 'PDF',
        filePath: d.filePath,
        tags: d.tags ?? [],
        metadata: { pageCount: d.pageCount ?? null },
        provenance: { origin: 'local-file' },
      };
    }
    case 'web': {
      const d = input.data;
      return {
        ...base, kind: 'web',
        title: d.title ?? d.url,
        identifier: d.url,
        identifierType: 'url',
        externalUrl: d.url,
        tags: d.tags ?? [],
        metadata: { accessedAt: d.accessedAt ?? now() },
        provenance: { origin: 'web' },
      };
    }
    case 'archive': {
      const d = input.data;
      return {
        ...base, kind: 'archive',
        title: d.title ?? d.filePath.split(/[\\/]/).pop() ?? '档案',
        filePath: d.filePath,
        tags: d.tags ?? [],
        metadata: { archiveType: d.archiveType ?? '' },
        provenance: { origin: 'local-file' },
      };
    }
    case 'image': {
      const d = input.data;
      return {
        ...base, kind: 'image',
        title: d.title ?? d.filePath.split(/[\\/]/).pop() ?? '图片',
        filePath: d.filePath,
        tags: d.tags ?? [],
        metadata: { caption: d.caption ?? '' },
        provenance: { origin: 'local-file' },
      };
    }
    case 'audio': {
      const d = input.data;
      return {
        ...base, kind: 'audio',
        title: d.title ?? d.filePath.split(/[\\/]/).pop() ?? '音频',
        filePath: d.filePath,
        tags: d.tags ?? [],
        metadata: { durationSec: d.durationSec ?? null, transcriptPath: d.transcriptPath ?? null },
        provenance: { origin: 'local-file' },
      };
    }
    case 'data': {
      const d = input.data;
      return {
        ...base, kind: 'data',
        title: d.title ?? d.filePath.split(/[\\/]/).pop() ?? '数据集',
        filePath: d.filePath,
        tags: d.tags ?? [],
        metadata: { format: d.format ?? '', rowCount: d.rowCount ?? null },
        provenance: { origin: 'local-file' },
      };
    }
    default: {
      // exhaustive; unreachable
      const _exhaustive: never = input;
      void _exhaustive;
      throw new Error(`Unknown source kind`);
    }
  }
}

// ─── Source service (CRUD over a backing store) ────────────────

/**
 * The store interface is intentionally minimal so it can be backed by PersistenceStore (SQL)
 * or an in-memory map for tests. Every consumer of research materials goes through this
 * service rather than touching papers/notes/experiments directly (METIS-403).
 */
export interface SourceStore {
  insert(source: Source): void;
  get(id: string): Source | undefined;
  listByProject(projectId: string): Source[];
  update(id: string, patch: Partial<Source>): void;
  softDelete(id: string, at: number): void;
}

export class SourceService {
  private readonly store: SourceStore;
  constructor(store: SourceStore) {
    this.store = store;
  }

  /** Register any material type as a unified Source. Returns the created Source. */
  register(projectId: string, input: SourceInput, opts?: NormalizeOptions): Source {
    const source = normalizeSource(projectId, input, opts);
    this.store.insert(source);
    return source;
  }

  get(id: string): Source | undefined {
    return this.store.get(id);
  }

  listByProject(projectId: string): Source[] {
    return this.store.listByProject(projectId);
  }

  /** Locate an existing source by external identifier (dedup before re-importing). */
  findByIdentifier(projectId: string, identifier: string): Source | undefined {
    if (!identifier) return undefined;
    return this.listByProject(projectId).find((s) => s.identifier === identifier && !s.deletedAt);
  }

  update(id: string, patch: Partial<Source>): void {
    this.store.update(id, { ...patch, updatedAt: Date.now() });
  }

  softDelete(id: string): void {
    this.store.softDelete(id, Date.now());
  }
}
