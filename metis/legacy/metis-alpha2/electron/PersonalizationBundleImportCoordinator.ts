import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  PersonalizationBundleSchema,
  PERSONALIZATION_BUNDLE_LIMITS,
  PersonalizationBundleImportResponseSchema,
  type PersonalizationBundle,
  type PersonalizationBundleAssetBinding,
  type PersonalizationBundleImportResponse,
} from '../engine/runtime/PersonalizationBundleContract.js';
import {
  McpDefinitionSchema,
  PERSONALIZATION_LIMITS,
  PersonalizationDefinitionSchema,
  type McpDefinition,
  type PersonalizationDefinition,
  type SkillDefinitionV2,
} from '../engine/runtime/PersonalizationRuntimeContract.js';
import {
  InstalledSkillVersionSchema,
  type InstalledSkillVersion,
} from '../engine/runtime/SkillInstallationContract.js';
import type {
  PersonalizationBundleDefinitionSink,
  PersonalizationBundleDefinitionTransaction,
} from './PersonalizationBundleService.js';
import { computePersonalizationBundleDigest } from './PersonalizationBundleService.js';
import type {
  PersonalizationBundleSkillRehydrationRequest,
  PersonalizationBundleSkillRehydrationResult,
} from './PersonalizationBundleSkillRehydrationService.js';

const RECEIPT_FORMAT = 'metis-personalization-import-coordinator';
const RECEIPT_VERSION = 1;
const DEFERRED_MCP_TAG = 'deferred_requires_local_activation';
const IMPORT_LOCK_FORMAT = 'metis-personalization-import-lock';
const IMPORT_LOCK_VERSION = 1;

export interface CoordinatedBundleImportService {
  importBundle(
    rawBytes: Uint8Array,
    sink: PersonalizationBundleDefinitionSink,
  ): Promise<PersonalizationBundleImportResponse>;
}

export interface CoordinatedSkillRehydrator {
  rehydrate(request: PersonalizationBundleSkillRehydrationRequest): PersonalizationBundleSkillRehydrationResult;
}

export interface CoordinatedSkillCompensator {
  getInstalled(id: string, version?: string): unknown | undefined;
  uninstall(id: string, version?: string): { ok: boolean };
}

export interface CoordinatedRehydratedSkill {
  definitionId: string;
  version: string;
  localInstallationId: string;
  reused: boolean;
}

export interface CoordinatedDeferredMcp {
  definitionId: string;
  status: 'deferred_requires_local_activation';
}

export type PersonalizationBundleImportCoordinatorResult =
  | {
      ok: true;
      code: 'imported';
      bundleDigest: string;
      bundleManifestSha256: string;
      imported: string[];
      rehydrated: CoordinatedRehydratedSkill[];
      deferred: CoordinatedDeferredMcp[];
      compensated: false;
      replayed: boolean;
    }
  | {
      ok: false;
      code:
        | 'invalid_bundle'
        | 'bundle_import_failed'
        | 'manifest_tampered'
        | 'definition_stage_failed'
        | 'skill_rehydration_failed'
        | 'definition_publish_failed'
        | 'receipt_failed'
        | 'replay_conflict'
        | 'compensation_failed';
      bundleDigest: string | null;
      imported: string[];
      rehydrated: CoordinatedRehydratedSkill[];
      deferred: CoordinatedDeferredMcp[];
      compensated: boolean;
      detail: string;
    };

interface CollectedDefinition {
  definition: PersonalizationDefinition;
  assetBinding?: PersonalizationBundleAssetBinding;
}

interface CoordinatorReceipt {
  format: typeof RECEIPT_FORMAT;
  version: typeof RECEIPT_VERSION;
  bundleDigest: string;
  bundleManifestSha256: string;
  imported: Array<{ id: string; digest: string }>;
  rehydrated: CoordinatedRehydratedSkill[];
  deferred: CoordinatedDeferredMcp[];
  createdAt: number;
}

interface DecodedBundle {
  bundle: PersonalizationBundle;
  bundleManifestSha256: string;
  definitions: PersonalizationDefinition[];
}

interface CoordinatorImportLock {
  fd: number;
  filePath: string;
  dev: number;
  ino: number;
  nonce: string;
}

interface CoordinatorLockRecord {
  format: typeof IMPORT_LOCK_FORMAT;
  version: typeof IMPORT_LOCK_VERSION;
  bundleDigest: string;
  pid: number;
  createdAt: number;
  nonce: string;
}

type PreparedReceiptRecovery = 'complete' | 'recovered' | 'conflict' | 'compensation_failed';

type ReceiptWriteResult = { ok: true } | { ok: false; published: boolean };

/**
 * Coordinates portable bundle assets with machine-local Skill installations
 * and atomic definition publication. MCP definitions are deliberately
 * downgraded to a non-runnable deferred state until a separate local installer
 * and controlled probe establish a new machine-local identity.
 */
export class PersonalizationBundleImportCoordinator {
  readonly #bundleService: CoordinatedBundleImportService;
  readonly #definitionSink: PersonalizationBundleDefinitionSink;
  readonly #skillRehydrator: CoordinatedSkillRehydrator;
  readonly #skillCompensator: CoordinatedSkillCompensator;
  readonly #bundleAssetRoot: string;
  readonly #receiptRoot: string;
  readonly #now: () => number;

  constructor(dependencies: {
    bundleService: CoordinatedBundleImportService;
    definitionSink: PersonalizationBundleDefinitionSink;
    skillRehydrator: CoordinatedSkillRehydrator;
    skillCompensator: CoordinatedSkillCompensator;
    bundleAssetRoot: string;
    receiptRoot: string;
    now?: () => number;
  }) {
    this.#bundleService = dependencies.bundleService;
    this.#definitionSink = dependencies.definitionSink;
    this.#skillRehydrator = dependencies.skillRehydrator;
    this.#skillCompensator = dependencies.skillCompensator;
    this.#bundleAssetRoot = ensureTrustedDirectory(dependencies.bundleAssetRoot, false);
    this.#receiptRoot = ensureTrustedDirectory(dependencies.receiptRoot, true);
    if (samePath(this.#bundleAssetRoot, this.#receiptRoot)
      || contained(this.#bundleAssetRoot, this.#receiptRoot)
      || contained(this.#receiptRoot, this.#bundleAssetRoot)) {
      throw new Error('Bundle import receipts must be isolated from imported assets');
    }
    this.#now = dependencies.now ?? Date.now;
  }

  async importBundle(rawBytes: Uint8Array): Promise<PersonalizationBundleImportCoordinatorResult> {
    const decoded = decodeAndVerifyBundle(rawBytes);
    if (!decoded) return coordinatorFailure('invalid_bundle', null, 'bundle_envelope_rejected');
    const { bundle, bundleManifestSha256 } = decoded;
    const bundleDigest = bundle.manifest.bundleDigest;
    if (!this.#rootsIntact()) {
      return coordinatorFailure('bundle_import_failed', bundleDigest, 'trusted_root_changed');
    }

    const importLock = this.#acquireImportLock(bundleDigest);
    if (!importLock) {
      return coordinatorFailure('replay_conflict', bundleDigest, 'import_already_in_progress');
    }
    try {
    const receiptAfterLock = this.#readReceipt(bundleDigest);
    if (receiptAfterLock) {
      const replay = await this.#replay(decoded, receiptAfterLock);
      if (replay.ok || replay.detail !== 'published_definition_mismatch') return replay;
      const recovery = await this.#recoverPreparedReceipt(receiptAfterLock);
      if (recovery === 'complete') return replay;
      if (recovery === 'conflict') {
        return replay;
      }
      if (recovery === 'compensation_failed') {
        return coordinatorFailure('compensation_failed', bundleDigest, 'prepared_receipt_recovery_failed');
      }
    }
    if (fs.existsSync(this.#receiptPath(bundleDigest))) {
      return coordinatorFailure('replay_conflict', bundleDigest, 'receipt_invalid');
    }
    const collector = new CollectingDefinitionSink(this.#definitionSink);
    const expectedAssetToken = bundle.manifest.assets.some((asset) => asset.included)
      ? `bundle_${bundleDigest.slice(0, 32)}`
      : null;
    if (expectedAssetToken !== null && this.#assetDirectoryExists(expectedAssetToken)) {
      const definitionsAbsent = await this.#definitionsAbsent(decoded.definitions);
      if (!definitionsAbsent || !this.#removeAssetDirectory(expectedAssetToken)) {
        return coordinatorFailure(
          definitionsAbsent ? 'compensation_failed' : 'replay_conflict',
          bundleDigest,
          definitionsAbsent ? 'orphan_asset_recovery_failed' : 'asset_inventory_exists_without_receipt',
          [],
          [],
          false,
        );
      }
    }
    let importedAssetsToken: string | null;
    try {
      const rawImported = await this.#bundleService.importBundle(rawBytes, collector);
      const parsedImported = PersonalizationBundleImportResponseSchema.safeParse(rawImported);
      if (!parsedImported.success) {
        const compensated = this.#removeExpectedAssetsOrConfirmAbsent(expectedAssetToken);
        return coordinatorFailure(
          compensated ? 'bundle_import_failed' : 'compensation_failed',
          bundleDigest,
          'bundle_service_response_invalid',
          [],
          [],
          compensated,
        );
      }
      const imported = parsedImported.data;
      if (!imported.ok) {
        const compensated = this.#removeExpectedAssetsOrConfirmAbsent(expectedAssetToken);
        return coordinatorFailure(
          compensated ? 'bundle_import_failed' : 'compensation_failed',
          bundleDigest,
          imported.code,
          [],
          [],
          compensated,
        );
      }
      importedAssetsToken = imported.assetDirectoryToken;
      if (!bundleServiceOutputMatches(decoded, imported, collector.entries)) {
        const compensated = expectedAssetToken === null || (importedAssetsToken === expectedAssetToken
          && this.#removeAssetDirectory(expectedAssetToken));
        return coordinatorFailure(
          compensated ? 'manifest_tampered' : 'compensation_failed',
          bundleDigest,
          'bundle_service_output_mismatch',
          [],
          [],
          compensated,
        );
      }
    } catch {
      const compensated = this.#removeExpectedAssetsOrConfirmAbsent(expectedAssetToken);
      return coordinatorFailure(
        compensated ? 'bundle_import_failed' : 'compensation_failed',
        bundleDigest,
        'bundle_service_exception',
        [],
        [],
        compensated,
      );
    }

    if (importedAssetsToken !== null) {
      const expectedToken = `bundle_${bundleDigest.slice(0, 32)}`;
      if (importedAssetsToken !== expectedToken
        || !this.#manifestFileMatches(importedAssetsToken, bundleManifestSha256)) {
        const removed = this.#removeAssetDirectory(importedAssetsToken);
        return removed
          ? coordinatorFailure('manifest_tampered', bundleDigest, 'published_manifest_mismatch', [], [], true)
          : coordinatorFailure('compensation_failed', bundleDigest, 'published_manifest_mismatch');
      }
    }

    const transformed = collector.entries.map((entry) => ({
      definition: entry.definition.kind === 'mcp' ? deferMcp(entry.definition) : entry.definition,
      ...(entry.assetBinding ? { assetBinding: entry.assetBinding } : {}),
    }));
    const deferred = transformed
      .filter((entry): entry is { definition: McpDefinition; assetBinding?: PersonalizationBundleAssetBinding } => (
        entry.definition.kind === 'mcp'
      ))
      .map((entry): CoordinatedDeferredMcp => ({
        definitionId: entry.definition.id,
        status: 'deferred_requires_local_activation',
      }));

    let transaction: PersonalizationBundleDefinitionTransaction | undefined;
    try {
      transaction = await this.#definitionSink.begin();
      for (const entry of transformed) await transaction.save(entry.definition, entry.assetBinding);
    } catch {
      return this.#compensateFailure({
        code: 'definition_stage_failed',
        detail: 'definition_stage_exception',
        bundleDigest,
        assetDirectoryToken: importedAssetsToken,
        transaction,
        rehydrated: [],
        deferred,
      });
    }

    const bindings = new Map(collector.entries.flatMap((entry) => entry.assetBinding
      ? [[entry.definition.id, entry.assetBinding] as const] : []));
    const rehydrated: CoordinatedRehydratedSkill[] = [];
    const ownedSkills: Array<{ definitionId: string; version: string }> = [];
    for (const entry of transformed) {
      if (entry.definition.kind !== 'skill') continue;
      const binding = bindings.get(entry.definition.id) ?? null;
      let existedBefore: boolean;
      try {
        existedBefore = this.#skillCompensator.getInstalled(
          entry.definition.id,
          entry.definition.provenance.version,
        ) !== undefined;
      } catch {
        return this.#compensateFailure({
          code: 'skill_rehydration_failed',
          detail: `${entry.definition.id}:local_install_lookup_failed`,
          bundleDigest,
          assetDirectoryToken: importedAssetsToken,
          transaction,
          rehydrated,
          deferred,
          ownedSkills,
        });
      }
      let result: PersonalizationBundleSkillRehydrationResult;
      try {
        result = this.#skillRehydrator.rehydrate({
          definition: entry.definition,
          assetBinding: binding,
          bundleManifestSha256: binding ? bundleManifestSha256 : null,
        });
      } catch {
        result = {
          ok: false,
          code: 'install_failed',
          detail: 'rehydrator_exception',
          compensated: false,
        };
      }
      if (!result.ok) {
        const failureState = this.#failedSkillState(entry.definition, existedBefore);
        return this.#compensateFailure({
          code: 'skill_rehydration_failed',
          detail: `${entry.definition.id}:${result.code}:${result.detail}`,
          bundleDigest,
          assetDirectoryToken: importedAssetsToken,
          transaction,
          rehydrated,
          deferred,
          ownedSkills,
          ...failureState,
        });
      }
      let installedAfter: unknown;
      try {
        installedAfter = this.#skillCompensator.getInstalled(
          entry.definition.id,
          entry.definition.provenance.version,
        );
      } catch {
        return this.#compensateFailure({
          code: 'skill_rehydration_failed',
          detail: `${entry.definition.id}:post_install_lookup_failed`,
          bundleDigest,
          assetDirectoryToken: importedAssetsToken,
          transaction,
          rehydrated,
          deferred,
          ownedSkills,
          ...(!existedBefore && result.reused === false ? {
            orphanedSkill: {
              definitionId: entry.definition.id,
              version: entry.definition.provenance.version,
            },
          } : {}),
          compensationCertain: false,
        });
      }
      if (!validRehydrationSuccess(result, entry.definition, installedAfter)
        || (existedBefore && !result.reused)) {
        const failureState = this.#failedSkillState(entry.definition, existedBefore);
        return this.#compensateFailure({
          code: 'skill_rehydration_failed',
          detail: `${entry.definition.id}:invalid_rehydrator_success`,
          bundleDigest,
          assetDirectoryToken: importedAssetsToken,
          transaction,
          rehydrated,
          deferred,
          ownedSkills,
          ...failureState,
        });
      }
      rehydrated.push({
        definitionId: entry.definition.id,
        version: result.installed.version,
        localInstallationId: result.localInstallationId,
        reused: result.reused,
      });
      if (!existedBefore && !result.reused) {
        ownedSkills.push({
          definitionId: entry.definition.id,
          version: result.installed.version,
        });
      }
    }

    const importedDefinitions = transformed.map((entry) => ({
      id: entry.definition.id,
      digest: sha256(canonicalJson(entry.definition)),
    }));
    if (importedAssetsToken !== null
      && !this.#manifestFileMatches(importedAssetsToken, bundleManifestSha256)) {
      return this.#compensateFailure({
        code: 'manifest_tampered',
        detail: 'manifest_changed_before_publication',
        bundleDigest,
        assetDirectoryToken: importedAssetsToken,
        transaction,
        rehydrated,
        deferred,
        ownedSkills,
      });
    }
    const receiptToWrite: CoordinatorReceipt = {
      format: RECEIPT_FORMAT,
      version: RECEIPT_VERSION,
      bundleDigest,
      bundleManifestSha256,
      imported: importedDefinitions,
      rehydrated,
      deferred,
      createdAt: this.#now(),
    };
    const receiptWrite = this.#writeReceipt(receiptToWrite);
    if (!receiptWrite.ok) {
      return this.#compensateFailure({
        code: 'receipt_failed',
        detail: 'receipt_publication_failed',
        bundleDigest,
        assetDirectoryToken: importedAssetsToken,
        transaction,
        rehydrated,
        deferred,
        ownedSkills,
        removeReceipt: receiptWrite.published,
      });
    }

    try {
      await transaction.commit();
    } catch {
      const result = await this.#compensateFailure({
        code: 'definition_publish_failed',
        detail: 'definition_commit_exception',
        bundleDigest,
        assetDirectoryToken: importedAssetsToken,
        transaction,
        rehydrated,
        deferred,
        ownedSkills,
        removeReceipt: true,
      });
      return result;
    }

    return {
      ok: true,
      code: 'imported',
      bundleDigest,
      bundleManifestSha256,
      imported: importedDefinitions.map((entry) => entry.id),
      rehydrated,
      deferred,
      compensated: false,
      replayed: false,
    };
    } finally {
      this.#releaseImportLock(importLock);
    }
  }

  async #replay(
    decoded: DecodedBundle,
    receipt: CoordinatorReceipt,
  ): Promise<PersonalizationBundleImportCoordinatorResult> {
    if (!this.#rootsIntact()) {
      return coordinatorFailure('replay_conflict', receipt.bundleDigest, 'trusted_root_changed');
    }
    if (receipt.bundleManifestSha256 !== decoded.bundleManifestSha256) {
      return coordinatorFailure('replay_conflict', decoded.bundle.manifest.bundleDigest, 'receipt_manifest_mismatch');
    }
    const transformed = decoded.definitions
      .filter((definition) => definition.provenance.origin !== 'builtin')
      .map((definition) => definition.kind === 'mcp' ? deferMcp(definition) : definition);
    const expected = new Map(transformed.map((definition) => [definition.id, sha256(canonicalJson(definition))]));
    if (expected.size !== receipt.imported.length
      || receipt.imported.some((entry) => expected.get(entry.id) !== entry.digest)) {
      return coordinatorFailure('replay_conflict', receipt.bundleDigest, 'receipt_definition_mismatch');
    }
    const expectedDeferred = transformed
      .filter((definition) => definition.kind === 'mcp')
      .map((definition): CoordinatedDeferredMcp => ({
        definitionId: definition.id,
        status: 'deferred_requires_local_activation',
      }));
    const expectedSkills = transformed.filter((definition) => definition.kind === 'skill');
    if (canonicalJson(expectedDeferred) !== canonicalJson(receipt.deferred)
      || expectedSkills.length !== receipt.rehydrated.length
      || expectedSkills.some((definition) => !receipt.rehydrated.some((skill) => (
        skill.definitionId === definition.id && skill.version === definition.provenance.version
      )))) {
      return coordinatorFailure('replay_conflict', receipt.bundleDigest, 'receipt_runtime_state_mismatch');
    }
    for (const factoryDefinition of decoded.definitions.filter((definition) => (
      definition.provenance.origin === 'builtin'
    ))) {
      let current: PersonalizationDefinition | undefined;
      try { current = await this.#definitionSink.get(factoryDefinition.id); } catch { current = undefined; }
      if (!current || current.provenance.origin !== 'builtin'
        || canonicalJson(current) !== canonicalJson(factoryDefinition)) {
        return coordinatorFailure('replay_conflict', receipt.bundleDigest, 'factory_definition_mismatch');
      }
    }
    for (const entry of receipt.imported) {
      let current: PersonalizationDefinition | undefined;
      try { current = await this.#definitionSink.get(entry.id); } catch { current = undefined; }
      if (!current || sha256(canonicalJson(current)) !== entry.digest) {
        return coordinatorFailure('replay_conflict', receipt.bundleDigest, 'published_definition_mismatch');
      }
    }

    const bindingToken = `bundle_${receipt.bundleDigest.slice(0, 32)}`;
    const hasIncludedAssets = decoded.bundle.manifest.assets.some((asset) => asset.included);
    if (hasIncludedAssets && !this.#manifestFileMatches(bindingToken, receipt.bundleManifestSha256)) {
      return coordinatorFailure('replay_conflict', receipt.bundleDigest, 'replay_asset_manifest_mismatch');
    }
    const rehydrated: CoordinatedRehydratedSkill[] = [];
    for (const definition of transformed) {
      if (definition.kind !== 'skill') continue;
      const hasAssets = decoded.bundle.manifest.assets.some((asset) => asset.ownerId === definition.id && asset.included);
      const binding: PersonalizationBundleAssetBinding | null = hasAssets ? {
        ownerId: definition.id,
        directoryToken: bindingToken,
        relativeRoot: sha256(definition.id).slice(0, 24),
      } : null;
      let result: PersonalizationBundleSkillRehydrationResult;
      try {
        result = this.#skillRehydrator.rehydrate({
          definition,
          assetBinding: binding,
          bundleManifestSha256: binding ? receipt.bundleManifestSha256 : null,
        });
      } catch {
        return coordinatorFailure('replay_conflict', receipt.bundleDigest, 'replay_rehydrator_exception');
      }
      if (!result.ok) {
        return coordinatorFailure(
          'replay_conflict',
          receipt.bundleDigest,
          `replay_skill_unavailable:${definition.id}:${result.code}`,
        );
      }
      rehydrated.push({
        definitionId: definition.id,
        version: result.installed.version,
        localInstallationId: result.localInstallationId,
        reused: result.reused,
      });
    }
    if (rehydrated.some((skill) => !receipt.rehydrated.some((expectedSkill) => (
      expectedSkill.definitionId === skill.definitionId
      && expectedSkill.version === skill.version
      && expectedSkill.localInstallationId === skill.localInstallationId
    )))) {
      return coordinatorFailure('replay_conflict', receipt.bundleDigest, 'local_installation_identity_mismatch');
    }
    return {
      ok: true,
      code: 'imported',
      bundleDigest: receipt.bundleDigest,
      bundleManifestSha256: receipt.bundleManifestSha256,
      imported: receipt.imported.map((entry) => entry.id),
      rehydrated,
      deferred: receipt.deferred,
      compensated: false,
      replayed: true,
    };
  }

  async #recoverPreparedReceipt(receipt: CoordinatorReceipt): Promise<PreparedReceiptRecovery> {
    if (receipt.imported.length === 0) return 'complete';
    let missing = 0;
    for (const entry of receipt.imported) {
      let current: PersonalizationDefinition | undefined;
      try {
        current = await this.#definitionSink.get(entry.id);
      } catch {
        return 'conflict';
      }
      if (!current) {
        missing += 1;
      } else if (sha256(canonicalJson(current)) !== entry.digest) {
        return 'conflict';
      }
    }
    if (missing === 0) return 'complete';
    if (missing !== receipt.imported.length) return 'conflict';

    for (const skill of [...receipt.rehydrated].reverse()) {
      if (skill.reused) continue;
      let installed: unknown;
      try {
        installed = this.#skillCompensator.getInstalled(skill.definitionId, skill.version);
      } catch {
        return 'compensation_failed';
      }
      if (installed === undefined) continue;
      const parsed = InstalledSkillVersionSchema.safeParse(installed);
      if (!parsed.success || localInstallationId(parsed.data) !== skill.localInstallationId) return 'conflict';
      try {
        if (!this.#skillCompensator.uninstall(skill.definitionId, skill.version).ok
          || this.#skillCompensator.getInstalled(skill.definitionId, skill.version) !== undefined) {
          return 'compensation_failed';
        }
      } catch {
        return 'compensation_failed';
      }
    }
    const assetToken = `bundle_${receipt.bundleDigest.slice(0, 32)}`;
    if (!this.#removeAssetDirectory(assetToken) || !this.#removeReceipt(receipt.bundleDigest)) {
      return 'compensation_failed';
    }
    return 'recovered';
  }

  async #definitionsAbsent(definitions: readonly PersonalizationDefinition[]): Promise<boolean> {
    for (const definition of definitions) {
      if (definition.provenance.origin === 'builtin') continue;
      try {
        if (await this.#definitionSink.get(definition.id)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  #removeExpectedAssetsOrConfirmAbsent(expectedAssetToken: string | null): boolean {
    if (expectedAssetToken === null || !this.#assetDirectoryExists(expectedAssetToken)) return true;
    return this.#removeAssetDirectory(expectedAssetToken);
  }

  async #compensateFailure(input: {
    code: Extract<PersonalizationBundleImportCoordinatorResult, { ok: false }>['code'];
    detail: string;
    bundleDigest: string;
    assetDirectoryToken: string | null;
    transaction?: PersonalizationBundleDefinitionTransaction;
    rehydrated: CoordinatedRehydratedSkill[];
    deferred: CoordinatedDeferredMcp[];
    ownedSkills?: Array<{ definitionId: string; version: string }>;
    orphanedSkill?: { definitionId: string; version: string };
    compensationCertain?: boolean;
    removeReceipt?: boolean;
  }): Promise<PersonalizationBundleImportCoordinatorResult> {
    let compensated = input.compensationCertain ?? true;
    if (input.transaction) {
      try { await input.transaction.rollback(); } catch { compensated = false; }
    }
    const cleanupSkills = [
      ...(input.orphanedSkill ? [input.orphanedSkill] : []),
      ...[...(input.ownedSkills ?? [])].reverse(),
    ].filter((skill, index, values) => values.findIndex((candidate) => (
      candidate.definitionId === skill.definitionId && candidate.version === skill.version
    )) === index);
    for (const skill of cleanupSkills) {
      try {
        if (!this.#skillCompensator.uninstall(skill.definitionId, skill.version).ok) compensated = false;
        else if (this.#skillCompensator.getInstalled(skill.definitionId, skill.version) !== undefined) compensated = false;
      } catch {
        compensated = false;
      }
    }
    if (input.assetDirectoryToken && !this.#removeAssetDirectory(input.assetDirectoryToken)) compensated = false;
    if (input.removeReceipt && !this.#removeReceipt(input.bundleDigest)) compensated = false;
    return coordinatorFailure(
      compensated ? input.code : 'compensation_failed',
      input.bundleDigest,
      input.detail,
      input.rehydrated,
      input.deferred,
      compensated,
    );
  }

  #failedSkillState(
    definition: SkillDefinitionV2,
    existedBefore: boolean,
  ): {
    orphanedSkill?: { definitionId: string; version: string };
    compensationCertain: boolean;
  } {
    if (existedBefore) return { compensationCertain: true };
    try {
      const installed = this.#skillCompensator.getInstalled(
        definition.id,
        definition.provenance.version,
      );
      return installed === undefined ? { compensationCertain: true } : {
        orphanedSkill: {
          definitionId: definition.id,
          version: definition.provenance.version,
        },
        compensationCertain: true,
      };
    } catch {
      return { compensationCertain: false };
    }
  }

  #acquireImportLock(bundleDigest: string): CoordinatorImportLock | undefined {
    const filePath = path.join(this.#receiptRoot, `.import-${bundleDigest}.lock`);
    let fd: number | undefined;
    const nonce = randomUUID();
    const open = (): number => fs.openSync(filePath, 'wx', 0o600);
    try {
      this.#assertRootIntact(this.#receiptRoot);
      try {
        fd = open();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
          || !this.#recoverStaleImportLock(filePath, bundleDigest)) return undefined;
        try { fd = open(); } catch { return undefined; }
      }
      fs.writeFileSync(fd, canonicalJson({
        format: IMPORT_LOCK_FORMAT,
        version: IMPORT_LOCK_VERSION,
        bundleDigest,
        pid: process.pid,
        createdAt: this.#now(),
        nonce,
      }), 'utf8');
      fs.fsyncSync(fd);
      const stat = fs.fstatSync(fd);
      return { fd, filePath, dev: stat.dev, ino: stat.ino, nonce };
    } catch {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* best-effort failed acquisition cleanup */ }
        try { fs.unlinkSync(filePath); } catch { /* no owned lock or cleanup failed */ }
      }
      return undefined;
    }
  }

  #releaseImportLock(lock: CoordinatorImportLock): void {
    try { fs.closeSync(lock.fd); } catch { return; }
    try {
      const stat = fs.lstatSync(lock.filePath);
      if (!stat.isFile() || stat.isSymbolicLink()
        || (process.platform !== 'win32' && (stat.dev !== lock.dev || stat.ino !== lock.ino))) return;
      const record = decodeImportLock(readStableFile(lock.filePath, 2048), undefined);
      if (!record || record.pid !== process.pid || record.nonce !== lock.nonce) return;
      fs.unlinkSync(lock.filePath);
      fsyncDirectory(this.#receiptRoot);
    } catch {
      // A stale lock blocks another new import, but cannot publish partial definitions.
    }
  }

  #recoverStaleImportLock(filePath: string, bundleDigest: string): boolean {
    try {
      const raw = readStableFile(filePath, 2048);
      const record = decodeImportLock(raw, bundleDigest);
      if (!record || processIsAlive(record.pid)) return false;
      if (!readStableFile(filePath, 2048).equals(raw)) return false;
      fs.unlinkSync(filePath);
      fsyncDirectory(this.#receiptRoot);
      return true;
    } catch {
      return false;
    }
  }

  #manifestFileMatches(directoryToken: string, expectedSha256: string): boolean {
    try {
      const directory = containedPath(this.#bundleAssetRoot, directoryToken);
      assertSafeDirectory(directory, this.#bundleAssetRoot);
      const manifestPath = path.join(directory, 'bundle-manifest.json');
      return sha256(readStableFile(manifestPath, PERSONALIZATION_BUNDLE_LIMITS.fileBytes)) === expectedSha256;
    } catch {
      return false;
    }
  }

  #assetDirectoryExists(directoryToken: string): boolean {
    if (!/^bundle_[a-f0-9]{32}$/u.test(directoryToken)) return true;
    try {
      const directory = containedPath(this.#bundleAssetRoot, directoryToken);
      if (!fs.existsSync(directory)) return false;
      assertSafeDirectory(directory, this.#bundleAssetRoot);
      return true;
    } catch {
      return true;
    }
  }

  #removeAssetDirectory(directoryToken: string): boolean {
    if (!/^bundle_[a-f0-9]{32}$/u.test(directoryToken)) return false;
    try {
      const directory = containedPath(this.#bundleAssetRoot, directoryToken);
      if (!fs.existsSync(directory)) return true;
      assertSafeDirectory(directory, this.#bundleAssetRoot);
      if (!treeContainsOnlyRegularFiles(directory)) return false;
      fs.rmSync(directory, { recursive: true, force: false });
      return !fs.existsSync(directory);
    } catch {
      return false;
    }
  }

  #receiptPath(bundleDigest: string): string {
    if (!/^[a-f0-9]{64}$/u.test(bundleDigest)) throw new Error('Invalid bundle digest');
    return path.join(this.#receiptRoot, `import-${bundleDigest}.json`);
  }

  #writeReceipt(receipt: CoordinatorReceipt): ReceiptWriteResult {
    if (!decodeReceipt(receipt, receipt.bundleDigest)) return { ok: false, published: false };
    const destination = this.#receiptPath(receipt.bundleDigest);
    const temporary = path.join(this.#receiptRoot, `.receipt-${randomUUID()}.tmp`);
    let fd: number | undefined;
    let published = false;
    try {
      this.#assertRootIntact(this.#receiptRoot);
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, `${canonicalJson(receipt)}\n`, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.linkSync(temporary, destination);
      published = true;
      fs.unlinkSync(temporary);
      fsyncDirectory(this.#receiptRoot);
      return { ok: true };
    } catch {
      return { ok: false, published };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch { /* renamed or best-effort */ }
    }
  }

  #readReceipt(bundleDigest: string): CoordinatorReceipt | undefined {
    try {
      const parsed = JSON.parse(readStableFile(this.#receiptPath(bundleDigest), 2 * 1024 * 1024).toString('utf8')) as unknown;
      return decodeReceipt(parsed, bundleDigest);
    } catch {
      return undefined;
    }
  }

  #removeReceipt(bundleDigest: string): boolean {
    try {
      const receiptPath = this.#receiptPath(bundleDigest);
      if (!fs.existsSync(receiptPath)) return true;
      const stat = fs.lstatSync(receiptPath);
      if (!stat.isFile() || stat.isSymbolicLink() || !samePath(fs.realpathSync(receiptPath), receiptPath)) return false;
      fs.unlinkSync(receiptPath);
      fsyncDirectory(this.#receiptRoot);
      return true;
    } catch {
      return false;
    }
  }

  #rootsIntact(): boolean {
    try {
      this.#assertRootIntact(this.#bundleAssetRoot);
      this.#assertRootIntact(this.#receiptRoot);
      return true;
    } catch {
      return false;
    }
  }

  #assertRootIntact(root: string): void {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(root), root)) {
      throw new Error('Coordinator root changed');
    }
  }
}

class CollectingDefinitionSink implements PersonalizationBundleDefinitionSink {
  readonly entries: CollectedDefinition[] = [];
  readonly #delegate: PersonalizationBundleDefinitionSink;

  constructor(delegate: PersonalizationBundleDefinitionSink) {
    this.#delegate = delegate;
  }

  get(id: string): PersonalizationDefinition | undefined | Promise<PersonalizationDefinition | undefined> {
    return this.#delegate.get(id);
  }

  begin(): PersonalizationBundleDefinitionTransaction {
    let state: 'open' | 'committed' | 'rolled_back' = 'open';
    return {
      save: (definition, assetBinding) => {
        if (state !== 'open' || this.entries.some((entry) => entry.definition.id === definition.id)) {
          throw new Error('Collector transaction rejected duplicate or closed save');
        }
        this.entries.push({ definition, ...(assetBinding ? { assetBinding } : {}) });
      },
      commit: () => {
        if (state !== 'open') throw new Error('Collector transaction is closed');
        state = 'committed';
      },
      rollback: () => {
        if (state === 'rolled_back') return;
        this.entries.length = 0;
        state = 'rolled_back';
      },
    };
  }
}

function decodeAndVerifyBundle(rawBytes: Uint8Array): DecodedBundle | undefined {
  if (rawBytes.byteLength > PERSONALIZATION_BUNDLE_LIMITS.encodedBytes) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(rawBytes).toString('utf8')); } catch { return undefined; }
  const parsed = PersonalizationBundleSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const bundle = parsed.data;
  const { bundleDigest, ...withoutDigest } = bundle.manifest;
  if (computePersonalizationBundleDigest({ manifest: withoutDigest, payloads: bundle.payloads }) !== bundleDigest) {
    return undefined;
  }
  const payloads = new Map<string, Buffer>();
  for (const payload of bundle.payloads) {
    const bytes = Buffer.from(payload.content, 'base64');
    if (bytes.toString('base64') !== payload.content || bytes.length !== payload.size
      || sha256(bytes) !== payload.sha256) return undefined;
    payloads.set(payload.path, bytes);
  }
  const definitions: PersonalizationDefinition[] = [];
  for (const entry of bundle.manifest.definitions) {
    const bytes = payloads.get(entry.payloadPath);
    if (!bytes || bytes.length !== entry.size || sha256(bytes) !== entry.sha256) return undefined;
    try {
      const definition = PersonalizationDefinitionSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
      if (definition.id !== entry.id || definition.kind !== entry.kind) return undefined;
      definitions.push(definition);
    } catch {
      return undefined;
    }
  }
  return {
    bundle,
    bundleManifestSha256: sha256(canonicalJson(bundle.manifest)),
    definitions,
  };
}

function bundleServiceOutputMatches(
  decoded: DecodedBundle,
  imported: Extract<PersonalizationBundleImportResponse, { ok: true }>,
  entries: readonly CollectedDefinition[],
): boolean {
  const { bundle } = decoded;
  if (bundle.manifest.definitions.some((entry, index) => {
    const definition = decoded.definitions[index];
    return !definition || definition.id !== entry.id || definition.kind !== entry.kind
      || definition.id.startsWith('builtin:') !== (definition.provenance.origin === 'builtin');
  })) return false;

  const expectedDefinitions = decoded.definitions.filter((definition) => definition.provenance.origin !== 'builtin');
  const entryIds = entries.map((entry) => entry.definition.id);
  if (entries.length !== expectedDefinitions.length || new Set(entryIds).size !== entryIds.length
    || expectedDefinitions.some((definition) => {
      const collected = entries.find((entry) => entry.definition.id === definition.id);
      return !collected || canonicalJson(collected.definition) !== canonicalJson(definition);
    })) return false;

  const includedOwners = [...new Set(bundle.manifest.assets
    .filter((asset) => asset.included)
    .map((asset) => asset.ownerId))].sort();
  const directoryToken = `bundle_${bundle.manifest.bundleDigest.slice(0, 32)}`;
  const expectedBindings: PersonalizationBundleAssetBinding[] = includedOwners.map((ownerId) => ({
    ownerId,
    directoryToken,
    relativeRoot: sha256(ownerId).slice(0, 24),
  }));
  const collectedBindings = entries.flatMap((entry) => entry.assetBinding ? [entry.assetBinding] : [])
    .sort((left, right) => left.ownerId.localeCompare(right.ownerId));
  const planBindings = [...imported.plan.assetBindings]
    .sort((left, right) => left.ownerId.localeCompare(right.ownerId));
  const orderedIds = imported.plan.orderedDefinitionIds;
  const allDefinitionIds = decoded.definitions.map((definition) => definition.id);
  return canonicalJson(collectedBindings) === canonicalJson(expectedBindings)
    && canonicalJson(planBindings) === canonicalJson(expectedBindings)
    && imported.assetDirectoryToken === (includedOwners.length > 0 ? directoryToken : null)
    && imported.plan.bundleDigest === bundle.manifest.bundleDigest
    && imported.plan.definitionCount === decoded.definitions.length
    && imported.plan.includedAssetCount === bundle.manifest.assets.filter((asset) => asset.included).length
    && imported.plan.listedAssetCount === bundle.manifest.assets.length
    && imported.plan.decodedBytes === bundle.payloads.reduce((sum, payload) => sum + payload.size, 0)
    && orderedIds.length === allDefinitionIds.length
    && new Set(orderedIds).size === orderedIds.length
    && allDefinitionIds.every((id) => orderedIds.includes(id));
}

function deferMcp(definition: McpDefinition): McpDefinition {
  const tags = [DEFERRED_MCP_TAG, ...definition.tags.filter((tag) => tag !== DEFERRED_MCP_TAG)]
    .slice(0, PERSONALIZATION_LIMITS.tags);
  return McpDefinitionSchema.parse({
    ...definition,
    enabled: false,
    tags,
    args: [],
    exposedTools: [],
    workingDirectoryToken: null,
  });
}

function validRehydrationSuccess(
  result: Extract<PersonalizationBundleSkillRehydrationResult, { ok: true }>,
  definition: SkillDefinitionV2,
  installedAfter: unknown,
): boolean {
  const reported = InstalledSkillVersionSchema.safeParse(result.installed);
  const persisted = InstalledSkillVersionSchema.safeParse(installedAfter);
  if (!reported.success || !persisted.success) return false;
  const expectedLocalId = `skill_install_${sha256(
    `${reported.data.storageKey}\0${reported.data.version}\0${reported.data.packageDigest}`,
  ).slice(0, 32)}`;
  return result.code === 'rehydrated'
    && typeof result.reused === 'boolean'
    && result.localInstallationId === expectedLocalId
    && reported.data.id === definition.id
    && reported.data.version === definition.provenance.version
    && reported.data.id === persisted.data.id
    && reported.data.version === persisted.data.version
    && reported.data.storageKey === persisted.data.storageKey
    && reported.data.packageDigest === persisted.data.packageDigest;
}

function localInstallationId(installed: InstalledSkillVersion): string {
  return `skill_install_${sha256(
    `${installed.storageKey}\0${installed.version}\0${installed.packageDigest}`,
  ).slice(0, 32)}`;
}

function decodeReceipt(raw: unknown, expectedBundleDigest: string): CoordinatorReceipt | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'bundleDigest,bundleManifestSha256,createdAt,deferred,format,imported,rehydrated,version'
    || value.format !== RECEIPT_FORMAT || value.version !== RECEIPT_VERSION
    || value.bundleDigest !== expectedBundleDigest
    || typeof value.bundleManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.bundleManifestSha256)
    || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0
    || !Array.isArray(value.imported) || !Array.isArray(value.rehydrated) || !Array.isArray(value.deferred)) {
    return undefined;
  }
  const imported = value.imported as unknown[];
  const rehydrated = value.rehydrated as unknown[];
  const deferred = value.deferred as unknown[];
  if (!imported.every(validReceiptDefinition)
    || !rehydrated.every(validReceiptSkill)
    || !deferred.every(validReceiptMcp)) return undefined;
  const importedIds = imported.map((entry) => (entry as { id: string }).id);
  if (new Set(importedIds).size !== importedIds.length) return undefined;
  return value as unknown as CoordinatorReceipt;
}

function decodeImportLock(
  raw: Uint8Array,
  expectedBundleDigest: string | undefined,
): CoordinatorLockRecord | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(raw).toString('utf8')); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'bundleDigest,createdAt,format,nonce,pid,version'
    || value.format !== IMPORT_LOCK_FORMAT
    || value.version !== IMPORT_LOCK_VERSION
    || typeof value.bundleDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.bundleDigest)
    || (expectedBundleDigest !== undefined && value.bundleDigest !== expectedBundleDigest)
    || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
    || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0
    || typeof value.nonce !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value.nonce)) {
    return undefined;
  }
  return value as unknown as CoordinatorLockRecord;
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function validReceiptDefinition(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  return Object.keys(value).sort().join(',') === 'digest,id'
    && typeof value.id === 'string'
    && typeof value.digest === 'string'
    && /^[a-f0-9]{64}$/u.test(value.digest);
}

function validReceiptSkill(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  return Object.keys(value).sort().join(',') === 'definitionId,localInstallationId,reused,version'
    && typeof value.definitionId === 'string'
    && typeof value.version === 'string'
    && typeof value.localInstallationId === 'string'
    && /^skill_install_[a-f0-9]{32}$/u.test(value.localInstallationId)
    && typeof value.reused === 'boolean';
}

function validReceiptMcp(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  return Object.keys(value).sort().join(',') === 'definitionId,status'
    && typeof value.definitionId === 'string'
    && value.status === 'deferred_requires_local_activation';
}

function coordinatorFailure(
  code: Extract<PersonalizationBundleImportCoordinatorResult, { ok: false }>['code'],
  bundleDigest: string | null,
  detail: string,
  rehydrated: CoordinatedRehydratedSkill[] = [],
  deferred: CoordinatedDeferredMcp[] = [],
  compensated = false,
): Extract<PersonalizationBundleImportCoordinatorResult, { ok: false }> {
  return {
    ok: false,
    code,
    bundleDigest,
    imported: [],
    rehydrated,
    deferred,
    compensated,
    detail,
  };
}

function ensureTrustedDirectory(input: string, create: boolean): string {
  const resolved = path.resolve(input);
  if (create && !fs.existsSync(resolved)) {
    const parent = path.dirname(resolved);
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !samePath(fs.realpathSync(parent), parent)) {
      throw new Error('Unsafe coordinator root parent');
    }
    fs.mkdirSync(resolved, { mode: 0o700 });
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(resolved), resolved)) {
    throw new Error('Unsafe coordinator root');
  }
  return fs.realpathSync(resolved);
}

function contained(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function containedPath(parent: string, relative: string): string {
  const candidate = path.resolve(parent, ...relative.split('/'));
  if (!contained(parent, candidate)) throw new Error('Path escaped coordinator root');
  return candidate;
}

function assertSafeDirectory(directory: string, parent: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !contained(parent, directory)
    || !samePath(fs.realpathSync(directory), directory)) throw new Error('Unsafe coordinator directory');
}

function treeContainsOnlyRegularFiles(root: string): boolean {
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const candidate = path.join(root, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        if (!samePath(fs.realpathSync(candidate), candidate) || !treeContainsOnlyRegularFiles(candidate)) return false;
      } else if (!entry.isFile()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function readStableFile(filePath: string, maxBytes: number): Buffer {
  let fd: number | undefined;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes
      || !samePath(fs.realpathSync(filePath), filePath)) throw new Error('Unsafe file');
    fd = fs.openSync(filePath, 'r');
    const before = fs.fstatSync(fd);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (!before.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || (process.platform !== 'win32' && (before.dev !== after.dev || before.ino !== after.ino))
      || bytes.length !== before.size) throw new Error('File changed during read');
    return bytes;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLocaleLowerCase('en-US') === path.resolve(right).toLocaleLowerCase('en-US')
    : path.resolve(left) === path.resolve(right);
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
