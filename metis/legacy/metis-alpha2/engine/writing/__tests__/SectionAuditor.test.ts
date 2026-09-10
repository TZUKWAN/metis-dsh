import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { auditSections } from '../SectionAuditor.js';

describe('SectionAuditor', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'section-audit-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTex(name: string, content: string) {
    await fs.writeFile(path.join(tmpDir, name), content, 'utf-8');
  }

  it('flags missing expected sections', async () => {
    await writeTex('main.tex', '\\section{Introduction}\nSome text.\n');
    const result = await auditSections(tmpDir);
    expect(result.issueCounts.missing_expected_section).toBeGreaterThan(0);
  });

  it('flags out-of-order sections', async () => {
    await writeTex(
      'main.tex',
      '\\begin{abstract}\n' + 'A '.repeat(100) +
        '\n\\end{abstract}\n' +
        '\\section{Results}\nText.\n' +
        '\\section{Methods}\nText.\n' +
        '\\section{Introduction}\nText.\n' +
        '\\section{Conclusion}\nText.\n',
    );
    const result = await auditSections(tmpDir);
    expect(result.issueCounts.section_out_of_order).toBeGreaterThan(0);
  });

  it('flags empty sections', async () => {
    await writeTex(
      'main.tex',
      '\\begin{abstract}\n' + 'A '.repeat(100) +
        '\n\\end{abstract}\n' +
        '\\section{Introduction}\n\\section{Methods}\nText.\n',
    );
    const result = await auditSections(tmpDir);
    expect(result.issueCounts.empty_section).toBeGreaterThan(0);
  });

  it('flags too many subsections', async () => {
    const subs = Array.from({ length: 8 }, (_, i) => `\\subsection{Part ${i}}\nText.`).join('\n');
    await writeTex(
      'main.tex',
      '\\begin{abstract}\n' + 'A '.repeat(100) +
        '\n\\end{abstract}\n' +
        '\\section{Introduction}\nText.\n' +
        '\\section{Methods}\n' + subs + '\n',
    );
    const result = await auditSections(tmpDir);
    expect(result.issueCounts.too_many_subsections).toBeGreaterThan(0);
  });

  it('flags deep nesting', async () => {
    await writeTex(
      'main.tex',
      '\\begin{abstract}\n' + 'A '.repeat(100) +
        '\n\\end{abstract}\n' +
        '\\section{Introduction}\n\\paragraph{Deep}\nText.\n',
    );
    const result = await auditSections(tmpDir);
    expect(result.issueCounts.too_deep_nesting).toBeGreaterThan(0);
  });

  it('flags short abstract', async () => {
    await writeTex('main.tex', '\\begin{abstract}\nShort.\n\\end{abstract}\n\\section{Introduction}\nText.\n');
    const result = await auditSections(tmpDir);
    expect(result.issueCounts.short_abstract).toBe(1);
  });

  it('flags missing abstract', async () => {
    await writeTex('main.tex', '\\section{Introduction}\nText.\n');
    const result = await auditSections(tmpDir);
    expect(result.issueCounts.missing_abstract).toBe(1);
  });
});
