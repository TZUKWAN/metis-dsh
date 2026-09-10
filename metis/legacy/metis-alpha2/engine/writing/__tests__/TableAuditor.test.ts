import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { auditTables, type TableAuditResult } from '../TableAuditor.js';

function issueTypes(result: TableAuditResult, type: string): string[] {
  return result.tables.flatMap((t) => t.issues).filter((i) => i.type === type).map((i) => i.message);
}

describe('TableAuditor', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'table-audit-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTex(name: string, content: string) {
    await fs.writeFile(path.join(tmpDir, name), content, 'utf-8');
  }

  it('detects missing caption and label in table environment', async () => {
    await writeTex(
      'main.tex',
      '\\begin{table}\n\\centering\n\\begin{tabular}{ll}\n\\toprule\nA & B \\\\\n\\bottomrule\n\\end{tabular}\n\\end{table}\n',
    );
    const result = await auditTables(tmpDir);
    expect(issueTypes(result, 'missing_caption').length).toBe(1);
    expect(issueTypes(result, 'missing_label').length).toBe(1);
  });

  it('flags vertical rules in column spec', async () => {
    await writeTex(
      'main.tex',
      '\\begin{table}\n\\caption{C}\\label{tab:c}\n\\begin{tabular}{|l|r|}\n\\hline\na & b \\\\\n\\hline\n\\end{tabular}\n\\end{table}\n',
    );
    const result = await auditTables(tmpDir);
    expect(issueTypes(result, 'vertical_rules').length).toBe(1);
  });

  it('flags hline-only tables without booktabs rules', async () => {
    await writeTex(
      'main.tex',
      '\\begin{table}\n\\caption{C}\\label{tab:c}\n\\begin{tabular}{ll}\n\\hline\nA & B \\\\\n\\hline\n\\end{tabular}\n\\end{table}\n',
    );
    const result = await auditTables(tmpDir);
    expect(issueTypes(result, 'no_booktabs').length).toBe(1);
  });

  it('suggests siunitx S column for numeric data', async () => {
    await writeTex(
      'main.tex',
      '\\begin{table}\n\\caption{Results}\\label{tab:res}\n\\begin{tabular}{lr}\n\\toprule\nMetric & Value \\\\\n\\midrule\nAcc & 0.95 \\\\\nF1 & 0.88 \\\\\n\\bottomrule\n\\end{tabular}\n\\end{table}\n',
    );
    const result = await auditTables(tmpDir);
    expect(issueTypes(result, 'numeric_misaligned').length).toBe(1);
  });

  it('detects empty cells', async () => {
    await writeTex(
      'main.tex',
      '\\begin{table}\n\\caption{C}\\label{tab:c}\n\\begin{tabular}{ll}\n\\toprule\nA &  \\\\\n\\bottomrule\n\\end{tabular}\n\\end{table}\n',
    );
    const result = await auditTables(tmpDir);
    expect(issueTypes(result, 'empty_cells').length).toBe(1);
  });

  it('flags overly wide tables', async () => {
    const cols = 'l'.repeat(10);
    const header = Array.from({ length: 10 }, (_, i) => `C${i}`).join(' & ');
    await writeTex(
      'main.tex',
      `\\begin{table}\n\\caption{Wide}\\label{tab:wide}\n\\begin{tabular}{${cols}}\n\\toprule\n${header} \\\\\n\\bottomrule\n\\end{tabular}\n\\end{table}\n`,
    );
    const result = await auditTables(tmpDir);
    expect(issueTypes(result, 'overly_wide_table').length).toBe(1);
  });

  it('detects duplicate tables by content', async () => {
    await writeTex(
      'main.tex',
      '\\begin{table}\n\\caption{A}\\label{tab:a}\n\\begin{tabular}{l}\n\\toprule\nX \\\\\n\\bottomrule\n\\end{tabular}\n\\end{table}\n' +
        '\\begin{table}\n\\caption{B}\\label{tab:b}\n\\begin{tabular}{l}\n\\toprule\nX \\\\\n\\bottomrule\n\\end{tabular}\n\\end{table}\n',
    );
    const result = await auditTables(tmpDir);
    expect(issueTypes(result, 'duplicate_table').length).toBe(1);
  });

  it('detects standalone tabular environments', async () => {
    await writeTex(
      'main.tex',
      'Some inline table: \\begin{tabular}{ll}\n\\toprule\nA & B \\\\\n\\bottomrule\n\\end{tabular}\n',
    );
    const result = await auditTables(tmpDir);
    expect(result.tables.length).toBe(1);
    expect(result.tables[0]?.environment).toBe('standalone_tabular');
  });
});
