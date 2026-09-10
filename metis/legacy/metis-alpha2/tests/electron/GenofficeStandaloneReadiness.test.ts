import { describe, expect, it } from 'vitest';
import { readinessExpressionFor } from '../../electron/genofficeStandaloneReadiness.js';
import { needsPdfStandaloneCompatibility } from '../../electron/genofficeStandaloneCompatibility.js';

describe('GenOffice standalone readiness expressions', () => {
  it('requires a named document editor for Word', () => {
    const expression = readinessExpressionFor('word', 'paper.docx');
    expect(expression).toContain('paper.docx');
    expect(expression).toContain('.editor-scroll .ProseMirror');
  });

  it('requires a rendered opened state for Slides and Sheets', () => {
    expect(readinessExpressionFor('ppt', 'deck.pptx')).toContain('.stage-wrap');
    expect(readinessExpressionFor('ppt', 'deck.pptx')).toContain('.slide-list');
    expect(readinessExpressionFor('spreadsheet', 'table.xlsx')).toContain('#univer-container');
    expect(readinessExpressionFor('spreadsheet', 'table.xlsx')).toContain('工作簿已完整加载');
  });

  it('requires rendered PDF pages for PDF', () => {
    expect(readinessExpressionFor('pdf', 'paper.pdf')).toContain('.pdf-page-content');
  });

  it('installs compatibility IPC only for the PDF standalone host', () => {
    expect(needsPdfStandaloneCompatibility('pdf')).toBe(true);
    expect(needsPdfStandaloneCompatibility('word')).toBe(false);
    expect(needsPdfStandaloneCompatibility('ppt')).toBe(false);
    expect(needsPdfStandaloneCompatibility('spreadsheet')).toBe(false);
  });
});
