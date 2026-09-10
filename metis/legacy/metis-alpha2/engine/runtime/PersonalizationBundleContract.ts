import { z } from 'zod';
import {
  PersonalizationDefinitionSchema,
  PersonalizationIdSchema,
  PersonalizationKindSchema,
} from './PersonalizationRuntimeContract.js';

export const PERSONALIZATION_BUNDLE_FORMAT = 'metis-personalization-bundle' as const;
export const PERSONALIZATION_BUNDLE_VERSION = 1 as const;

export const PERSONALIZATION_BUNDLE_LIMITS = Object.freeze({
  encodedBytes: 64 * 1024 * 1024,
  decodedBytes: 32 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024,
  definitions: 2_000,
  assets: 512,
  payloads: 3_000,
  pathChars: 1_024,
  secretRefs: 128,
} as const);

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PAYLOAD_PATH = /^(?:definitions|assets)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,1022}$/u;
const SAFE_ASSET_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1022}$/u;
const SAFE_ENVIRONMENT = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const RESERVED_RUNTIME_ENVIRONMENT = new Set([
  'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR',
  'PATH', 'PATHEXT', 'COMSPEC', 'SHELL', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'PYTHONPATH', 'RUBYOPT',
]);

function safeSegments(value: string): boolean {
  return !value.includes('\\')
    && !value.startsWith('/')
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export const PersonalizationBundleDigestSchema = z.string().regex(SHA256);
export const PersonalizationBundlePayloadPathSchema = z.string()
  .min(1).max(PERSONALIZATION_BUNDLE_LIMITS.pathChars).regex(SAFE_PAYLOAD_PATH).refine(safeSegments, {
    message: 'Unsafe bundle payload path',
  });
export const PersonalizationBundleAssetPathSchema = z.string()
  .min(1).max(PERSONALIZATION_BUNDLE_LIMITS.pathChars).regex(SAFE_ASSET_PATH).refine(safeSegments, {
    message: 'Unsafe bundle asset path',
  });
export const PersonalizationBundleSecretRefSchema = z.string()
  .regex(/^\$\{secret:[A-Z_][A-Z0-9_]{0,127}\}$/u)
  .refine((value) => isSafeBundledEnvironmentName(value.slice('${secret:'.length, -1)), {
    message: 'Secret reference controls the runtime and is forbidden',
  });

export const PersonalizationBundlePayloadSchema = z.strictObject({
  path: PersonalizationBundlePayloadPathSchema,
  encoding: z.literal('base64'),
  size: z.number().int().nonnegative().max(PERSONALIZATION_BUNDLE_LIMITS.fileBytes),
  sha256: PersonalizationBundleDigestSchema,
  content: z.string().max(Math.ceil(PERSONALIZATION_BUNDLE_LIMITS.fileBytes * 4 / 3) + 8),
});

export const PersonalizationBundleDefinitionEntrySchema = z.strictObject({
  id: PersonalizationIdSchema,
  kind: PersonalizationKindSchema,
  payloadPath: PersonalizationBundlePayloadPathSchema,
  size: z.number().int().positive().max(PERSONALIZATION_BUNDLE_LIMITS.fileBytes),
  sha256: PersonalizationBundleDigestSchema,
  secretRefs: z.array(PersonalizationBundleSecretRefSchema)
    .max(PERSONALIZATION_BUNDLE_LIMITS.secretRefs)
    .refine((values) => new Set(values).size === values.length, { message: 'Secret references must be unique' }),
});

export const PersonalizationBundleAssetEntrySchema = z.strictObject({
  ownerId: PersonalizationIdSchema,
  assetPath: PersonalizationBundleAssetPathSchema,
  payloadPath: PersonalizationBundlePayloadPathSchema.nullable(),
  included: z.boolean(),
  executable: z.literal(false),
  size: z.number().int().nonnegative().max(PERSONALIZATION_BUNDLE_LIMITS.fileBytes),
  sha256: PersonalizationBundleDigestSchema,
}).superRefine((entry, context) => {
  if (entry.included !== (entry.payloadPath !== null)) {
    context.addIssue({ code: 'custom', path: ['payloadPath'], message: 'Included assets require a payload path' });
  }
});

export const PersonalizationBundleManifestSchema = z.strictObject({
  format: z.literal(PERSONALIZATION_BUNDLE_FORMAT),
  version: z.literal(PERSONALIZATION_BUNDLE_VERSION),
  bundleId: z.string().uuid(),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdBy: z.string().min(1).max(200),
  rootDefinitionIds: z.array(PersonalizationIdSchema).max(PERSONALIZATION_BUNDLE_LIMITS.definitions),
  definitions: z.array(PersonalizationBundleDefinitionEntrySchema)
    .min(1).max(PERSONALIZATION_BUNDLE_LIMITS.definitions),
  assets: z.array(PersonalizationBundleAssetEntrySchema).max(PERSONALIZATION_BUNDLE_LIMITS.assets),
  bundleDigest: PersonalizationBundleDigestSchema,
}).superRefine((manifest, context) => {
  const definitionIds = manifest.definitions.map((entry) => entry.id);
  const definitionPaths = manifest.definitions.map((entry) => entry.payloadPath);
  const assetIdentities = manifest.assets.map((entry) => `${entry.ownerId}\0${entry.assetPath}`);
  const payloadPaths = [
    ...definitionPaths,
    ...manifest.assets.flatMap((entry) => entry.payloadPath ? [entry.payloadPath] : []),
  ];
  if (new Set(definitionIds).size !== definitionIds.length) {
    context.addIssue({ code: 'custom', path: ['definitions'], message: 'Definition IDs must be unique' });
  }
  if (new Set(definitionPaths).size !== definitionPaths.length) {
    context.addIssue({ code: 'custom', path: ['definitions'], message: 'Definition payload paths must be unique' });
  }
  if (new Set(assetIdentities).size !== assetIdentities.length) {
    context.addIssue({ code: 'custom', path: ['assets'], message: 'Asset identities must be unique' });
  }
  if (new Set(payloadPaths).size !== payloadPaths.length) {
    context.addIssue({ code: 'custom', message: 'All payload paths must be unique' });
  }
  const definitionSet = new Set(definitionIds);
  if (new Set(manifest.rootDefinitionIds).size !== manifest.rootDefinitionIds.length
    || manifest.rootDefinitionIds.some((id) => !definitionSet.has(id))) {
    context.addIssue({ code: 'custom', path: ['rootDefinitionIds'], message: 'Roots must be unique bundled definitions' });
  }
  if (manifest.assets.some((asset) => !definitionSet.has(asset.ownerId))) {
    context.addIssue({ code: 'custom', path: ['assets'], message: 'Asset owner must be bundled' });
  }
});

export const PersonalizationBundleSchema = z.strictObject({
  manifest: PersonalizationBundleManifestSchema,
  payloads: z.array(PersonalizationBundlePayloadSchema)
    .min(1).max(PERSONALIZATION_BUNDLE_LIMITS.payloads),
}).superRefine((bundle, context) => {
  const paths = bundle.payloads.map((payload) => payload.path);
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: 'custom', path: ['payloads'], message: 'Payload paths must be unique' });
  }
  const expected = new Set([
    ...bundle.manifest.definitions.map((entry) => entry.payloadPath),
    ...bundle.manifest.assets.flatMap((entry) => entry.payloadPath ? [entry.payloadPath] : []),
  ]);
  if (paths.length !== expected.size || paths.some((payloadPath) => !expected.has(payloadPath))) {
    context.addIssue({ code: 'custom', path: ['payloads'], message: 'Payload list must exactly match the manifest' });
  }
  const total = bundle.payloads.reduce((sum, payload) => sum + payload.size, 0);
  if (total > PERSONALIZATION_BUNDLE_LIMITS.decodedBytes) {
    context.addIssue({ code: 'custom', path: ['payloads'], message: 'Bundle exceeds decoded size limit' });
  }
});

export const PersonalizationBundleExportRequestSchema = z.strictObject({
  rootDefinitionIds: z.array(PersonalizationIdSchema).min(1).max(PERSONALIZATION_BUNDLE_LIMITS.definitions),
  assetMode: z.enum(['none', 'manifest_only', 'include_files']),
  createdBy: z.string().min(1).max(200),
});

export const PersonalizationBundleAssetBindingSchema = z.strictObject({
  ownerId: PersonalizationIdSchema,
  directoryToken: z.string().regex(/^bundle_[a-f0-9]{32}$/u),
  relativeRoot: z.string().regex(/^[a-f0-9]{24}$/u),
});

export const PersonalizationBundleImportPlanSchema = z.strictObject({
  bundleDigest: PersonalizationBundleDigestSchema,
  orderedDefinitionIds: z.array(PersonalizationIdSchema).min(1).max(PERSONALIZATION_BUNDLE_LIMITS.definitions),
  definitionCount: z.number().int().positive().max(PERSONALIZATION_BUNDLE_LIMITS.definitions),
  includedAssetCount: z.number().int().nonnegative().max(PERSONALIZATION_BUNDLE_LIMITS.assets),
  listedAssetCount: z.number().int().nonnegative().max(PERSONALIZATION_BUNDLE_LIMITS.assets),
  decodedBytes: z.number().int().nonnegative().max(PERSONALIZATION_BUNDLE_LIMITS.decodedBytes),
  assetBindings: z.array(PersonalizationBundleAssetBindingSchema).max(PERSONALIZATION_BUNDLE_LIMITS.definitions),
});

export const PersonalizationBundleImportResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    plan: PersonalizationBundleImportPlanSchema,
    assetDirectoryToken: z.string().regex(/^bundle_[a-f0-9]{32}$/u).nullable(),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum([
      'bundle_too_large', 'invalid_bundle', 'digest_mismatch', 'payload_mismatch',
      'definition_invalid', 'truth_field_rejected', 'factory_protected', 'existing_conflict',
      'dependency_missing', 'dependency_cycle', 'asset_rejected', 'staging_failed',
      'sink_failed', 'commit_failed', 'rollback_failed',
    ]),
  }),
]);

export const PersonalizationBundleExportIpcRequestSchema = z.strictObject({
  contractVersion: z.literal(1),
  operationId: z.string().uuid(),
  rootDefinitionIds: z.array(PersonalizationIdSchema).min(1).max(PERSONALIZATION_BUNDLE_LIMITS.definitions)
    .refine((ids) => new Set(ids).size === ids.length),
});

export const PersonalizationBundleImportIpcRequestSchema = z.strictObject({
  contractVersion: z.literal(1),
  operationId: z.string().uuid(),
});

export const PersonalizationBundleIpcResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    operationId: z.string().uuid(),
    action: z.enum(['exported', 'imported']),
    bundleDigest: PersonalizationBundleDigestSchema,
    definitionCount: z.number().int().positive().max(PERSONALIZATION_BUNDLE_LIMITS.definitions),
  }),
  z.strictObject({
    ok: z.literal(false),
    operationId: z.string().uuid(),
    code: z.enum(['invalid_request', 'cancelled', 'service_unavailable', 'read_failed', 'write_failed', 'export_failed', 'import_failed']),
  }),
]);

export type PersonalizationBundle = z.infer<typeof PersonalizationBundleSchema>;
export type PersonalizationBundleManifest = z.infer<typeof PersonalizationBundleManifestSchema>;
export type PersonalizationBundlePayload = z.infer<typeof PersonalizationBundlePayloadSchema>;
export type PersonalizationBundleExportRequest = z.infer<typeof PersonalizationBundleExportRequestSchema>;
export type PersonalizationBundleImportPlan = z.infer<typeof PersonalizationBundleImportPlanSchema>;
export type PersonalizationBundleImportResponse = z.infer<typeof PersonalizationBundleImportResponseSchema>;
export type PersonalizationDefinitionForBundle = z.infer<typeof PersonalizationDefinitionSchema>;
export type PersonalizationBundleAssetBinding = z.infer<typeof PersonalizationBundleAssetBindingSchema>;
export type PersonalizationBundleExportIpcRequest = z.infer<typeof PersonalizationBundleExportIpcRequestSchema>;
export type PersonalizationBundleImportIpcRequest = z.infer<typeof PersonalizationBundleImportIpcRequestSchema>;
export type PersonalizationBundleIpcResponse = z.infer<typeof PersonalizationBundleIpcResponseSchema>;

export function decodePersonalizationBundleIpcResponse(raw: unknown): PersonalizationBundleIpcResponse {
  const parsed = PersonalizationBundleIpcResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data : {
    ok: false,
    operationId: '00000000-0000-4000-8000-000000000000',
    code: 'invalid_request',
  };
}

export function secretReferenceForEnvironment(name: string): string {
  if (!isSafeBundledEnvironmentName(name)) throw new Error('Invalid environment name');
  return `\${secret:${name}}`;
}

export function isSafeBundledEnvironmentName(name: string): boolean {
  return SAFE_ENVIRONMENT.test(name) && !RESERVED_RUNTIME_ENVIRONMENT.has(name);
}
