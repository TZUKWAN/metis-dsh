import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  SkillDefinitionV2Schema,
  type PersonalizationDefinition,
} from '../engine/runtime/PersonalizationRuntimeContract.js';
import {
  InstalledSkillVersionSchema,
  type InstalledSkillVersion,
} from '../engine/runtime/SkillInstallationContract.js';
import type {
  PersonalizationBundleAssetSet,
  PersonalizationBundleAssetSource,
} from './PersonalizationBundleService.js';

const SKILL_MANIFEST_FILE = 'metis-skill.json';
const SKILL_INSTALL_RECORD_FILE = 'metis-install.json';

export interface BundleSkillDefinitionSource {
  get(id: string, includeArchived?: boolean): unknown;
}

export interface BundleSkillInstallationSource {
  getInstalled(id: string, version?: string): unknown | undefined;
  resolveInstalledDirectory(id: string, version?: string): string | undefined;
}

/**
 * Main-process-only bridge from verified local Skill installations to the
 * portable bundle writer. Local paths never cross IPC and package bytes are
 * still re-read through PersonalizationBundleService's stable-read boundary.
 */
export class PersonalizationBundleSkillAssetSource implements PersonalizationBundleAssetSource {
  readonly #definitions: BundleSkillDefinitionSource;
  readonly #installations: BundleSkillInstallationSource;

  constructor(
    definitions: BundleSkillDefinitionSource,
    installations: BundleSkillInstallationSource,
  ) {
    this.#definitions = definitions;
    this.#installations = installations;
  }

  list(ownerId: string): PersonalizationBundleAssetSet | undefined {
    const rawDefinition = this.#definitions.get(ownerId, true);
    const definition = SkillDefinitionV2Schema.safeParse(rawDefinition);
    if (!definition.success || definition.data.provenance.origin === 'builtin') return undefined;
    if (definition.data.sourceMode === 'markdown') return undefined;

    const rawInstalled = this.#installations.getInstalled(
      definition.data.id,
      definition.data.provenance.version,
    );
    const installed = InstalledSkillVersionSchema.safeParse(rawInstalled);
    if (!installed.success || !installationMatchesDefinition(installed.data, definition.data)) {
      throw new Error(`Portable Skill installation is unavailable or inconsistent: ${ownerId}`);
    }
    const rootDirectory = this.#installations.resolveInstalledDirectory(
      installed.data.id,
      installed.data.version,
    );
    if (!rootDirectory) throw new Error(`Portable Skill directory is unavailable: ${ownerId}`);
    const expectedFiles = verifyInstalledFileSet(rootDirectory, installed.data);
    verifyDefinitionText(rootDirectory, installed.data, definition.data.markdown, definition.data.systemPrompt);
    return {
      rootDirectory,
      relativePaths: expectedFiles.map((file) => file.relativePath),
      expectedFiles,
    };
  }
}

function verifyInstalledFileSet(
  root: string,
  installed: InstalledSkillVersion,
): Array<{ relativePath: string; size: number; sha256: string }> {
  const resolvedRoot = fs.realpathSync(root);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Portable Skill installation root is unsafe');
  }
  const manifestBytes = readVerifiedBytes(
    resolvedRoot,
    SKILL_MANIFEST_FILE,
    undefined,
    installed.provenance.manifestSha256,
  );
  const expected = [{
    relativePath: SKILL_MANIFEST_FILE,
    size: manifestBytes.length,
    sha256: installed.provenance.manifestSha256,
  }];
  for (const declared of installed.manifest.files) {
    readVerifiedBytes(resolvedRoot, declared.path, declared.size, declared.sha256);
    expected.push({
      relativePath: declared.path,
      size: declared.size,
      sha256: declared.sha256,
    });
  }
  const allowedInventory = new Set([
    SKILL_MANIFEST_FILE,
    SKILL_INSTALL_RECORD_FILE,
    ...installed.manifest.files.map((file) => file.path),
  ]);
  const actualInventory = listRelativeFiles(resolvedRoot);
  if (actualInventory.length !== allowedInventory.size
    || actualInventory.some((relativePath) => !allowedInventory.has(relativePath))) {
    throw new Error('Portable Skill installation inventory differs from its manifest');
  }
  return expected;
}

function listRelativeFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new Error('Portable Skill installation contains a symbolic link');
      }
      if (entry.isDirectory() && stat.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && stat.isFile()) {
        const real = fs.realpathSync(absolute);
        const relative = path.relative(root, real);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error('Portable Skill inventory escapes its installation');
        }
        files.push(relative.split(path.sep).join('/'));
      } else {
        throw new Error('Portable Skill installation contains a non-regular entry');
      }
    }
  };
  visit(root);
  return files.sort();
}

function installationMatchesDefinition(
  installed: InstalledSkillVersion,
  definition: Extract<PersonalizationDefinition, { kind: 'skill' }>,
): boolean {
  return installed.id === definition.id
    && installed.version === definition.provenance.version
    && installed.packageDigest === definition.provenance.installedDigest
    && installed.manifest.id === definition.id
    && installed.manifest.version === definition.provenance.version
    && installed.manifest.name === definition.name
    && installed.manifest.description === definition.description
    && installed.manifest.author === definition.provenance.author
    && installed.manifest.license === definition.provenance.license
    && installed.manifest.entry === definition.packageEntry;
}

function verifyDefinitionText(
  root: string,
  installed: InstalledSkillVersion,
  expectedMarkdown: string,
  expectedSystemPrompt: string,
): void {
  const entry = installed.manifest.files.find((file) => file.path === installed.manifest.entry);
  const promptPath = installed.manifest.systemPromptFile ?? installed.manifest.entry;
  const prompt = installed.manifest.files.find((file) => file.path === promptPath);
  if (!entry || !prompt) throw new Error('Portable Skill text declarations are missing');
  if (readVerifiedUtf8(root, entry.path, entry.size, entry.sha256) !== expectedMarkdown
    || readVerifiedUtf8(root, prompt.path, prompt.size, prompt.sha256) !== expectedSystemPrompt) {
    throw new Error('Portable Skill definition differs from its installed package');
  }
}

function readVerifiedUtf8(root: string, relativePath: string, size: number, digest: string): string {
  const bytes = readVerifiedBytes(root, relativePath, size, digest);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Portable Skill text is not valid UTF-8');
  }
}

function readVerifiedBytes(
  root: string,
  relativePath: string,
  size: number | undefined,
  digest: string,
): Buffer {
  const resolvedRoot = fs.realpathSync(root);
  const candidate = path.resolve(resolvedRoot, ...relativePath.split('/'));
  const relative = path.relative(resolvedRoot, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Portable Skill path escapes its installation');
  }
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || (size !== undefined && stat.size !== size)) {
    throw new Error('Portable Skill file metadata differs from its manifest');
  }
  const real = fs.realpathSync(candidate);
  const realRelative = path.relative(resolvedRoot, real);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error('Portable Skill file escapes its installation');
  }
  const bytes = fs.readFileSync(real);
  if ((size !== undefined && bytes.length !== size) || sha256(bytes) !== digest) {
    throw new Error('Portable Skill file digest differs from its manifest');
  }
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
