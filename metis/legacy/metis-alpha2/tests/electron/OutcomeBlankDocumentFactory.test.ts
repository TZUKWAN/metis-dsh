import { describe, expect, it } from 'vitest';
import { parseSpreadsheetWorkbook, validatePdfBytes } from '../../electron/OutcomeExternalEditorBridge.js';
import { createBlankPdfBytes, createBlankSpreadsheetBytes } from '../../electron/OutcomeBlankDocumentFactory.js';

describe('blank external documents', () => {
  it('creates a real parseable blank XLSX workbook', async () => {
    const workbook = await parseSpreadsheetWorkbook(await createBlankSpreadsheetBytes());
    expect(workbook.sheetNames).toEqual(['Sheet1']);
    expect(workbook.activeSheet).toBe('Sheet1');
  });

  it('creates a real parseable one-page blank PDF', async () => {
    expect(await validatePdfBytes(createBlankPdfBytes())).toBe(1);
  });
});
