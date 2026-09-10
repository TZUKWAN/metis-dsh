/**
 * WorkspaceAgentsManager — Metis.md CAS-protected service with lossless legacy AGENTS.md migration.
 *
 * Atomic dual-slot architecture:
 *  - Two content slots: AGENTS.0.md / AGENTS.1.md
 *  - Two meta slots:    .agents.meta.0.json / .agents.meta.1.json
 *  - One pointer:       .agents.ptr.json → {slot: 0|1}
 *
 * Write always targets the INACTIVE slot; only the pointer rename is the
 * atomic commit. Any failure before pointer rename leaves the active slot
 * fully intact (complete old content + complete old etag). After pointer
 * rename, the new slot is active with complete new content + new etag.
 *
 * Crash at any point recovers to EITHER complete-old OR complete-new state.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  WorkspaceAgentsContentSchema,
  WORKSPACE_METIS_FILENAME,
  LEGACY_WORKSPACE_AGENTS_FILENAME,
  createWorkspaceAgentsFailure,
  createWorkspaceAgentsCASConflict,
  type WorkspaceAgentsView,
  type WorkspaceAgentsMutationResult,
} from '../runtime/WorkspaceAgentsContract.js';
import { hashWorkspaceAgentsContent } from './WorkspaceAgentsHash.js';

const MAX_ALLOWED_VERSION = Number.MAX_SAFE_INTEGER - 1;
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function workspaceProjectDirectoryName(projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error('Invalid projectId');
  return createHash('sha256').update(projectId, 'utf8').digest('hex');
}

export function workspaceProjectDirectory(trustedBase: string, projectId: string): string {
  return path.join(trustedBase, 'project-rules', workspaceProjectDirectoryName(projectId));
}

interface AgentsMeta {
  version: number;
  contentHash: string;
  updatedAt: number;
  contentMtimeMs?: number;
  contentSize?: number;
}

interface PtrFile {
  slot: 0 | 1;
}

interface SlotScanResult {
  slot: 0 | 1;
  status: 'valid' | 'invalid' | 'absent';
  content: string;
  version: number;
  contentHash: string;
}

export class WorkspaceAgentsManager {
  private readonly contentPaths: [string, string];
  private readonly metaPaths: [string, string];
  private readonly lockPath: string;
  private readonly ptrPath: string;
  private readonly canonicalRulesPath: string;
  private readonly legacyRulesPath: string;
  private readonly legacyBackupPath: string;
  private readonly migrationReceiptPath: string;
  /** Canonical realpath of trustedBase — used as a containment anchor for
   *  all pre-mkdir ancestor checks to prevent TOCTOU junction traversal. */
  private readonly canonicalTrustedBase: string;
  // WorkspaceRoot is computed in constructor and reserved for future containment checks
  readonly workspaceRoot: string;
  readonly projectId: string;

  /**
   * @param trustedBase  Trusted base directory (e.g., Electron userData)
   * @param projectId   Validated project identifier — directory is derived as
   *                     `<trustedBase>/project-rules/<sha256(projectId)>` to
   *                     isolate case-distinct IDs on Windows.
   */
  constructor(trustedBase: string, projectId: string) {
    if (!projectId || typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error('Invalid projectId');
    }
    this.projectId = projectId;
    // Reject if trustedBase itself is a symlink or junction
    try {
      const baseStat = fs.lstatSync(trustedBase);
      if (baseStat.isSymbolicLink() || this.isJunction(baseStat, trustedBase)) {
        throw new Error('Workspace root must not be a junction or symlink');
      }
      this.canonicalTrustedBase = fs.realpathSync(trustedBase);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Workspace root')) throw err;
      throw new Error(`Trusted base path invalid: ${String(err)}`, { cause: err });
    }
    const projectsRoot = path.join(trustedBase, 'projects');
    const dataDir = workspaceProjectDirectory(trustedBase, projectId);
    this.migrateLegacyProjectDirectory(projectsRoot, projectId, dataDir);

    let resolved: string;
    try {
      if (fs.existsSync(dataDir)) {
        resolved = fs.realpathSync(dataDir);
        const stat = fs.lstatSync(dataDir);
        if (stat.isSymbolicLink() || this.isJunction(stat, dataDir)) {
          throw new Error('Workspace root must not be a junction or symlink');
        }
      } else {
        let ancestor = dataDir;
        const missing: string[] = [];
        while (!fs.existsSync(ancestor)) {
          const parent = path.dirname(ancestor);
          if (parent === ancestor) break;
          missing.unshift(path.basename(ancestor));
          ancestor = parent;
        }
        // Ancestor itself must pass lstat + junction/symlink check —
        // realpathSync alone would resolve through a junction target,
        // silently bypassing the containment check.
        const ancestorStat = fs.lstatSync(ancestor);
        if (ancestorStat.isSymbolicLink() || this.isJunction(ancestorStat, ancestor)) {
          throw new Error('Workspace root must not be a junction or symlink');
        }
        resolved = path.join(fs.realpathSync(ancestor), ...missing);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('Workspace root')) throw err;
      // Path resolution failure → fail closed: do not fall back to raw path
      throw new Error(`Workspace root path resolution failed: ${String(err)}`, { cause: err });
    }
    this.workspaceRoot = resolved;

    // Keep the proven legacy slot names so existing projects migrate without
    // copying or rewriting trusted content. The public contract and UI expose
    // this document as Metis.md; these backend files are implementation detail.
    this.contentPaths = [
      path.join(resolved, 'AGENTS.0.md'),
      path.join(resolved, 'AGENTS.1.md'),
    ];
    this.metaPaths = [
      path.join(resolved, '.agents.meta.0.json'),
      path.join(resolved, '.agents.meta.1.json'),
    ];
    this.lockPath = path.join(resolved, '.agents.lock');
    this.ptrPath = path.join(resolved, '.agents.ptr.json');
    this.canonicalRulesPath = path.join(resolved, WORKSPACE_METIS_FILENAME);
    this.legacyRulesPath = path.join(resolved, LEGACY_WORKSPACE_AGENTS_FILENAME);
    this.legacyBackupPath = path.join(resolved, `${LEGACY_WORKSPACE_AGENTS_FILENAME}.pre-metis-v1.bak`);
    this.migrationReceiptPath = path.join(resolved, '.metis-rules-migration.v1.json');
  }

  /**
   * Older builds used the raw project ID as a Windows directory name.  Move an
   * exact-case legacy entry into its digest-derived namespace before use.  An
   * aliased spelling (case-only or trailing-dot) is never allowed to claim the
   * legacy directory, which prevents two SQLite project IDs from sharing one
   * filesystem rule surface on case-insensitive filesystems.
   */
  private migrateLegacyProjectDirectory(projectsRoot: string, projectId: string, dataDir: string): void {
    if (!fs.existsSync(projectsRoot)) return;
    try {
      const projectsStat = fs.lstatSync(projectsRoot);
      if (!projectsStat.isDirectory() || projectsStat.isSymbolicLink() || this.isJunction(projectsStat, projectsRoot)) {
        throw new Error('Workspace projects root must be a real directory');
      }
      const projectsReal = fs.realpathSync(projectsRoot);
      if (!projectsReal.startsWith(this.canonicalTrustedBase + path.sep)) {
        throw new Error('Workspace projects root escaped trusted base');
      }
      const exactLegacy = fs.readdirSync(projectsRoot, { withFileTypes: true })
        .find((entry) => entry.name === projectId);
      if (!exactLegacy) return;
      const legacyDir = path.join(projectsRoot, exactLegacy.name);
      if (fs.existsSync(dataDir)) throw new Error('Legacy and canonical project rule directories both exist');
      const legacyStat = fs.lstatSync(legacyDir);
      if (!exactLegacy.isDirectory() || legacyStat.isSymbolicLink() || this.isJunction(legacyStat, legacyDir)) {
        throw new Error('Legacy project rule directory is unsafe');
      }
      const legacyReal = fs.realpathSync(legacyDir);
      if (!legacyReal.startsWith(this.canonicalTrustedBase + path.sep)) {
        throw new Error('Legacy project rule directory escaped trusted base');
      }
      const canonicalParent = path.dirname(dataDir);
      if (!fs.existsSync(canonicalParent)) fs.mkdirSync(canonicalParent, { recursive: false, mode: 0o700 });
      const canonicalParentStat = fs.lstatSync(canonicalParent);
      if (!canonicalParentStat.isDirectory() || canonicalParentStat.isSymbolicLink()
        || this.isJunction(canonicalParentStat, canonicalParent)) {
        throw new Error('Canonical project rule root is unsafe');
      }
      const canonicalParentReal = fs.realpathSync(canonicalParent);
      if (!canonicalParentReal.startsWith(this.canonicalTrustedBase + path.sep)) {
        throw new Error('Canonical project rule root escaped trusted base');
      }
      let renamed = false;
      try {
        fs.renameSync(legacyDir, dataDir);
        renamed = true;
        if (process.platform !== 'win32') {
          const fd = fs.openSync(projectsRoot, 'r');
          try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
      } catch (error) {
        if (renamed && fs.existsSync(dataDir) && !fs.existsSync(legacyDir)) {
          try { fs.renameSync(dataDir, legacyDir); } catch { /* fail closed below */ }
        }
        throw error;
      }
    } catch (error) {
      throw new Error(`Project rule directory migration failed: ${String(error)}`, { cause: error });
    }
  }

  /** Detect Windows junction/reparse point */
  private isJunction(_stat: fs.Stats, filePath: string): boolean {
    if (process.platform !== 'win32') return false;
    // On Windows, junctions report as directories but have reparse attribute
    // We detect by checking if realpath differs from the nominal path
    try {
      const real = fs.realpathSync(filePath);
      const normalized = path.resolve(filePath);
      return real !== normalized;
    } catch {
      return false;
    }
  }

  /** Verify workspaceRoot still exists, is not a symlink/junction, realpath
   *  matches the canonical path, and the resolved path is contained within
   *  canonicalTrustedBase.  Called before every read/write and after mkdir to
   *  close TOCTOU windows. */
  private verifyWorkspaceRoot(): boolean {
    try {
      const stat = fs.lstatSync(this.workspaceRoot);
      if (stat.isSymbolicLink() || this.isJunction(stat, this.workspaceRoot)) {
        return false;
      }
      const real = fs.realpathSync(this.workspaceRoot);
      if (real !== this.workspaceRoot) return false;
      // Must be contained within canonicalTrustedBase
      const sep = path.sep;
      if (!real.startsWith(this.canonicalTrustedBase + sep) && real !== this.canonicalTrustedBase) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Pre-mkdir containment check: walk from workspaceRoot up to the nearest
   *  existing ancestor, verify it is not a symlink/junction, and that its
   *  realpath is within canonicalTrustedBase.  Must pass BEFORE any mkdir to
   *  prevent creating directories inside a junction target. */
  private verifyAncestorContainment(): boolean {
    try {
      let ancestor = this.workspaceRoot;
      while (!fs.existsSync(ancestor)) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return false; // hit root
        ancestor = parent;
      }
      const stat = fs.lstatSync(ancestor);
      if (stat.isSymbolicLink() || this.isJunction(stat, ancestor)) {
        return false;
      }
      const real = fs.realpathSync(ancestor);
      const sep = path.sep;
      if (!real.startsWith(this.canonicalTrustedBase + sep) && real !== this.canonicalTrustedBase) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // ─── Read ──────────────────────────────────────────────────

  read(): WorkspaceAgentsView {
    // If workspaceRoot exists, verify it's still canonical (TOCTOU defence)
    try {
      if (fs.existsSync(this.workspaceRoot) && !this.verifyWorkspaceRoot()) {
        return { exists: true, content: '', version: 0, contentHash: '', externalConflict: true, projectId: this.projectId };
      }
    } catch { /* absent workspaceRoot → ok for read */ }

    const results: [SlotScanResult, SlotScanResult] = [
      this.scanSlot(0),
      this.scanSlot(1),
    ];

    const valid = results.filter(r => r.status === 'valid');
    const hasAnyFile = results.some(r => r.status !== 'absent');

    // ── No valid slots ──────────────────────────────────────
    if (valid.length === 0) {
      if (!hasAnyFile) {
        return this.readPublicRuleSurface()
          ?? { exists: false, content: '', version: 0, contentHash: '', projectId: this.projectId };
      }
      // Files exist but neither validates → external conflict
      return { exists: true, content: '', version: 0, contentHash: '', externalConflict: true, projectId: this.projectId };
    }

    // ── Exactly one valid slot ──────────────────────────────
    if (valid.length === 1) {
      const v = valid[0]!;
      return this.withPublicSurfaceIntegrity({
        exists: true, content: v.content, version: v.version, contentHash: v.contentHash, projectId: this.projectId,
      });
    }

    // ── Both slots valid ────────────────────────────────────
    const [a, b] = valid as [SlotScanResult, SlotScanResult];

    // Different versions → highest wins (recovery)
    if (a.version !== b.version) {
      const winner = a.version > b.version ? a : b;
      return this.withPublicSurfaceIntegrity({
        exists: true, content: winner.content, version: winner.version, contentHash: winner.contentHash, projectId: this.projectId,
      });
    }

    // Same version, different hash → fork detected → externalConflict
    if (a.contentHash !== b.contentHash) {
      return { exists: true, content: a.content, version: a.version, contentHash: a.contentHash, externalConflict: true, projectId: this.projectId };
    }

    // Same version, same hash → pick pointer-preferred, or either
    const ptr = this.readPtr();
    if (ptr && valid.some(v => v.slot === ptr.slot)) {
      const preferred = valid.find(v => v.slot === ptr.slot)!;
      return this.withPublicSurfaceIntegrity({
        exists: true, content: preferred.content, version: preferred.version, contentHash: preferred.contentHash, projectId: this.projectId,
      });
    }
    return this.withPublicSurfaceIntegrity({
      exists: true, content: a.content, version: a.version, contentHash: a.contentHash, projectId: this.projectId,
    });
  }

  private withPublicSurfaceIntegrity(view: WorkspaceAgentsView): WorkspaceAgentsView {
    const canonical = this.readSafePublicFile(this.canonicalRulesPath);
    const legacy = this.readSafePublicFile(this.legacyRulesPath);
    const backup = this.readSafePublicFile(this.legacyBackupPath);
    if (canonical === null || legacy === null || backup === null) return { ...view, externalConflict: true };
    if (canonical !== undefined && hashWorkspaceAgentsContent(canonical) !== view.contentHash) {
      return { ...view, externalConflict: true };
    }
    if (canonical === undefined) {
      if (legacy === undefined || hashWorkspaceAgentsContent(legacy) !== view.contentHash
        || backup !== undefined || fs.existsSync(this.migrationReceiptPath)) {
        return { ...view, externalConflict: true };
      }
      return view;
    }
    if (legacy === undefined) {
      if (backup !== undefined || fs.existsSync(this.migrationReceiptPath)) {
        return { ...view, externalConflict: true };
      }
      return view;
    }
    if (backup !== legacy || this.validateMigrationReceipt(hashWorkspaceAgentsContent(legacy)) !== 'valid') {
      return { ...view, externalConflict: true };
    }
    return view;
  }

  /** Independently evaluate one slot: content schema → meta → hash → version → mtime/size.
   *
   *  Uses lstatSync (not existsSync) so that EACCES/IO errors are surfaced as
   *  'invalid' rather than silently folded into 'absent'.  Rejects symlinks and
   *  Windows junctions/reparse points on content and meta files. */
  private scanSlot(slot: 0 | 1): SlotScanResult {
    const contentPath = this.contentPaths[slot];
    const metaPath = this.metaPaths[slot];

    // ── Content file — lstat to surface IO errors ────────────
    let contentStat: fs.Stats;
    try {
      contentStat = fs.lstatSync(contentPath);
    } catch (_err: unknown) {
      const err = _err as { code?: string };
      if (err?.code === 'ENOENT') {
        return { slot, status: 'absent', content: '', version: 0, contentHash: '' };
      }
      // EACCES, EIO, etc. → fail-closed (not empty)
      return { slot, status: 'invalid', content: '', version: 0, contentHash: '' };
    }
    // Reject symlinks / junctions on content files
    if (contentStat.isSymbolicLink() || this.isJunction(contentStat, contentPath)) {
      return { slot, status: 'invalid', content: '', version: 0, contentHash: '' };
    }
    if (!contentStat.isFile()) {
      return { slot, status: 'invalid', content: '', version: 0, contentHash: '' };
    }

    // ── Read + validate content ─────────────────────────────
    let content: string;
    try {
      const raw = fs.readFileSync(contentPath, 'utf-8');
      const parsed = WorkspaceAgentsContentSchema.safeParse(raw);
      if (!parsed.success) {
        return { slot, status: 'invalid', content: '', version: 0, contentHash: '' };
      }
      content = raw;
    } catch {
      return { slot, status: 'invalid', content: '', version: 0, contentHash: '' };
    }

    const contentHash = hashWorkspaceAgentsContent(content);

    // ── Meta — lstat to surface IO errors + reject symlinks ─
    try {
      const metaStat = fs.lstatSync(metaPath);
      if (metaStat.isSymbolicLink() || this.isJunction(metaStat, metaPath)) {
        return { slot, status: 'invalid', content, version: 0, contentHash };
      }
    } catch {
      // ENOENT → missing meta (invalid), EACCES/EIO → invalid
      return { slot, status: 'invalid', content, version: 0, contentHash };
    }

    const meta = this.readMeta(metaPath);
    if (!meta) {
      return { slot, status: 'invalid', content, version: 0, contentHash };
    }

    // ── Hash integrity ──────────────────────────────────────
    if (meta.contentHash !== contentHash) {
      return { slot, status: 'invalid', content, version: meta.version, contentHash };
    }

    // ── Version safety ──────────────────────────────────────
    if (!Number.isSafeInteger(meta.version) || meta.version < 0 || meta.version > MAX_ALLOWED_VERSION) {
      return { slot, status: 'invalid', content, version: meta.version, contentHash };
    }

    // ── Mtime/size cross-check (when recorded) ──────────────
    if (meta.contentMtimeMs !== undefined && meta.contentSize !== undefined) {
      try {
        const stat = fs.statSync(contentPath);
        if (stat.mtimeMs !== meta.contentMtimeMs || stat.size !== meta.contentSize) {
          return { slot, status: 'invalid', content, version: meta.version, contentHash };
        }
      } catch {
        // stat failure → slot invalid (disk error or externally removed)
        return { slot, status: 'invalid', content, version: meta.version, contentHash };
      }
    }

    return { slot, status: 'valid', content, version: meta.version, contentHash };
  }

  // ─── Exclusive lock ────────────────────────────────────────

  private acquireLock(): boolean {
    try {
      const dir = path.dirname(this.lockPath);
      if (!fs.existsSync(dir)) {
        // Pre-mkdir: verify nearest existing ancestor is within
        // canonicalTrustedBase and is not a junction.  If workspaceRoot was
        // swapped after construction, this fails BEFORE any directory is created.
        if (!this.verifyAncestorContainment()) return false;
        fs.mkdirSync(dir, { recursive: true });
        // Post-mkdir: verify the newly-created workspaceRoot is canonical
        if (!this.verifyWorkspaceRoot()) return false;
      } else if (!this.verifyWorkspaceRoot()) {
        // Directory already exists but may have been replaced with a junction
        // after construction. Verify workspaceRoot is still canonical.
        return false;
      }
      fs.writeFileSync(this.lockPath, String(process.pid), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      return true;
    } catch { return false; }
  }

  private releaseLock(): void {
    try { if (fs.existsSync(this.lockPath)) fs.unlinkSync(this.lockPath); } catch { /* best-effort */ }
  }

  // ─── Write (CAS) ───────────────────────────────────────────

  write(content: string, expectedVersion: number): WorkspaceAgentsMutationResult {
    if (!this.acquireLock()) return createWorkspaceAgentsFailure('io_error');
    try {
    const contentCheck = WorkspaceAgentsContentSchema.safeParse(content);
    if (!contentCheck.success) {
      return createWorkspaceAgentsFailure('content_invalid');
    }

    const current = this.read();

    // Version-overflow check from stored meta — independent of read()'s
    // normalization, since read() may squash an overflowed slot to 'invalid' and
    // lose the version information. Checks both slots.
    for (const slot of [0, 1] as const) {
      const sm = this.readMeta(this.metaPaths[slot]);
      if (sm && sm.version >= MAX_ALLOWED_VERSION) {
        return createWorkspaceAgentsFailure('io_error');
      }
    }

    if (current.externalConflict) {
      return { success: false, code: 'external_conflict' as const };
    }

    if (expectedVersion !== current.version) {
      return createWorkspaceAgentsCASConflict(current.version, current.contentHash);
    }

    const canonicalTemp = this.prepareCanonicalRuleSurface(content, current);
    if (!canonicalTemp) return { success: false, code: 'external_conflict' as const };

    const newHash = hashWorkspaceAgentsContent(content);
    const newVersion = current.version + 1;
    const meta: AgentsMeta = {
      version: newVersion,
      contentHash: newHash,
      updatedAt: Date.now(),
    };

    // Read current pointer to find inactive slot
    const ptr = this.readPtr();
    const activeSlot = ptr?.slot ?? 0;
    const inactiveSlot = activeSlot === 0 ? 1 : 0;
    const targetContentPath = this.contentPaths[inactiveSlot];
    const targetMetaPath = this.metaPaths[inactiveSlot];

    // Ensure directory exists — with pre-mkdir containment + post-mkdir verify
    const dir = path.dirname(targetContentPath);
    if (!fs.existsSync(dir)) {
      // Pre-mkdir: verify nearest existing ancestor is canonical.
      // Prevents creating directories inside a junction target swapped
      // between construction and now.
      if (!this.verifyAncestorContainment()) {
        try { this.releaseLock(); } catch { /* best-effort */ }
        return createWorkspaceAgentsFailure('io_error');
      }
      fs.mkdirSync(dir, { recursive: true });
      // Post-mkdir: verify the newly-created directory is canonical
      if (!this.verifyWorkspaceRoot()) {
        try { this.releaseLock(); } catch { /* best-effort */ }
        return createWorkspaceAgentsFailure('io_error');
      }
    }

    // ── Phase A: write content to inactive slot (temp → fsync → rename) ─
    const contentTmp = `${targetContentPath}.${randomUUID()}.tmp`;
    try {
      if (!this.verifyWorkspaceRoot()) {
        return createWorkspaceAgentsFailure('io_error');
      }
      fs.writeFileSync(contentTmp, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      const cFd = fs.openSync(contentTmp, 'r+');
      try { fs.fsyncSync(cFd); } finally { fs.closeSync(cFd); }
      fs.renameSync(contentTmp, targetContentPath);
    } catch {
      try { if (fs.existsSync(contentTmp)) fs.unlinkSync(contentTmp); } catch { /* ignore */ }
      return createWorkspaceAgentsFailure('io_error');
    }

    // Capture mtime/size of newly-written content, then build the final meta
    // once (with mtime/size).  This avoids the old two-phase write where the
    // second writeFileSync(targetMetaPath, …) was an in-place overwrite without
    // fsync/rename — which could leave a truncated meta on crash.
    try {
      const stat = fs.statSync(targetContentPath);
      meta.contentMtimeMs = stat.mtimeMs;
      meta.contentSize = stat.size;
    } catch { /* non-critical — meta will lack mtime/size cross-check fields */ }

    const finalMetaJson = JSON.stringify(meta, null, 2) + '\n';
    const metaTmp = `${targetMetaPath}.${randomUUID()}.tmp`;
    try {
      if (!this.verifyWorkspaceRoot()) {
        return createWorkspaceAgentsFailure('io_error');
      }
      fs.writeFileSync(metaTmp, finalMetaJson, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      const mFd = fs.openSync(metaTmp, 'r+');
      try { fs.fsyncSync(mFd); } finally { fs.closeSync(mFd); }
      fs.renameSync(metaTmp, targetMetaPath);
    } catch {
      try { if (fs.existsSync(metaTmp)) fs.unlinkSync(metaTmp); } catch { /* ignore */ }
      return createWorkspaceAgentsFailure('io_error');
    }

    // ── Phase B: ATOMIC COMMIT — pointer temp → fsync → rename ──
    // This is the ONLY commit point. If it fails, old slot is still active
    // with complete old content + meta intact.
    const newPtr: PtrFile = { slot: inactiveSlot as 0 | 1 };
    const ptrTmp = `${this.ptrPath}.${randomUUID()}.tmp`;

    try {
      if (!this.verifyWorkspaceRoot()) {
        return createWorkspaceAgentsFailure('io_error');
      }
      fs.writeFileSync(ptrTmp, JSON.stringify(newPtr), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      const pFd = fs.openSync(ptrTmp, 'r+');
      try { fs.fsyncSync(pFd); } finally { fs.closeSync(pFd); }
      fs.renameSync(ptrTmp, this.ptrPath);

      if (process.platform !== 'win32') {
        const dirFd = fs.openSync(dir, 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      }
    } catch {
      try { if (fs.existsSync(ptrTmp)) fs.unlinkSync(ptrTmp); } catch { /* ignore */ }
      try { if (fs.existsSync(canonicalTemp)) fs.unlinkSync(canonicalTemp); } catch { /* ignore */ }
      try { if (fs.existsSync(targetContentPath)) fs.unlinkSync(targetContentPath); } catch { /* ignore */ }
      try { if (fs.existsSync(targetMetaPath)) fs.unlinkSync(targetMetaPath); } catch { /* ignore */ }
      // Pointer NOT updated → old slot still active → complete old state intact
      return createWorkspaceAgentsFailure('io_error');
    }

    try {
      fs.renameSync(canonicalTemp, this.canonicalRulesPath);
      if (process.platform !== 'win32') {
        const dirFd = fs.openSync(dir, 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      }
    } catch {
      try { if (fs.existsSync(canonicalTemp)) fs.unlinkSync(canonicalTemp); } catch { /* ignore */ }
      // The internal commit cannot remain newer than the public Metis.md
      // surface. Remove the just-written inactive generation so read()
      // deterministically recovers the previous complete state.
      try { if (fs.existsSync(targetContentPath)) fs.unlinkSync(targetContentPath); } catch { /* ignore */ }
      try { if (fs.existsSync(targetMetaPath)) fs.unlinkSync(targetMetaPath); } catch { /* ignore */ }
      try {
        if (ptr) {
          const rollback = `${this.ptrPath}.${randomUUID()}.rollback`;
          fs.writeFileSync(rollback, JSON.stringify(ptr), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
          fs.renameSync(rollback, this.ptrPath);
        } else if (fs.existsSync(this.ptrPath)) {
          fs.unlinkSync(this.ptrPath);
        }
      } catch { /* read() still ignores a pointer to an absent generation */ }
      return createWorkspaceAgentsFailure('io_error');
    }

    return {
      success: true,
      code: 'saved' as const,
      version: newVersion,
      contentHash: newHash,
    };
    } finally {
      this.releaseLock();
    }
  }

  /** Read the canonical public Metis.md file, falling back to legacy
   *  AGENTS.md only when no dual-slot generation exists. If both public
   *  files exist with different bytes, fail closed instead of silently
   *  merging or choosing one. */
  private readPublicRuleSurface(): WorkspaceAgentsView | null {
    const canonical = this.readSafePublicFile(this.canonicalRulesPath);
    const legacy = this.readSafePublicFile(this.legacyRulesPath);
    if (canonical === undefined && legacy === undefined) return null;
    if (canonical === null || legacy === null) {
      return { exists: true, content: '', version: 0, contentHash: '', externalConflict: true, projectId: this.projectId };
    }
    if (canonical !== undefined && legacy !== undefined && canonical !== legacy) {
      return {
        exists: true,
        content: canonical,
        version: 0,
        contentHash: hashWorkspaceAgentsContent(canonical),
        externalConflict: true,
        projectId: this.projectId,
      };
    }
    const content = canonical ?? legacy;
    if (content === undefined) return null;
    return {
      exists: true,
      content,
      version: 0,
      contentHash: hashWorkspaceAgentsContent(content),
      projectId: this.projectId,
    };
  }

  private readSafePublicFile(filePath: string): string | undefined | null {
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || this.isJunction(stat, filePath)) return null;
      const real = fs.realpathSync(filePath);
      const relative = path.relative(this.workspaceRoot, real);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
      const content = fs.readFileSync(real, 'utf8');
      return WorkspaceAgentsContentSchema.safeParse(content).success ? content : null;
    } catch (error) {
      return (error as { code?: string }).code === 'ENOENT' ? undefined : null;
    }
  }

  /** Prepare an fsynced canonical Metis.md generation before committing the
   *  dual-slot pointer. Legacy AGENTS.md is copied once as an immutable
   *  backup and accompanied by a bounded migration receipt. */
  private prepareCanonicalRuleSurface(content: string, current: WorkspaceAgentsView): string | null {
    try {
      const canonical = this.readSafePublicFile(this.canonicalRulesPath);
      const legacy = this.readSafePublicFile(this.legacyRulesPath);
      if (canonical === null || legacy === null) return null;
      if (canonical !== undefined && hashWorkspaceAgentsContent(canonical) !== current.contentHash) return null;
      if (canonical === undefined && legacy !== undefined
        && hashWorkspaceAgentsContent(legacy) !== current.contentHash) return null;

      if (legacy !== undefined) {
        const backup = this.readSafePublicFile(this.legacyBackupPath);
        if (backup === null || (backup !== undefined && backup !== legacy)) return null;
        if (backup === undefined) {
          fs.writeFileSync(this.legacyBackupPath, legacy, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
          const backupFd = fs.openSync(this.legacyBackupPath, 'r+');
          try { fs.fsyncSync(backupFd); } finally { fs.closeSync(backupFd); }
        }
        const sourceSha256 = hashWorkspaceAgentsContent(legacy);
        const receiptState = this.validateMigrationReceipt(sourceSha256);
        if (receiptState === 'invalid') return null;
        if (receiptState === 'absent') {
        const receipt = JSON.stringify({
          format: 'metis-rules-migration',
          version: 1,
          projectId: this.projectId,
          source: LEGACY_WORKSPACE_AGENTS_FILENAME,
          target: WORKSPACE_METIS_FILENAME,
          sourceSha256,
        }, null, 2) + '\n';
        fs.writeFileSync(this.migrationReceiptPath, receipt, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        const receiptFd = fs.openSync(this.migrationReceiptPath, 'r+');
        try { fs.fsyncSync(receiptFd); } finally { fs.closeSync(receiptFd); }
        }
      }

      const temp = `${this.canonicalRulesPath}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      const fd = fs.openSync(temp, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return temp;
    } catch {
      try {
        for (const entry of fs.readdirSync(this.workspaceRoot)) {
          if (entry.startsWith(`${WORKSPACE_METIS_FILENAME}.`) && entry.endsWith('.tmp')) {
            fs.unlinkSync(path.join(this.workspaceRoot, entry));
          }
        }
      } catch { /* best-effort cleanup */ }
      return null;
    }
  }

  private validateMigrationReceipt(expectedSourceSha256: string): 'absent' | 'valid' | 'invalid' {
    try {
      const stat = fs.lstatSync(this.migrationReceiptPath);
      if (!stat.isFile() || stat.isSymbolicLink() || this.isJunction(stat, this.migrationReceiptPath)) return 'invalid';
      const real = fs.realpathSync(this.migrationReceiptPath);
      const relative = path.relative(this.workspaceRoot, real);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return 'invalid';
      const parsed = JSON.parse(fs.readFileSync(real, 'utf8')) as Record<string, unknown>;
      return Object.keys(parsed).sort().join(',') === 'format,projectId,source,sourceSha256,target,version'
        && parsed.format === 'metis-rules-migration'
        && parsed.version === 1
        && parsed.projectId === this.projectId
        && parsed.source === LEGACY_WORKSPACE_AGENTS_FILENAME
        && parsed.target === WORKSPACE_METIS_FILENAME
        && parsed.sourceSha256 === expectedSourceSha256
        ? 'valid' : 'invalid';
    } catch (error) {
      return (error as { code?: string }).code === 'ENOENT' ? 'absent' : 'invalid';
    }
  }

  // ─── Pointer file ──────────────────────────────────────────

  private readPtr(): PtrFile | null {
    try {
      if (!fs.existsSync(this.ptrPath)) return null;
      const raw = fs.readFileSync(this.ptrPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed?.slot === 'number' && (parsed.slot === 0 || parsed.slot === 1)) {
        return { slot: parsed.slot };
      }
      return null;
    } catch {
      return null;
    }
  }

  // ─── Meta sidecar ──────────────────────────────────────────

  private readMeta(metaPath: string): AgentsMeta | null {
    try {
      if (!fs.existsSync(metaPath)) return null;
      const raw = fs.readFileSync(metaPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (
        typeof parsed?.version === 'number' &&
        typeof parsed?.contentHash === 'string'
      ) {
        return {
          version: parsed.version,
          contentHash: parsed.contentHash,
          updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
          contentMtimeMs: typeof parsed.contentMtimeMs === 'number' ? parsed.contentMtimeMs : undefined,
          contentSize: typeof parsed.contentSize === 'number' ? parsed.contentSize : undefined,
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}
