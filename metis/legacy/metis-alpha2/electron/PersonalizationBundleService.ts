import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  PERSONALIZATION_BUNDLE_LIMITS,
  PersonalizationBundleAssetPathSchema,
  PersonalizationBundleExportRequestSchema,
  PersonalizationBundleImportPlanSchema,
  PersonalizationBundleImportResponseSchema,
  PersonalizationBundleSchema,
  PersonalizationBundleSecretRefSchema,
  isSafeBundledEnvironmentName,
  secretReferenceForEnvironment,
  type PersonalizationBundle,
  type PersonalizationBundleAssetBinding,
  type PersonalizationBundleImportPlan,
  type PersonalizationBundleImportResponse,
} from '../engine/runtime/PersonalizationBundleContract.js';
import {
  PersonalizationDefinitionSchema,
  type PersonalizationDefinition,
} from '../engine/runtime/PersonalizationRuntimeContract.js';

export interface PersonalizationBundleDefinitionSource {
  get(id: string): PersonalizationDefinition | undefined | Promise<PersonalizationDefinition | undefined>;
}

export interface PersonalizationBundleAssetSet {
  rootDirectory: string;
  relativePaths: readonly string[];
  /** Optional integrity authority supplied by a verified installer. When present it must cover the exact export set. */
  expectedFiles?: readonly {
    relativePath: string;
    size: number;
    sha256: string;
  }[];
}

export interface PersonalizationBundleAssetSource {
  list(ownerId: string): PersonalizationBundleAssetSet | undefined | Promise<PersonalizationBundleAssetSet | undefined>;
}

export interface PersonalizationBundleDefinitionTransaction {
  /** Stage a definition and its opaque asset location; neither may be visible before commit. */
  save(definition: PersonalizationDefinition, assetBinding?: PersonalizationBundleAssetBinding): void | Promise<void>;
  /** Atomically publish every staged definition/binding or throw without committing any item. */
  commit(): void | Promise<void>;
  /** Revert all staged/committed items. Must be idempotent for failure recovery. */
  rollback(): void | Promise<void>;
}

export interface PersonalizationBundleDefinitionSink {
  get(id: string): PersonalizationDefinition | undefined | Promise<PersonalizationDefinition | undefined>;
  begin(): PersonalizationBundleDefinitionTransaction | Promise<PersonalizationBundleDefinitionTransaction>;
}

export interface PersonalizationBundleExportResult {
  bundle: PersonalizationBundle;
  bytes: Uint8Array;
}

interface PreparedImport {
  bundle: PersonalizationBundle;
  plan: PersonalizationBundleImportPlan;
  definitionsToSave: PersonalizationDefinition[];
  includedAssets: Array<{ relativePath: string; bytes: Buffer }>;
}

const FORBIDDEN_AUTHORITY_FIELDS = new Set([
  'verified', 'verificationStatus', 'correctionState', 'truthPolicy', 'truthReceipt',
  'approvalReceipt', 'receiptSignature', 'sourceSnapshotDigest', 'claimVerified',
]);

export class PersonalizationBundleService {
  readonly #importRoot: string;
  readonly #now: () => number;

  constructor(importRoot: string, options?: { now?: () => number }) {
    this.#importRoot = ensureTrustedDirectory(importRoot);
    this.#now = options?.now ?? Date.now;
  }

  async exportBundle(
    rawRequest: unknown,
    source: PersonalizationBundleDefinitionSource,
    assetSource?: PersonalizationBundleAssetSource,
  ): Promise<PersonalizationBundleExportResult> {
    const request = PersonalizationBundleExportRequestSchema.parse(rawRequest);
    const definitions = await collectDefinitionGraph(request.rootDefinitionIds, source);
    const payloads: PersonalizationBundle['payloads'] = [];
    const definitionEntries: PersonalizationBundle['manifest']['definitions'] = [];
    const assetEntries: PersonalizationBundle['manifest']['assets'] = [];

    for (const definition of definitions) {
      const portable = redactDefinitionSecrets(PersonalizationDefinitionSchema.parse(definition));
      const definitionBytes = Buffer.from(canonicalJson(portable.definition), 'utf8');
      const payloadPath = `definitions/${sha256(portable.definition.id).slice(0, 32)}.json`;
      const definitionSha256 = sha256(definitionBytes);
      definitionEntries.push({
        id: portable.definition.id,
        kind: portable.definition.kind,
        payloadPath,
        size: definitionBytes.length,
        sha256: definitionSha256,
        secretRefs: portable.secretRefs,
      });
      payloads.push(payloadFor(payloadPath, definitionBytes));

      if (request.assetMode === 'none' || definition.provenance.origin === 'builtin'
        || (definition.kind !== 'skill' && definition.kind !== 'mcp')) continue;
      if (!assetSource) throw new Error('Asset source is required by the selected export mode');
      const assetSet = await assetSource.list(definition.id);
      if (!assetSet) continue;
      const safeRoot = verifyAssetRoot(assetSet.rootDirectory);
      const paths = [...assetSet.relativePaths];
      if (new Set(paths).size !== paths.length) throw new Error(`Duplicate asset path for ${definition.id}`);
      const expectedFiles = assetSet.expectedFiles
        ? new Map(assetSet.expectedFiles.map((file) => {
          const normalized = PersonalizationBundleAssetPathSchema.parse(file.relativePath.split(path.sep).join('/'));
          return [normalized, { size: file.size, sha256: file.sha256 }] as const;
        }))
        : null;
      if (expectedFiles && (expectedFiles.size !== assetSet.expectedFiles!.length || expectedFiles.size !== paths.length)) {
        throw new Error(`Asset integrity inventory differs from export set for ${definition.id}`);
      }
      for (const relativePath of paths) {
        const assetPath = PersonalizationBundleAssetPathSchema.parse(relativePath.split(path.sep).join('/'));
        if (isSensitiveAssetPath(assetPath)) throw new Error(`Sensitive asset cannot be exported: ${assetPath}`);
        const expectedFile = expectedFiles?.get(assetPath);
        if (expectedFiles && !expectedFile) throw new Error(`Asset is missing installer integrity metadata: ${assetPath}`);
        const absolute = containedFile(safeRoot, assetPath);
        const stat = fs.lstatSync(absolute);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PERSONALIZATION_BUNDLE_LIMITS.fileBytes) {
          throw new Error(`Unsafe asset: ${assetPath}`);
        }
        const real = fs.realpathSync(absolute);
        assertContained(safeRoot, real);
        const bytes = readStableRegularFile(real, PERSONALIZATION_BUNDLE_LIMITS.fileBytes);
        const included = request.assetMode === 'include_files';
        const payloadPath = included
          ? `assets/${sha256(definition.id).slice(0, 24)}/${assetPath}`
          : null;
        const assetSha256 = sha256(bytes);
        if (expectedFile && (bytes.length !== expectedFile.size || assetSha256 !== expectedFile.sha256)) {
          throw new Error(`Asset differs from installer integrity metadata: ${assetPath}`);
        }
        assetEntries.push({
          ownerId: definition.id,
          assetPath,
          payloadPath,
          included,
          executable: false,
          size: bytes.length,
          sha256: assetSha256,
        });
        if (payloadPath) payloads.push(payloadFor(payloadPath, bytes));
      }
    }

    if (definitionEntries.length > PERSONALIZATION_BUNDLE_LIMITS.definitions
      || assetEntries.length > PERSONALIZATION_BUNDLE_LIMITS.assets
      || payloads.length > PERSONALIZATION_BUNDLE_LIMITS.payloads) {
      throw new Error('Personalization bundle item limit exceeded');
    }
    const decodedBytes = payloads.reduce((sum, payload) => sum + payload.size, 0);
    if (decodedBytes > PERSONALIZATION_BUNDLE_LIMITS.decodedBytes) {
      throw new Error('Personalization bundle size limit exceeded');
    }
    const manifestWithoutDigest = {
      format: 'metis-personalization-bundle' as const,
      version: 1 as const,
      bundleId: randomUUID(),
      createdAt: this.#now(),
      createdBy: request.createdBy,
      rootDefinitionIds: request.rootDefinitionIds,
      definitions: definitionEntries.sort((left, right) => left.id.localeCompare(right.id)),
      assets: assetEntries.sort((left, right) => left.ownerId.localeCompare(right.ownerId)
        || left.assetPath.localeCompare(right.assetPath)),
    };
    const bundleDigest = computePersonalizationBundleDigest({ manifest: manifestWithoutDigest, payloads });
    const bundle = PersonalizationBundleSchema.parse({
      manifest: { ...manifestWithoutDigest, bundleDigest },
      payloads: [...payloads].sort((left, right) => left.path.localeCompare(right.path)),
    });
    const bytes = Buffer.from(canonicalJson(bundle), 'utf8');
    if (bytes.length > PERSONALIZATION_BUNDLE_LIMITS.encodedBytes) throw new Error('Encoded bundle size limit exceeded');
    return { bundle, bytes };
  }

  async dryRunImport(rawBytes: Uint8Array, sink: PersonalizationBundleDefinitionSink): Promise<
    { ok: true; plan: PersonalizationBundleImportPlan } | { ok: false; code: Extract<PersonalizationBundleImportResponse, { ok: false }>['code'] }
  > {
    const prepared = await this.#prepareImport(rawBytes, sink);
    return prepared.ok ? { ok: true, plan: prepared.value.plan } : prepared;
  }

  async importBundle(
    rawBytes: Uint8Array,
    sink: PersonalizationBundleDefinitionSink,
  ): Promise<PersonalizationBundleImportResponse> {
    const prepared = await this.#prepareImport(rawBytes, sink);
    if (!prepared.ok) return PersonalizationBundleImportResponseSchema.parse(prepared);
    const { bundle, plan, definitionsToSave, includedAssets } = prepared.value;
    let stagingDirectory: string | null = null;
    let finalDirectory: string | null = null;
    let transaction: PersonalizationBundleDefinitionTransaction | null = null;
    let published = false;
    let phase: 'staging' | 'sink' | 'commit' = 'staging';
    try {
      this.#assertImportRootIntact();
      if (includedAssets.length > 0) {
        stagingDirectory = containedFile(this.#importRoot, `.staging-${bundle.manifest.bundleDigest}-${randomUUID()}`);
        fs.mkdirSync(stagingDirectory, { recursive: false, mode: 0o700 });
        for (const asset of includedAssets) {
          const destination = containedFile(stagingDirectory, asset.relativePath);
          fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
          writeExclusiveAndSync(destination, asset.bytes);
        }
        writeExclusiveAndSync(
          path.join(stagingDirectory, 'bundle-manifest.json'),
          Buffer.from(canonicalJson(bundle.manifest), 'utf8'),
        );
      }

      phase = 'sink';
      transaction = await sink.begin();
      const bindings = new Map(plan.assetBindings.map((binding) => [binding.ownerId, binding]));
      for (const definition of definitionsToSave) await transaction.save(definition, bindings.get(definition.id));

      let assetDirectoryToken: string | null = null;
      if (stagingDirectory) {
        this.#assertImportRootIntact();
        assetDirectoryToken = `bundle_${bundle.manifest.bundleDigest.slice(0, 32)}`;
        finalDirectory = containedFile(this.#importRoot, assetDirectoryToken);
        if (fs.existsSync(finalDirectory)) throw new Error('asset_destination_exists');
        fs.renameSync(stagingDirectory, finalDirectory);
        stagingDirectory = null;
        published = true;
        fsyncDirectory(this.#importRoot);
      }
      phase = 'commit';
      await transaction.commit();
      return PersonalizationBundleImportResponseSchema.parse({ ok: true, plan, assetDirectoryToken });
    } catch {
      let rollbackFailed = false;
      if (transaction) {
        try { await transaction.rollback(); } catch { rollbackFailed = true; }
      }
      if (published && finalDirectory) {
        try { fs.rmSync(finalDirectory, { recursive: true, force: true }); } catch { rollbackFailed = true; }
      }
      if (stagingDirectory) {
        try { fs.rmSync(stagingDirectory, { recursive: true, force: true }); } catch { rollbackFailed = true; }
      }
      return PersonalizationBundleImportResponseSchema.parse({
        ok: false,
        code: rollbackFailed ? 'rollback_failed'
          : phase === 'staging' ? 'staging_failed'
            : phase === 'sink' ? 'sink_failed' : 'commit_failed',
      });
    }
  }

  #assertImportRootIntact(): void {
    const stat = fs.lstatSync(this.#importRoot);
    const real = fs.realpathSync(this.#importRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(real, this.#importRoot)) {
      throw new Error('Unsafe import root');
    }
  }

  async #prepareImport(
    rawBytes: Uint8Array,
    sink: PersonalizationBundleDefinitionSink,
  ): Promise<
    { ok: true; value: PreparedImport }
    | { ok: false; code: Extract<PersonalizationBundleImportResponse, { ok: false }>['code'] }
  > {
    if (rawBytes.byteLength > PERSONALIZATION_BUNDLE_LIMITS.encodedBytes) return { ok: false, code: 'bundle_too_large' };
    let raw: unknown;
    try { raw = JSON.parse(Buffer.from(rawBytes).toString('utf8')); } catch { return { ok: false, code: 'invalid_bundle' }; }
    const parsed = PersonalizationBundleSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: 'invalid_bundle' };
    const bundle = parsed.data;
    if (computePersonalizationBundleDigest({ manifest: withoutBundleDigest(bundle.manifest), payloads: bundle.payloads })
      !== bundle.manifest.bundleDigest) return { ok: false, code: 'digest_mismatch' };

    const decoded = new Map<string, Buffer>();
    for (const payload of bundle.payloads) {
      let bytes: Buffer;
      try {
        bytes = Buffer.from(payload.content, 'base64');
        if (bytes.toString('base64') !== payload.content) return { ok: false, code: 'payload_mismatch' };
      } catch {
        return { ok: false, code: 'payload_mismatch' };
      }
      if (bytes.length !== payload.size || sha256(bytes) !== payload.sha256) return { ok: false, code: 'payload_mismatch' };
      decoded.set(payload.path, bytes);
    }

    const definitions = new Map<string, PersonalizationDefinition>();
    for (const entry of bundle.manifest.definitions) {
      const bytes = decoded.get(entry.payloadPath);
      if (!bytes || bytes.length !== entry.size || sha256(bytes) !== entry.sha256) return { ok: false, code: 'payload_mismatch' };
      let definitionRaw: unknown;
      try { definitionRaw = JSON.parse(bytes.toString('utf8')); } catch { return { ok: false, code: 'definition_invalid' }; }
      if (containsAuthorityField(definitionRaw)) return { ok: false, code: 'truth_field_rejected' };
      const definition = PersonalizationDefinitionSchema.safeParse(definitionRaw);
      if (!definition.success || definition.data.id !== entry.id || definition.data.kind !== entry.kind) {
        return { ok: false, code: 'definition_invalid' };
      }
      if (definition.data.kind === 'mcp'
        && Object.keys(definition.data.environment).some((name) => !isSafeBundledEnvironmentName(name))) {
        return { ok: false, code: 'definition_invalid' };
      }
      let expectedSecretRefs: string[];
      try { expectedSecretRefs = secretRefsForDefinition(definition.data); } catch {
        return { ok: false, code: 'definition_invalid' };
      }
      if (canonicalJson(expectedSecretRefs) !== canonicalJson(entry.secretRefs)) return { ok: false, code: 'definition_invalid' };
      if (definition.data.kind === 'mcp'
        && Object.values(definition.data.environment).some((environment) => environment.secret && environment.value !== null)) {
        return { ok: false, code: 'definition_invalid' };
      }
      definitions.set(definition.data.id, definition.data);
    }

    const definitionsToSave: PersonalizationDefinition[] = [];
    for (const definition of definitions.values()) {
      const incomingFactory = definition.id.startsWith('builtin:') || definition.provenance.origin === 'builtin';
      if (incomingFactory !== (definition.id.startsWith('builtin:') && definition.provenance.origin === 'builtin')) {
        return { ok: false, code: 'factory_protected' };
      }
      let existing: PersonalizationDefinition | undefined;
      try { existing = await sink.get(definition.id); } catch { return { ok: false, code: 'sink_failed' }; }
      if (incomingFactory) {
        if (!existing || existing.provenance.origin !== 'builtin'
          || canonicalJson(existing) !== canonicalJson(definition)) return { ok: false, code: 'factory_protected' };
        continue;
      }
      if (existing) return { ok: false, code: existing.provenance.origin === 'builtin' ? 'factory_protected' : 'existing_conflict' };
      definitionsToSave.push(definition);
    }

    let kindsValid: boolean;
    try { kindsValid = await dependencyKindsAreValid(definitions, sink); } catch { return { ok: false, code: 'sink_failed' }; }
    if (!kindsValid) return { ok: false, code: 'dependency_missing' };
    let ordered: Awaited<ReturnType<typeof dependencyOrder>>;
    try { ordered = await dependencyOrder(definitions, sink); } catch { return { ok: false, code: 'sink_failed' }; }
    if (!ordered.ok) return ordered;
    const assetOwners = new Map(definitions);
    const includedAssets: Array<{ relativePath: string; bytes: Buffer }> = [];
    const includedOwnerIds = new Set<string>();
    for (const asset of bundle.manifest.assets) {
      const owner = assetOwners.get(asset.ownerId);
      if (!owner || owner.provenance.origin === 'builtin'
        || (owner.kind !== 'skill' && owner.kind !== 'mcp')) return { ok: false, code: 'asset_rejected' };
      if (!asset.included || !asset.payloadPath) continue;
      const bytes = decoded.get(asset.payloadPath);
      if (!bytes || bytes.length !== asset.size || sha256(bytes) !== asset.sha256) return { ok: false, code: 'asset_rejected' };
      includedAssets.push({
        relativePath: `${sha256(asset.ownerId).slice(0, 24)}/${asset.assetPath}`,
        bytes,
      });
      includedOwnerIds.add(asset.ownerId);
    }

    const directoryToken = `bundle_${bundle.manifest.bundleDigest.slice(0, 32)}`;
    const assetBindings = [...includedOwnerIds].sort().map((ownerId) => ({
      ownerId,
      directoryToken,
      relativeRoot: sha256(ownerId).slice(0, 24),
    }));
    const plan = PersonalizationBundleImportPlanSchema.parse({
      bundleDigest: bundle.manifest.bundleDigest,
      orderedDefinitionIds: ordered.ids,
      definitionCount: definitions.size,
      includedAssetCount: includedAssets.length,
      listedAssetCount: bundle.manifest.assets.length,
      decodedBytes: bundle.payloads.reduce((sum, payload) => sum + payload.size, 0),
      assetBindings,
    });
    const orderIndex = new Map(ordered.ids.map((id, index) => [id, index]));
    definitionsToSave.sort((left, right) => (orderIndex.get(left.id) ?? 0) - (orderIndex.get(right.id) ?? 0));
    return { ok: true, value: { bundle, plan, definitionsToSave, includedAssets } };
  }
}

export function computePersonalizationBundleDigest(input: {
  manifest: Omit<PersonalizationBundle['manifest'], 'bundleDigest'>;
  payloads: PersonalizationBundle['payloads'];
}): string {
  return sha256(canonicalJson({
    manifest: input.manifest,
    payloads: [...input.payloads].sort((left, right) => left.path.localeCompare(right.path)),
  }));
}

function withoutBundleDigest(manifest: PersonalizationBundle['manifest']): Omit<PersonalizationBundle['manifest'], 'bundleDigest'> {
  const { bundleDigest, ...rest } = manifest;
  void bundleDigest;
  return rest;
}

function payloadFor(payloadPath: string, bytes: Buffer): PersonalizationBundle['payloads'][number] {
  return {
    path: payloadPath,
    encoding: 'base64',
    size: bytes.length,
    sha256: sha256(bytes),
    content: bytes.toString('base64'),
  };
}

function redactDefinitionSecrets(definition: PersonalizationDefinition): {
  definition: PersonalizationDefinition;
  secretRefs: string[];
} {
  if (definition.kind !== 'mcp') return { definition, secretRefs: [] };
  if (Object.keys(definition.environment).some((name) => !isSafeBundledEnvironmentName(name))) {
    throw new Error('MCP definition contains a runtime-control environment name');
  }
  const environment = Object.fromEntries(Object.entries(definition.environment).map(([name, value]) => [
    name,
    value.secret ? { secret: true, value: null } : value,
  ]));
  const portable = PersonalizationDefinitionSchema.parse({ ...definition, environment });
  return { definition: portable, secretRefs: secretRefsForDefinition(portable) };
}

function secretRefsForDefinition(definition: PersonalizationDefinition): string[] {
  if (definition.kind !== 'mcp') return [];
  return Object.entries(definition.environment)
    .filter(([, value]) => value.secret)
    .map(([name]) => PersonalizationBundleSecretRefSchema.parse(secretReferenceForEnvironment(name)))
    .sort();
}

function references(definition: PersonalizationDefinition): string[] {
  switch (definition.kind) {
    case 'scenario':
      return [...new Set([
        ...definition.agentIds, ...definition.skillIds, ...definition.mcpIds, ...definition.rulesIds,
        ...definition.workflow.flatMap((step) => [step.agentId, ...step.skillIds, ...step.mcpIds]
          .filter((id): id is string => typeof id === 'string')),
      ])];
    case 'agent': return [...new Set([...definition.skillIds, ...definition.mcpIds])];
    case 'skill': return [...definition.mcpIds];
    case 'mcp':
    case 'rules': return [];
  }
}

function typedReferences(definition: PersonalizationDefinition): Array<{
  id: string;
  kind: PersonalizationDefinition['kind'];
}> {
  switch (definition.kind) {
    case 'scenario':
      return [
        ...definition.agentIds.map((id) => ({ id, kind: 'agent' as const })),
        ...definition.skillIds.map((id) => ({ id, kind: 'skill' as const })),
        ...definition.mcpIds.map((id) => ({ id, kind: 'mcp' as const })),
        ...definition.rulesIds.map((id) => ({ id, kind: 'rules' as const })),
        ...definition.workflow.flatMap((step) => [
          ...(step.agentId ? [{ id: step.agentId, kind: 'agent' as const }] : []),
          ...step.skillIds.map((id) => ({ id, kind: 'skill' as const })),
          ...step.mcpIds.map((id) => ({ id, kind: 'mcp' as const })),
        ]),
      ];
    case 'agent':
      return [
        ...definition.skillIds.map((id) => ({ id, kind: 'skill' as const })),
        ...definition.mcpIds.map((id) => ({ id, kind: 'mcp' as const })),
      ];
    case 'skill': return definition.mcpIds.map((id) => ({ id, kind: 'mcp' as const }));
    case 'mcp':
    case 'rules': return [];
  }
}

async function dependencyKindsAreValid(
  definitions: ReadonlyMap<string, PersonalizationDefinition>,
  sink: PersonalizationBundleDefinitionSink,
): Promise<boolean> {
  for (const definition of definitions.values()) {
    for (const reference of typedReferences(definition)) {
      const target = definitions.get(reference.id) ?? await sink.get(reference.id);
      if (!target || target.kind !== reference.kind) return false;
    }
  }
  return true;
}

async function collectDefinitionGraph(
  rootIds: readonly string[],
  source: PersonalizationBundleDefinitionSource,
): Promise<PersonalizationDefinition[]> {
  const collected = new Map<string, PersonalizationDefinition>();
  const pending = [...rootIds];
  while (pending.length > 0) {
    const id = pending.shift()!;
    if (collected.has(id)) continue;
    const definition = await source.get(id);
    if (!definition) throw new Error(`Missing personalization definition: ${id}`);
    const parsed = PersonalizationDefinitionSchema.parse(definition);
    collected.set(parsed.id, parsed);
    pending.push(...references(parsed));
    if (collected.size + pending.length > PERSONALIZATION_BUNDLE_LIMITS.definitions * 2) {
      throw new Error('Definition graph exceeds bundle limit');
    }
  }
  return [...collected.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function dependencyOrder(
  definitions: ReadonlyMap<string, PersonalizationDefinition>,
  sink: PersonalizationBundleDefinitionSink,
): Promise<{ ok: true; ids: string[] } | { ok: false; code: 'dependency_missing' | 'dependency_cycle' }> {
  const permanent = new Set<string>();
  const temporary = new Set<string>();
  const ids: string[] = [];
  const visit = async (id: string): Promise<'ok' | 'missing' | 'cycle'> => {
    if (permanent.has(id)) return 'ok';
    if (temporary.has(id)) return 'cycle';
    temporary.add(id);
    const definition = definitions.get(id);
    if (!definition) return 'missing';
    for (const dependency of references(definition)) {
      if (definitions.has(dependency)) {
        const result = await visit(dependency);
        if (result !== 'ok') return result;
      } else if (!await sink.get(dependency)) {
        return 'missing';
      }
    }
    temporary.delete(id);
    permanent.add(id);
    ids.push(id);
    return 'ok';
  };
  for (const id of [...definitions.keys()].sort()) {
    const result = await visit(id);
    if (result === 'missing') return { ok: false, code: 'dependency_missing' };
    if (result === 'cycle') return { ok: false, code: 'dependency_cycle' };
  }
  return { ok: true, ids };
}

function containsAuthorityField(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsAuthorityField);
  const record = value as Record<string, unknown>;
  return Object.entries(record).some(([key, child]) => FORBIDDEN_AUTHORITY_FIELDS.has(key) || containsAuthorityField(child));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function ensureTrustedDirectory(input: string): string {
  const resolved = path.resolve(input);
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Unsafe import root');
  }
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  const real = fs.realpathSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(real, resolved)) throw new Error('Unsafe import root');
  return real;
}

function verifyAssetRoot(input: string): string {
  const resolved = path.resolve(input);
  const stat = fs.lstatSync(resolved);
  const real = fs.realpathSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(real, resolved)) throw new Error('Unsafe asset root');
  return real;
}

function containedFile(root: string, relative: string): string {
  const target = path.resolve(root, ...relative.split('/'));
  assertContained(root, target);
  return target;
}

function assertContained(root: string, target: string): void {
  const relation = path.relative(root, target);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    if (samePath(root, target)) return;
    throw new Error('Path escapes bundle root');
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function writeExclusiveAndSync(filePath: string, bytes: Uint8Array): void {
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function readStableRegularFile(filePath: string, maxBytes: number): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error('Unsafe asset file');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
      throw new Error('Asset changed while being exported');
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function isSensitiveAssetPath(assetPath: string): boolean {
  const name = path.posix.basename(assetPath).toLowerCase();
  return name === '.env' || name.startsWith('.env.') || name === '.npmrc'
    || name === 'credentials.json' || name === 'secrets.json' || name === 'id_rsa'
    || name.endsWith('.pem') || name.endsWith('.key') || name.endsWith('.p12') || name.endsWith('.pfx');
}

function fsyncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}
