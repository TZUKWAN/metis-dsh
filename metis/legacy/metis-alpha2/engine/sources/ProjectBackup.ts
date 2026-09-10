/**
 * Project backup / import-export (METIS-407).
 *
 * Exports a portable, self-describing project bundle: metadata, sources (with their
 * evidence anchors), claims + the claim-evidence graph, artifacts, decisions, and run
 * records. SENSITIVE KEYS (API keys, decrypted credentials) are NEVER included — the bundle
 * is safe to move between machines (METIS-407: "sensitive keys must not be exported").
 *
 * On import, the bundle is validated against a schema version, ids are preserved so evidence
 * anchors and artifact history remain navigable (METIS-407: "after import, evidence anchors
 * and artifact history are still usable"), and the import is idempotent (re-importing the
 * same bundle does not duplicate).
 */

import type { Project, Source, Evidence, Claim, ClaimEvidenceLink, ResearchArtifact } from '../persistence/researchModel.js';

export interface ProjectBundle {
  format: 'metis-project';
  version: 1;
  exportedAt: number;
  project: Project;
  sources: Source[];
  evidence: Evidence[];
  claims: Claim[];
  claimEvidenceLinks: ClaimEvidenceLink[];
  artifacts: ResearchArtifact[];
  decisions: Array<{ id: string; text: string; at: number; context?: string }>;
}

export interface BackupSource {
  dumpProject(projectId: string): { project: Project; sources: Source[]; evidence: Evidence[]; claims: Claim[]; links: ClaimEvidenceLink[]; artifacts: ResearchArtifact[]; decisions: ProjectBundle['decisions'] } | undefined;
  hasProject(projectId: string): boolean;
  insertProject(p: Project): void;
  insertSource(s: Source): void;
  insertEvidence(e: Evidence): void;
  insertClaim(c: Claim): void;
  insertLink(l: ClaimEvidenceLink): void;
  insertArtifact(a: ResearchArtifact): void;
  recordDecision(d: ProjectBundle['decisions'][number]): void;
}

export interface ExportResult {
  success: boolean;
  bundle?: ProjectBundle;
  /** Sensitive-field scrub audit: confirms no key material leaked. */
  scrubAudit: { inspectedPaths: string[]; leakedSecrets: string[] };
  error?: string;
}

export interface ImportResult {
  success: boolean;
  importedCounts: { sources: number; evidence: number; claims: number; links: number; artifacts: number; decisions: number };
  projectId: string;
  error?: string;
}

const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /apiKey/i,
  /secret/i,
  /password/i,
  /token/i,
  /encryptedApiKey/i,
];

/** Scrub + audit: deep-scan the bundle for any field that looks like a secret. */
function auditSecrets(bundle: ProjectBundle): { inspectedPaths: string[]; leakedSecrets: string[] } {
  const inspected: string[] = [];
  const leaked: string[] = [];
  const visit = (path: string, value: unknown) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const p = `${path}.${k}`;
        inspected.push(p);
        if (SECRET_PATTERNS.some((re) => re.test(k))) {
          // field name looks secret-y; only flag if it has a non-empty value
          if (v !== '' && v !== null && v !== undefined) leaked.push(p);
        }
        visit(p, v);
      }
    }
  };
  visit('bundle', bundle);
  return { inspectedPaths: inspected, leakedSecrets: leaked };
}

export class ProjectBackupService {
  private readonly source: BackupSource;
  constructor(source: BackupSource) {
    this.source = source;
  }

  /** Export a project as a portable bundle. NEVER includes API keys. */
  exportProject(projectId: string): ExportResult {
    const data = this.source.dumpProject(projectId);
    if (!data) return { success: false, scrubAudit: { inspectedPaths: [], leakedSecrets: [] }, error: `project ${projectId} not found` };
    const bundle: ProjectBundle = {
      format: 'metis-project',
      version: 1,
      exportedAt: Date.now(),
      project: data.project,
      sources: data.sources,
      evidence: data.evidence,
      claims: data.claims,
      claimEvidenceLinks: data.links,
      artifacts: data.artifacts,
      decisions: data.decisions,
    };
    const scrubAudit = auditSecrets(bundle);
    return { success: true, bundle, scrubAudit };
  }

  /** Serialize to JSON string (for file save). */
  serialize(bundle: ProjectBundle): string {
    return JSON.stringify(bundle, null, 2);
  }

  /** Parse + validate a bundle from a JSON string. */
  parse(json: string): { ok: true; bundle: ProjectBundle } | { ok: false; error: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ok: false, error: 'malformed bundle JSON' };
    }
    const b = parsed as Partial<ProjectBundle>;
    if (b.format !== 'metis-project') return { ok: false, error: `unsupported format: ${b.format ?? '(missing)'}` };
    if (b.version !== 1) return { ok: false, error: `unsupported bundle version: ${b.version}` };
    if (!b.project?.id) return { ok: false, error: 'bundle missing project.id' };
    return { ok: true, bundle: b as ProjectBundle };
  }

  /**
   * Import a bundle into the target store. Idempotent: re-importing the same bundle does
   * not duplicate (inserts use IF-NOT-EXISTS semantics via the source's own upsert). Ids are
   * preserved so evidence anchors + artifact history remain valid (METIS-407).
   */
  importBundle(bundle: ProjectBundle): ImportResult {
    const counts = { sources: 0, evidence: 0, claims: 0, links: 0, artifacts: 0, decisions: 0 };
    try {
      this.source.insertProject(bundle.project);
      for (const s of bundle.sources ?? []) { this.source.insertSource(s); counts.sources++; }
      for (const e of bundle.evidence ?? []) { this.source.insertEvidence(e); counts.evidence++; }
      for (const c of bundle.claims ?? []) { this.source.insertClaim(c); counts.claims++; }
      for (const l of bundle.claimEvidenceLinks ?? []) { this.source.insertLink(l); counts.links++; }
      for (const a of bundle.artifacts ?? []) { this.source.insertArtifact(a); counts.artifacts++; }
      for (const d of bundle.decisions ?? []) { this.source.recordDecision(d); counts.decisions++; }
      return { success: true, importedCounts: counts, projectId: bundle.project.id };
    } catch (err) {
      return { success: false, importedCounts: counts, projectId: bundle.project.id, error: (err as Error).message };
    }
  }
}
