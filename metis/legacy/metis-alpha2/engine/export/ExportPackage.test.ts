/**
 * METIS-901 ~ 906 — Export, packaging config, updater, privacy tests.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeForExport, exportArtifact, resolveExportPath, latexAbsenceIsFatal,
  type ExportPlan, type PlatformRenderer,
} from './ArtifactExporter.js';
import {
  auditTransmission, maskSensitive,
  verifyAppUpdate, applyAppUpdate,
  type AppUpdateManifest,
} from './PrivacyBoundary.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── 901 Export ──
describe('METIS-901 export', () => {
  const plan: ExportPlan = {
    format: 'docx', title: '测试论文',
    sections: [{ heading: '引言', body: '正文内容', footnotes: ['脚注1'], citationRefs: ['s1'] }],
    citations: { s1: '作者，《标题》，2024。' },
    tableOfContents: true, chartRefs: [], cjkFont: 'Source Han Serif',
  };

  it('normalizeForExport produces TOC + body + citations + footnotes', () => {
    const out = normalizeForExport('docx', plan.title, plan.sections, plan.citations, { toc: true });
    expect(out).toContain('目录');
    expect(out).toContain('引言');
    expect(out).toContain('作者，《标题》，2024');
    expect(out).toContain('[^1]: 脚注1');
  });

  it('exportArtifact succeeds via injected renderer', async () => {
    const renderer: PlatformRenderer = { async render() { return { bytes: 1024, warnings: [] }; } };
    const r = await exportArtifact(plan, renderer);
    expect(r.success).toBe(true);
    expect(r.bytes).toBe(1024);
  });

  it('exportArtifact surfaces renderer errors (no silent failure)', async () => {
    const renderer: PlatformRenderer = { async render() { throw new Error('pdf engine missing'); } };
    const r = await exportArtifact({ ...plan, format: 'pdf' }, renderer);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/pdf engine missing/);
  });

  it('unresolved citations are marked (never silently dropped)', () => {
    const out = normalizeForExport('markdown', 'T', [{ heading: 'h', body: 'b', citationRefs: ['unknown'] }], {}, { toc: false });
    expect(out).toContain('（未解析）');
  });
});

// ── 902 LaTeX degradation ──
describe('METIS-902 LaTeX degradation', () => {
  it('core PDF export works WITHOUT TeX', () => {
    expect(resolveExportPath('missing').corePdfWorks).toBe(true);
  });
  it('LaTeX absence is never fatal to the app', () => {
    expect(latexAbsenceIsFatal('missing')).toBe(false);
  });
  it('when TeX present, LaTeX compile is available as a bonus', () => {
    expect(resolveExportPath('available').latexCompileAvailable).toBe(true);
  });
});

// ── 903/904 packaging config ──
describe('METIS-903/904 packaging config', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { build: { win?: { target: unknown[] }; nsis?: Record<string, unknown> }; main: string };

  it('main points at the compiled electron main (no dev-machine absolute path)', () => {
    expect(pkg.main).toBe('dist-electron/electron/main.js');
    expect(pkg.main.includes(':')).toBe(false); // no drive-letter absolute path
  });

  it('win target includes NSIS (EXE installer)', () => {
    const targets = pkg.build.win?.target as Array<{ target: string }> | undefined;
    expect(targets?.some((t) => t.target === 'nsis')).toBe(true);
  });

  it('win target includes MSI (METIS-904 deployable .msi)', () => {
    const targets = pkg.build.win?.target as Array<{ target: string }> | undefined;
    expect(targets?.some((t) => t.target === 'msi')).toBe(true);
  });

  it('NSIS allows install-dir change + per-user (non-destructive to other users)', () => {
    const nsis = pkg.build.nsis;
    expect(nsis?.allowToChangeInstallationDirectory).toBe(true);
    expect(nsis?.perMachine).toBe(false);
  });
});

// ── 905 App updater ──
describe('METIS-905 app updater', () => {
  const update: AppUpdateManifest = {
    version: '1.1.0', downloadUrl: 'https://official/metis-1.1.0.exe',
    sha256: 'abc', signature: 'valid:abc', minCompatibleProjectVersion: 1,
  };
  const goodSig = (_m: string, s: string) => s.startsWith('valid:');
  const badSig = () => false;

  it('verifyAppUpdate rejects a bad signature', () => {
    expect(verifyAppUpdate(update, badSig).ok).toBe(false);
  });
  it('applyAppUpdate rolls back on hash mismatch', async () => {
    let rolledBack = false;
    const r = await applyAppUpdate('1.0.0', update, {
      verifySha256: () => false,
      download: async () => ({ bytes: Buffer.from('x'), sha256: 'wrong' }),
      migrate: async () => ({ migrated: 0 }),
      rollback: async () => { rolledBack = true; },
    });
    expect(r.success).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(rolledBack).toBe(true);
  });
  it('applyAppUpdate succeeds + migrates projects on valid update', async () => {
    const r = await applyAppUpdate('1.0.0', update, {
      verifySha256: () => true,
      download: async () => ({ bytes: Buffer.from('x'), sha256: 'abc' }),
      migrate: async () => ({ migrated: 5 }),
      rollback: async () => {},
    });
    expect(r.success).toBe(true);
    expect(r.toVersion).toBe('1.1.0');
    expect(r.migratedProjects).toBe(5);
    void goodSig;
  });
});

// ── 906 Privacy boundary ──
describe('METIS-906 privacy boundary', () => {
  it('flags an API key leak in the payload (must NEVER be sent)', () => {
    const a = auditTransmission({ payload: { apiKey: 'sk-leaked' }, sensitiveFields: [] }, { activeProjectId: 'p1', userApprovedSensitive: false });
    expect(a.apiKeyLeaked).toBe(true);
    expect(a.approved).toBe(false);
  });
  it('flags unrelated-project content leak', () => {
    const a = auditTransmission({ payload: { note: 'projectId:pOther content' }, sensitiveFields: [] }, { activeProjectId: 'p1', userApprovedSensitive: false });
    expect(a.unrelatedProjectLeak).toBe(true);
    expect(a.approved).toBe(false);
  });
  it('flags sensitive fields unless user-approved', () => {
    const a1 = auditTransmission({ payload: { interview: '原始逐字稿' }, sensitiveFields: [] }, { activeProjectId: 'p1', userApprovedSensitive: false });
    expect(a1.sensitiveDetected).toContain('interview');
    expect(a1.approved).toBe(false);
    const a2 = auditTransmission({ payload: { interview: '脱敏后' }, sensitiveFields: ['interview'] }, { activeProjectId: 'p1', userApprovedSensitive: true });
    expect(a2.approved).toBe(true);
  });
  it('maskSensitive de-identifies a value', () => {
    expect(maskSensitive('张三丰', 1)).not.toBe('张三丰');
    expect(maskSensitive('张三丰', 1).length).toBeGreaterThan(0);
  });
});
