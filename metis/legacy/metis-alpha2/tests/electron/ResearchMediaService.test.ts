import fs from 'node:fs';

import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { realTempRoot } from './helpers/realTempDir.mjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import type { Project, Source } from '../../engine/persistence/researchModel.js';
import {
  decodeResearchArtifactVersionRequest,
  type ResearchArtifactVersionRequest,
} from '../../engine/runtime/ResearchRuntimeContract.js';
import { buildResearchExport } from '../../engine/export/ResearchExportBuilder.js';
import { FileCapabilityRegistry } from '../../electron/FileCapabilityRegistry.js';
import { ResearchMediaService } from '../../electron/ResearchMediaService.js';
import { ResearchRuntimeService } from '../../electron/ResearchRuntimeService.js';
import {
  buildExportSnapshot,
  resolveTrustedArtifactExportBinding,
} from '../../electron/ResearchExportAdapter.js';
import { SecureExportService } from '../../electron/SecureExportService.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlV9Z8AAAAASUVORK5CYII=',
  'base64',
);
const OWNER_A = {
  webContentsId: 101,
  mainFrameProcessId: 201,
  mainFrameRoutingId: 301,
} as const;
const OWNER_B = {
  webContentsId: 102,
  mainFrameProcessId: 202,
  mainFrameRoutingId: 302,
} as const;

function project(id: string): Project {
  const now = Date.now();
  return {
    id,
    title: `Project ${id}`,
    originalIntent: 'Export a production research artifact.',
    researchQuestion: 'Does the trusted media chain preserve the exact image?',
    lifecycle: 'draft',
    methodology: 'Integration test',
    discipline: 'Computer science',
    metadata: {},
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    version: 1,
    source: 'user',
    deletedAt: null,
  };
}

function regularSource(id: string, projectId: string): Source {
  const now = Date.now();
  return {
    id,
    projectId,
    kind: 'paper',
    title: 'Concurrent source',
    authors: [],
    year: null,
    venue: '',
    identifier: '',
    identifierType: 'other',
    filePath: null,
    externalUrl: null,
    tags: [],
    metadata: {},
    sourceVersionHash: null,
    provenance: { origin: 'test' },
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function unzip(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed));
    offset = dataStart + compressedSize;
  }
  return entries;
}

function listRegularFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  };
  visit(root);
  return files;
}

describe('MEDIA-303 production research media trust chain', () => {
  let temporaryRoot: string;
  let managedRoot: string;
  let externalRoot: string;
  let exportRoot: string;
  let store: PersistenceStore;
  let repository: ResearchRepository;
  let capabilities: FileCapabilityRegistry;
  let media: ResearchMediaService;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(realTempRoot(), 'metis-media-303-'));
    managedRoot = path.join(temporaryRoot, 'managed');
    externalRoot = path.join(temporaryRoot, 'external');
    exportRoot = path.join(temporaryRoot, 'exports');
    fs.mkdirSync(externalRoot, { recursive: true });
    fs.mkdirSync(exportRoot, { recursive: true });
    store = new PersistenceStore(path.join(temporaryRoot, 'metis.db'));
    repository = new ResearchRepository(store.raw);
    repository.createProject(project('project_media_a'));
    repository.createProject(project('project_media_b'));
    capabilities = new FileCapabilityRegistry();
    media = new ResearchMediaService({
      repository,
      fileCapabilities: capabilities,
      managedRoot,
    });
  });

  afterEach(() => {
    capabilities.clear();
    store.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function issue(bytes: Buffer, displayName = 'figure.png') {
    const filePath = path.join(externalRoot, `${Date.now()}-${Math.random()}-${displayName}`);
    fs.writeFileSync(filePath, bytes);
    const result = capabilities.issue({
      path: filePath,
      kind: 'file',
      mime: 'application/octet-stream',
      displayName,
      operations: ['read'],
    }, OWNER_A);
    if (!result.success) throw new Error('Failed to issue test file capability');
    return { filePath, capabilityId: result.capability.capabilityId };
  }

  async function attach(
    sourceId: string,
    options: { projectId?: string; bytes?: Buffer; caption?: string; ordinal?: number } = {},
  ) {
    const selected = issue(options.bytes ?? PNG);
    const result = await media.attach({
      projectId: options.projectId ?? 'project_media_a',
      sourceId,
      capabilityId: selected.capabilityId,
      caption: options.caption ?? 'Figure 1: trusted one-pixel image',
      ordinal: options.ordinal ?? 0,
    }, OWNER_A);
    return { result, selected };
  }

  function saveVersion(
    runtime: ResearchRuntimeService,
    sourceId: string,
    artifactId = 'artifact_media_001',
  ): number {
    const decoded = decodeResearchArtifactVersionRequest({
      operation: 'save_version',
      projectId: 'project_media_a',
      artifactId,
      expectedVersion: null,
      title: 'Media-backed research artifact',
      artifactType: 'report',
      reviewStatus: 'draft',
      inputs: [],
      capabilityId: 'research_editor',
      method: 'save exact version',
      citedSourceIds: [],
      rendererKind: 'markdown',
      contentRef: null,
      media: [{
        sourceId,
        caption: 'Figure 1: trusted one-pixel image',
        ordinal: 0,
      }],
      inputHash: null,
      content: 'Figure 1 is embedded from a managed project source.',
      createdBy: 'user',
      branchFromVersion: null,
    });
    if (!decoded.ok) throw new Error('Test version request did not decode');
    const result = runtime.handleVersion(decoded.value as ResearchArtifactVersionRequest);
    if (!result.success || !('version' in result) || result.version === undefined) {
      throw new Error('Test artifact version was not saved');
    }
    return result.version;
  }

  it('consumes a pathless capability and returns only a bounded safe DTO', async () => {
    const { result, selected } = await attach('source_media_safe');
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.media).toMatchObject({
      sourceId: 'source_media_safe',
      mediaType: 'image/png',
      byteLength: PNG.byteLength,
      widthPx: 1,
      heightPx: 1,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(temporaryRoot);
    expect(serialized).not.toContain(selected.filePath);
    expect(serialized).not.toContain('filePath');
    expect(serialized).not.toContain('resolvedPath');
    expect(serialized).not.toContain('base64Data');

    const source = repository.getSource('source_media_safe');
    expect(source?.filePath).toBeTruthy();
    expect(source?.sourceVersionHash).toBe(result.media.sha256);
    expect(source?.filePath && path.relative(managedRoot, source.filePath).startsWith('..')).toBe(false);
    expect(source?.filePath && fs.lstatSync(source.filePath).isSymbolicLink()).toBe(false);
    expect(source?.filePath && fs.readFileSync(source.filePath)).toEqual(PNG);

    const consumed = await media.attach({
      projectId: 'project_media_a',
      sourceId: 'source_media_reuse',
      capabilityId: selected.capabilityId,
      caption: 'Capability reuse must fail',
      ordinal: 0,
    }, OWNER_A);
    expect(consumed.success).toBe(false);
  });

  it('rejects a secondary BrowserWindow owner while preserving the grant for its issuer', async () => {
    const selected = issue(PNG, 'owner-bound.png');
    const request = {
      projectId: 'project_media_a',
      sourceId: 'source_owner_bound',
      capabilityId: selected.capabilityId,
      caption: 'Owner-bound media',
      ordinal: 0,
    } as const;
    const secondaryWindow = await media.attach(request, OWNER_B);
    expect(secondaryWindow.success).toBe(false);
    expect(repository.getSource('source_owner_bound', true)).toBeUndefined();

    const issuingWindow = await media.attach(request, OWNER_A);
    expect(issuingWindow.success).toBe(true);
    const replay = await media.attach({ ...request, sourceId: 'source_owner_replay' }, OWNER_A);
    expect(replay.success).toBe(false);
    expect(repository.getSource('source_owner_replay', true)).toBeUndefined();
  });

  it('fails closed for invalid bytes, oversized files, missing projects, and TOCTOU mutation', async () => {
    const invalid = await attach('source_invalid', { bytes: Buffer.from('<html>not an image</html>') });
    expect(invalid.result.success).toBe(false);

    const oversized = await attach('source_oversized', {
      bytes: Buffer.alloc(3 * 1024 * 1024 + 1, 0x41),
    });
    expect(oversized.result.success).toBe(false);

    const missingProject = await attach('source_missing_project', { projectId: 'project_missing' });
    expect(missingProject.result.success).toBe(false);

    const selected = issue(PNG, 'toctou.png');
    const toctouService = new ResearchMediaService({
      repository,
      fileCapabilities: capabilities,
      managedRoot,
      sourceReadBarrier: async (_handle, sourcePath) => {
        await fs.promises.appendFile(sourcePath, Buffer.from([0]));
      },
    });
    const toctou = await toctouService.attach({
      projectId: 'project_media_a',
      sourceId: 'source_toctou',
      capabilityId: selected.capabilityId,
      caption: 'TOCTOU must fail closed',
      ordinal: 0,
    }, OWNER_A);
    expect(toctou.success).toBe(false);
    expect(repository.getSource('source_toctou', true)).toBeUndefined();
    expect(listRegularFiles(managedRoot)).toHaveLength(0);
  });

  it('cleans an atomically published file if a concurrent source-id conflict wins', async () => {
    const selected = issue(PNG, 'conflict.png');
    const conflictService = new ResearchMediaService({
      repository,
      fileCapabilities: capabilities,
      managedRoot,
      sourceReadBarrier: async () => {
        repository.insertSourceIfAbsent(regularSource('source_conflict', 'project_media_a'));
      },
    });
    const result = await conflictService.attach({
      projectId: 'project_media_a',
      sourceId: 'source_conflict',
      capabilityId: selected.capabilityId,
      caption: 'Concurrent source conflict',
      ordinal: 0,
    }, OWNER_A);
    expect(result).toEqual({ success: false, code: 'research_media_conflict' });
    expect(repository.getSource('source_conflict')?.kind).toBe('paper');
    expect(listRegularFiles(managedRoot)).toHaveLength(0);
  });

  it('rejects a symlinked managed root instead of publishing outside the configured root', async () => {
    const realRoot = path.join(temporaryRoot, 'real-managed-root');
    const linkedRoot = path.join(temporaryRoot, 'linked-managed-root');
    fs.mkdirSync(realRoot);
    try {
      fs.symlinkSync(realRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      expect(['EPERM', 'EACCES', 'ENOSYS']).toContain(code);
      return;
    }
    const selected = issue(PNG, 'root-link.png');
    const linkedService = new ResearchMediaService({
      repository,
      fileCapabilities: capabilities,
      managedRoot: linkedRoot,
    });
    const result = await linkedService.attach({
      projectId: 'project_media_a',
      sourceId: 'source_root_link',
      capabilityId: selected.capabilityId,
      caption: 'Symlinked root must fail',
      ordinal: 0,
    }, OWNER_A);
    expect(result.success).toBe(false);
    expect(repository.getSource('source_root_link', true)).toBeUndefined();
    expect(listRegularFiles(realRoot)).toHaveLength(0);
  });

  it('binds only active same-project managed sources and protects their trusted fields', async () => {
    const attached = await attach('source_scope');
    expect(attached.result.success).toBe(true);
    const reference = [{ sourceId: 'source_scope', caption: 'Scoped image', ordinal: 0 }];
    expect(media.resolveManifestDescriptors('project_media_a', reference)).toHaveLength(1);
    expect(media.resolveManifestDescriptors('project_media_b', reference)).toBeNull();

    const runtime = new ResearchRuntimeService(repository, media);
    const rendererHashCreate = runtime.handleCrud({
      operation: 'create',
      entityKind: 'source',
      projectId: 'project_media_a',
      value: {
        id: 'source_renderer_hash',
        kind: 'image',
        title: 'Renderer-owned hash must be rejected',
        authors: [],
        year: null,
        venue: '',
        identifier: '',
        identifierType: 'other',
        externalUrl: null,
        tags: [],
        sourceVersionHash: '0'.repeat(64),
      },
    });
    expect(rendererHashCreate).toEqual({ success: false, code: 'rejected' });
    const updateHash = runtime.handleCrud({
      operation: 'update',
      entityKind: 'source',
      projectId: 'project_media_a',
      entityId: 'source_scope',
      patch: { sourceVersionHash: '0'.repeat(64) },
    });
    expect(updateHash).toEqual({ success: false, code: 'rejected' });
    expect(repository.getSource('source_scope')?.sourceVersionHash).not.toBe('0'.repeat(64));

    expect(repository.softDeleteSource('source_scope')).toBe(true);
    expect(media.resolveManifestDescriptors('project_media_a', reference)).toBeNull();
    expect(repository.restoreSource('source_scope')).toBe(true);
  });

  it('retains soft-deleted referenced media and purges only unreferenced managed files', async () => {
    expect((await attach('source_referenced')).result.success).toBe(true);
    const runtime = new ResearchRuntimeService(repository, media);
    const version = saveVersion(runtime, 'source_referenced', 'artifact_referenced');
    expect(repository.listArtifactInputs('artifact_referenced', version)).toEqual([
      expect.objectContaining({
        inputKind: 'source',
        inputId: 'source_referenced',
        inputHash: repository.getSource('source_referenced')?.sourceVersionHash,
      }),
    ]);
    const referencedPath = repository.getSource('source_referenced')?.filePath;
    expect(repository.softDeleteSource('source_referenced')).toBe(true);
    const referencedPurge = await media.purge({
      projectId: 'project_media_a',
      sourceId: 'source_referenced',
    });
    expect(referencedPurge).toEqual({ success: false, code: 'research_media_referenced' });
    expect(referencedPath && fs.existsSync(referencedPath)).toBe(true);

    expect((await attach('source_unreferenced')).result.success).toBe(true);
    const unreferencedPath = repository.getSource('source_unreferenced')?.filePath;
    expect(repository.softDeleteSource('source_unreferenced')).toBe(true);
    const purged = await media.purge({
      projectId: 'project_media_a',
      sourceId: 'source_unreferenced',
    });
    expect(purged).toEqual({
      success: true,
      code: 'research_media_purged',
      sourceId: 'source_unreferenced',
    });
    expect(repository.getSource('source_unreferenced', true)).toBeUndefined();
    expect(unreferencedPath && fs.existsSync(unreferencedPath)).toBe(false);
  });

  it('detects current-file tampering, deletion, and exact manifest/input-hash mismatches after restart', async () => {
    const attached = await attach('source_restart');
    expect(attached.result.success).toBe(true);
    const runtime = new ResearchRuntimeService(repository, media);
    const version = saveVersion(runtime, 'source_restart', 'artifact_restart');
    const snapshot = repository.snapshotProject('project_media_a');
    expect(snapshot).toBeDefined();
    if (!snapshot) return;
    const binding = resolveTrustedArtifactExportBinding(snapshot, 'artifact_restart', version);
    expect(binding).not.toBeNull();
    if (!binding) return;

    const restarted = new ResearchMediaService({
      repository,
      fileCapabilities: new FileCapabilityRegistry(),
      managedRoot,
    });
    const filePath = repository.getSource('source_restart')?.filePath;
    expect(filePath).toBeTruthy();
    if (!filePath) return;
    const interruptedTemporary = path.join(path.dirname(filePath), '.tmp-interrupted-write');
    const interruptedPurge = path.join(
      path.dirname(filePath),
      `.purge-${'a'.repeat(32)}-${path.basename(filePath)}`,
    );
    fs.writeFileSync(interruptedTemporary, Buffer.from('partial'));
    fs.renameSync(filePath, interruptedPurge);
    expect(await restarted.loadArtifactMedia(snapshot, binding)).toHaveLength(1);
    expect(fs.existsSync(interruptedTemporary)).toBe(false);
    expect(fs.existsSync(interruptedPurge)).toBe(false);
    expect(fs.readFileSync(filePath)).toEqual(PNG);

    fs.writeFileSync(filePath, Buffer.from('tampered'));
    expect(await restarted.loadArtifactMedia(snapshot, binding)).toBeNull();
    fs.writeFileSync(filePath, PNG);
    expect(await restarted.loadArtifactMedia(snapshot, binding)).toHaveLength(1);

    store.raw.prepare(`
      UPDATE artifact_inputs SET input_hash = ?
      WHERE artifact_id = ? AND version = ? AND input_kind = 'source'
    `).run('0'.repeat(64), 'artifact_restart', version);
    expect(await restarted.loadArtifactMedia(snapshot, binding)).toBeNull();
    store.raw.prepare(`
      UPDATE artifact_inputs SET input_hash = ?
      WHERE artifact_id = ? AND version = ? AND input_kind = 'source'
    `).run(repository.getSource('source_restart')?.sourceVersionHash, 'artifact_restart', version);
    fs.unlinkSync(filePath);
    expect(await restarted.loadArtifactMedia(snapshot, binding)).toBeNull();
  });

  it('blocks a draft SQLite media artifact before formal DOCX preview/write', async () => {
    const attached = await attach('source_production', {
      caption: 'Figure 1: production SQLite media',
    });
    expect(attached.result.success).toBe(true);
    const runtime = new ResearchRuntimeService(repository, media);
    const decoded = decodeResearchArtifactVersionRequest({
      operation: 'save_version',
      projectId: 'project_media_a',
      artifactId: 'artifact_production',
      expectedVersion: null,
      title: 'Production DOCX with trusted image',
      artifactType: 'report',
      reviewStatus: 'draft',
      inputs: [],
      capabilityId: 'research_editor',
      method: 'save exact version',
      citedSourceIds: [],
      rendererKind: 'markdown',
      contentRef: null,
      media: [{
        sourceId: 'source_production',
        caption: 'Figure 1: production SQLite media',
        ordinal: 0,
      }],
      inputHash: null,
      content: 'The production artifact contains Figure 1.',
      createdBy: 'user',
      branchFromVersion: null,
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const saved = runtime.handleVersion(decoded.value);
    expect(saved.success).toBe(true);
    if (!saved.success || !('version' in saved) || saved.version === undefined) return;

    const snapshot = repository.snapshotProject('project_media_a');
    expect(snapshot).toBeDefined();
    if (!snapshot) return;
    const binding = resolveTrustedArtifactExportBinding(
      snapshot,
      'artifact_production',
      saved.version,
    );
    expect(binding).not.toBeNull();
    if (!binding) return;
    const images = await media.loadArtifactMedia(snapshot, binding);
    expect(images).toHaveLength(1);
    if (!images) return;
    const adapted = buildExportSnapshot(snapshot, binding, images);
    expect(adapted.artifact?.[0]?.images).toHaveLength(1);

    const built = buildResearchExport({
      exportId: `ex_${'a'.repeat(32)}`,
      projectId: 'project_media_a',
      artifactId: 'artifact_production',
      destinationCapabilityId: `fc_${'b'.repeat(32)}`,
      displayName: 'production-media-export',
      scopes: ['project', 'artifact', 'citations'],
      format: 'docx',
      privacyProfile: 'private-local',
      redaction: {
        stripSecrets: true,
        stripAbsolutePaths: true,
        stripPersonalData: true,
        pseudonymizeParticipants: true,
        omitRawTranscripts: true,
        omitModelPrompts: true,
        omitToolArguments: true,
      },
      requestedAt: 1_700_000_000_000,
      artifactVersion: binding.artifactVersion,
      artifactManifestDigest: binding.artifactManifestDigest,
    }, adapted);
    expect(built.ok).toBe(false);
    if (!built.ok) return;

    const secureExport = new SecureExportService();
    const preview = secureExport.preview(built.plan);
    expect(preview.success).toBe(true);
    expect(preview.success && preview.code).toBe('export_preview_ready');
    const written = await secureExport.write(built.plan, { resolvedDirectory: exportRoot });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.publicResult.success).toBe(true);

    const docxName = built.plan.files.find((file) => file.mediaType.includes('wordprocessingml'))?.relativeName;
    expect(docxName).toBeTruthy();
    if (!docxName) return;
    const entries = unzip(fs.readFileSync(path.join(written.resolvedDirectory, docxName)));
    const mediaEntry = [...entries.entries()].find(([name]) => name.startsWith('word/media/'));
    expect(mediaEntry?.[1]).toEqual(PNG);
    expect(entries.get('[Content_Types].xml')?.toString('utf8')).toContain('image/png');
    expect(entries.get('word/_rels/document.xml.rels')?.toString('utf8')).toMatch(/Target="media\//u);
    expect(entries.get('word/document.xml')?.toString('utf8')).toContain('<w:drawing>');
    expect(entries.get('word/document.xml')?.toString('utf8')).toContain('<a:blip r:embed=');
    expect(entries.get('word/document.xml')?.toString('utf8')).toContain('Figure 1: production SQLite media');
  });
});
