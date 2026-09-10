import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  PersonalizationBundleAssetBindingSchema,
  PERSONALIZATION_BUNDLE_LIMITS,
  PersonalizationBundleManifestSchema,
  type PersonalizationBundleAssetBinding,
} from '../engine/runtime/PersonalizationBundleContract.js';
import {
  SkillDefinitionV2Schema,
  type SkillDefinitionV2,
} from '../engine/runtime/PersonalizationRuntimeContract.js';
import {
  InstalledSkillVersionSchema,
  SKILL_INSTALLATION_LIMITS,
  SkillInstallationResultSchema,
  SkillPackageManifestSchema,
  type InstalledSkillVersion,
  type SkillInstallationResult,
  type SkillPackageManifest,
} from '../engine/runtime/SkillInstallationContract.js';

const BUNDLE_MANIFEST_FILE = 'bundle-manifest.json';
const SKILL_MANIFEST_FILE = 'metis-skill.json';
const LOCAL_INSTALLATION_ID = /^skill_install_[a-f0-9]{32}$/u;

export interface BundleSkillRehydrationInstaller {
  installFromPackage(sourcePath: string): SkillInstallationResult;
  getInstalled(id: string, version?: string): InstalledSkillVersion | undefined;
  resolveInstalledDirectory(id: string, version?: string): string | undefined;
  uninstall(id: string, version?: string): { ok: boolean };
}

export interface PersonalizationBundleSkillRehydrationRequest {
  definition: SkillDefinitionV2;
  assetBinding: PersonalizationBundleAssetBinding | null;
  /** SHA-256 captured from the verified import transaction before publication. */
  bundleManifestSha256: string | null;
}

export type PersonalizationBundleSkillRehydrationResult =
  | {
      ok: true;
      code: 'rehydrated';
      localInstallationId: string;
      installed: InstalledSkillVersion;
      reused: boolean;
    }
  | {
      ok: false;
      code:
        | 'invalid_request'
        | 'binding_rejected'
        | 'asset_unavailable'
        | 'asset_tampered'
        | 'package_rejected'
        | 'install_conflict'
        | 'install_failed'
        | 'verification_failed'
        | 'compensation_failed';
      detail: string;
      compensated: boolean;
    };

interface PreparedSource {
  sourcePath: string;
  expectedPackageDigest: string;
  cleanupRoot: string;
}

interface VerifiedBundleAsset {
  assetPath: string;
  absolutePath: string;
  bytes: Buffer;
  sha256: string;
}

/**
 * Rehydrates portable Skill assets into the normal machine-local Skill store.
 *
 * Bundle directories remain untrusted inventory. Every byte is rebound to the
 * imported bundle manifest, copied into a private staging directory, and then
 * passed through the existing Skill installer. This service deliberately does
 * not publish or mutate personalization definitions; the caller can compose it
 * with its own repository transaction after a successful local installation.
 */
export class PersonalizationBundleSkillRehydrationService {
  readonly #bundleRoot: string;
  readonly #stagingRoot: string;
  readonly #installer: BundleSkillRehydrationInstaller;

  constructor(
    bundleRoot: string,
    stagingRoot: string,
    installer: BundleSkillRehydrationInstaller,
  ) {
    this.#bundleRoot = ensureTrustedDirectory(bundleRoot, false);
    this.#stagingRoot = ensureTrustedDirectory(stagingRoot, true);
    if (samePath(this.#bundleRoot, this.#stagingRoot)
      || contained(this.#bundleRoot, this.#stagingRoot)
      || contained(this.#stagingRoot, this.#bundleRoot)) {
      throw new Error('Skill rehydration staging must be isolated from bundle inventory');
    }
    this.#installer = installer;
  }

  rehydrate(raw: unknown): PersonalizationBundleSkillRehydrationResult {
    const request = decodeRequest(raw);
    if (!request) return failure('invalid_request', 'request_schema_rejected');
    if (request.definition.id.startsWith('builtin:') || request.definition.provenance.origin === 'builtin') {
      return failure('invalid_request', 'factory_skill_rejected');
    }
    if (!this.#rootsIntact()) return failure('asset_unavailable', 'trusted_root_changed');

    let prepared: PreparedSource;
    try {
      prepared = request.definition.sourceMode === 'markdown'
        ? this.#prepareMarkdown(request.definition, request.assetBinding, request.bundleManifestSha256)
        : this.#preparePortablePackage(request.definition, request.assetBinding, request.bundleManifestSha256);
    } catch (error) {
      return mapPreparationFailure(error);
    }

    try {
      let existing: InstalledSkillVersion | undefined;
      try {
        const rawExisting = this.#installer.getInstalled(
          request.definition.id,
          request.definition.provenance.version,
        );
        if (rawExisting) {
          const parsedExisting = InstalledSkillVersionSchema.safeParse(rawExisting);
          if (!parsedExisting.success) return failure('install_conflict', 'existing_installation_invalid');
          existing = parsedExisting.data;
        }
      } catch {
        return failure('install_failed', 'installer_lookup_failed');
      }
      if (existing) {
        return this.#coherentInstallation(existing, request.definition, prepared.expectedPackageDigest)
          ? success(existing, true)
          : failure('install_conflict', 'existing_local_installation_differs');
      }

      let rawInstallation: SkillInstallationResult;
      try {
        rawInstallation = this.#installer.installFromPackage(prepared.sourcePath);
      } catch {
        return failure('install_failed', 'installer_exception');
      }
      const parsedInstallation = SkillInstallationResultSchema.safeParse(rawInstallation);
      if (!parsedInstallation.success) return failure('install_failed', 'invalid_installer_response');
      const installation = parsedInstallation.data;
      if (!installation.ok) {
        if (installation.code === 'already_installed' || installation.code === 'install_conflict') {
          let raced: InstalledSkillVersion | undefined;
          try {
            const rawRaced = this.#installer.getInstalled(
              request.definition.id,
              request.definition.provenance.version,
            );
            if (rawRaced) {
              const parsedRaced = InstalledSkillVersionSchema.safeParse(rawRaced);
              if (parsedRaced.success) raced = parsedRaced.data;
            }
          } catch {
            return failure('install_failed', 'installer_lookup_failed');
          }
          return raced && this.#coherentInstallation(raced, request.definition, prepared.expectedPackageDigest)
            ? success(raced, true)
            : failure('install_conflict', installation.code);
        }
        return failure('install_failed', installation.code);
      }
      if (this.#coherentInstallation(
        installation.installed,
        request.definition,
        prepared.expectedPackageDigest,
      )) {
        return success(installation.installed, false);
      }

      let compensated = false;
      try {
        compensated = this.#installer.uninstall(
          installation.installed.id,
          installation.installed.version,
        ).ok;
      } catch {
        compensated = false;
      }
      return compensated
        ? failure('verification_failed', 'installed_skill_identity_mismatch', true)
        : failure('compensation_failed', 'installed_skill_identity_mismatch');
    } finally {
      safeRemoveStaging(this.#stagingRoot, prepared.cleanupRoot);
    }
  }

  #prepareMarkdown(
    definition: SkillDefinitionV2,
    binding: PersonalizationBundleAssetBinding | null,
    bundleManifestSha256: string | null,
  ): PreparedSource {
    if (binding) {
      const assets = this.#verifiedBindingAssets(definition, binding, bundleManifestSha256);
      if (assets.length !== 1 || !assets[0]?.assetPath.toLocaleLowerCase('en-US').endsWith('.md')) {
        throw new RehydrationError('package_rejected', 'markdown_binding_must_contain_one_markdown_file');
      }
      const text = decodeUtf8(assets[0].bytes);
      if (text !== definition.markdown) {
        throw new RehydrationError('asset_tampered', 'markdown_asset_differs_from_definition');
      }
    }

    const files = new Map<string, Buffer>([
      ['SKILL.md', Buffer.from(definition.markdown, 'utf8')],
    ]);
    let promptFile: string | null = 'SKILL.md';
    if (definition.systemPrompt !== definition.markdown) {
      files.set('SYSTEM.md', Buffer.from(definition.systemPrompt, 'utf8'));
      promptFile = 'SYSTEM.md';
    }
    const manifest = SkillPackageManifestSchema.parse({
      schemaVersion: 1,
      id: definition.id,
      name: definition.name,
      description: definition.description,
      version: definition.provenance.version,
      author: definition.provenance.author,
      license: definition.provenance.license,
      entry: 'SKILL.md',
      systemPromptFile: promptFile,
      files: [...files.entries()].map(([filePath, bytes]) => ({
        path: filePath,
        size: bytes.length,
        sha256: sha256(bytes),
        role: 'documentation' as const,
        executable: false,
      })),
    });
    return this.#stageDirectoryPackage(manifest, files);
  }

  #preparePortablePackage(
    definition: SkillDefinitionV2,
    binding: PersonalizationBundleAssetBinding | null,
    bundleManifestSha256: string | null,
  ): PreparedSource {
    if (!binding) throw new RehydrationError('binding_rejected', 'package_binding_required');
    const assets = this.#verifiedBindingAssets(definition, binding, bundleManifestSha256);
    if (assets.length === 1 && assets[0]?.assetPath.toLocaleLowerCase('en-US').endsWith('.zip')) {
      if (definition.provenance.installedDigest !== assets[0].sha256) {
        throw new RehydrationError('asset_tampered', 'archive_digest_differs_from_definition');
      }
      const staging = this.#createStagingDirectory();
      const archivePath = path.join(staging, 'skill.zip');
      writeExclusiveAndSync(archivePath, assets[0].bytes);
      return { sourcePath: archivePath, expectedPackageDigest: assets[0].sha256, cleanupRoot: staging };
    }

    const byPath = new Map(assets.map((asset) => [asset.assetPath, asset]));
    const manifestAsset = byPath.get(SKILL_MANIFEST_FILE);
    if (!manifestAsset) throw new RehydrationError('package_rejected', 'skill_manifest_missing');
    let manifest: SkillPackageManifest;
    try {
      manifest = SkillPackageManifestSchema.parse(JSON.parse(decodeUtf8(manifestAsset.bytes)) as unknown);
    } catch {
      throw new RehydrationError('package_rejected', 'skill_manifest_invalid');
    }
    if (!definitionMatchesManifest(definition, manifest)) {
      throw new RehydrationError('package_rejected', 'skill_manifest_definition_mismatch');
    }
    const expectedPaths = new Set([SKILL_MANIFEST_FILE, ...manifest.files.map((file) => file.path)]);
    if (byPath.size !== expectedPaths.size || [...byPath.keys()].some((filePath) => !expectedPaths.has(filePath))) {
      throw new RehydrationError('package_rejected', 'package_asset_list_mismatch');
    }
    const files = new Map<string, Buffer>();
    for (const declaration of manifest.files) {
      const asset = byPath.get(declaration.path);
      if (!asset || asset.bytes.length !== declaration.size || asset.sha256 !== declaration.sha256) {
        throw new RehydrationError('asset_tampered', 'declared_file_mismatch');
      }
      files.set(declaration.path, asset.bytes);
    }
    const entry = files.get(manifest.entry);
    const prompt = files.get(manifest.systemPromptFile ?? manifest.entry);
    if (!entry || !prompt || decodeUtf8(entry) !== definition.markdown
      || decodeUtf8(prompt) !== definition.systemPrompt) {
      throw new RehydrationError('package_rejected', 'definition_content_differs_from_package');
    }
    return this.#stageDirectoryPackage(manifest, files);
  }

  #verifiedBindingAssets(
    definition: SkillDefinitionV2,
    rawBinding: PersonalizationBundleAssetBinding,
    expectedManifestSha256: string | null,
  ): VerifiedBundleAsset[] {
    if (!expectedManifestSha256 || !/^[a-f0-9]{64}$/u.test(expectedManifestSha256)) {
      throw new RehydrationError('binding_rejected', 'bundle_manifest_digest_required');
    }
    const parsed = PersonalizationBundleAssetBindingSchema.safeParse(rawBinding);
    if (!parsed.success || parsed.data.ownerId !== definition.id) {
      throw new RehydrationError('binding_rejected', 'binding_owner_mismatch');
    }
    const binding = parsed.data;
    if (binding.relativeRoot !== sha256(definition.id).slice(0, 24)) {
      throw new RehydrationError('binding_rejected', 'binding_root_mismatch');
    }
    this.#assertRootIntact(this.#bundleRoot);
    const bundleDirectory = containedPath(this.#bundleRoot, binding.directoryToken);
    const assetRoot = containedPath(bundleDirectory, binding.relativeRoot);
    assertSafeDirectory(bundleDirectory, this.#bundleRoot);
    assertSafeDirectory(assetRoot, bundleDirectory);

    const manifestPath = path.join(bundleDirectory, BUNDLE_MANIFEST_FILE);
    let manifest;
    try {
      const manifestBytes = readStableFile(manifestPath, PERSONALIZATION_BUNDLE_LIMITS.fileBytes);
      if (sha256(manifestBytes) !== expectedManifestSha256) {
        throw new RehydrationError('asset_tampered', 'bundle_manifest_digest_mismatch');
      }
      manifest = PersonalizationBundleManifestSchema.parse(
        JSON.parse(manifestBytes.toString('utf8')) as unknown,
      );
    } catch (error) {
      if (error instanceof RehydrationError) throw error;
      throw new RehydrationError('asset_tampered', 'bundle_manifest_invalid');
    }
    if (binding.directoryToken !== `bundle_${manifest.bundleDigest.slice(0, 32)}`
      || !manifest.definitions.some((entry) => entry.id === definition.id && entry.kind === 'skill')) {
      throw new RehydrationError('binding_rejected', 'bundle_identity_mismatch');
    }
    const entries = manifest.assets.filter((entry) => entry.ownerId === definition.id);
    if (entries.length === 0 || entries.some((entry) => !entry.included || !entry.payloadPath)) {
      throw new RehydrationError('asset_unavailable', 'included_skill_assets_missing');
    }
    if (entries.reduce((sum, entry) => sum + entry.size, 0) > PERSONALIZATION_BUNDLE_LIMITS.decodedBytes) {
      throw new RehydrationError('asset_unavailable', 'included_skill_assets_too_large');
    }
    const actualPaths = listRegularFiles(assetRoot);
    const declaredPaths = new Set(entries.map((entry) => entry.assetPath));
    if (actualPaths.length !== declaredPaths.size || actualPaths.some((filePath) => !declaredPaths.has(filePath))) {
      throw new RehydrationError('asset_tampered', 'asset_inventory_mismatch');
    }
    return entries.map((entry): VerifiedBundleAsset => {
      const absolutePath = containedPath(assetRoot, entry.assetPath);
      const bytes = readStableFile(absolutePath, PERSONALIZATION_BUNDLE_LIMITS.fileBytes);
      const digest = sha256(bytes);
      if (bytes.length !== entry.size || digest !== entry.sha256) {
        throw new RehydrationError('asset_tampered', 'asset_digest_mismatch');
      }
      return { assetPath: entry.assetPath, absolutePath, bytes, sha256: digest };
    });
  }

  #stageDirectoryPackage(
    manifest: SkillPackageManifest,
    files: ReadonlyMap<string, Buffer>,
  ): PreparedSource {
    const staging = this.#createStagingDirectory();
    try {
      for (const [relativePath, bytes] of files) {
        const destination = containedPath(staging, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        writeExclusiveAndSync(destination, bytes);
      }
      writeExclusiveAndSync(
        path.join(staging, SKILL_MANIFEST_FILE),
        Buffer.from(JSON.stringify(manifest), 'utf8'),
      );
      const digest = directoryPackageDigest([
        [SKILL_MANIFEST_FILE, Buffer.from(JSON.stringify(manifest), 'utf8')],
        ...files,
      ]);
      return { sourcePath: staging, expectedPackageDigest: digest, cleanupRoot: staging };
    } catch (error) {
      safeRemoveStaging(this.#stagingRoot, staging);
      throw error;
    }
  }

  #coherentInstallation(
    installed: InstalledSkillVersion,
    definition: SkillDefinitionV2,
    expectedPackageDigest: string,
  ): boolean {
    try {
      if (installed.id !== definition.id
        || installed.version !== definition.provenance.version
        || installed.name !== definition.name
        || installed.packageDigest !== expectedPackageDigest
        || !definitionMatchesManifest(definition, installed.manifest)) return false;
      const directory = this.#installer.resolveInstalledDirectory(installed.id, installed.version);
      if (!directory) return false;
      const entry = readStableFile(containedPath(directory, installed.manifest.entry));
      const prompt = readStableFile(containedPath(
        directory,
        installed.manifest.systemPromptFile ?? installed.manifest.entry,
      ));
      return decodeUtf8(entry) === definition.markdown && decodeUtf8(prompt) === definition.systemPrompt;
    } catch {
      return false;
    }
  }

  #createStagingDirectory(): string {
    this.#assertRootIntact(this.#stagingRoot);
    const directory = containedPath(this.#stagingRoot, `rehydrate-${randomUUID()}`);
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    assertSafeDirectory(directory, this.#stagingRoot);
    return directory;
  }

  #rootsIntact(): boolean {
    try {
      this.#assertRootIntact(this.#bundleRoot);
      this.#assertRootIntact(this.#stagingRoot);
      return true;
    } catch {
      return false;
    }
  }

  #assertRootIntact(root: string): void {
    assertSafeDirectory(root, path.dirname(root), true);
  }
}

class RehydrationError extends Error {
  constructor(
    readonly code: Extract<PersonalizationBundleSkillRehydrationResult, { ok: false }>['code'],
    message: string,
  ) {
    super(message);
    this.name = 'RehydrationError';
  }
}

function decodeRequest(raw: unknown): PersonalizationBundleSkillRehydrationRequest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'definition'
    && key !== 'assetBinding'
    && key !== 'bundleManifestSha256')) return undefined;
  const definition = SkillDefinitionV2Schema.safeParse(record.definition);
  if (!definition.success) return undefined;
  if (record.assetBinding === null || record.assetBinding === undefined) {
    if (record.bundleManifestSha256 !== null && record.bundleManifestSha256 !== undefined) return undefined;
    return { definition: definition.data, assetBinding: null, bundleManifestSha256: null };
  }
  if (typeof record.bundleManifestSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(record.bundleManifestSha256)) return undefined;
  const binding = PersonalizationBundleAssetBindingSchema.safeParse(record.assetBinding);
  return binding.success ? {
    definition: definition.data,
    assetBinding: binding.data,
    bundleManifestSha256: record.bundleManifestSha256,
  } : undefined;
}

function definitionMatchesManifest(definition: SkillDefinitionV2, manifest: SkillPackageManifest): boolean {
  return manifest.id === definition.id
    && manifest.name === definition.name
    && manifest.description === definition.description
    && manifest.version === definition.provenance.version
    && manifest.author === definition.provenance.author
    && manifest.license === definition.provenance.license
    && (definition.sourceMode === 'markdown'
      ? definition.packageEntry === null
      : definition.packageEntry !== null && manifest.entry === definition.packageEntry);
}

function success(
  installed: InstalledSkillVersion,
  reused: boolean,
): Extract<PersonalizationBundleSkillRehydrationResult, { ok: true }> {
  const localInstallationId = `skill_install_${sha256(
    `${installed.storageKey}\0${installed.version}\0${installed.packageDigest}`,
  ).slice(0, 32)}`;
  if (!LOCAL_INSTALLATION_ID.test(localInstallationId)) throw new Error('Invalid local Skill installation identity');
  return { ok: true, code: 'rehydrated', localInstallationId, installed, reused };
}

function failure(
  code: Extract<PersonalizationBundleSkillRehydrationResult, { ok: false }>['code'],
  detail: string,
  compensated = false,
): Extract<PersonalizationBundleSkillRehydrationResult, { ok: false }> {
  return { ok: false, code, detail, compensated };
}

function mapPreparationFailure(error: unknown): PersonalizationBundleSkillRehydrationResult {
  return error instanceof RehydrationError
    ? failure(error.code, error.message)
    : failure('asset_unavailable', 'preparation_failed');
}

function ensureTrustedDirectory(input: string, create: boolean): string {
  const resolved = path.resolve(input);
  if (create && !fs.existsSync(resolved)) {
    let ancestor = resolved;
    const missing: string[] = [];
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error('Skill rehydration root has no trusted ancestor');
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
    const ancestorStat = fs.lstatSync(ancestor);
    const ancestorReal = fs.realpathSync(ancestor);
    if (!ancestorStat.isDirectory() || ancestorStat.isSymbolicLink()
      || !samePath(ancestorReal, ancestor)) throw new Error('Unsafe Skill rehydration ancestor');
    const expected = path.join(ancestorReal, ...missing);
    if (!samePath(expected, resolved)) throw new Error('Skill rehydration root escapes its trusted ancestor');
    let current = ancestor;
    for (const segment of missing) {
      current = path.join(current, segment);
      fs.mkdirSync(current, { mode: 0o700 });
      const createdStat = fs.lstatSync(current);
      if (!createdStat.isDirectory() || createdStat.isSymbolicLink()
        || !samePath(fs.realpathSync(current), current)) {
        throw new Error('Unsafe created Skill rehydration directory');
      }
    }
  }
  const stat = fs.lstatSync(resolved);
  const real = fs.realpathSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(real, resolved)) {
    throw new Error('Unsafe Skill rehydration root');
  }
  return real;
}

function assertSafeDirectory(directory: string, parent: string, allowSame = false): void {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  const real = fs.realpathSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(real, resolved)
    || (!allowSame && !contained(parent, resolved))) {
    throw new RehydrationError('asset_unavailable', 'unsafe_asset_directory');
  }
}

function contained(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function containedPath(parent: string, relativePath: string): string {
  const candidate = path.resolve(parent, ...relativePath.split('/'));
  if (!contained(parent, candidate)) throw new RehydrationError('binding_rejected', 'path_escape_rejected');
  return candidate;
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLocaleLowerCase('en-US') === path.resolve(right).toLocaleLowerCase('en-US')
    : path.resolve(left) === path.resolve(right);
}

function readStableFile(filePath: string, maxBytes = SKILL_INSTALLATION_LIMITS.fileBytes): Buffer {
  let fd: number | undefined;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes
      || !samePath(fs.realpathSync(filePath), filePath)) {
      throw new RehydrationError('asset_unavailable', 'unsafe_asset_file');
    }
    fd = fs.openSync(filePath, 'r');
    const before = fs.fstatSync(fd);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const stable = before.isFile()
      && before.size === after.size
      && before.mtimeMs === after.mtimeMs
      && (process.platform === 'win32' || (before.dev === after.dev && before.ino === after.ino));
    if (!stable || bytes.length !== before.size) {
      throw new RehydrationError('asset_tampered', 'asset_changed_during_read');
    }
    return bytes;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function listRegularFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new RehydrationError('asset_unavailable', 'asset_symlink_rejected');
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!samePath(fs.realpathSync(absolute), absolute)) {
          throw new RehydrationError('asset_unavailable', 'asset_junction_rejected');
        }
        visit(absolute, relative);
      } else if (entry.isFile()) {
        files.push(relative);
      } else {
        throw new RehydrationError('asset_unavailable', 'unsupported_asset_entry');
      }
    }
  };
  visit(root, '');
  return files.sort();
}

function writeExclusiveAndSync(filePath: string, bytes: Buffer): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function directoryPackageDigest(entries: Iterable<readonly [string, Buffer]>): string {
  return sha256(Buffer.from([...entries]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, bytes]) => `${filePath}\0${sha256(bytes)}`)
    .join('\n'), 'utf8'));
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RehydrationError('package_rejected', 'package_text_is_not_utf8');
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeRemoveStaging(stagingRoot: string, target: string): void {
  try {
    const resolved = path.resolve(target);
    if (!contained(stagingRoot, resolved)) return;
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(fs.realpathSync(resolved), resolved)) return;
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch {
    // The unique staging directory is never used as a runtime root. A cleanup
    // failure is intentionally not reported as a successful compensation.
  }
}
