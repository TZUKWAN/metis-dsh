/**
 * Tests for LaTeX log parser.
 */

import { describe, it, expect } from 'vitest';
import { parseLatexLog } from '../../engine/latex/LatexLogParser.js';

describe('LatexLogParser', () => {
  it('parses a pdflatex error with line number', () => {
    const log = `
! Undefined control sequence.
l.25 \\unknowncommand
    `;
    const result = parseLatexLog(log);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      line: 25,
      message: 'Undefined control sequence.',
      severity: 'error',
    });
  });

  it('parses LaTeX warnings', () => {
    const log = 'LaTeX Warning: Citation `missing\' on page 1 undefined.';
    const result = parseLatexLog(log);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      line: 0,
      message: 'Citation `missing\' on page 1 undefined.',
      severity: 'warning',
    });
  });

  it('returns an empty array for clean logs', () => {
    const result = parseLatexLog('This is a clean log with no issues.');
    expect(result).toHaveLength(0);
  });
});
