import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import type { OutcomeDocument, OutcomeKind, OutcomeMedia, PdfDocument, SpreadsheetDocument, SpreadsheetWorkbook } from '../engine/runtime/OutcomeRuntimeContract.js';
import type { ExternalEditorKind } from './OutcomeExternalEditorService.js';

export type ExternalEditorOutcomeDescriptor = Readonly<{
  kind: ExternalEditorKind;
  fileName: string;
  mediaType: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' | 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
}>;

export function externalEditorKindForFile(filePath: string): ExternalEditorKind | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.docx') return 'word';
  if (extension === '.pptx') return 'ppt';
  if (extension === '.xlsx' || extension === '.xlsm') return 'spreadsheet';
  if (extension === '.pdf') return 'pdf';
  return undefined;
}

export function externalEditorKindForOutcome(kind: OutcomeKind): ExternalEditorKind | undefined {
  if (kind === 'word') return 'word';
  if (kind === 'ppt') return 'ppt';
  if (kind === 'spreadsheet') return 'spreadsheet';
  if (kind === 'pdf') return 'pdf';
  return undefined;
}

export function externalEditorDocumentKind(kind: ExternalEditorKind): OutcomeDocument['type'] {
  return kind === 'word' ? 'word' : kind === 'ppt' ? 'ppt' : kind;
}

export function externalEditorExtension(kind: ExternalEditorKind): string {
  return kind === 'word' ? '.docx' : kind === 'ppt' ? '.pptx' : kind === 'spreadsheet' ? '.xlsx' : '.pdf';
}

export function isExternalEditorDocumentBytes(kind: ExternalEditorKind, bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  if (kind === 'pdf') return bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
  return bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const asArray = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const asText = (value: unknown): string | undefined => typeof value === 'string' ? value : value && typeof value === 'object' && '#text' in value && typeof (value as { '#text'?: unknown })['#text'] === 'string' ? (value as { '#text': string })['#text'] : undefined;
// fast-xml-parser converts numeric tag text to JS numbers by default; dropping
// them here would silently turn every numeric cell into null.
const xmlScalar = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return asText(value);
};
const zipPath = (base: string, target: string): string => target.startsWith('/') ? target.slice(1) : path.posix.normalize(`${base}/${target}`);

/** Decompression budgets for untrusted XLSX packages (zip-bomb guard). */
export type XlsxBudgets = Readonly<{
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
  maxSharedStrings: number;
  /** Entries compressed below this size are exempt from the ratio check (tiny entries are noisy). */
  minCompressedBytesForRatio: number;
}>;

export const DEFAULT_XLSX_BUDGETS: XlsxBudgets = Object.freeze({
  maxEntries: 2_048,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxSharedStrings: 100_000,
  minCompressedBytesForRatio: 1024,
});

type JsZipEntrySizes = { uncompressedSize?: number; compressedSize?: number };

/** Refuses packages whose decompressed shape could exhaust main-process memory. */
function assertXlsxZipBudgets(zip: JSZip, budgets: XlsxBudgets): void {
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > budgets.maxEntries) throw new Error('spreadsheet_zip_entries_exceeded');
  let totalBytes = 0;
  for (const entry of entries) {
    const sizes = (entry as unknown as { _data?: JsZipEntrySizes })._data ?? {};
    const uncompressed = typeof sizes.uncompressedSize === 'number' ? sizes.uncompressedSize : 0;
    const compressed = typeof sizes.compressedSize === 'number' ? sizes.compressedSize : 0;
    if (uncompressed > budgets.maxEntryBytes) throw new Error('spreadsheet_zip_entry_too_large');
    if (compressed > budgets.minCompressedBytesForRatio && uncompressed / compressed > budgets.maxCompressionRatio) throw new Error('spreadsheet_zip_ratio_exceeded');
    totalBytes += uncompressed;
    if (totalBytes > budgets.maxTotalBytes) throw new Error('spreadsheet_zip_total_exceeded');
  }
}

/** Extracts the real workbook sheet order, formulas and stored cell values. */
export async function parseSpreadsheetWorkbook(bytes: Buffer, budgets: XlsxBudgets = DEFAULT_XLSX_BUDGETS): Promise<SpreadsheetWorkbook> {
  const zip = await JSZip.loadAsync(bytes);
  assertXlsxZipBudgets(zip, budgets);
  const readXml = async (name: string): Promise<Record<string, unknown> | undefined> => {
    const file = zip.file(name);
    if (!file) return undefined;
    try { return xmlParser.parse(await file.async('string')) as Record<string, unknown>; } catch { return undefined; }
  };
  const workbook = await readXml('xl/workbook.xml');
  const relationships = await readXml('xl/_rels/workbook.xml.rels');
  if (!workbook || !relationships) throw new Error('spreadsheet_workbook_missing');
  const workbookRoot = (workbook.workbook ?? {}) as Record<string, unknown>;
  const relRoot = (relationships.Relationships ?? {}) as Record<string, unknown>;
  const rels = new Map(asArray(relRoot.Relationship as Record<string, unknown> | Record<string, unknown>[]).map((item) => [String(item['@_Id'] ?? ''), String(item['@_Target'] ?? '')]));
  const sheetsRoot = (workbookRoot.sheets ?? {}) as Record<string, unknown>;
  const sheets = asArray(sheetsRoot.sheet as Record<string, unknown> | Record<string, unknown>[]);
  const sheetNames = sheets.map((sheet) => String(sheet['@_name'] ?? '')).filter(Boolean).slice(0, 500);
  const activeTabValue = ((workbookRoot.bookViews as Record<string, unknown> | undefined)?.workbookView as Record<string, unknown> | undefined)?.['@_activeTab'];
  const activeTab = typeof activeTabValue === 'string' || typeof activeTabValue === 'number' ? Number(activeTabValue) : 0;
  const activeSheet = sheetNames[Number.isInteger(activeTab) && activeTab >= 0 ? activeTab : 0] ?? sheetNames[0] ?? null;
  const sharedStringsXml = await readXml('xl/sharedStrings.xml');
  const sharedStringEntries = asArray(((sharedStringsXml?.sst ?? {}) as Record<string, unknown>).si as Record<string, unknown> | Record<string, unknown>[]);
  if (sharedStringEntries.length > budgets.maxSharedStrings) throw new Error('spreadsheet_shared_strings_exceeded');
  const sharedStrings = sharedStringEntries
    .map((entry) => asText((entry as Record<string, unknown>).t) ?? asArray((entry as Record<string, unknown>).r as Record<string, unknown> | Record<string, unknown>[]).map((run) => asText(run.t) ?? '').join(''));
  const cells: SpreadsheetWorkbook['cells'] = {};
  for (const sheet of sheets) {
    const name = String(sheet['@_name'] ?? '');
    const relationId = String(sheet['@_r:id'] ?? '');
    const target = rels.get(relationId);
    if (!name || !target) continue;
    const sheetXml = await readXml(zipPath('xl', target));
    const worksheet = (sheetXml?.worksheet ?? {}) as Record<string, unknown>;
    const sheetData = (worksheet.sheetData ?? {}) as Record<string, unknown>;
    for (const row of asArray(sheetData.row as Record<string, unknown> | Record<string, unknown>[])) {
      for (const cell of asArray(row.c as Record<string, unknown> | Record<string, unknown>[])) {
        if (Object.keys(cells).length >= 20_000) break;
        const address = String(cell['@_r'] ?? '');
        if (!address) continue;
        const type = typeof cell['@_t'] === 'string' ? cell['@_t'] : undefined;
        const formula = xmlScalar(cell.f);
        const rawValue = xmlScalar(cell.v) ?? xmlScalar((cell.is as Record<string, unknown> | undefined)?.t);
        const value = type === 's' && rawValue !== undefined
          ? sharedStrings[Number(rawValue)] ?? rawValue
          : type === 'b' && rawValue !== undefined
            ? rawValue === '1'
            : rawValue === undefined || rawValue === ''
              ? null
              : /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(rawValue) && Number.isFinite(Number(rawValue))
                ? Number(rawValue)
                : rawValue;
        cells[`${name}!${address}`] = { value, ...(formula ? { formula } : {}), ...(type ? { type } : {}) };
      }
    }
  }
  return { sheetNames, activeSheet, activeCell: null, cells };
}

/** Counts page objects from a valid PDF without pretending to understand page content. */
export function countPdfPages(bytes: Buffer): number | null {
  if (!isExternalEditorDocumentBytes('pdf', bytes)) return null;
  const count = (bytes.toString('latin1').match(/\/Type\s*\/Page\b/gu) ?? []).length;
  return count > 0 ? count : null;
}

/** Parse the actual PDF structure before allowing an external edit back into METIS. */
export async function validatePdfBytes(bytes: Buffer): Promise<number> {
  if (!isExternalEditorDocumentBytes('pdf', bytes)) throw new Error('pdf_signature_invalid');
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as {
      getDocument: (options: { data: Uint8Array; isEvalSupported: boolean; useSystemFonts: boolean }) => { promise: Promise<{ numPages: number; getPage: (pageNumber: number) => Promise<unknown> }> };
    };
    const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true }).promise;
    if (!Number.isInteger(document.numPages) || document.numPages <= 0 || document.numPages > 100_000) throw new Error('pdf_page_count_invalid');
    await document.getPage(1);
    return document.numPages;
  } catch {
    throw new Error('pdf_structure_invalid');
  }
}

export async function externalDocumentFromSavedBytes(kind: 'spreadsheet' | 'pdf', media: OutcomeMedia, bytes: Buffer): Promise<SpreadsheetDocument | PdfDocument> {
  if (kind === 'spreadsheet') return { type: 'spreadsheet', media, originalArchiveMediaId: media.id, workbook: await parseSpreadsheetWorkbook(bytes) };
  return { type: 'pdf', media, originalArchiveMediaId: media.id, pageCount: await validatePdfBytes(bytes), activePage: null };
}

export function externalEditorDescriptor(kind: ExternalEditorKind, fileName: string): ExternalEditorOutcomeDescriptor {
  return {
    kind,
    fileName,
    mediaType: kind === 'word'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : kind === 'ppt'
        ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        : kind === 'spreadsheet'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/pdf',
  };
}
