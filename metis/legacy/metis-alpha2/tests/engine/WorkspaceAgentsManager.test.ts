import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceAgentsManager,
  workspaceProjectDirectory,
} from '../../engine/memory/WorkspaceAgentsManager.js';
import { hashWorkspaceAgentsContent } from '../../engine/memory/WorkspaceAgentsHash.js';

let trustedBase: string;
let projectId: string;

beforeEach(() => {
  trustedBase = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-agents-mgr-'));
  projectId = 'test-project';
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(trustedBase, { recursive: true, force: true }); } catch { /* cleanup */ }
});

function newManager(base = trustedBase, proj = projectId) {
  return new WorkspaceAgentsManager(base, proj);
}

function projectDirectory(base = trustedBase, proj = projectId) {
  return workspaceProjectDirectory(base, proj);
}

function legacyProjectDirectory(base = trustedBase, proj = projectId) {
  return path.join(base, 'projects', proj);
}

function writeAndRead(content: string, expectedVersion: number, mgr = newManager()) {
  const r = mgr.write(content, expectedVersion);
  expect(r.success).toBe(true);
  return { result: r, view: mgr.read() };
}

// ── Helper: create valid meta + content at a given slot ────────
function seedSlot(slot: 0 | 1, content: string, version: number, base = trustedBase, proj = projectId) {
  const projDir = workspaceProjectDirectory(base, proj);
  fs.mkdirSync(projDir, { recursive: true });
  const contentPath = path.join(projDir, `AGENTS.${slot}.md`);
  const metaPath = path.join(projDir, `.agents.meta.${slot}.json`);
  const contentHash = hashWorkspaceAgentsContent(content);
  fs.writeFileSync(contentPath, content, 'utf-8');
  fs.writeFileSync(metaPath, JSON.stringify({ version, contentHash, updatedAt: Date.now() }), 'utf-8');
  return { contentPath, metaPath, contentHash };
}

describe('WorkspaceAgentsManager regression', () => {
  // ── Write / Read round-trip ──────────────────────────────────
  it('writes initial content at version 0', () => {
    const r = newManager().write('# hello', 0);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.version).toBe(1);
      expect(r.code).toBe('saved');
      expect(r.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('reads back written content', () => {
    const mgr = newManager();
    writeAndRead('# hello', 0, mgr);
    const view = mgr.read();
    expect(view.exists).toBe(true);
    expect(view.content).toBe('# hello');
    expect(view.version).toBe(1);
  });

  it('reads empty view when nothing written', () => {
    const view = newManager().read();
    expect(view.exists).toBe(false);
    expect(view.content).toBe('');
    expect(view.version).toBe(0);
  });

  it('reads a legacy AGENTS.md losslessly before the first migration save', () => {
    const projectDir = legacyProjectDirectory();
    fs.mkdirSync(projectDir, { recursive: true });
    const legacy = '# AGENTS.md\n\n保留旧项目的每一个字节。\n';
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), legacy, 'utf8');
    const view = newManager().read();
    expect(view).toMatchObject({ exists: true, content: legacy, version: 0 });
    expect(view.contentHash).toBe(hashWorkspaceAgentsContent(legacy));
  });

  it('migrates AGENTS.md to Metis.md with an immutable backup and receipt on save', () => {
    const legacyProjectDir = legacyProjectDirectory();
    fs.mkdirSync(legacyProjectDir, { recursive: true });
    const legacy = '# Legacy\n\nKeep this content.\n';
    const updated = '# Metis.md\n\nKeep this content.\n\nAdd a project rule.\n';
    fs.writeFileSync(path.join(legacyProjectDir, 'AGENTS.md'), legacy, 'utf8');
    const manager = newManager();
    const result = manager.write(updated, 0);
    expect(result).toMatchObject({ success: true, code: 'saved', version: 1 });
    const projectDir = manager.workspaceRoot;
    expect(fs.readFileSync(path.join(projectDir, 'Metis.md'), 'utf8')).toBe(updated);
    expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md.pre-metis-v1.bak'), 'utf8')).toBe(legacy);
    const receipt = JSON.parse(fs.readFileSync(path.join(projectDir, '.metis-rules-migration.v1.json'), 'utf8'));
    expect(receipt).toEqual({
      format: 'metis-rules-migration',
      version: 1,
      projectId,
      source: 'AGENTS.md',
      target: 'Metis.md',
      sourceSha256: hashWorkspaceAgentsContent(legacy),
    });
    expect(newManager().read()).toMatchObject({ content: updated, version: 1 });
  });

  it('fails closed when legacy AGENTS.md and canonical Metis.md disagree before migration', () => {
    const projectDir = legacyProjectDirectory();
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'AGENTS.md'), '# Legacy', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'Metis.md'), '# Canonical', 'utf8');
    const manager = newManager();
    expect(manager.read()).toMatchObject({ externalConflict: true, content: '# Canonical', version: 0 });
    expect(manager.write('# Never merge silently', 0)).toMatchObject({ success: false, code: 'external_conflict' });
  });

  it('updates the public Metis.md mirror on every successful CAS revision', () => {
    const manager = newManager();
    expect(manager.write('# v1', 0).success).toBe(true);
    expect(manager.write('# v2', 1).success).toBe(true);
    const projectDir = manager.workspaceRoot;
    expect(fs.readFileSync(path.join(projectDir, 'Metis.md'), 'utf8')).toBe('# v2');
    expect(manager.read()).toMatchObject({ content: '# v2', version: 2 });
  });

  it('rejects a forged migration receipt or mismatched legacy backup', () => {
    const legacyProjectDir = legacyProjectDirectory();
    fs.mkdirSync(legacyProjectDir, { recursive: true });
    fs.writeFileSync(path.join(legacyProjectDir, 'AGENTS.md'), '# Legacy', 'utf8');
    fs.writeFileSync(path.join(legacyProjectDir, 'AGENTS.md.pre-metis-v1.bak'), '# Forged backup', 'utf8');
    fs.writeFileSync(path.join(legacyProjectDir, '.metis-rules-migration.v1.json'), JSON.stringify({ verified: true }), 'utf8');
    const manager = newManager();
    expect(manager.write('# New', 0)).toMatchObject({ success: false, code: 'external_conflict' });
    const projectDir = manager.workspaceRoot;
    expect(fs.existsSync(path.join(projectDir, 'Metis.md'))).toBe(false);
    expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8')).toBe('# Legacy');
  });

  it('supports multiple sequential writes', () => {
    const mgr = newManager();
    mgr.write('# v1', 0);
    mgr.write('# v2', 1);
    mgr.write('# v3', 2);
    const view = mgr.read();
    expect(view.content).toBe('# v3');
    expect(view.version).toBe(3);
  });

  // ── CAS (Compare-And-Swap) ────────────────────────────────────
  it('CAS: rejects write with wrong expectedVersion', () => {
    const mgr = newManager();
    mgr.write('# v1', 0);
    const r = mgr.write('# v2', 999);
    expect(r.success).toBe(false);
    expect(r.code).toBe('cas_conflict');
  });

  it('CAS: accepts write with correct expectedVersion', () => {
    const mgr = newManager();
    mgr.write('# v1', 0);
    const r = mgr.write('# v2', 1);
    expect(r.success).toBe(true);
    expect(r.version).toBe(2);
  });

  it('CAS: rejects write after earlier rejection (no version drift)', () => {
    const mgr = newManager();
    mgr.write('# v1', 0);
    mgr.write('# v2', 1);
    const r = mgr.write('# v3', 1); // stale version
    expect(r.success).toBe(false);
    expect(r.code).toBe('cas_conflict');
  });

  // ── Content validation ────────────────────────────────────────
  it('rejects content exceeding 50000 chars', () => {
    const r = newManager().write('x'.repeat(50001), 0);
    expect(r.success).toBe(false);
    expect(r.code).toBe('content_invalid');
  });

  it('rejects content with control characters', () => {
    const r = newManager().write('bad' + String.fromCharCode(0) + 'content', 0);
    expect(r.success).toBe(false);
    expect(r.code).toBe('content_invalid');
  });

  it('accepts content at exactly 50000 chars', () => {
    const r = newManager().write('x'.repeat(50000), 0);
    expect(r.success).toBe(true);
  });

  // ── External conflict ─────────────────────────────────────────
  it('detects externalConflict when meta is missing but content exists', () => {
    const mgr = newManager();
    mgr.write('# content', 0);
    const slot = JSON.parse(fs.readFileSync(path.join(projectDirectory(), '.agents.ptr.json'), 'utf8')).slot;
    fs.unlinkSync(path.join(projectDirectory(), `.agents.meta.${slot}.json`));
    const view = newManager().read();
    expect(view.exists).toBe(true);
    expect(view.externalConflict).toBe(true);
  });

  it('detects externalConflict when content hash does not match meta', () => {
    const mgr = newManager();
    mgr.write('# original', 0);
    const slot = JSON.parse(fs.readFileSync(path.join(projectDirectory(), '.agents.ptr.json'), 'utf8')).slot;
    const contentPath = path.join(projectDirectory(), `AGENTS.${slot}.md`);
    fs.writeFileSync(contentPath, '# tampered', 'utf-8');
    const view = newManager().read();
    expect(view.externalConflict).toBe(true);
  });

  // ── Pointer recovery ──────────────────────────────────────────
  it('recovers from corrupt pointer by scanning both slots', () => {
    const mgr = newManager();
    mgr.write('# v1', 0);
    mgr.write('# v2', 1);
    fs.writeFileSync(path.join(projectDirectory(), '.agents.ptr.json'), 'garbage');
    const mgr2 = newManager();
    const view = mgr2.read();
    expect(view.exists).toBe(true);
    expect(view.version).toBe(2);
    expect(view.content).toBe('# v2');
  });

  it('recovers from missing pointer file', () => {
    const mgr = newManager();
    mgr.write('# content', 0);
    fs.unlinkSync(path.join(projectDirectory(), '.agents.ptr.json'));
    const view = newManager().read();
    expect(view.exists).toBe(true);
    expect(view.content).toBe('# content');
  });

  it('pointer recovery: picks slot with higher version when pointer is wrong', () => {
    const mgr = newManager();
    mgr.write('# v1', 0);
    mgr.write('# v2', 1);
    // Force pointer to old slot
    fs.writeFileSync(path.join(projectDirectory(), '.agents.ptr.json'), JSON.stringify({ slot: 0 }));
    const view = newManager().read();
    // Both slots valid but slot 1 has higher version → should pick higher
    expect(view.version).toBe(2);
  });

  // ── Stat / IO failure (spy) ────────────────────────────────────
  it('statSync failure on mtime/size cross-check returns externalConflict', () => {
    const mgr = newManager();
    mgr.write('# content', 0);
    const slot = JSON.parse(fs.readFileSync(path.join(projectDirectory(), '.agents.ptr.json'), 'utf8')).slot;
    const contentPath = path.join(projectDirectory(), `AGENTS.${slot}.md`);
    expect(fs.existsSync(contentPath)).toBe(true);
    // Spy statSync to throw (mtime/size cross-check path)
    const orig = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation((p: fs.PathLike, _options?: Parameters<typeof fs.statSync>[1]) => {
      if (String(p).includes(`AGENTS.${slot}.md`)) {
        throw new Error('Simulated disk error');
      }
      return orig(p, _options);
    });
    const view = newManager().read();
    expect(view.externalConflict).toBe(true);
    expect(view.exists).toBe(true);
  });

  it('lstatSync EACCES on content path → externalConflict, not empty', () => {
    const mgr = newManager();
    mgr.write('# content', 0);
    const slot = JSON.parse(fs.readFileSync(path.join(projectDirectory(), '.agents.ptr.json'), 'utf8')).slot;
    const contentPath = path.join(projectDirectory(), `AGENTS.${slot}.md`);
    expect(fs.existsSync(contentPath)).toBe(true);
    const orig = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((p: fs.PathLike, _options?: Parameters<typeof fs.statSync>[1]) => {
      if (String(p) === contentPath) {
        const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' as const });
        throw err;
      }
      return orig(p, _options);
    });
    const view = newManager().read();
    // Must not return empty — IO error is fail-closed
    expect(view.externalConflict).toBe(true);
    expect(view.exists).toBe(true);
  });

  it('lstatSync EACCES on meta path → externalConflict', () => {
    const mgr = newManager();
    mgr.write('# content', 0);
    const slot = JSON.parse(fs.readFileSync(path.join(projectDirectory(), '.agents.ptr.json'), 'utf8')).slot;
    const metaPath = path.join(projectDirectory(), `.agents.meta.${slot}.json`);
    expect(fs.existsSync(metaPath)).toBe(true);
    const orig = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((p: fs.PathLike, _options?: Parameters<typeof fs.statSync>[1]) => {
      if (String(p) === metaPath) {
        const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' as const });
        throw err;
      }
      return orig(p, _options);
    });
    const view = newManager().read();
    expect(view.externalConflict).toBe(true);
  });

  // ── Same version, different real hash on both slots ────────────
  it('both slots valid with same version different hash → externalConflict', () => {
    const projDir = projectDirectory();
    fs.mkdirSync(projDir, { recursive: true });
    const a = seedSlot(0, '# content A', 1);
    const b = seedSlot(1, '# content B', 1);
    expect(a.contentHash).not.toBe(b.contentHash);
    // Point to slot 0
    fs.writeFileSync(path.join(projDir, '.agents.ptr.json'), JSON.stringify({ slot: 0 }));
    const view = newManager().read();
    expect(view.exists).toBe(true);
    expect(view.externalConflict).toBe(true);
  });

  // ── Lock race: two managers same expectedVersion ───────────────
  it('two managers: only first commit succeeds with same expectedVersion', () => {
    const mgr1 = newManager();
    const mgr2 = newManager();
    mgr1.write('# initial', 0);
    const r1 = mgr1.write('# from mgr1', 1);
    const r2 = mgr2.write('# from mgr2', 1);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(false);
    expect(r2.code).toBe('cas_conflict');
  });

  // ── Junction/symlink rejection ────────────────────────────────
  it('rejects trustedBase that is a symlink', () => {
    if (process.platform === 'win32') {
      // Windows: use junction
      const target = path.join(trustedBase, 'real-target');
      fs.mkdirSync(target);
      const link = path.join(trustedBase, 'junction-link');
      fs.symlinkSync(target, link, 'junction');
      expect(() => new WorkspaceAgentsManager(link, 'any-proj')).toThrow(/junction|symlink|Trusted base/i);
    }
  });

  it('rejects ancestor segment that is a junction', () => {
    if (process.platform === 'win32') {
      const realBase = path.join(trustedBase, 'real');
      fs.mkdirSync(realBase);
      const junctionBase = path.join(trustedBase, 'link');
      fs.symlinkSync(realBase, junctionBase, 'junction');
      // junctionBase/projects/proj — ancestor is junctionBase which is a junction
      expect(() => new WorkspaceAgentsManager(junctionBase, 'proj')).toThrow(/junction|symlink|Trusted base/i);
    }
  });

  // ── Nonexistent base rejected (main must create canonical) ───
  it('trustedBase must exist and be canonical', () => {
    const nonexistent = path.join(trustedBase, 'nonexistent-root');
    if (fs.existsSync(nonexistent)) fs.rmdirSync(nonexistent);
    expect(() => new WorkspaceAgentsManager(nonexistent, 'proj')).toThrow(/Trusted base|invalid/i);
  });

  // ── Existing base with missing projects dir works ─────────────
  it('existing trustedBase with no projects dir lazily creates on write', () => {
    const mgr = newManager(); // trustedBase exists
    const r = mgr.write('# test', 0);
    expect(r.success).toBe(true);
  });

  // ── Symlink content/meta rejection ────────────────────────────
  it('rejects slot where lstat reports content as symlink', () => {
    const mgr = newManager();
    mgr.write('# content', 0);
    const slot = JSON.parse(fs.readFileSync(path.join(projectDirectory(), '.agents.ptr.json'), 'utf8')).slot;
    const contentPath = path.join(projectDirectory(), `AGENTS.${slot}.md`);
    // Spy lstatSync: return a Stats object with isSymbolicLink()=true for the content path
    const orig = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((p: fs.PathLike, _options?: Parameters<typeof fs.statSync>[1]) => {
      const s = orig(p, _options);
      if (String(p) === contentPath) {
        // Return a modified stat with isSymbolicLink → true
        return Object.create(s, {
          isSymbolicLink: { value: () => true },
          isFile: { value: () => false },
        });
      }
      return s;
    });
    const view = newManager().read();
    expect(view.externalConflict).toBe(true);
  });

  it('rejects slot where lstat reports meta as symlink', () => {
    const mgr = newManager();
    mgr.write('# content', 0);
    const slot = JSON.parse(fs.readFileSync(path.join(projectDirectory(), '.agents.ptr.json'), 'utf8')).slot;
    const metaPath = path.join(projectDirectory(), `.agents.meta.${slot}.json`);
    const orig = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((p: fs.PathLike, _options?: Parameters<typeof fs.statSync>[1]) => {
      const s = orig(p, _options);
      if (String(p) === metaPath) {
        return Object.create(s, {
          isSymbolicLink: { value: () => true },
        });
      }
      return s;
    });
    const view = newManager().read();
    expect(view.externalConflict).toBe(true);
  });

  // ── TOCTOU: junction swap after construction ──────────────────
  it('TOCTOU: write fails when projects dir replaced with junction after construction', () => {
    if (process.platform !== 'win32') return;
    const mgr = newManager();
    // First write succeeds — creates projects/project-id
    mgr.write('# initial', 0);
    const projDir = mgr.workspaceRoot;
    const outsideTarget = path.join(trustedBase, 'outside-target');
    fs.mkdirSync(outsideTarget);
    // Replace workspaceRoot with a junction pointing outside
    fs.rmSync(projDir, { recursive: true, force: true });
    fs.symlinkSync(outsideTarget, projDir, 'junction');
    // Write must fail — TOCTOU detection
    const r = mgr.write('# attack', 1);
    expect(r.success).toBe(false);
    expect(r.code).toBe('io_error');
    // No files or directories must have been created in the junction target
    // Pre-mkdir ancestor containment check must prevent even the project dir creation
    const outsideFiles = fs.readdirSync(outsideTarget);
    expect(outsideFiles.length).toBe(0);
    // The project directory must NOT exist under the junction target
    expect(fs.existsSync(path.join(outsideTarget, 'projects'))).toBe(false);
  });

  // ── Version overflow ──────────────────────────────────────────
  it('rejects write when version exceeds safe limit', () => {
    const mgr = newManager();
    mgr.write('# v1', 0);
    const slot = JSON.parse(fs.readFileSync(path.join(projectDirectory(), '.agents.ptr.json'), 'utf8')).slot;
    const metaPath = path.join(projectDirectory(), `.agents.meta.${slot}.json`);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.version = 9007199254740991; // MAX_SAFE_INTEGER
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    const r = newManager().write('# v2', 9007199254740991);
    expect(r.success).toBe(false);
    expect(r.code).toBe('io_error');
  });

  // ── Phase A/B durability: final-meta atomic write failure ─────
  it('final-meta write failure returns io_error, old slot intact', () => {
    const mgr = newManager();
    mgr.write('# initial', 0);
    const viewBefore = mgr.read();
    // Spy renameSync to fail only on the meta temp→target rename
    const origRename = fs.renameSync;
    let metaRenameCalled = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      const np = String(newPath);
      if (np.includes('.agents.meta.') && !metaRenameCalled) {
        metaRenameCalled = true;
        throw new Error('Simulated disk full');
      }
      return origRename(oldPath, newPath);
    });
    const r = mgr.write('# updated', 1);
    expect(r.success).toBe(false);
    expect(r.code).toBe('io_error');
    // Old slot must still be intact
    const viewAfter = newManager().read();
    expect(viewAfter.version).toBe(viewBefore.version);
    expect(viewAfter.content).toBe(viewBefore.content);
  });

  it('pointer commit failure removes the prepared higher generation and preserves Metis.md', () => {
    const manager = newManager();
    expect(manager.write('# committed', 0).success).toBe(true);
    const before = manager.read();
    const projectDir = manager.workspaceRoot;
    const originalRename = fs.renameSync;
    let failed = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((source: fs.PathLike, destination: fs.PathLike) => {
      if (!failed && String(destination).endsWith('.agents.ptr.json')) {
        failed = true;
        throw new Error('simulated pointer commit failure');
      }
      return originalRename(source, destination);
    });
    expect(manager.write('# uncommitted', 1)).toMatchObject({ success: false, code: 'io_error' });
    vi.restoreAllMocks();
    expect(newManager().read()).toMatchObject({
      content: before.content,
      version: before.version,
      contentHash: before.contentHash,
    });
    expect(fs.readFileSync(path.join(projectDir, 'Metis.md'), 'utf8')).toBe('# committed');
    const metas = [0, 1].map((slot) => path.join(projectDir, `.agents.meta.${slot}.json`))
      .filter((file) => fs.existsSync(file))
      .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number });
    expect(metas.every((meta) => meta.version <= before.version)).toBe(true);
  });

  it('Metis.md publish failure rolls back the prepared higher generation', () => {
    const manager = newManager();
    expect(manager.write('# committed', 0).success).toBe(true);
    const before = manager.read();
    const originalRename = fs.renameSync;
    let failed = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((source: fs.PathLike, destination: fs.PathLike) => {
      if (!failed && String(destination).endsWith(`${path.sep}Metis.md`)) {
        failed = true;
        throw new Error('simulated Metis.md publish failure');
      }
      return originalRename(source, destination);
    });
    expect(manager.write('# uncommitted', 1)).toMatchObject({ success: false, code: 'io_error' });
    vi.restoreAllMocks();
    expect(newManager().read()).toMatchObject({
      content: before.content,
      version: before.version,
      contentHash: before.contentHash,
    });
  });

  // ── TOCTOU: root swap between Phase A content and Phase B pointer ─
  it('pointer write fails when verifyWorkspaceRoot fails at pointer stage', () => {
    const mgr = newManager();
    mgr.write('# initial', 0);
    const viewBefore = mgr.read();

    // Count verifyWorkspaceRoot calls during write():
    //   1: acquireLock (dir exists path)
    //   2: read() TOCTOU check
    //   3: Phase A content write check
    //   4: Phase A meta write check  ← fail here
    // The meta write returns io_error BEFORE the pointer commit.
    // Content written to inactive slot has no valid meta → scanSlot
    // marks it 'invalid'. Old active slot stays intact.
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- private method spy
    const verifySpy = vi.spyOn(mgr as any, 'verifyWorkspaceRoot').mockImplementation(function(this: typeof mgr) {
      callCount++;
      return callCount < 4;
    });

    const r = mgr.write('# attack', 1);
    // Meta write blocked by verifyWorkspaceRoot → io_error (not external_conflict)
    expect(r.success).toBe(false);
    expect(r.code).toBe('io_error');

    verifySpy.mockRestore();

    // ── Prove no outside write: old slot must be completely intact ─
    const viewAfter = newManager().read();
    expect(viewAfter.exists).toBe(true);
    expect(viewAfter.version).toBe(viewBefore.version);
    expect(viewAfter.content).toBe(viewBefore.content);
    expect(viewAfter.contentHash).toBe(viewBefore.contentHash);
    // The inactive slot's orphaned content (no meta) must not leak
    expect(viewAfter.externalConflict).toBeUndefined();
  });

  // ── TOCTOU: root swap before content write in Phase A ────────
  it('content write fails when verifyWorkspaceRoot fails before Phase A content', () => {
    const mgr = newManager();
    mgr.write('# initial', 0);

    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- private method spy
    vi.spyOn(mgr as any, 'verifyWorkspaceRoot').mockImplementation(function(this: typeof mgr) {
      callCount++;
      // Call sequence for write():
      //   1: acquireLock() check (dir exists path)
      //   2: read() TOCTOU check
      //   3: Phase A content write check ← fail here
      return callCount !== 3;
    });

    const r = mgr.write('# attack', 1);
    expect(r.success).toBe(false);
    expect(r.code).toBe('io_error');
  });


  // ── Repo delete → re-authorization on each get/set ───────────
  it('read returns exists=false when workspaceRoot deleted after construction', () => {
    const mgr = newManager();
    mgr.write('# content', 0);
    expect(mgr.read().exists).toBe(true);
    // Delete the entire project directory
    fs.rmSync(mgr.workspaceRoot, { recursive: true, force: true });
    // After deletion, read() must not return stale cached content.
    // workspaceRoot no longer exists → verifyWorkspaceRoot short-circuits
    // and both slots scan absent → exists=false, version=0
    const view = mgr.read();
    expect(view.exists).toBe(false);
    expect(view.content).toBe('');
    expect(view.version).toBe(0);
  });

  it('read returns exists=false when project never created', () => {
    const mgr = newManager();
    try { fs.rmSync(mgr.workspaceRoot, { recursive: true, force: true }); } catch { /* ok */ }
    const view = mgr.read();
    expect(view.exists).toBe(false);
    expect(view.content).toBe('');
  });

  it('write after workspaceRoot deletion: acquireLock recreates dir, then CAS fails because version reset to 0', () => {
    const mgr = newManager();
    mgr.write('# initial', 0);
    expect(mgr.read().version).toBe(1);
    // Delete the project directory — version resets to 0
    fs.rmSync(mgr.workspaceRoot, { recursive: true, force: true });
    // Write with expectedVersion=1: acquireLock recreates the directory,
    // read() returns version=0, CAS check fails → cas_conflict
    const r = mgr.write('# attempt', 1);
    expect(r.success).toBe(false);
    expect(r.code).toBe('cas_conflict');
    // Verify expectedVersion was reset (stale cache evicted)
    if (r.code === 'cas_conflict') {
      expect(r.currentVersion).toBe(0);
    }
  });

  it('consecutive reads after deletion both return exists=false (no stale cache)', () => {
    const mgr = newManager();
    mgr.write('# content', 0);
    expect(mgr.read().exists).toBe(true);
    // Delete project directory
    fs.rmSync(mgr.workspaceRoot, { recursive: true, force: true });
    // Every get must re-validate — no stale cache
    const view1 = mgr.read();
    expect(view1.exists).toBe(false);
    const view2 = mgr.read();
    expect(view2.exists).toBe(false);
    // Set after deletion also re-validates (CAS conflict as version=0)
    const r = mgr.write('# fresh', 0);
    expect(r.success).toBe(true); // version=0 matches current, write succeeds on recreated dir
    expect(r.version).toBe(1);
  });
});
