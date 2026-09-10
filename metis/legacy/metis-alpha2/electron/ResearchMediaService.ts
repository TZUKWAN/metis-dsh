import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { ArtifactManifestSchema } from '../engine/artifacts/ArtifactManifest.js';
import type {
  ProjectSnapshot,
  Source,
} from '../engine/persistence/researchModel.js';
import type { ResearchRepository } from '../engine/persistence/ResearchRepository.js';
import type { ResearchExportRecord } from '../engine/export/ResearchExportBuilder.js';
import { inspectResearchImageBytes } from '../engine/export/renderers/ImageSupport.js';
import {
  RESEARCH_MEDIA_LIMITS,
  ResearchMediaDescriptorSchema,
  createResearchMediaAttachFailure,
  createResearchMediaPurgeFailure,
  type ResearchMediaAttachRequest,
  type ResearchMediaAttachResult,
  type ResearchMediaDescriptor,
  type ResearchMediaPurgeRequest,
  type ResearchMediaPurgeResult,
  type ResearchMediaReference,
  type ResearchMediaType,
} from '../engine/runtime/ResearchMediaRuntimeContract.js';
import type {
  FileCapabilityRegistry,
  FileCapabilityResolution,
} from './FileCapabilityRegistry.js';
import type { ExecutionOwnerIdentity } from './ExecutionCapabilityRegistry.js';
import {
  canonicalArtifactManifestDigest,
  type TrustedArtifactExportBinding,
} from './ResearchExportAdapter.js';

type ExportImage = NonNullable<ResearchExportRecord['images']>[number];

interface ManagedMediaMetadata {
  schemaVersion: 1;
  displayName: string;
  mediaType: ResearchMediaType;
  byteLength: number;
  sha256: string;
  widthPx: number;
  heightPx: number;
}

interface CapabilityConsumer {
  consume(input: unknown, owner: ExecutionOwnerIdentity): FileCapabilityResolution;
}

export interface ResearchMediaServiceOptions {
  repository: ResearchRepository;
  fileCapabilities: Pick<FileCapabilityRegistry, 'consume'>;
  managedRoot: string;
  /** Test-only synchronization point after open/fstat and before reading. */
  sourceReadBarrier?: (handle: FileHandle, sourcePath: string) => Promise<void>;
}

const MEDIA_EXTENSION: Readonly<Record<ResearchMediaType, string>> = Object.freeze({
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
});

const MANAGED_ORIGIN = 'metis-managed-research-media-v1';
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function sameFileSnapshot(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

async function readBoundedHandle(handle: FileHandle): Promise<Buffer | null> {
  const buffer = Buffer.alloc(RESEARCH_MEDIA_LIMITS.decodedBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(buffer, offset, buffer.byteLength - offset, null);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset === 0 || offset > RESEARCH_MEDIA_LIMITS.decodedBytes) return null;
  return buffer.subarray(0, offset);
}

function safeDisplayName(value: string, mediaType: ResearchMediaType): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this boundary removes
  const withoutControls = path.basename(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, '').trim();
  const extension = MEDIA_EXTENSION[mediaType];
  const stem = path.parse(withoutControls).name.trim() || 'image';
  return `${stem.slice(0, RESEARCH_MEDIA_LIMITS.displayNameChars - extension.length)}${extension}`;
}

function parseManagedMetadata(source: Source): ManagedMediaMetadata | null {
  const raw = source.metadata.managedMedia;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const parsed = ResearchMediaDescriptorSchema.safeParse({
    sourceId: source.id,
    caption: 'Managed research media',
    ordinal: 0,
    displayName: record.displayName,
    mediaType: record.mediaType,
    byteLength: record.byteLength,
    sha256: record.sha256,
    widthPx: record.widthPx,
    heightPx: record.heightPx,
  });
  if (!parsed.success || record.schemaVersion !== 1) return null;
  return {
    schemaVersion: 1,
    displayName: parsed.data.displayName,
    mediaType: parsed.data.mediaType,
    byteLength: parsed.data.byteLength,
    sha256: parsed.data.sha256,
    widthPx: parsed.data.widthPx,
    heightPx: parsed.data.heightPx,
  };
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.promises.open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is not supported on every Electron platform. File fsync
    // and same-volume atomic rename remain mandatory.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class ResearchMediaService {
  readonly #repository: ResearchRepository;
  readonly #fileCapabilities: CapabilityConsumer;
  readonly #managedRoot: string;
  readonly #sourceReadBarrier?: ResearchMediaServiceOptions['sourceReadBarrier'];
  readonly #busySourceIds = new Set<string>();
  #rootPreparation?: Promise<string>;

  constructor(options: ResearchMediaServiceOptions) {
    if (!path.isAbsolute(options.managedRoot)) {
      throw new Error('Research media root must be absolute');
    }
    this.#repository = options.repository;
    this.#fileCapabilities = options.fileCapabilities;
    this.#managedRoot = path.resolve(options.managedRoot);
    this.#sourceReadBarrier = options.sourceReadBarrier;
  }

  isManagedSource(source: Source): boolean {
    return source.kind === 'image'
      && source.filePath !== null
      && source.sourceVersionHash !== null
      && source.provenance.origin === MANAGED_ORIGIN
      && parseManagedMetadata(source)?.sha256 === source.sourceVersionHash;
  }

  async attach(
    request: ResearchMediaAttachRequest,
    owner: ExecutionOwnerIdentity,
  ): Promise<ResearchMediaAttachResult> {
    if (this.#busySourceIds.has(request.sourceId)) {
      return createResearchMediaAttachFailure('research_media_conflict');
    }
    this.#busySourceIds.add(request.sourceId);
    let publishedPath: string | undefined;
    let temporaryPath: string | undefined;
    try {
      const resolution = this.#fileCapabilities.consume({
        capabilityId: request.capabilityId,
        operation: 'read',
        maxBytes: RESEARCH_MEDIA_LIMITS.decodedBytes + 1,
      }, owner);
      if (!resolution.ok || resolution.capability.kind !== 'file') {
        return createResearchMediaAttachFailure();
      }

      const project = this.#repository.getProject(request.projectId, true);
      if (!project || project.deletedAt !== null) return createResearchMediaAttachFailure();
      if (this.#repository.getSource(request.sourceId, true)) {
        return createResearchMediaAttachFailure('research_media_conflict');
      }

      const bytes = await this.#readExternalFileOnce(resolution.resolvedPath);
      if (!bytes) return createResearchMediaAttachFailure();
      const inspected = inspectResearchImageBytes(bytes);
      if (!inspected.ok) return createResearchMediaAttachFailure();
      const image = inspected.image;

      const displayName = safeDisplayName(resolution.capability.displayName, image.mediaType);
      const descriptorResult = ResearchMediaDescriptorSchema.safeParse({
        sourceId: request.sourceId,
        caption: request.caption,
        ordinal: request.ordinal,
        displayName,
        mediaType: image.mediaType,
        byteLength: image.bytes.byteLength,
        sha256: image.sha256,
        widthPx: image.widthPx,
        heightPx: image.heightPx,
      });
      if (!descriptorResult.success) return createResearchMediaAttachFailure();
      const descriptor = descriptorResult.data;

      const directory = await this.#ensureProjectDirectory(request.projectId);
      const token = randomBytes(16).toString('hex');
      const fileName = `${descriptor.sha256}-${token}${MEDIA_EXTENSION[descriptor.mediaType]}`;
      publishedPath = path.join(directory, fileName);
      temporaryPath = path.join(directory, `.tmp-${token}`);
      if (!isInsideRoot(directory, publishedPath) || !isInsideRoot(directory, temporaryPath)) {
        return createResearchMediaAttachFailure();
      }

      const output = await fs.promises.open(
        temporaryPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      try {
        await output.writeFile(bytes);
        await output.sync();
      } finally {
        await output.close();
      }
      await fs.promises.rename(temporaryPath, publishedPath);
      temporaryPath = undefined;
      await fs.promises.chmod(publishedPath, 0o600).catch(() => undefined);
      await this.#assertManagedRegularFile(publishedPath);
      await syncDirectory(directory);

      const now = Date.now();
      const metadata: ManagedMediaMetadata = {
        schemaVersion: 1,
        displayName: descriptor.displayName,
        mediaType: descriptor.mediaType,
        byteLength: descriptor.byteLength,
        sha256: descriptor.sha256,
        widthPx: descriptor.widthPx,
        heightPx: descriptor.heightPx,
      };
      const source: Source = {
        id: request.sourceId,
        projectId: request.projectId,
        kind: 'image',
        title: descriptor.displayName,
        authors: [],
        year: null,
        venue: '',
        identifier: descriptor.sha256,
        identifierType: 'other',
        filePath: publishedPath,
        externalUrl: null,
        tags: [],
        metadata: { managedMedia: metadata },
        sourceVersionHash: descriptor.sha256,
        provenance: { origin: MANAGED_ORIGIN, importedAt: now },
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      if (!this.#repository.insertSourceIfAbsent(source)) {
        return createResearchMediaAttachFailure('research_media_conflict');
      }
      publishedPath = undefined;
      return { success: true, code: 'research_media_attached', media: descriptor };
    } catch {
      return createResearchMediaAttachFailure();
    } finally {
      if (temporaryPath) await fs.promises.unlink(temporaryPath).catch(() => undefined);
      if (publishedPath) await fs.promises.unlink(publishedPath).catch(() => undefined);
      this.#busySourceIds.delete(request.sourceId);
    }
  }

  resolveManifestDescriptors(
    projectId: string,
    references: readonly ResearchMediaReference[],
  ): ResearchMediaDescriptor[] | null {
    const sourceIds = new Set<string>();
    const ordinals = new Set<number>();
    const descriptors: ResearchMediaDescriptor[] = [];
    for (const reference of references) {
      if (sourceIds.has(reference.sourceId) || ordinals.has(reference.ordinal)) return null;
      const source = this.#repository.getSource(reference.sourceId, true);
      const metadata = source ? parseManagedMetadata(source) : null;
      if (
        !source
        || source.deletedAt !== null
        || source.projectId !== projectId
        || !this.isManagedSource(source)
        || !metadata
      ) return null;
      const parsed = ResearchMediaDescriptorSchema.safeParse({
        ...reference,
        displayName: metadata.displayName,
        mediaType: metadata.mediaType,
        byteLength: metadata.byteLength,
        sha256: metadata.sha256,
        widthPx: metadata.widthPx,
        heightPx: metadata.heightPx,
      });
      if (!parsed.success) return null;
      sourceIds.add(reference.sourceId);
      ordinals.add(reference.ordinal);
      descriptors.push(parsed.data);
    }
    return descriptors.sort((left, right) => left.ordinal - right.ordinal);
  }

  async loadArtifactMedia(
    snapshot: ProjectSnapshot,
    binding: TrustedArtifactExportBinding,
  ): Promise<ExportImage[] | null> {
    if (snapshot.project.deletedAt !== null) return null;
    const version = snapshot.artifactVersions.find((candidate) => (
      candidate.artifactId === binding.artifactId
      && candidate.version === binding.artifactVersion
    ));
    if (!version) return null;
    const parsedManifest = ArtifactManifestSchema.safeParse(version.manifest);
    if (!parsedManifest.success) return null;
    const manifest = parsedManifest.data;
    if (
      manifest.id !== binding.artifactId
      || manifest.projectId !== snapshot.project.id
      || manifest.version !== binding.artifactVersion
      || canonicalArtifactManifestDigest(manifest) !== binding.artifactManifestDigest
    ) return null;

    const inputHashBySource = new Map(
      this.#repository.listArtifactInputs(binding.artifactId, binding.artifactVersion)
        .filter((input) => input.inputKind === 'source')
        .map((input) => [input.inputId, input.inputHash]),
    );
    const images: ExportImage[] = [];
    for (const descriptor of [...(manifest.media ?? [])].sort((left, right) => left.ordinal - right.ordinal)) {
      if (inputHashBySource.get(descriptor.sourceId) !== descriptor.sha256) return null;
      const source = this.#repository.getSource(descriptor.sourceId, true);
      if (
        !source
        || source.deletedAt !== null
        || source.projectId !== snapshot.project.id
        || !this.isManagedSource(source)
        || source.filePath === null
      ) return null;
      const bytes = await this.#readManagedFile(source.filePath);
      if (!bytes) return null;
      const inspected = inspectResearchImageBytes(bytes);
      if (
        !inspected.ok
        || inspected.image.mediaType !== descriptor.mediaType
        || inspected.image.bytes.byteLength !== descriptor.byteLength
        || inspected.image.sha256 !== descriptor.sha256
        || inspected.image.widthPx !== descriptor.widthPx
        || inspected.image.heightPx !== descriptor.heightPx
      ) return null;
      images.push({
        id: descriptor.sourceId,
        ordinal: descriptor.ordinal,
        mediaType: inspected.image.mediaType,
        base64Data: bytes.toString('base64'),
        sha256: inspected.image.sha256,
        widthPx: inspected.image.widthPx,
        heightPx: inspected.image.heightPx,
        caption: descriptor.caption,
      });
    }
    return images;
  }

  async purge(request: ResearchMediaPurgeRequest): Promise<ResearchMediaPurgeResult> {
    if (this.#busySourceIds.has(request.sourceId)) {
      return createResearchMediaPurgeFailure('research_media_conflict');
    }
    this.#busySourceIds.add(request.sourceId);
    let stagedPath: string | undefined;
    let originalPath: string | undefined;
    try {
      const source = this.#repository.getSource(request.sourceId, true);
      if (
        !source
        || source.projectId !== request.projectId
        || source.deletedAt === null
        || !this.isManagedSource(source)
        || source.filePath === null
      ) return createResearchMediaPurgeFailure();
      if (this.#repository.countArtifactInputReferences('source', source.id) > 0) {
        return createResearchMediaPurgeFailure('research_media_referenced');
      }
      await this.#assertManagedRegularFile(source.filePath);
      originalPath = source.filePath;
      stagedPath = path.join(
        path.dirname(source.filePath),
        `.purge-${randomBytes(16).toString('hex')}-${path.basename(source.filePath)}`,
      );
      await fs.promises.rename(originalPath, stagedPath);
      if (!this.#repository.purgeSourceIfUnreferenced(source.id)) {
        await fs.promises.rename(stagedPath, originalPath);
        stagedPath = undefined;
        return createResearchMediaPurgeFailure('research_media_referenced');
      }
      originalPath = undefined;
      await fs.promises.unlink(stagedPath);
      await syncDirectory(path.dirname(stagedPath));
      return { success: true, code: 'research_media_purged', sourceId: source.id };
    } catch {
      if (stagedPath && originalPath) {
        await fs.promises.rename(stagedPath, originalPath).catch(() => undefined);
      }
      return createResearchMediaPurgeFailure();
    } finally {
      this.#busySourceIds.delete(request.sourceId);
    }
  }

  async #readExternalFileOnce(sourcePath: string): Promise<Buffer | null> {
    let handle: FileHandle | undefined;
    try {
      const candidate = path.resolve(sourcePath);
      const beforePath = await fs.promises.lstat(candidate);
      if (!beforePath.isFile() || beforePath.isSymbolicLink()) return null;
      const canonical = await fs.promises.realpath(candidate);
      if (!samePath(canonical, candidate)) return null;
      handle = await fs.promises.open(candidate, fs.constants.O_RDONLY | NOFOLLOW);
      const before = await handle.stat();
      if (!before.isFile() || before.size > RESEARCH_MEDIA_LIMITS.decodedBytes) return null;
      await this.#sourceReadBarrier?.(handle, candidate);
      const bytes = await readBoundedHandle(handle);
      const after = await handle.stat();
      return bytes && sameFileSnapshot(before, after) ? bytes : null;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #readManagedFile(filePath: string): Promise<Buffer | null> {
    let handle: FileHandle | undefined;
    try {
      const canonicalRoot = await this.#ensureManagedRoot();
      const candidate = path.resolve(filePath);
      if (!isInsideRoot(canonicalRoot, candidate)) return null;
      const pathStat = await fs.promises.lstat(candidate);
      if (!pathStat.isFile() || pathStat.isSymbolicLink()) return null;
      const canonical = await fs.promises.realpath(candidate);
      if (!isInsideRoot(canonicalRoot, canonical) || !samePath(canonical, candidate)) return null;
      handle = await fs.promises.open(candidate, fs.constants.O_RDONLY | NOFOLLOW);
      const before = await handle.stat();
      if (!before.isFile() || before.size > RESEARCH_MEDIA_LIMITS.decodedBytes) return null;
      const bytes = await readBoundedHandle(handle);
      const after = await handle.stat();
      return bytes && sameFileSnapshot(before, after) ? bytes : null;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #ensureManagedRoot(): Promise<string> {
    if (!this.#rootPreparation) {
      this.#rootPreparation = this.#prepareManagedRoot().catch((error: unknown) => {
        this.#rootPreparation = undefined;
        throw error;
      });
    }
    return this.#rootPreparation;
  }

  async #prepareManagedRoot(): Promise<string> {
    await fs.promises.mkdir(this.#managedRoot, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(this.#managedRoot, 0o700).catch(() => undefined);
    const stat = await fs.promises.lstat(this.#managedRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe research media root');
    const canonical = await fs.promises.realpath(this.#managedRoot);
    if (!samePath(canonical, this.#managedRoot)) throw new Error('Research media root is not canonical');
    await this.#recoverInterruptedPublishes(canonical);
    return canonical;
  }

  async #recoverInterruptedPublishes(root: string): Promise<void> {
    const projectEntries = await fs.promises.readdir(root, { withFileTypes: true });
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) continue;
      const directory = path.join(root, projectEntry.name);
      if (!isInsideRoot(root, directory)) continue;
      const directoryPath = await fs.promises.realpath(directory);
      if (!samePath(directory, directoryPath) || !isInsideRoot(root, directoryPath)) continue;
      const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const stagedPath = path.join(directoryPath, entry.name);
        if (entry.name.startsWith('.tmp-')) {
          await fs.promises.unlink(stagedPath).catch(() => undefined);
          continue;
        }
        const purged = /^\.purge-[a-f0-9]{32}-(.+)$/u.exec(entry.name);
        const originalName = purged?.[1];
        if (!originalName || path.basename(originalName) !== originalName) continue;
        const originalPath = path.join(directoryPath, originalName);
        const source = this.#repository.findSourceByFilePath(originalPath);
        if (!source) {
          await fs.promises.unlink(stagedPath).catch(() => undefined);
          continue;
        }
        const originalExists = await fs.promises.lstat(originalPath)
          .then((value) => value.isFile() && !value.isSymbolicLink())
          .catch(() => false);
        if (originalExists) {
          await fs.promises.unlink(stagedPath).catch(() => undefined);
        } else {
          await fs.promises.rename(stagedPath, originalPath);
        }
      }
      await syncDirectory(directoryPath);
    }
  }

  async #ensureProjectDirectory(projectId: string): Promise<string> {
    const root = await this.#ensureManagedRoot();
    const directory = path.join(root, sha256(projectId));
    if (!isInsideRoot(root, directory)) throw new Error('Unsafe research media directory');
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(directory, 0o700).catch(() => undefined);
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe research media directory');
    const canonical = await fs.promises.realpath(directory);
    if (!isInsideRoot(root, canonical) || !samePath(canonical, directory)) {
      throw new Error('Research media directory escaped its root');
    }
    return canonical;
  }

  async #assertManagedRegularFile(filePath: string): Promise<void> {
    const root = await this.#ensureManagedRoot();
    const candidate = path.resolve(filePath);
    if (!isInsideRoot(root, candidate)) throw new Error('Managed media escaped its root');
    const stat = await fs.promises.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Managed media is not a regular file');
    const canonical = await fs.promises.realpath(candidate);
    if (!isInsideRoot(root, canonical) || !samePath(canonical, candidate)) {
      throw new Error('Managed media escaped its root');
    }
  }
}
