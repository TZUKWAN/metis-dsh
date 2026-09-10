/**
 * METIS-407 — Project backup / import-export tests.
 *
 * Covers: export captures all six entities; API keys / secrets are NEVER in the bundle
 * (scrub audit); bundle round-trips through serialize → parse; import preserves ids so
 * evidence anchors + artifact history remain usable; import is idempotent.
 */

import { describe, it, expect } from 'vitest';
import { ProjectBackupService, type BackupSource, type ProjectBundle } from './ProjectBackup.js';
import type { Project, Source, Evidence, Claim, ClaimEvidenceLink, ResearchArtifact } from '../persistence/researchModel.js';

class MemBackupSource implements BackupSource {
  projects = new Map<string, Project>();
  sources = new Map<string, Source>();
  evidence = new Map<string, Evidence>();
  claims = new Map<string, Claim>();
  links = new Map<string, ClaimEvidenceLink>();
  artifacts = new Map<string, ResearchArtifact>();
  decisions: Array<{ id: string; text: string; at: number; context?: string }> = [];

  dumpProject(pid: string) {
    const project = this.projects.get(pid);
    if (!project) return undefined;
    return {
      project,
      sources: [...this.sources.values()].filter((s) => s.projectId === pid),
      evidence: [...this.evidence.values()].filter((e) => e.projectId === pid),
      claims: [...this.claims.values()].filter((c) => c.projectId === pid),
      links: [...this.links.values()].filter((l) => this.claims.get(l.claimId)?.projectId === pid),
      artifacts: [...this.artifacts.values()].filter((a) => a.projectId === pid),
      decisions: this.decisions,
    };
  }
  hasProject(pid: string) { return this.projects.has(pid); }
  insertProject(p: Project) { this.projects.set(p.id, { ...p }); }
  insertSource(s: Source) { if (!this.sources.has(s.id)) this.sources.set(s.id, { ...s }); }
  insertEvidence(e: Evidence) { if (!this.evidence.has(e.id)) this.evidence.set(e.id, { ...e }); }
  insertClaim(c: Claim) { if (!this.claims.has(c.id)) this.claims.set(c.id, { ...c }); }
  insertLink(l: ClaimEvidenceLink) { if (!this.links.has(l.id)) this.links.set(l.id, { ...l }); }
  insertArtifact(a: ResearchArtifact) { if (!this.artifacts.has(a.id)) this.artifacts.set(a.id, { ...a }); }
  recordDecision(d: ProjectBundle['decisions'][number]) { if (!this.decisions.find((x) => x.id === d.id)) this.decisions.push(d); }
}

function seed(src: BackupSource) {
  const now = Date.now();
  const project: Project = { id: 'p1', title: 'P', originalIntent: 'i', researchQuestion: 'q', lifecycle: 'draft', methodology: 'm', discipline: 'sociology', metadata: {}, createdAt: now, updatedAt: now, archivedAt: null, version: 1, source: 'user', deletedAt: null };
  src.insertProject(project);
  src.insertSource({ id: 's1', projectId: 'p1', kind: 'paper', title: 'Paper', authors: [], year: 2020, venue: '', identifier: '10.1/x', identifierType: 'doi', filePath: null, externalUrl: null, tags: [], metadata: {}, sourceVersionHash: 'v1', provenance: {}, createdAt: now, updatedAt: now, deletedAt: null });
  src.insertEvidence({ id: 'e1', projectId: 'p1', sourceId: 's1', anchorType: 'page', anchorStart: null, anchorEnd: null, pageNumber: 5, snippet: '原句', snippetHash: 'h', sourceVersionHash: 'v1', confidence: 0.8, metadata: {}, createdAt: now, updatedAt: now, deletedAt: null });
  src.insertClaim({ id: 'c1', projectId: 'p1', statement: '论断', claimType: 'assertion', confidence: 0.7, status: 'supported', metadata: {}, createdAt: now, updatedAt: now, deletedAt: null });
  src.insertLink({ id: 'l1', claimId: 'c1', evidenceId: 'e1', relation: 'supports', weight: 1, note: '', createdAt: now });
  src.insertArtifact({ id: 'a1', projectId: 'p1', title: '初稿', artifactType: 'manuscript', reviewStatus: 'draft', contentRef: null, inputHash: null, provenance: {}, metadata: {}, version: 1, createdAt: now, updatedAt: now, deletedAt: null });
  src.recordDecision({ id: 'd1', text: '采用 DID', at: now });
}

describe('METIS-407 ProjectBackup — export captures everything', () => {
  it('exports a bundle with all six entity sets + decisions', () => {
    const src = new MemBackupSource();
    seed(src);
    const svc = new ProjectBackupService(src);
    const r = svc.exportProject('p1');
    expect(r.success).toBe(true);
    const b = r.bundle!;
    expect(b.format).toBe('metis-project');
    expect(b.version).toBe(1);
    expect(b.sources).toHaveLength(1);
    expect(b.evidence).toHaveLength(1);
    expect(b.claims).toHaveLength(1);
    expect(b.claimEvidenceLinks).toHaveLength(1);
    expect(b.artifacts).toHaveLength(1);
    expect(b.decisions).toHaveLength(1);
  });

  it('fails gracefully when the project does not exist', () => {
    const svc = new ProjectBackupService(new MemBackupSource());
    const r = svc.exportProject('nope');
    expect(r.success).toBe(false);
  });
});

describe('METIS-407 ProjectBackup — NO secrets in the bundle (scrub audit)', () => {
  it('the scrub audit finds zero leaked secrets for a clean project', () => {
    const src = new MemBackupSource();
    seed(src);
    const svc = new ProjectBackupService(src);
    const r = svc.exportProject('p1');
    expect(r.scrubAudit.leakedSecrets).toEqual([]);
  });

  it('the scrub audit flags a project that (erroneously) carries an apiKey in metadata', () => {
    const src = new MemBackupSource();
    seed(src);
    // simulate an accidental leak into project metadata
    const p = src.projects.get('p1')!;
    p.metadata = { apiKey: 'sk-leaked-1234567890' };
    src.insertProject(p);
    const svc = new ProjectBackupService(src);
    const r = svc.exportProject('p1');
    expect(r.scrubAudit.leakedSecrets.length).toBeGreaterThan(0);
    expect(r.scrubAudit.leakedSecrets.some((s) => s.includes('apiKey'))).toBe(true);
  });

  it('serialize never contains a raw API key for a clean project', () => {
    const src = new MemBackupSource();
    seed(src);
    const svc = new ProjectBackupService(src);
    const r = svc.exportProject('p1');
    const json = svc.serialize(r.bundle!);
    expect(json).not.toMatch(/sk-leaked|apiKey.*sk-/i);
  });
});

describe('METIS-407 ProjectBackup — round-trip + import on a clean machine', () => {
  it('serializes and parses back losslessly', () => {
    const src = new MemBackupSource();
    seed(src);
    const svc = new ProjectBackupService(src);
    const bundle = svc.exportProject('p1').bundle!;
    const json = svc.serialize(bundle);
    const parsed = svc.parse(json);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.bundle.project.id).toBe('p1');
      expect(parsed.bundle.evidence[0]?.id).toBe('e1');
    }
  });

  it('parse rejects wrong format / wrong version / missing project', () => {
    const svc = new ProjectBackupService(new MemBackupSource());
    expect(svc.parse('not json').ok).toBe(false);
    expect(svc.parse(JSON.stringify({ format: 'other', version: 1 })).ok).toBe(false);
    expect(svc.parse(JSON.stringify({ format: 'metis-project', version: 99 })).ok).toBe(false);
    expect(svc.parse(JSON.stringify({ format: 'metis-project', version: 1 })).ok).toBe(false);
  });

  it('import into a clean machine preserves ids (evidence anchors + artifact history usable)', () => {
    const exportSrc = new MemBackupSource();
    seed(exportSrc);
    const svc = new ProjectBackupService(exportSrc);
    const bundle = svc.exportProject('p1').bundle!;

    const importSrc = new MemBackupSource(); // a clean machine
    const importSvc = new ProjectBackupService(importSrc);
    const r = importSvc.importBundle(bundle);
    expect(r.success).toBe(true);
    expect(r.importedCounts.sources).toBe(1);
    expect(r.importedCounts.evidence).toBe(1);
    // ids preserved → evidence anchor points back to the same source/page
    expect(importSrc.evidence.get('e1')?.sourceId).toBe('s1');
    expect(importSrc.evidence.get('e1')?.pageNumber).toBe(5);
    expect(importSrc.artifacts.get('a1')?.version).toBe(1);
  });

  it('import is idempotent (re-importing the same bundle does not duplicate)', () => {
    const exportSrc = new MemBackupSource();
    seed(exportSrc);
    const svc = new ProjectBackupService(exportSrc);
    const bundle = svc.exportProject('p1').bundle!;

    const importSrc = new MemBackupSource();
    const importSvc = new ProjectBackupService(importSrc);
    importSvc.importBundle(bundle);
    const r2 = importSvc.importBundle(bundle);
    expect(r2.success).toBe(true);
    expect(importSrc.sources.size).toBe(1);
    expect(importSrc.evidence.size).toBe(1);
    expect(importSrc.claims.size).toBe(1);
  });
});
