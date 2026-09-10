/**
 * Audio/Interview viewer + Corpus/Data-table viewer + Qualitative coding workspace
 * (METIS-702 / METIS-703 / METIS-704).
 *
 * 702: waveform navigation, transcript sync, speaker turns, timestamp anchors → evidence.
 * 703: virtualized large-corpus / structured-data table (10万行 不塞 DOM/上下文), filter/sort/sample/export.
 * 704: codebook, text coding, AI-suggested codes (strictly separated from human codes),
 *      accept/reject, coding history, inter-coder consistency.
 */

import type { AnchorSpec } from '../sources/EvidenceAnchor.js';
import type { NoteCodeAuthor } from '../persistence/researchModel.js';

// ─── METIS-702 Audio/Interview ────────────────────────────────

export interface TranscriptTurn {
  speakerId: string;
  speakerLabel: string;
  startSec: number;
  endSec: number;
  text: string;
  /** Marked sensitive (PII) — masked in exports (METIS-906). */
  sensitive?: boolean;
}

export interface AudioTranscript {
  sourceId: string;
  durationSec: number;
  turns: TranscriptTurn[];
}

/** Find the turn active at a given timestamp (for playback sync). */
export function turnAt(transcript: AudioTranscript, sec: number): TranscriptTurn | undefined {
  return transcript.turns.find((t) => sec >= t.startSec && sec <= t.endSec);
}

/** Build a timestamped evidence anchor from a turn or sub-range. */
export function audioAnchor(sourceId: string, startSec: number, endSec: number, snippet: string): { sourceId: string; anchor: AnchorSpec; snippet: string } {
  return {
    sourceId,
    anchor: { type: 'timestamp', timestamp: startSec, start: startSec, end: endSec },
    snippet,
  };
}

/** Jump target for "click evidence → seek audio to that time". */
export function seekTargetForEvidence(anchor: AnchorSpec): number {
  return anchor.timestamp ?? anchor.start ?? 0;
}

// ─── METIS-703 Corpus / Data-table ────────────────────────────

export interface DataTable {
  sourceId: string;
  columns: Array<{ name: string; type: 'string' | 'number' | 'date' | 'boolean' }>;
  rows: Record<string, unknown>[];
}

export interface DataTableView {
  /** Visible row slice (virtualized — never the whole 10万行). */
  rows: Record<string, unknown>[];
  totalRows: number;
  startIdx: number;
}

/** Compute the visible window for a scroll position (virtualization). */
export function dataTableWindow(table: DataTable, scrollTop: number, viewportHeight: number, rowHeight: number): DataTableView {
  const startIdx = Math.max(0, Math.floor(scrollTop / rowHeight));
  const count = Math.ceil(viewportHeight / rowHeight) + 5;
  const endIdx = Math.min(table.rows.length, startIdx + count);
  return { rows: table.rows.slice(startIdx, endIdx), totalRows: table.rows.length, startIdx };
}

/** Filter + sort without mutating the source; returns a new array. */
export function filterAndSort(table: DataTable, opts: { column?: string; query?: string; sortColumn?: string; sortDir?: 'asc' | 'desc' }): Record<string, unknown>[] {
  let rows = table.rows;
  const q = opts.query?.trim().toLowerCase();
  if (q && opts.column) {
    rows = rows.filter((r) => String(r[opts.column!] ?? '').toLowerCase().includes(q));
  } else if (q) {
    rows = rows.filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(q)));
  }
  if (opts.sortColumn) {
    const col = opts.sortColumn;
    const dir = opts.sortDir === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const av = a[col]; const bv = b[col];
      if (av === bv) return 0;
      return av === undefined || av === null ? 1 : bv === undefined || bv === null ? -1 : av > bv ? dir : -dir;
    });
  }
  return rows;
}

/** Sample N rows for preview (never load all into model context). */
export function sampleRows(table: DataTable, n: number): Record<string, unknown>[] {
  if (table.rows.length <= n) return table.rows;
  const step = Math.floor(table.rows.length / n);
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < table.rows.length && out.length < n; i += step) out.push(table.rows[i]!);
  return out;
}

// ─── METIS-704 Qualitative coding workspace ───────────────────

export interface CodebookEntry {
  code: string;
  definition: string;
  color?: string;
}

export interface CodingInstance {
  id: string;
  code: string;
  author: NoteCodeAuthor;       // human | ai — STRICTLY separated
  evidenceId: string | null;
  textSpan: string;
  confidence: number;           // AI suggestions carry this
  accepted: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
}

export interface QualitativeCodingState {
  codebook: CodebookEntry[];
  codings: CodingInstance[];
}

/** Add an AI-suggested code — always starts as 'pending', never auto-accepted. */
export function addAiSuggestedCode(state: QualitativeCodingState, coding: Omit<CodingInstance, 'author' | 'accepted'>): QualitativeCodingState {
  const instance: CodingInstance = { ...coding, author: 'ai', accepted: 'pending' };
  return { ...state, codings: [...state.codings, instance] };
}

/** Add a human code — accepted by default (the human did it themselves). */
export function addHumanCode(state: QualitativeCodingState, coding: Omit<CodingInstance, 'author' | 'accepted'>): QualitativeCodingState {
  const instance: CodingInstance = { ...coding, author: 'human', accepted: 'accepted' };
  return { ...state, codings: [...state.codings, instance] };
}

/** Human reviews an AI suggestion: accept or reject (METIS-704: strictly separated). */
export function reviewAiCode(state: QualitativeCodingState, codingId: string, decision: 'accepted' | 'rejected'): QualitativeCodingState {
  return {
    ...state,
    codings: state.codings.map((c) => c.id === codingId && c.author === 'ai' ? { ...c, accepted: decision } : c),
  };
}

/** Inter-coder consistency: for codes applied by multiple authors to the same span, agreement %. */
export function interCoderAgreement(state: QualitativeCodingState): { total: number; agreed: number; rate: number } {
  const bySpan = new Map<string, Set<string>>();
  for (const c of state.codings) {
    if (c.accepted !== 'accepted') continue;
    const key = c.textSpan;
    const set = bySpan.get(key) ?? new Set<string>();
    set.add(c.code);
    bySpan.set(key, set);
  }
  let agreed = 0;
  for (const codes of bySpan.values()) {
    if (codes.size === 1) agreed++;
  }
  const total = bySpan.size;
  return { total, agreed, rate: total === 0 ? 0 : agreed / total };
}
