import { z } from 'zod';
import {
  PERSONALIZATION_CONTRACT_VERSION,
  PersonalizationDigestSchema,
  PersonalizationIdSchema,
  PersonalizationSemverSchema,
  PersonalizationTimestampSchema,
  PersonalizationUrlSchema,
} from './PersonalizationRuntimeContract.js';

export const SKILL_PACKAGE_SCHEMA_VERSION = 1 as const;

export const SKILL_INSTALLATION_LIMITS = Object.freeze({
  archiveBytes: 32 * 1024 * 1024,
  extractedBytes: 96 * 1024 * 1024,
  fileBytes: 32 * 1024 * 1024,
  files: 512,
  pathChars: 512,
  manifestBytes: 512 * 1024,
  redirects: 5,
  compressionRatio: 200,
  downloadTimeoutMs: 180_000,
} as const);

// eslint-disable-next-line no-control-regex -- this trust boundary intentionally rejects control characters in archive paths
const SAFE_PACKAGE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)(?!.*\\)(?!.*[\u0000-\u001f\u007f])[A-Za-z0-9._@+ -]+(?:\/[A-Za-z0-9._@+ -]+)*$/u;

function hasUnsafeControl(value: string, multiline: boolean): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x7f && code <= 0x9f) return true;
    if (code < 0x20 && !(multiline && (code === 0x09 || code === 0x0a || code === 0x0d))) return true;
  }
  return false;
}

const SkillSingleLineSchema = z.string().min(1).max(200).refine((value) => !hasUnsafeControl(value, false), {
  message: 'Text contains unsafe control characters',
});
const SkillDescriptionSchema = z.string().max(4_000).refine((value) => !hasUnsafeControl(value, true), {
  message: 'Description contains unsafe control characters',
});

export const SkillPackagePathSchema = z.string()
  .min(1)
  .max(SKILL_INSTALLATION_LIMITS.pathChars)
  .refine((value) => SAFE_PACKAGE_PATH.test(value), { message: 'Unsafe package path' })
  .refine((value) => !value.split('/').some((segment) => segment === '.' || segment === '..' || segment.length === 0), {
    message: 'Package path contains an unsafe segment',
  })
  .refine((value) => !value.split('/').some((segment) => /[. ]$/u.test(segment)), {
    message: 'Package path contains a Windows-ambiguous trailing character',
  })
  .refine((value) => !value.split('/').some((segment) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)), {
    message: 'Package path contains a reserved device name',
  });

export const SkillPackageFileRoleSchema = z.enum(['documentation', 'script', 'asset', 'schema']);

export const SkillPackageFileSchema = z.strictObject({
  path: SkillPackagePathSchema,
  size: z.number().int().min(0).max(SKILL_INSTALLATION_LIMITS.fileBytes),
  sha256: PersonalizationDigestSchema,
  role: SkillPackageFileRoleSchema,
  executable: z.boolean(),
});

export const SkillPackageManifestSchema = z.strictObject({
  schemaVersion: z.literal(SKILL_PACKAGE_SCHEMA_VERSION),
  id: PersonalizationIdSchema.refine((value) => value.startsWith('user:') || value.startsWith('url:'), {
    message: 'Installable skill IDs must use the user: or url: namespace',
  }),
  name: SkillSingleLineSchema,
  description: SkillDescriptionSchema,
  version: PersonalizationSemverSchema,
  author: SkillSingleLineSchema,
  license: SkillSingleLineSchema.nullable(),
  entry: SkillPackagePathSchema,
  systemPromptFile: SkillPackagePathSchema.nullable(),
  files: z.array(SkillPackageFileSchema).min(1).max(SKILL_INSTALLATION_LIMITS.files),
}).superRefine((manifest, context) => {
  const foldedPaths = new Set<string>();
  for (let index = 0; index < manifest.files.length; index += 1) {
    const file = manifest.files[index];
    if (!file) continue;
    const folded = file.path.normalize('NFC').toLocaleLowerCase('en-US');
    if (foldedPaths.has(folded)) {
      context.addIssue({ code: 'custom', path: ['files', index, 'path'], message: 'Package file paths must be unique' });
    }
    foldedPaths.add(folded);
  }
  const entry = manifest.files.find((file) => file.path === manifest.entry);
  if (!entry || entry.role !== 'documentation') {
    context.addIssue({ code: 'custom', path: ['entry'], message: 'entry must name a declared documentation file' });
  }
  if (manifest.systemPromptFile !== null && !manifest.files.some((file) => file.path === manifest.systemPromptFile)) {
    context.addIssue({ code: 'custom', path: ['systemPromptFile'], message: 'systemPromptFile must name a declared file' });
  }
  const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
  if (total > SKILL_INSTALLATION_LIMITS.extractedBytes) {
    context.addIssue({ code: 'custom', path: ['files'], message: 'Declared package contents exceed the extraction limit' });
  }
});

export const SkillInstallationProvenanceSchema = z.strictObject({
  sourceMode: z.enum(['package', 'url']),
  sourceUrl: PersonalizationUrlSchema.nullable(),
  resolvedUrl: PersonalizationUrlSchema.nullable(),
  redirectChain: z.array(PersonalizationUrlSchema).max(SKILL_INSTALLATION_LIMITS.redirects),
  archiveSha256: PersonalizationDigestSchema,
  manifestSha256: PersonalizationDigestSchema,
  installedAt: PersonalizationTimestampSchema,
});

export const InstalledSkillVersionSchema = z.strictObject({
  id: PersonalizationIdSchema,
  name: z.string().min(1).max(200),
  version: PersonalizationSemverSchema,
  active: z.boolean(),
  packageDigest: PersonalizationDigestSchema,
  manifest: SkillPackageManifestSchema,
  provenance: SkillInstallationProvenanceSchema,
  storageKey: PersonalizationDigestSchema,
});

export const SkillUrlInstallRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  url: PersonalizationUrlSchema,
  expectedArchiveSha256: PersonalizationDigestSchema.nullable(),
  expectedId: PersonalizationIdSchema.nullable(),
  expectedVersion: PersonalizationSemverSchema.nullable(),
}).superRefine((request, context) => {
  try {
    const parsed = new URL(request.url);
    if (parsed.protocol !== 'https:') {
      context.addIssue({ code: 'custom', path: ['url'], message: 'Remote skill installation requires HTTPS' });
    }
    if (parsed.hash.length > 0) {
      context.addIssue({ code: 'custom', path: ['url'], message: 'Skill installation URLs cannot contain fragments' });
    }
    if ([...parsed.searchParams.keys()].some((key) => /(?:token|secret|password|credential|signature|api[_-]?key|access[_-]?key|auth)/iu.test(key))) {
      context.addIssue({ code: 'custom', path: ['url'], message: 'Skill installation URLs cannot contain credential query parameters' });
    }
  } catch {
    context.addIssue({ code: 'custom', path: ['url'], message: 'Skill installation URL is invalid' });
  }
});

export const SkillUninstallRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  id: PersonalizationIdSchema,
  version: PersonalizationSemverSchema.nullable(),
});

export const SkillSetActiveVersionRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  id: PersonalizationIdSchema,
  version: PersonalizationSemverSchema,
});

export const SkillInstallationFailureCodeSchema = z.enum([
  'invalid_request',
  'source_missing',
  'source_not_file',
  'source_symlink',
  'source_too_large',
  'archive_invalid',
  'archive_encrypted',
  'archive_unsupported',
  'too_many_files',
  'uncompressed_too_large',
  'compression_ratio_exceeded',
  'path_invalid',
  'symlink_rejected',
  'duplicate_path',
  'manifest_missing',
  'manifest_ambiguous',
  'manifest_invalid',
  'file_mismatch',
  'digest_mismatch',
  'id_mismatch',
  'version_mismatch',
  'already_installed',
  'storage_unavailable',
  'install_conflict',
  'publish_failed',
  'rollback_failed',
  'url_invalid',
  'private_network_rejected',
  'redirect_rejected',
  'redirect_limit',
  'content_type_rejected',
  'download_too_large',
  'download_failed',
  'not_found',
  'version_not_found',
  'active_version_conflict',
  'uninstall_failed',
]);

export const SkillInstallationResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), installed: InstalledSkillVersionSchema }),
  z.strictObject({
    ok: z.literal(false),
    code: SkillInstallationFailureCodeSchema,
    message: z.string().min(1).max(4_000),
  }),
]);

export const InstalledSkillListResultSchema = z.strictObject({
  ok: z.literal(true),
  installed: z.array(InstalledSkillVersionSchema).max(10_000),
});

export type SkillPackageManifest = z.infer<typeof SkillPackageManifestSchema>;
export type SkillPackageFile = z.infer<typeof SkillPackageFileSchema>;
export type SkillInstallationProvenance = z.infer<typeof SkillInstallationProvenanceSchema>;
export type InstalledSkillVersion = z.infer<typeof InstalledSkillVersionSchema>;
export type SkillUrlInstallRequest = z.infer<typeof SkillUrlInstallRequestSchema>;
export type SkillUninstallRequest = z.infer<typeof SkillUninstallRequestSchema>;
export type SkillSetActiveVersionRequest = z.infer<typeof SkillSetActiveVersionRequestSchema>;
export type SkillInstallationFailureCode = z.infer<typeof SkillInstallationFailureCodeSchema>;
export type SkillInstallationResult = z.infer<typeof SkillInstallationResultSchema>;

export function decodeSkillUrlInstallRequest(raw: unknown): SkillUrlInstallRequest | undefined {
  const result = SkillUrlInstallRequestSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

export function decodeSkillInstallationResult(raw: unknown): SkillInstallationResult {
  const result = SkillInstallationResultSchema.safeParse(raw);
  return result.success
    ? result.data
    : { ok: false, code: 'invalid_request', message: 'Invalid skill installation response' };
}
