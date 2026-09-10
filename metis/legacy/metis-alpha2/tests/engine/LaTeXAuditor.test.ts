/**
 * Tests for LaTeXAuditor.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { auditLaTeX } from '../../engine/writing/LaTeXAuditor.js';

describe('auditLaTeX', () => {
  it('detects undefined references and unused labels', async () => {
    const tmpDir = path.join(os.tmpdir(), `metis-latex-audit-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'main.tex'),
      [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Intro}',
        '\\label{sec:intro}',
        'See \\ref{sec:missing}.',
        '\\end{document}',
      ].join('\n'),
      'utf-8',
    );

    const result = await auditLaTeX({ texDir: tmpDir });

    expect(result.issues.some((i) => i.type === 'undefined_reference' && i.message.includes('sec:missing'))).toBe(true);
    expect(result.issues.some((i) => i.type === 'unused_label' && i.message.includes('sec:intro'))).toBe(true);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('detects duplicate labels', async () => {
    const tmpDir = path.join(os.tmpdir(), `metis-latex-dup-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'a.tex'),
      '\\section{A}\\label{sec:shared}',
      'utf-8',
    );
    await fs.writeFile(
      path.join(tmpDir, 'b.tex'),
      '\\section{B}\\label{sec:shared}',
      'utf-8',
    );

    const result = await auditLaTeX({ texDir: tmpDir });
    expect(result.issues.some((i) => i.type === 'duplicate_label')).toBe(true);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('cross-checks citations against .bib file', async () => {
    const tmpDir = path.join(os.tmpdir(), `metis-latex-bib-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'main.tex'),
      '\\cite{known,unknown}',
      'utf-8',
    );
    await fs.writeFile(
      path.join(tmpDir, 'refs.bib'),
      '@article{known, title = {Known}, author = {A}, year = {2020}}\n@article{unused, title = {Unused}, author = {B}, year = {2021}}',
      'utf-8',
    );

    const result = await auditLaTeX({ texDir: tmpDir, bibPath: path.join(tmpDir, 'refs.bib') });

    expect(result.issues.some((i) => i.type === 'undefined_citation' && i.message.includes('unknown'))).toBe(true);
    expect(result.issues.some((i) => i.type === 'unused_citation' && i.message.includes('unused'))).toBe(true);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('detects TODO comments and draft artifacts', async () => {
    const tmpDir = path.join(os.tmpdir(), `metis-latex-draft-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'main.tex'),
      [
        '\\documentclass{article}',
        '\\usepackage{draftwatermark}',
        '% TODO: write abstract',
        '\\begin{document}',
        '\\end{document}',
      ].join('\n'),
      'utf-8',
    );

    const result = await auditLaTeX({ texDir: tmpDir });

    expect(result.issues.some((i) => i.type === 'todo_comment')).toBe(true);
    expect(result.issues.some((i) => i.type === 'draft_artifact')).toBe(true);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('detects empty sections', async () => {
    const tmpDir = path.join(os.tmpdir(), `metis-latex-empty-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'main.tex'),
      [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Empty Section}',
        '\\section{Filled Section}',
        'Some text.',
        '\\end{document}',
      ].join('\n'),
      'utf-8',
    );

    const result = await auditLaTeX({ texDir: tmpDir });

    expect(result.issues.some((i) => i.type === 'empty_section' && i.message.includes('Empty Section'))).toBe(true);
    expect(result.issues.some((i) => i.type === 'empty_section' && i.message.includes('Filled Section'))).toBe(false);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('detects style issues', async () => {
    const tmpDir = path.join(os.tmpdir(), `metis-latex-style-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'main.tex'),
      'This is bad... and uses ~\\\\ newline.',
      'utf-8',
    );

    const result = await auditLaTeX({ texDir: tmpDir });

    expect(result.issues.filter((i) => i.type === 'style_issue').length).toBeGreaterThanOrEqual(1);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
