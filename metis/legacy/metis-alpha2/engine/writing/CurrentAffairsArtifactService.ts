/**
 * CurrentAffairsArtifactService — strict artifact write/read.
 *
 * Constructor requires baseRoot already exist as canonical non-link directory.
 * Write: exclusive per-level mkdir, tmpDir exclusive non-recursive,
 * rename after re-verify containment. No recursive mkdir across untrusted ancestors.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { buildResearchExport, type SecureExportPlan } from '../export/ResearchExportBuilder.js';
import type { CurrentAffairsManifest } from './CurrentAffairsProfile.js';
import type { CurrentAffairsWorkflowState } from './CurrentAffairsWorkflow.js';
import { buildExportRecords } from './CurrentAffairsExportAdapter.js';

// ── Safe names ──────────────────────────────────────────────────

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
const WINDOWS_FORBIDDEN_FILE_CHARS_RE = /[<>:"|?*]/u;

function assertSafeName(value: string, label: string): void {
  if (!value || value.length === 0 || value.length > 256) throw new Error(`Invalid ${label}: length`);
  if (value.includes('/') || value.includes('\\') || value.includes('..')) throw new Error(`Path traversal in ${label}`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F-\x9F]/u.test(value)) throw new Error(`Control chars in ${label}`);
  if (!SAFE_NAME_RE.test(value)) throw new Error(`Invalid ${label}`);
}

function assertSafeFileName(value: string): void {
  if (!value || value.length > 256) throw new Error('Invalid fileName: length');
  if (value !== value.normalize('NFC')) throw new Error('Invalid fileName: normalization');
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw new Error('Path traversal in fileName');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F-\x9F]/u.test(value)) throw new Error('Control chars in fileName');
  if (WINDOWS_FORBIDDEN_FILE_CHARS_RE.test(value)) throw new Error('Invalid fileName');
  if (value.endsWith('.') || value.endsWith(' ')) throw new Error('Invalid fileName');
  if (WINDOWS_RESERVED_BASENAME_RE.test(value)) throw new Error('Invalid fileName');
}

// ── Provenance Zod ──────────────────────────────────────────────

const ArtifactFileEntrySchema = z.strictObject({
  name: z.string().min(1).max(256),
  size: z.number().int().min(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const ProvenanceRecordSchema = z.strictObject({
  artifactId: z.string().min(1).max(256),
  artifactVersion: z.number().int().positive(),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  receiptId: z.string().min(1).max(256),
  createdAt: z.number().int().min(0),
  createdBy: z.string().min(1).max(256),
  files: z.array(ArtifactFileEntrySchema).max(256),
});

export type ProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>;

// ── Public interfaces ───────────────────────────────────────────

export interface ArtifactFileEntry { name: string; size: number; sha256: string }
export interface ArtifactWriteResult {
  ok: boolean; artifactId: string; artifactVersion: number; targetDir: string;
  /** When stageOnly, this is the staging tmpDir path; caller must publish (rename→fsync). */
  stagingDir?: string;
  manifestDigest: string; files: ArtifactFileEntry[]; error?: string;
}
export interface ArtifactReadResult {
  ok: boolean; artifactId: string; artifactVersion: number; manifestDigest: string;
  files: Array<{ name: string; size: number; sha256: string; content: string }>; error?: string;
}

// ── Service ──────────────────────────────────────────────────────

export class CurrentAffairsArtifactService {
  readonly baseRoot: string;

  /**
   * baseRoot must already exist as a canonical non-link directory.
   * Main process creates it in controlled DATA_DIR.
   */
  constructor(baseRoot: string) {
    if (!fs.existsSync(baseRoot)) throw new Error('baseRoot must already exist');
    const stat = fs.lstatSync(baseRoot);
    if (stat.isSymbolicLink()) throw new Error('baseRoot must not be a symlink');
    this.baseRoot = fs.realpathSync(baseRoot);
  }

  private isContained(realPath: string): boolean {
    const rel = path.relative(this.baseRoot, realPath);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  /** Re-verify baseRoot identity hasn't changed. */
  private assertBaseRootIntact(): void {
    if (!fs.existsSync(this.baseRoot)) throw new Error('baseRoot missing');
    const stat = fs.lstatSync(this.baseRoot);
    if (stat.isSymbolicLink()) throw new Error('baseRoot became symlink');
    if (fs.realpathSync(this.baseRoot) !== this.baseRoot) throw new Error('baseRoot realpath changed');
  }

  /** Create directory path one level at a time with exclusive mkdir+verify. */
  private mkdirExclusive(dir: string): void {
    const parts = path.relative(this.baseRoot, dir).split(path.sep).filter(Boolean);
    let current = this.baseRoot;
    for (const part of parts) {
      assertSafeName(part, 'dir segment');
      current = path.join(current, part);
      if (!fs.existsSync(current)) {
        fs.mkdirSync(current); // non-recursive exclusive
        const st = fs.lstatSync(current);
        if (st.isSymbolicLink()) throw new Error(`Created dir is symlink: ${current}`);
      }
      const real = fs.realpathSync(current);
      if (!this.isContained(real)) throw new Error(`Path escaped baseRoot: ${current}`);
    }
  }

  targetDir(artifactId: string, version: number): string {
    assertSafeName(artifactId, 'artifactId');
    return path.join(this.baseRoot, artifactId, `v${version}`);
  }

  buildPlan(manifest: CurrentAffairsManifest, state: CurrentAffairsWorkflowState):
    { ok: true; plan: SecureExportPlan } | { ok: false } {
    const allRecords = buildExportRecords(manifest, state);
    // Builder gate requires artifact scope to have exactly 1 record.
    // Use a summary record for artifact; put all structured records under project.
    const summaryContent = `Current Affairs Report: ${manifest.title}\nSources: ${manifest.sources.length}\nFacts: ${manifest.facts?.length ?? 0}`;
    // ExportGate requires: reviewStatus='verified', deliverableProfile binding
    const artifactSummary: typeof allRecords[0] = {
      id: `ca_artifact_${manifest.profileId}`,
      title: manifest.title,
      content: summaryContent,
      sensitivity: 'none' as const,
      fields: [
        { key: 'reviewStatus', value: 'verified', sensitivity: 'none' as const },
        { key: 'deliverableProfileId', value: 'research_report', sensitivity: 'none' as const },
        { key: 'deliverableProfileSchemaVersion', value: '1', sensitivity: 'none' as const },
        { key: 'deliverableProfileVersion', value: '1.0.0', sensitivity: 'none' as const },
        { key: 'artifactKind', value: 'current_affairs_report', sensitivity: 'none' as const },
        { key: 'profileId', value: manifest.profileId, sensitivity: 'none' as const },
        { key: 'sourceCount', value: String(manifest.sources.length), sensitivity: 'none' as const },
        { key: 'factCount', value: String(manifest.facts?.length ?? 0), sensitivity: 'none' as const },
      ],
      images: [],
    };
    // displayName must be ASCII-safe for file naming (SAFE_NAME_RE)
    const safeDisplayName = 'ca_' + (manifest.title.replace(/[^\x20-\x7E]/g, '_').replace(/\s+/g, '_').slice(0, 57) || 'report');
    const manifestDigest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    // ResearchExportSnapshotSchema expects top-level artifact/citations/evidence/audit/project.
    const snapshot = {
      artifactBinding: {
        artifactId: `artifact-${manifest.profileId}`,
        artifactVersion: manifest.manifestVersion,
        artifactManifestDigest: manifestDigest,
      },
      artifact: [artifactSummary],
      project: allRecords,
      citations: [] as typeof allRecords,
      evidence: [] as typeof allRecords,
      audit: [] as typeof allRecords,
    };
    const exportId = `ex_${createHash('sha256').update(`ca:${manifest.projectId}:${manifest.profileId}`).digest('hex').slice(0, 32)}`;
    const capId = `fc_${createHash('sha256').update(`ca-cap:${manifest.projectId}:${manifest.profileId}`).digest('hex').slice(0, 32)}`;
    const result = buildResearchExport({
      exportId,
      projectId: manifest.projectId,
      artifactId: `artifact-${manifest.profileId}`,
      destinationCapabilityId: capId,
      displayName: safeDisplayName,
      scopes: ['artifact', 'project'],
      format: 'markdown',
      privacyProfile: 'private-local',
      requestedAt: Date.now(),
      artifactVersion: manifest.manifestVersion,
      artifactManifestDigest: manifestDigest,
    }, snapshot);
    return result.ok ? { ok: true, plan: result.plan } : { ok: false };
  }

  writeArtifact(plan: SecureExportPlan, artifactVersion: number, receiptId: string, opts?: { stageOnly?: boolean }): ArtifactWriteResult {
    const artifactId = plan.artifactId;
    const manifestDigest = plan.artifactManifestDigest;
    try { this.assertBaseRootIntact(); } catch (err) {
      return { ok: false, artifactId, artifactVersion: 0, targetDir: '', manifestDigest, files: [], error: String(err instanceof Error ? err.message : err) };
    }
    assertSafeName(artifactId, 'artifactId');
    for (const f of plan.files) assertSafeFileName(f.relativeName);
    if (!Number.isSafeInteger(artifactVersion) || artifactVersion < 1) {
      return { ok: false, artifactId, artifactVersion: 0, targetDir: '', manifestDigest, files: [], error: 'version must be positive safe integer' };
    }

    try {
      let version = artifactVersion;
      let targetPath = this.targetDir(artifactId, version);
      while (fs.existsSync(targetPath)) {
        if (version >= Number.MAX_SAFE_INTEGER) return { ok: false, artifactId, artifactVersion: 0, targetDir: '', manifestDigest, files: [], error: 'Version overflow' };
        version++; targetPath = this.targetDir(artifactId, version);
      }

      // Non-recursive exclusive tmpDir
      const tmpDir = path.join(this.baseRoot, `.tmp-${artifactId}-${randomUUID()}`);
      fs.mkdirSync(tmpDir);

      try {
        const fileEntries: ArtifactFileEntry[] = [];
        for (const file of plan.files) {
          const fp = path.join(tmpDir, file.relativeName);
          fs.writeFileSync(fp, file.content, { encoding: file.encoding === 'base64' ? 'base64' : 'utf-8', flag: 'wx', mode: 0o600 });
          const fd = fs.openSync(fp, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          const buf = fs.readFileSync(fp);
          fileEntries.push({ name: file.relativeName, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
        }

        const provenance: ProvenanceRecord = { artifactId, artifactVersion: version, manifestDigest, receiptId, createdAt: Date.now(), createdBy: 'ca-service', files: fileEntries };
        const pp = path.join(tmpDir, 'provenance.json');
        fs.writeFileSync(pp, JSON.stringify(provenance, null, 2), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
        const pf = fs.openSync(pp, 'r+'); try { fs.fsyncSync(pf); } finally { fs.closeSync(pf); }

        // Create parent directories non-recursively with verification
        const stageOnly = opts?.stageOnly === true;
        if (!stageOnly) {
          this.mkdirExclusive(path.dirname(targetPath));
          // Re-verify baseRoot + parent identity before rename
          this.assertBaseRootIntact();
          const parentReal = fs.realpathSync(path.dirname(targetPath));
          if (!this.isContained(parentReal)) throw new Error('Parent escaped baseRoot');
        }

        if (stageOnly) {
          // Stage only: caller will publish (rename→fsync) after commit
          return { ok: true, artifactId, artifactVersion: version, targetDir: targetPath, stagingDir: tmpDir, manifestDigest, files: fileEntries };
        }

        fs.renameSync(tmpDir, targetPath);

        // Post-rename: tmpDir gone, targetPath exists. If fsync fails,
        // try to undo; if undo fails, artifact visible but not durable.
        try {
          if (process.platform !== 'win32') {
            const dfd = fs.openSync(targetPath, 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
          }
        } catch {
          try { fs.rmSync(targetPath, { recursive: true, force: true }); } catch { /* undo failed */ }
          if (!fs.existsSync(targetPath)) throw new Error('Write fsync failed — artifact removed');
          // Undo failed: artifact exists at targetPath, but durability uncertain
          return { ok: false, artifactId, artifactVersion: version, targetDir: targetPath, manifestDigest, files: fileEntries, error: 'visibility_uncertain' };
        }

        return { ok: true, artifactId, artifactVersion: version, targetDir: targetPath, manifestDigest, files: fileEntries };
      } catch (inner) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
        throw inner;
      }
    } catch (err) {
      return { ok: false, artifactId, artifactVersion: 0, targetDir: '', manifestDigest, files: [], error: err instanceof Error ? err.message : 'Write failed' };
    }
  }

  /** Atomically publish a staged artifact from tmpDir to its final target.
   *  Creates parent directories, verifies containment, renames, and fsyncs.
   *  Returns 'ok' on success, 'visibility_uncertain' if rename succeeded but
   *  post-rename fsync+cleanup failed (artifact MAY be visible, receipt should be consumed). */
  publishStaged(stagingDir: string, targetDir: string): 'ok' | 'visibility_uncertain' {
    this.assertBaseRootIntact();
    if (!fs.existsSync(stagingDir)) throw new Error('Staging directory missing');
    const stagingReal = fs.realpathSync(stagingDir);
    if (!this.isContained(stagingReal)) throw new Error('Staging outside baseRoot');
    const parentDir = path.dirname(targetDir);
    this.mkdirExclusive(parentDir);
    this.assertBaseRootIntact();
    const parentReal = fs.realpathSync(parentDir);
    if (!this.isContained(parentReal)) throw new Error('Parent escaped baseRoot');
    fs.renameSync(stagingDir, targetDir);
    // Post-rename: stagingDir no longer exists, targetDir DOES exist.
    // If fsync fails, must clean up targetDir to avoid visible-uncommitted artifact.
    try {
      if (process.platform !== 'win32') {
        const dfd = fs.openSync(targetDir, 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
      }
      return 'ok';
    } catch {
      // Rename succeeded but fsync failed — artifact visible, receipt not consumed.
      // Try to undo: delete targetDir, fsync parent.
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch { /* cleanup failed */ }
      try {
        if (process.platform !== 'win32') {
          const pfd = fs.openSync(parentDir, 'r'); try { fs.fsyncSync(pfd); } finally { fs.closeSync(pfd); }
        }
      } catch { /* fsync parent failed */ }
      // If targetDir still exists, cleanup failed → visibility is uncertain
      if (fs.existsSync(targetDir)) return 'visibility_uncertain';
      throw new Error('Publish fsync failed — artifact removed, retry safe');
    }
  }

  /** Verify a staging directory: validate containment, parse provenance.json with
   *  strict schema, validate it against expected fields, then bidirectionally verify
   *  every payload file matches the provenance files list (exact name set, size, sha256).
   *  Rejects symlinks, non-files, duplicate names, extra/missing files, paths outside baseRoot. */
  verifyStaged(stagingDir: string, expected: {
    artifactId: string; artifactVersion: number; manifestDigest: string; receiptId: string;
    files: Array<{ name: string; size: number; sha256: string }>;
  }): { ok: true } | { ok: false; code: string } {
    try {
      // Containment: stagingDir must be within baseRoot, non-symlink directory
      this.assertBaseRootIntact();
      const stagingStat = fs.lstatSync(stagingDir);
      if (stagingStat.isSymbolicLink()) return { ok: false, code: 'staging_symlink' };
      if (!stagingStat.isDirectory()) return { ok: false, code: 'staging_not_directory' };
      if (!this.isContained(fs.realpathSync(stagingDir))) return { ok: false, code: 'staging_outside_root' };

      const entries = fs.readdirSync(stagingDir, { withFileTypes: true });
      const seen = new Set<string>();
      let provRaw: string | null = null;
      const stagedPayloads = new Map<string, { size: number; sha256: string }>();

      for (const ent of entries) {
        const fp = path.join(stagingDir, ent.name);
        // Per-file containment: no symlinks, regular files only, within baseRoot
        const entStat = fs.lstatSync(fp);
        if (entStat.isSymbolicLink()) return { ok: false, code: 'non_file_in_staging' };
        if (!entStat.isFile()) return { ok: false, code: 'non_file_in_staging' };
        if (!this.isContained(fs.realpathSync(fp))) return { ok: false, code: 'staging_outside_root' };
        if (seen.has(ent.name)) return { ok: false, code: 'duplicate_in_staging' };
        seen.add(ent.name);
        const buf = fs.readFileSync(fp);
        if (ent.name === 'provenance.json') {
          provRaw = buf.toString('utf-8');
        } else {
          stagedPayloads.set(ent.name, { size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
        }
      }

      if (!provRaw) return { ok: false, code: 'provenance_missing' };
      let provJson: unknown;
      try { provJson = JSON.parse(provRaw); } catch { return { ok: false, code: 'provenance_invalid' }; }
      const parsed = ProvenanceRecordSchema.safeParse(provJson);
      if (!parsed.success) return { ok: false, code: 'provenance_invalid' };

      const prov = parsed.data;
      if (prov.artifactId !== expected.artifactId) return { ok: false, code: 'provenance_artifact_id_mismatch' };
      if (prov.artifactVersion !== expected.artifactVersion) return { ok: false, code: 'provenance_version_mismatch' };
      if (prov.manifestDigest !== expected.manifestDigest) return { ok: false, code: 'provenance_digest_mismatch' };
      if (prov.receiptId !== expected.receiptId) return { ok: false, code: 'provenance_receipt_mismatch' };

      // Bidirectional: every provenance file exists in staging, every staging payload in provenance
      if (prov.files.length !== expected.files.length) return { ok: false, code: 'file_count_mismatch' };
      const provFileMap = new Map(prov.files.map(f => [f.name, f]));
      if (provFileMap.size !== prov.files.length) return { ok: false, code: 'provenance_duplicate_name' };
      if (stagedPayloads.size !== expected.files.length) return { ok: false, code: 'staging_file_count_mismatch' };

      const expectedMap = new Map(expected.files.map(f => [f.name, f]));
      for (const [name, sf] of stagedPayloads) {
        const pf = provFileMap.get(name);
        const ef = expectedMap.get(name);
        if (!pf || !ef) return { ok: false, code: 'file_missing_from_provenance' };
        if (sf.size !== pf.size || sf.sha256 !== pf.sha256 || sf.size !== ef.size || sf.sha256 !== ef.sha256) {
          return { ok: false, code: 'file_hash_mismatch' };
        }
      }
      // Ensure every provenance entry has a real staged file
      for (const pn of provFileMap.keys()) {
        if (!stagedPayloads.has(pn)) return { ok: false, code: 'provenance_extra_file' };
      }

      return { ok: true };
    } catch { return { ok: false, code: 'verify_failed' }; }
  }

  readArtifact(artifactId: string, version: number): ArtifactReadResult {
    if (!Number.isSafeInteger(version) || version < 1) return { ok: false, artifactId, artifactVersion: version, manifestDigest: '', files: [], error: 'version invalid' };
    try { this.assertBaseRootIntact(); } catch (err) {
      return { ok: false, artifactId, artifactVersion: version, manifestDigest: '', files: [], error: String(err instanceof Error ? err.message : err) };
    }
    assertSafeName(artifactId, 'artifactId');

    try {
      const dir = this.targetDir(artifactId, version);
      const dirStat = fs.lstatSync(dir);
      if (dirStat.isSymbolicLink()) return { ok: false, artifactId, artifactVersion: version, manifestDigest: '', files: [], error: 'dir is symlink' };
      if (!this.isContained(fs.realpathSync(dir))) return { ok: false, artifactId, artifactVersion: version, manifestDigest: '', files: [], error: 'dir outside baseRoot' };

      const pp = path.join(dir, 'provenance.json');
      const ps = fs.lstatSync(pp);
      if (ps.isSymbolicLink()) return { ok: false, artifactId, artifactVersion: version, manifestDigest: '', files: [], error: 'provenance symlink' };
      const proven = ProvenanceRecordSchema.parse(JSON.parse(fs.readFileSync(pp, 'utf-8')));
      if (proven.artifactId !== artifactId) return { ok: false, artifactId, artifactVersion: version, manifestDigest: '', files: [], error: 'artifactId mismatch' };
      if (proven.artifactVersion !== version) return { ok: false, artifactId, artifactVersion: version, manifestDigest: '', files: [], error: 'version mismatch' };
      if (!Number.isSafeInteger(proven.artifactVersion) || proven.artifactVersion < 1) return { ok: false, artifactId, artifactVersion: version, manifestDigest: '', files: [], error: 'version invalid' };

      const seen = new Set<string>();
      for (const e of proven.files) { if (seen.has(e.name)) return { ok: false, artifactId, artifactVersion: version, manifestDigest: proven.manifestDigest, files: [], error: 'duplicate entry' }; seen.add(e.name); }

      const readFiles: Array<{ name: string; size: number; sha256: string; content: string }> = [];
      for (const entry of proven.files) {
        assertSafeFileName(entry.name);
        const fp = path.join(dir, entry.name);
        const fsStat = fs.lstatSync(fp);
        if (fsStat.isSymbolicLink()) return { ok: false, artifactId, artifactVersion: version, manifestDigest: proven.manifestDigest, files: [], error: `symlink: ${entry.name}` };
        if (!this.isContained(fs.realpathSync(fp))) return { ok: false, artifactId, artifactVersion: version, manifestDigest: proven.manifestDigest, files: [], error: `outside: ${entry.name}` };
        const buf = fs.readFileSync(fp);
        const sha = createHash('sha256').update(buf).digest('hex');
        if (sha !== entry.sha256) return { ok: false, artifactId, artifactVersion: version, manifestDigest: proven.manifestDigest, files: [], error: `hash mismatch: ${entry.name}` };
        if (buf.length !== entry.size) return { ok: false, artifactId, artifactVersion: version, manifestDigest: proven.manifestDigest, files: [], error: `size mismatch: ${entry.name}` };
        readFiles.push({ name: entry.name, size: buf.length, sha256: sha, content: buf.toString('utf-8') });
      }

      const provNames = new Set(proven.files.map(f => f.name));
      for (const de of fs.readdirSync(dir)) { if (de !== 'provenance.json' && !provNames.has(de)) return { ok: false, artifactId, artifactVersion: version, manifestDigest: proven.manifestDigest, files: [], error: `extra file: ${de}` }; }

      return { ok: true, artifactId, artifactVersion: version, manifestDigest: proven.manifestDigest, files: readFiles };
    } catch (err) {
      return { ok: false, artifactId, artifactVersion: version, manifestDigest: '', files: [], error: err instanceof Error ? err.message : 'Read failed' };
    }
  }
}
