/**
 * @vitest-environment node
 *
 * METIS-F10 — Complete project archive round-trip tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import {
  PROJECT_ARCHIVE_FORMAT,
  PROJECT_ARCHIVE_FORMAT_VERSION,
  exportProjectArchive,
  importProjectArchive,
} from '../../engine/export/ProjectArchiveExporter.js';
import type { Project, Source, Evidence, NoteCode, Claim } from '../../engine/persistence/researchModel.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-archive-test-'));
}

const T0 = 1_700_000_000_000;

function seedProject(repo: ResearchRepository): { project: Project; source: Source; evidence: Evidence } {
  const project: Project = {
    id: 'p1',
    title: 'Archive target project',
    originalIntent: 'wants to understand retrieval quality',
    researchQuestion: 'How does chunking affect RAG retrieval quality?',
    lifecycle: 'active',
    methodology: 'empirical',
    discipline: 'cs',
    metadata: { owner: 'lab-a' },
    createdAt: T0,
    updatedAt: T0 + 100,
    archivedAt: null,
    version: 3,
    source: 'user',
    deletedAt: null,
  };
  repo.createProject(project);

  const source: Source = {
    id: 's1',
    projectId: 'p1',
    kind: 'pdf',
    title: 'Chunking survey',
    authors: ['A', 'B'],
    year: 2024,
    venue: 'ARXIV',
    identifier: '10.1234/x',
    identifierType: 'doi',
    filePath: null, // filled by the test when an attachment exists
    externalUrl: null,
    tags: ['rag'],
    metadata: { pages: 12 },
    sourceVersionHash: 'abc123',
    provenance: { origin: 'import', importedAt: T0 },
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
  };
  repo.saveSource(source);

  const evidence: Evidence = {
    id: 'e1',
    projectId: 'p1',
    sourceId: 's1',
    anchorType: 'char_range',
    anchorStart: 100,
    anchorEnd: 240,
    pageNumber: 3,
    snippet: 'chunk size 512 outperforms 128',
    snippetHash: 'sha-e1',
    sourceVersionHash: 'abc123',
    confidence: 0.9,
    metadata: { note: 'primary result' },
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
  };
  repo.saveEvidence(evidence);

  const noteCode: NoteCode = {
    id: 'nc1',
    projectId: 'p1',
    evidenceId: 'e1',
    code: 'result',
    content: 'main finding',
    author: 'ai',
    confidence: 0.8,
    accepted: 1,
    tags: ['key'],
    metadata: {},
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
  };
  repo.saveNoteCode(noteCode);

  const claim: Claim = {
    id: 'c1',
    projectId: 'p1',
    statement: 'Chunk size 512 improves retrieval',
    claimType: 'finding',
    confidence: 0.9,
    status: 'supported',
    metadata: {},
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
  };
  repo.saveClaim(claim);
  repo.linkClaimEvidence({ id: 'l1', claimId: 'c1', evidenceId: 'e1', relation: 'supports', weight: 1.0, note: '', createdAt: T0 });

  // Soft-deleted rows must survive the round trip too.
  repo.saveSource({
    ...source,
    id: 's2',
    title: 'Deleted source',
    filePath: null,
    deletedAt: T0 + 50,
  });

  repo.saveRun({
    id: 'r1',
    projectId: 'p1',
    status: 'completed',
    plan: { steps: ['retrieve', 'synthesize'] },
    providerProfile: { model: 'gpt-4o' },
    currentStepId: 'synthesize',
    createdAt: T0,
    updatedAt: T0,
    completedAt: T0 + 60,
    deletedAt: null,
  });
  repo.recordCheckpoint({
    id: 'ck1',
    projectId: 'p1',
    runId: 'r1',
    stepId: 'retrieve',
    lifecycle: 'active',
    inputHash: 'in-hash',
    outputHash: 'out-hash',
    completedSteps: ['retrieve'],
    output: { count: 42 },
    decisions: [],
    sideEffectKeys: ['k1'],
    pendingSteps: [],
    runtimeProfileVersion: '1.0',
    errorCategory: null,
    recoveryStrategy: null,
    createdAt: T0,
  });
  repo.recordDecision({
    id: 'd1',
    projectId: 'p1',
    runId: 'r1',
    targetKind: 'source',
    targetId: 's1',
    decision: 'accept',
    origin: 'human',
    beforeValue: {},
    afterValue: { title: 'Chunking survey' },
    note: 'keep',
    createdAt: T0,
    undoneAt: null,
  });

  return { project, source, evidence };
}

describe('ProjectArchiveExporter', () => {
  let dir: string;
  let store: PersistenceStore;
  let repo: ResearchRepository;

  beforeEach(() => {
    dir = tempDir();
    store = new PersistenceStore(path.join(dir, 'metis.db'));
    repo = new ResearchRepository(store.raw);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exports a single-file archive whose metadata round-trips', async () => {
    seedProject(repo);
    const destPath = path.join(dir, 'exports', 'p1.mts');

    const result = await exportProjectArchive({ db: store.raw, projectId: 'p1', destPath, appVersion: '0.1.0-test' });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(destPath)).toBe(true);
    expect(result.manifest).toBeTruthy();
    expect(result.manifest!.format).toBe(PROJECT_ARCHIVE_FORMAT);
    expect(result.manifest!.formatVersion).toBe(PROJECT_ARCHIVE_FORMAT_VERSION);
    expect(result.manifest!.appVersion).toBe('0.1.0-test');
    expect(result.manifest!.projectTitle).toBe('Archive target project');
    expect(result.manifest!.entityCounts.projects).toBe(1);
    expect(result.manifest!.entityCounts.sources).toBe(2); // includes soft-deleted
    expect(result.manifest!.entityCounts.evidence).toBe(1);
    expect(result.manifest!.entityCounts.claims).toBe(1);
    expect(result.manifest!.entityCounts.research_runs).toBe(1);

    // The archive is a real SQLite file: reopen it and verify meta directly.
    const archive = new Database(destPath, { readonly: true });
    try {
      const meta = archive.prepare('SELECT value FROM archive_meta WHERE key = ?').get('projectTitle') as { value: string };
      expect(meta.value).toBe('Archive target project');
      const sources = archive.prepare('SELECT * FROM sources').all() as Array<Record<string, unknown>>;
      expect(sources.length).toBe(2);
      const softDeleted = sources.find((s) => s.id === 's2');
      expect(softDeleted?.deleted_at).not.toBeNull();
    } finally {
      archive.close();
    }
  });

  it('round-trips a project into a fresh database with full fidelity', async () => {
    seedProject(repo);
    const archivePath = path.join(dir, 'p1.mts');
    const exportResult = await exportProjectArchive({ db: store.raw, projectId: 'p1', destPath: archivePath });
    expect(exportResult.ok).toBe(true);

    const restoredDir = path.join(dir, 'restored');
    fs.mkdirSync(restoredDir, { recursive: true });
    const store2 = new PersistenceStore(path.join(restoredDir, 'metis.db'));
    try {
      const repo2 = new ResearchRepository(store2.raw);
      const importResult = await importProjectArchive({
        db: store2.raw,
        archivePath,
        filesDir: path.join(dir, 'restored-files'),
      });
      expect(importResult.ok).toBe(true);
      expect(importResult.restored?.projectId).toBe('p1');

      const restored = repo2.getProject('p1');
      expect(restored).toBeTruthy();
      expect(restored!.title).toBe('Archive target project');
      expect(restored!.version).toBe(3);
      expect(restored!.metadata).toEqual({ owner: 'lab-a' });

      const sources = repo2.listSources('p1', true);
      expect(sources.length).toBe(2);
      const softDeleted = sources.find((s) => s.id === 's2');
      expect(softDeleted?.deletedAt).not.toBeNull();
      expect(softDeleted?.title).toBe('Deleted source');

      const evidence = repo2.listEvidence('p1');
      expect(evidence.length).toBe(1);
      expect(evidence[0]!.snippet).toBe('chunk size 512 outperforms 128');
      expect(evidence[0]!.anchorStart).toBe(100);

      const noteCodes = repo2.listNoteCodes('p1');
      expect(noteCodes.length).toBe(1);
      expect(noteCodes[0]!.code).toBe('result');

      const claims = repo2.listClaims('p1');
      expect(claims.length).toBe(1);
      const links = repo2.listClaimEvidenceLinks('p1');
      expect(links.length).toBe(1);
      expect(links[0]!.claimId).toBe('c1');

      const runs = repo2.listRuns('p1');
      expect(runs.length).toBe(1);
      expect(runs[0]!.status).toBe('completed');
      const checkpoints = repo2.listCheckpoints('r1');
      expect(checkpoints.length).toBe(1);
      expect(checkpoints[0]!.output).toEqual({ count: 42 });

      const decisions = repo2.listDecisions('p1');
      expect(decisions.length).toBe(1);
      expect(decisions[0]!.afterValue).toEqual({ title: 'Chunking survey' });
    } finally {
      store2.close();
    }
  });

  it('rejects a conflicting import unless overwrite is requested', async () => {
    seedProject(repo);
    const archivePath = path.join(dir, 'p1.mts');
    const exportResult = await exportProjectArchive({ db: store.raw, projectId: 'p1', destPath: archivePath });
    expect(exportResult.ok).toBe(true);

    // Target already has the project.
    const conflict = await importProjectArchive({ db: store.raw, archivePath, filesDir: dir });
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toContain('project_exists');

    // Overwrite succeeds and is idempotent.
    const overwritten = await importProjectArchive({ db: store.raw, archivePath, filesDir: dir, overwrite: true });
    expect(overwritten.ok).toBe(true);
    expect(repo.listSources('p1', true).length).toBe(2);
  });

  it('imports under a remapped project id without touching the original', async () => {
    seedProject(repo);
    const archivePath = path.join(dir, 'p1.mts');
    const exportResult = await exportProjectArchive({ db: store.raw, projectId: 'p1', destPath: archivePath });
    expect(exportResult.ok).toBe(true);

    const copyDir = path.join(dir, 'copy');
    fs.mkdirSync(copyDir, { recursive: true });
    const store2 = new PersistenceStore(path.join(copyDir, 'metis.db'));
    try {
      const repo2 = new ResearchRepository(store2.raw);
      const importResult = await importProjectArchive({
        db: store2.raw,
        archivePath,
        projectId: 'p1-copy',
        filesDir: path.join(dir, 'copy-files'),
      });
      expect(importResult.ok).toBe(true);
      expect(importResult.restored?.projectId).toBe('p1-copy');

      const copied = repo2.getProject('p1-copy');
      expect(copied?.title).toBe('Archive target project');
      expect(repo2.getProject('p1')).toBeUndefined();
      const sources = repo2.listSources('p1-copy', true);
      expect(sources.length).toBe(2);
      expect(sources.every((s) => s.projectId === 'p1-copy')).toBe(true);
      const evidence = repo2.listEvidence('p1-copy');
      expect(evidence.length).toBe(1);
      expect(evidence[0]!.projectId).toBe('p1-copy');
      expect(repo2.listRuns('p1-copy').length).toBe(1);
      expect(repo2.listDecisions('p1-copy').length).toBe(1);
    } finally {
      store2.close();
    }
  });

  it('archives attached source files and restores them with sha256 verification', async () => {
    const attachment = path.join(dir, 'paper.pdf');
    fs.writeFileSync(attachment, 'fake pdf bytes for attachment round trip');
    seedProject(repo);
    repo.saveSource({ ...repo.getSource('s1', true)!, filePath: attachment });

    const archivePath = path.join(dir, 'p1.mts');
    const exportResult = await exportProjectArchive({ db: store.raw, projectId: 'p1', destPath: archivePath });
    expect(exportResult.ok).toBe(true);
    expect(exportResult.manifest!.attachedFiles.count).toBe(1);
    expect(exportResult.manifest!.attachedFiles.skipped).toEqual([]);

    const restoredDir = path.join(dir, 'restored');
    fs.mkdirSync(restoredDir, { recursive: true });
    const store2 = new PersistenceStore(path.join(restoredDir, 'metis.db'));
    try {
      const repo2 = new ResearchRepository(store2.raw);
      const importResult = await importProjectArchive({
        db: store2.raw,
        archivePath,
        filesDir: path.join(dir, 'restored-files'),
      });
      expect(importResult.ok).toBe(true);
      expect(importResult.restored!.attachedFiles.count).toBe(1);

      const restoredSource = repo2.getSource('s1', true)!;
      expect(restoredSource.filePath).toBeTruthy();
      expect(restoredSource.filePath).toContain('restored-files');
      expect(fs.readFileSync(restoredSource.filePath!, 'utf-8')).toBe('fake pdf bytes for attachment round trip');
    } finally {
      store2.close();
    }
  });

  it('records missing attachments as skipped instead of failing', async () => {
    seedProject(repo);
    repo.saveSource({ ...repo.getSource('s1', true)!, filePath: path.join(dir, 'does-not-exist.pdf') });

    const archivePath = path.join(dir, 'p1.mts');
    const exportResult = await exportProjectArchive({ db: store.raw, projectId: 'p1', destPath: archivePath });
    expect(exportResult.ok).toBe(true);
    expect(exportResult.manifest!.attachedFiles.count).toBe(0);
    expect(exportResult.manifest!.attachedFiles.skipped.length).toBe(1);
    expect(exportResult.manifest!.attachedFiles.skipped[0]!.reason).toBe('file_missing');
  });

  it('fails cleanly for an unknown project', async () => {
    const result = await exportProjectArchive({ db: store.raw, projectId: 'nope', destPath: path.join(dir, 'x.mts') });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Project not found');
  });
});

describe('ProjectArchiveExporter linked library papers', () => {
  let dir: string;
  let store: PersistenceStore;
  let repo: ResearchRepository;

  beforeEach(() => {
    dir = tempDir();
    store = new PersistenceStore(path.join(dir, 'metis.db'));
    repo = new ResearchRepository(store.raw);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('carries linked library papers and their PDFs across devices', async () => {
    seedProject(repo);
    // A paper linked to the project, with a real PDF file on disk.
    const pdfPath = path.join(dir, 'paper-one.pdf');
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-1.4\nlinked paper content'));
    store.savePaper({
      id: 'paper-1',
      title: 'Linked Paper',
      authors: ['Ada'],
      year: 2024,
      venue: 'ACL',
      abstract: 'abstract',
      doi: '10.1/linked',
      pdfPath,
      tags: [],
      notes: '',
      readStatus: 'unread',
      rating: 0,
      addedAt: T0,
      projectId: 'p1',
    });
    // A library-only paper must NOT travel with this project.
    store.savePaper({
      id: 'paper-global',
      title: 'Global Paper',
      authors: [],
      year: 2024,
      venue: '',
      abstract: '',
      tags: [],
      notes: '',
      readStatus: 'unread',
      rating: 0,
      addedAt: T0,
    });

    const destPath = path.join(dir, 'exports', 'p1.mts');
    const exported = await exportProjectArchive({ db: store.raw, projectId: 'p1', destPath });
    expect(exported.ok).toBe(true);
    // The whole library travels with the archive (linked + global papers).
    expect(exported.manifest?.entityCounts.papers).toBe(2);
    expect(exported.manifest?.attachedFiles.count).toBe(1);

    // "Second device": a fresh database + repository.
    const freshDir = path.join(dir, 'device2');
    fs.mkdirSync(freshDir, { recursive: true });
    const freshStore = new PersistenceStore(path.join(freshDir, 'metis.db'));
    try {
      const imported = await importProjectArchive({
        db: freshStore.raw,
        archivePath: destPath,
        filesDir: freshDir,
      });
      expect(imported.ok).toBe(true);

      const papers = freshStore.getPapers();
      expect(papers.some((p) => p.id === 'paper-1')).toBe(true);
      expect(papers.find((p) => p.id === 'paper-1')?.projectId).toBe('p1');
      // The whole library travels with the archive.
      expect(papers.some((p) => p.id === 'paper-global')).toBe(true);
      // The PDF was restored and repointed.
      const restored = papers.find((p) => p.id === 'paper-1');
      expect(restored?.pdfPath).toBeTruthy();
      expect(fs.existsSync(restored!.pdfPath!)).toBe(true);
      expect(fs.readFileSync(restored!.pdfPath!)).toEqual(Buffer.from('%PDF-1.4\nlinked paper content'));
    } finally {
      freshStore.close();
    }
  });

  it('remaps paper project links when importing under a new project id', async () => {
    seedProject(repo);
    store.savePaper({
      id: 'paper-2',
      title: 'Remap Paper',
      authors: [],
      year: 2024,
      venue: '',
      abstract: '',
      tags: [],
      notes: '',
      readStatus: 'unread',
      rating: 0,
      addedAt: T0,
      projectId: 'p1',
    });
    const destPath = path.join(dir, 'exports', 'p1.mts');
    const exported = await exportProjectArchive({ db: store.raw, projectId: 'p1', destPath });
    expect(exported.ok).toBe(true);

    const freshDir = path.join(dir, 'device2');
    fs.mkdirSync(freshDir, { recursive: true });
    const freshStore = new PersistenceStore(path.join(freshDir, 'metis.db'));
    try {
      const imported = await importProjectArchive({
        db: freshStore.raw,
        archivePath: destPath,
        projectId: 'imported-copy',
        filesDir: freshDir,
      });
      expect(imported.ok).toBe(true);
      const papers = freshStore.getPapers();
      expect(papers.find((p) => p.id === 'paper-2')?.projectId).toBe('imported-copy');
    } finally {
      freshStore.close();
    }
  });
});

describe('ProjectArchiveExporter conversations', () => {
  let dir: string;
  let store: PersistenceStore;
  let repo: ResearchRepository;

  beforeEach(() => {
    dir = tempDir();
    store = new PersistenceStore(path.join(dir, 'metis.db'));
    repo = new ResearchRepository(store.raw);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('carries project conversations with their full message history', async () => {
    seedProject(repo);
    // A project-bound conversation with messages.
    store.createSession('session-p1', undefined, 'p1');
    store.appendMessage('session-p1', 'user', '项目里的问题');
    store.appendMessage('session-p1', 'assistant', '项目里的回答');
    // A global conversation that must NOT travel with the project.
    store.createSession('session-global');
    store.appendMessage('session-global', 'user', '全局对话');

    const destPath = path.join(dir, 'exports', 'p1.mts');
    const exported = await exportProjectArchive({ db: store.raw, projectId: 'p1', destPath });
    expect(exported.ok).toBe(true);
    expect(exported.manifest?.entityCounts.sessions).toBe(1);
    expect(exported.manifest?.entityCounts.messages).toBe(2);

    const freshDir = path.join(dir, 'device2');
    fs.mkdirSync(freshDir, { recursive: true });
    const freshStore = new PersistenceStore(path.join(freshDir, 'metis.db'));
    try {
      const imported = await importProjectArchive({ db: freshStore.raw, archivePath: destPath, filesDir: freshDir });
      expect(imported.ok).toBe(true);

      const sessions = freshStore.listSessions();
      expect(sessions.some((s) => s.id === 'session-p1' && s.projectId === 'p1')).toBe(true);
      expect(sessions.some((s) => s.id === 'session-global')).toBe(false);
      const messages = freshStore.getMessages('session-p1');
      expect(messages.map((m) => m.content)).toEqual(['项目里的问题', '项目里的回答']);
    } finally {
      freshStore.close();
    }
  });

  it('remaps conversation project links when importing under a new id', async () => {
    seedProject(repo);
    store.createSession('session-p1', undefined, 'p1');
    store.appendMessage('session-p1', 'user', '消息');
    const destPath = path.join(dir, 'exports', 'p1.mts');
    const exported = await exportProjectArchive({ db: store.raw, projectId: 'p1', destPath });
    expect(exported.ok).toBe(true);

    const freshDir = path.join(dir, 'device2');
    fs.mkdirSync(freshDir, { recursive: true });
    const freshStore = new PersistenceStore(path.join(freshDir, 'metis.db'));
    try {
      const imported = await importProjectArchive({
        db: freshStore.raw,
        archivePath: destPath,
        projectId: 'imported-copy',
        filesDir: freshDir,
      });
      expect(imported.ok).toBe(true);
      const sessions = freshStore.listSessions();
      expect(sessions.find((s) => s.id === 'session-p1')?.projectId).toBe('imported-copy');
      expect(freshStore.getMessages('session-p1')).toHaveLength(1);
    } finally {
      freshStore.close();
    }
  });
});
