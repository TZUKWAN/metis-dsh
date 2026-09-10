import type { FileCapabilityDescriptor } from '../runtime/FileCapabilityContract.js';

export type ReadStatus = 'unread' | 'reading' | 'read' | 'skimmed';

/**
 * Shared paper record used by the renderer store and research engines.
 * Keeping this DOM-free prevents engine type checking from importing Zustand
 * state, browser globals, or the preload API surface.
 */
export interface PaperItem {
  id: string;
  title: string;
  authors: string[];
  year: number;
  venue: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  publicationType?: 'journal_article' | 'book' | 'chapter' | 'thesis' | 'report' | 'web';
  abstract: string;
  doi?: string;
  arxivId?: string;
  pdfCapability?: FileCapabilityDescriptor;
  pdfUrl?: string;
  url?: string;
  pdfText?: string;
  citationCount?: number;
  tags: string[];
  notes: string;
  readStatus: ReadStatus;
  readAt?: number;
  rating: number;
  starred?: boolean;
  referenceIds: string[];
  readingProgress?: number;
  readingTimeSeconds?: number;
  archived?: boolean;
  priority?: 'high' | 'medium' | 'low';
  deadline?: string;
  /** Legacy primary project pointer; use projectIds for complete membership. */
  projectId?: string;
  /** Every research project that currently reuses this library paper. */
  projectIds?: string[];
  addedAt: number;
}
