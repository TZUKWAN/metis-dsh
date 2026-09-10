/**
 * Tests for IntegrityReporter.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { getIntegrityReporter } from '../../engine/evidence/IntegrityReporter.js';
import type { ClaimManifestEntry } from '../../engine/manifest/ClaimManifest.js';
import type { ToolResult } from '../../engine/core/types.js';

function makeEntry(status: ClaimManifestEntry['status'], claim = 'Test claim'): ClaimManifestEntry {
  return {
    id: '1',
    claim,
    status,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('IntegrityReporter dimensions', () => {
  it('scores claim faithfulness as pass when most claims are verified', () => {
    const reporter = getIntegrityReporter();
    const entries = [
      makeEntry('verified'),
      makeEntry('verified'),
      makeEntry('single_index'),
    ];
    const report = reporter.generate({
      sessionId: 'test',
      claimManifestEntries: entries,
    });

    const dim = report.dimensions.find((d) => d.name === '声明忠实度');
    expect(dim).toBeDefined();
    expect(dim!.status).toBe('pass');
    expect(dim!.score).toBeGreaterThanOrEqual(0.6);
  });

  it('scores claim faithfulness as fail when contradicted claims dominate', () => {
    const reporter = getIntegrityReporter();
    const entries = [
      makeEntry('contradicted'),
      makeEntry('gap'),
      makeEntry('verified'),
    ];
    const report = reporter.generate({
      sessionId: 'test',
      claimManifestEntries: entries,
    });

    const dim = report.dimensions.find((d) => d.name === '声明忠实度');
    expect(dim!.status).toBe('fail');
  });

  it('warns when no claim manifest entries are provided', () => {
    const reporter = getIntegrityReporter();
    const report = reporter.generate({ sessionId: 'test' });

    const dim = report.dimensions.find((d) => d.name === '声明忠实度');
    expect(dim!.status).toBe('warn');
    expect(dim!.score).toBe(0.5);
  });

  it('includes claim manifest entries in raw output', () => {
    const reporter = getIntegrityReporter();
    const entries = [makeEntry('verified')];
    const report = reporter.generate({ sessionId: 'test', claimManifestEntries: entries });
    expect(report.raw.claimManifestEntries).toEqual(entries);
  });

  it('warns on writing quality when no writing audit tool results are provided', () => {
    const reporter = getIntegrityReporter();
    const report = reporter.generate({ sessionId: 'test' });
    const dim = report.dimensions.find((d) => d.name === '写作/格式质量');
    expect(dim).toBeDefined();
    expect(dim!.status).toBe('warn');
    expect(dim!.score).toBe(0.5);
  });

  it('passes writing quality when all writing audits report zero issues', () => {
    const reporter = getIntegrityReporter();
    const toolResults: ToolResult[] = [
      makeWritingToolResult('latex_integrity_report', 'Total issues: 0\nSeverity — critical: 0, high: 0, medium: 0, low: 0'),
      makeWritingToolResult('section_audit', 'Total issues: 0\nSections found: 6'),
    ];
    const report = reporter.generate({ sessionId: 'test', toolResults });
    const dim = report.dimensions.find((d) => d.name === '写作/格式质量');
    expect(dim!.status).toBe('pass');
    expect(dim!.score).toBeGreaterThanOrEqual(0.8);
  });

  it('fails writing quality when critical issues are present', () => {
    const reporter = getIntegrityReporter();
    const toolResults: ToolResult[] = [
      makeWritingToolResult('latex_integrity_report', 'Total issues: 5\nSeverity — critical: 1, high: 0, medium: 2, low: 2'),
    ];
    const report = reporter.generate({ sessionId: 'test', toolResults });
    const dim = report.dimensions.find((d) => d.name === '写作/格式质量');
    expect(dim!.status).toBe('fail');
    expect(dim!.score).toBeLessThan(0.5);
  });

  it('warns writing quality for moderate issue counts', () => {
    const reporter = getIntegrityReporter();
    const toolResults: ToolResult[] = [
      makeWritingToolResult('table_audit', 'Total issues: 7'),
      makeWritingToolResult('figure_audit', 'Total issues: 3'),
    ];
    const report = reporter.generate({ sessionId: 'test', toolResults });
    const dim = report.dimensions.find((d) => d.name === '写作/格式质量');
    expect(dim!.status).toBe('warn');
  });
});

function makeWritingToolResult(toolName: string, content: string): ToolResult {
  return {
    toolName,
    content,
    status: 'ok',
    toolCallId: '',
    metadata: {},
  };
}

describe('generateIntegrityReport tool path', () => {
  let originalDataDir: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    originalDataDir = process.env.METIS_DATA_DIR;
    tempDir = path.join(os.tmpdir(), `metis-integrity-test-${Date.now()}`);
    process.env.METIS_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    if (originalDataDir !== undefined) {
      process.env.METIS_DATA_DIR = originalDataDir;
    } else {
      delete process.env.METIS_DATA_DIR;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('integrity_report handler includes claim faithfulness dimension', async () => {
    const { addClaim } = await import('../../engine/manifest/ClaimManifest.js');
    await addClaim({ claim: 'A causes B.', status: 'verified' });

    const { integrityReportHandler } = await import('../../engine/tools/builtin/evidence-tools.js');
    const result = await integrityReportHandler({ text: 'A causes B according to prior work.' });

    expect(result).toContain('声明忠实度');
    expect(result).toContain('综合评分');
  }, 10000);

  it('integrity_report handler includes writing quality dimension when texDir is provided', async () => {
    const texDir = path.join(tempDir, 'paper');
    await fs.mkdir(texDir, { recursive: true });
    const abstract = Array.from({ length: 120 }, () => 'word').join(' ');
    await fs.writeFile(
      path.join(texDir, 'main.tex'),
      `\\begin{abstract}\n${abstract}\n\\end{abstract}\n\\section{Introduction}\nSome text.\n`,
    );

    const { integrityReportHandler } = await import('../../engine/tools/builtin/evidence-tools.js');
    const result = await integrityReportHandler({
      text: 'This draft uses LaTeX.',
      texDir,
    });

    expect(result).toContain('写作/格式质量');
    expect(result).toContain('综合评分');
  }, 10000);
});
