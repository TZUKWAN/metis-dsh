import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runLaTeXIntegrityReport } from '../LaTeXIntegrityReporter.js';

function makePngBuffer(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 0;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = makeChunk('IHDR', ihdrData);
  const iend = makeChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, iend]);
}

function makeChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const chunk = Buffer.concat([typeBuf, data]);
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(0, 0);
  return Buffer.concat([lengthBuf, chunk, crcBuf]);
}

describe('LaTeXIntegrityReporter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'latex-integrity-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFile(name: string, content: string | Buffer) {
    await fs.writeFile(path.join(tmpDir, name), content);
  }

  it('aggregates latex, figure, and table issues', async () => {
    await writeFile(
      'main.tex',
      '\\section{Intro}\n\\cite{}\n\\ref{missing-label}\n\\begin{figure}\n\\includegraphics[width=5cm]{lowres.png}\n\\end{figure}\n' +
        '\\begin{table}\n\\begin{tabular}{|l|r|}\n\\hline\na & b \\\\\n\\hline\n\\end{tabular}\n\\end{table}\n',
    );
    await writeFile('lowres.png', makePngBuffer(50, 50));

    const report = await runLaTeXIntegrityReport({ texDir: tmpDir });
    expect(report.severity.total).toBeGreaterThan(0);
    expect(report.sections.latex.issues.length).toBeGreaterThan(0);
    expect(report.sections.figures.totalIssues).toBeGreaterThan(0);
    expect(report.sections.tables.totalIssues).toBeGreaterThan(0);
    expect(report.filesWithIssues.length).toBeGreaterThan(0);
    expect(report.recommendations.length).toBeGreaterThan(0);
  });

  it('includes optional bib audit', async () => {
    await writeFile('main.tex', '\\cite{smith2020}\n');
    await writeFile(
      'refs.bib',
      '@article{smith2020,\n  title={A paper},\n  author={Smith},\n  year={2020}\n}\n' +
        '@book{unused2020,\n  title={Unused},\n  author={Doe},\n  year={2020}\n}\n',
    );

    const report = await runLaTeXIntegrityReport({ texDir: tmpDir, bibPath: path.join(tmpDir, 'refs.bib') });
    expect(report.sections.bib).toBeDefined();
    expect(report.sections.bib!.summary.entryCount).toBe(2);
  });

  it('severity counts are consistent', async () => {
    await writeFile('main.tex', '\\ref{missing-label}\n');
    const report = await runLaTeXIntegrityReport({ texDir: tmpDir });
    expect(report.severity.total).toBe(report.severity.critical + report.severity.high + report.severity.medium + report.severity.low);
  });
});
