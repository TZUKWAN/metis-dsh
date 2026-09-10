import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { DEFAULT_XLSX_BUDGETS, externalEditorKindForFile, externalEditorKindForOutcome, externalEditorDocumentKind, isExternalEditorDocumentBytes, parseSpreadsheetWorkbook, validatePdfBytes } from '../../electron/OutcomeExternalEditorBridge.js';

async function buildWorkbookZip(parts: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(parts)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const WORKBOOK_XML = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
const WORKBOOK_RELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
const sheetXmlWith = (content: string) => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><extra>${content}</extra></worksheet>`;

describe('Outcome external editor bridge', () => {
  it('maps only supported native file extensions to editor kinds', () => {
    expect(externalEditorKindForFile('paper.docx')).toBe('word');
    expect(externalEditorKindForFile('deck.pptx')).toBe('ppt');
    expect(externalEditorKindForFile('table.xlsx')).toBe('spreadsheet');
    expect(externalEditorKindForFile('paper.pdf')).toBe('pdf');
    expect(externalEditorKindForFile('table.csv')).toBeUndefined();
    expect(externalEditorKindForFile('macro-book.xlsm')).toBe('spreadsheet');
  });

  it('maps only native outcome kinds to a GenOffice editor', () => {
    expect(externalEditorKindForOutcome('word')).toBe('word');
    expect(externalEditorKindForOutcome('ppt')).toBe('ppt');
    expect(externalEditorKindForOutcome('spreadsheet')).toBe('spreadsheet');
    expect(externalEditorKindForOutcome('pdf')).toBe('pdf');
    expect(externalEditorKindForOutcome('image')).toBeUndefined();
  });

  it('maps native editor kinds to the persisted outcome document discriminator', () => {
    expect(externalEditorDocumentKind('word')).toBe('word');
    expect(externalEditorDocumentKind('ppt')).toBe('ppt');
    expect(externalEditorDocumentKind('spreadsheet')).toBe('spreadsheet');
    expect(externalEditorDocumentKind('pdf')).toBe('pdf');
  });

  it('recognizes real PDF and OOXML signatures before launching an editor', () => {
    expect(isExternalEditorDocumentBytes('pdf', Buffer.from('%PDF-1.7'))).toBe(true);
    expect(isExternalEditorDocumentBytes('word', Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(isExternalEditorDocumentBytes('spreadsheet', Buffer.from('not-an-xlsx'))).toBe(false);
  });

  it('rejects a PDF that only has a forged header instead of a parseable page tree', async () => {
    await expect(validatePdfBytes(Buffer.from('%PDF-1.7\nnot-a-document'))).rejects.toThrow('pdf_structure_invalid');
  });

  it('parses a small valid workbook under the default budgets', async () => {
    const bytes = await buildWorkbookZip({
      'xl/workbook.xml': WORKBOOK_XML,
      'xl/_rels/workbook.xml.rels': WORKBOOK_RELS,
      'xl/worksheets/sheet1.xml': sheetXmlWith('ok'),
    });
    const workbook = await parseSpreadsheetWorkbook(bytes);
    expect(workbook.sheetNames).toEqual(['Sheet1']);
    expect(workbook.cells['Sheet1!A1']?.value).toBe(1);
  });

  it('rejects a workbook whose entry count exceeds the budget', async () => {
    const bytes = await buildWorkbookZip({
      'xl/workbook.xml': WORKBOOK_XML,
      'xl/_rels/workbook.xml.rels': WORKBOOK_RELS,
      'xl/worksheets/sheet1.xml': sheetXmlWith('ok'),
    });
    await expect(parseSpreadsheetWorkbook(bytes, { ...DEFAULT_XLSX_BUDGETS, maxEntries: 2 })).rejects.toThrow('spreadsheet_zip_entries_exceeded');
  });

  it('rejects a workbook whose single entry decompresses beyond the budget', async () => {
    const bytes = await buildWorkbookZip({
      'xl/workbook.xml': WORKBOOK_XML,
      'xl/_rels/workbook.xml.rels': WORKBOOK_RELS,
      'xl/worksheets/sheet1.xml': sheetXmlWith('x'.repeat(4096)),
    });
    await expect(parseSpreadsheetWorkbook(bytes, { ...DEFAULT_XLSX_BUDGETS, maxEntryBytes: 1024, maxCompressionRatio: 1000 })).rejects.toThrow('spreadsheet_zip_entry_too_large');
  });

  it('rejects a workbook whose compression ratio exceeds the budget', async () => {
    const bytes = await buildWorkbookZip({
      'xl/workbook.xml': WORKBOOK_XML,
      'xl/_rels/workbook.xml.rels': WORKBOOK_RELS,
      'xl/worksheets/sheet1.xml': sheetXmlWith('0'.repeat(8192)),
    });
    await expect(parseSpreadsheetWorkbook(bytes, { ...DEFAULT_XLSX_BUDGETS, maxCompressionRatio: 50, minCompressedBytesForRatio: 16 })).rejects.toThrow('spreadsheet_zip_ratio_exceeded');
  });

  it('rejects a workbook whose total decompressed size exceeds the budget', async () => {
    const bytes = await buildWorkbookZip({
      'xl/workbook.xml': WORKBOOK_XML,
      'xl/_rels/workbook.xml.rels': WORKBOOK_RELS,
      'xl/worksheets/sheet1.xml': sheetXmlWith('y'.repeat(2048)),
    });
    await expect(parseSpreadsheetWorkbook(bytes, { ...DEFAULT_XLSX_BUDGETS, maxEntryBytes: 8192, maxCompressionRatio: 1000, maxTotalBytes: 1024 })).rejects.toThrow('spreadsheet_zip_total_exceeded');
  });

  it('rejects a workbook whose shared strings exceed the budget', async () => {
    const sharedStrings = '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>a</t></si><si><t>b</t></si><si><t>c</t></si></sst>';
    const bytes = await buildWorkbookZip({
      'xl/workbook.xml': WORKBOOK_XML,
      'xl/_rels/workbook.xml.rels': WORKBOOK_RELS,
      'xl/worksheets/sheet1.xml': sheetXmlWith('ok'),
      'xl/sharedStrings.xml': sharedStrings,
    });
    await expect(parseSpreadsheetWorkbook(bytes, { ...DEFAULT_XLSX_BUDGETS, maxSharedStrings: 2 })).rejects.toThrow('spreadsheet_shared_strings_exceeded');
  });
});
