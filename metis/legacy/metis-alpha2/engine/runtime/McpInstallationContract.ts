import { z } from 'zod';

/**
 * Strict public contract for URL-installed and Builder-generated MCP servers.
 *
 * Remote manifests are data, never launch instructions: the runtime executable
 * is selected by Metis, secrets are references rather than values, and every
 * payload file is size/hash bound before it can enter the installation store.
 */

export const MCP_PACKAGE_FORMAT = 'metis-mcp-package' as const;
export const MCP_PACKAGE_CONTRACT_VERSION = 1 as const;

export const MCP_INSTALL_LIMITS = Object.freeze({
  manifestBytes: 256 * 1024,
  packageBytes: 16 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024,
  files: 128,
  tools: 128,
  environment: 64,
  text: 8_192,
  requirement: 64_000,
  arguments: 64,
  redirects: 3,
} as const);

// eslint-disable-next-line no-control-regex -- this boundary intentionally rejects C0/C1 input
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const SAFE_ENV = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const SAFE_TOOL = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u;
const SAFE_RELATIVE_PATH = /^(?![./])(?!(?:.*[/\\])?\.\.(?:[/\\]|$))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RESERVED_RUNTIME_ENVIRONMENT = new Set([
  'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR',
  'PATH', 'PATHEXT', 'COMSPEC', 'SHELL', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'PYTHONPATH', 'RUBYOPT',
]);

function safeText(max: number = MCP_INSTALL_LIMITS.text) {
  return z.string().min(1).max(max).refine((value) => !CONTROL.test(value), {
    message: 'Text contains unsafe control characters',
  });
}

function isBlockedHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/\.$/u, '');
  if (value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local')) return true;
  if (value === '0.0.0.0' || value === '::' || value === '::1') return true;
  // Literal IPv4 addresses are rejected here. DNS results are rechecked by the installer.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)) return true;
  // Bracketed/literal IPv6 hosts are rejected; public DNS names remain supported.
  if (value.includes(':')) return true;
  return false;
}

export const McpHttpsUrlSchema = z.string().min(1).max(8_192).superRefine((value, context) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') {
      context.addIssue({ code: 'custom', message: 'Only HTTPS URLs are accepted' });
    }
    if (parsed.username || parsed.password) {
      context.addIssue({ code: 'custom', message: 'URL credentials are forbidden' });
    }
    if ([...parsed.searchParams.keys()].some((key) => /(?:token|secret|password|credential|signature|api[_-]?key|access[_-]?key|auth)/iu.test(key))) {
      context.addIssue({ code: 'custom', message: 'Credential query parameters are forbidden' });
    }
    if (isBlockedHostname(parsed.hostname)) {
      context.addIssue({ code: 'custom', message: 'Local and literal-IP hosts are forbidden' });
    }
    if (parsed.port && parsed.port !== '443') {
      context.addIssue({ code: 'custom', message: 'Only the standard HTTPS port is accepted' });
    }
    if (parsed.hash) {
      context.addIssue({ code: 'custom', message: 'URL fragments are forbidden' });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'URL is invalid' });
  }
});

export const McpPackageIdSchema = z.string().min(1).max(128).regex(SAFE_ID);
export const McpPackageVersionSchema = z.string().min(1).max(64)
  .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u);
export const McpPackageDigestSchema = z.string().regex(SHA256);
export const McpRelativePathSchema = z.string().min(1).max(512).regex(SAFE_RELATIVE_PATH)
  .refine((value) => !value.includes('\\') && value.split('/').every((segment) => segment !== '.' && segment !== '..'), {
    message: 'Unsafe relative path',
  });
export const McpEnvironmentNameSchema = z.string().regex(SAFE_ENV)
  .refine((value) => !RESERVED_RUNTIME_ENVIRONMENT.has(value), {
    message: 'Environment name controls the runtime and is forbidden',
  });
export const McpToolNameSchema = z.string().regex(SAFE_TOOL);

export const McpDeclaredToolSchema = z.strictObject({
  name: McpToolNameSchema,
  description: safeText(4_000),
  inputSchema: z.record(z.string(), z.unknown()),
});

export const McpPackageFileSchema = z.strictObject({
  path: McpRelativePathSchema,
  url: McpHttpsUrlSchema,
  sha256: McpPackageDigestSchema,
  size: z.number().int().positive().max(MCP_INSTALL_LIMITS.fileBytes),
});

export const McpSecretBindingSchema = z.strictObject({
  name: McpEnvironmentNameSchema,
  secretRef: z.string().regex(/^\$\{secret:[A-Z_][A-Z0-9_]{0,127}\}$/u),
  required: z.boolean(),
  description: safeText(2_000),
});

export const McpPackageManifestSchema = z.strictObject({
  format: z.literal(MCP_PACKAGE_FORMAT),
  contractVersion: z.literal(MCP_PACKAGE_CONTRACT_VERSION),
  packageId: McpPackageIdSchema,
  version: McpPackageVersionSchema,
  name: safeText(200),
  description: safeText(8_000),
  transport: z.literal('stdio'),
  runtime: z.literal('node'),
  entry: McpRelativePathSchema.refine((value) => value.endsWith('.mjs'), {
    message: 'Node MCP entry must be an .mjs file',
  }),
  args: z.array(safeText(2_000)).max(MCP_INSTALL_LIMITS.arguments),
  environment: z.array(McpSecretBindingSchema).max(MCP_INSTALL_LIMITS.environment),
  tools: z.array(McpDeclaredToolSchema).min(1).max(MCP_INSTALL_LIMITS.tools),
  files: z.array(McpPackageFileSchema).min(1).max(MCP_INSTALL_LIMITS.files),
}).superRefine((manifest, context) => {
  const paths = manifest.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: 'custom', path: ['files'], message: 'File paths must be unique' });
  }
  if (!paths.includes(manifest.entry)) {
    context.addIssue({ code: 'custom', path: ['entry'], message: 'Entry must be declared in files' });
  }
  const toolNames = manifest.tools.map((tool) => tool.name);
  if (new Set(toolNames).size !== toolNames.length) {
    context.addIssue({ code: 'custom', path: ['tools'], message: 'Tool names must be unique' });
  }
  const environmentNames = manifest.environment.map((item) => item.name);
  if (new Set(environmentNames).size !== environmentNames.length) {
    context.addIssue({ code: 'custom', path: ['environment'], message: 'Environment names must be unique' });
  }
  const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
  if (total > MCP_INSTALL_LIMITS.packageBytes) {
    context.addIssue({ code: 'custom', path: ['files'], message: 'Package exceeds total size limit' });
  }
});

export const McpUrlInstallRequestSchema = z.strictObject({
  operationId: z.string().uuid(),
  manifestUrl: McpHttpsUrlSchema,
  expectedManifestSha256: McpPackageDigestSchema.nullable(),
});

export const McpInstallStateSchema = z.enum([
  'downloaded',
  'static_verified',
  'probe_failed',
  'enabled',
]);

export const McpInstalledRecordSchema = z.strictObject({
  installationId: z.string().regex(/^mcp_[a-f0-9]{32}$/u),
  packageId: McpPackageIdSchema,
  packageVersion: McpPackageVersionSchema,
  manifestSha256: McpPackageDigestSchema,
  packageSha256: McpPackageDigestSchema,
  state: McpInstallStateSchema,
  enabled: z.boolean(),
  installedAt: z.number().int().nonnegative(),
  verifiedAt: z.number().int().nonnegative().nullable(),
  probedAt: z.number().int().nonnegative().nullable(),
  exposedTools: z.array(McpToolNameSchema).max(MCP_INSTALL_LIMITS.tools),
  failureCode: safeText(256).nullable(),
}).superRefine((record, context) => {
  if (record.enabled !== (record.state === 'enabled')) {
    context.addIssue({ code: 'custom', path: ['enabled'], message: 'Only enabled state may be enabled' });
  }
});

export const McpUrlInstallResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), operationId: z.string().uuid(), record: McpInstalledRecordSchema }),
  z.strictObject({
    ok: z.literal(false),
    operationId: z.string().uuid(),
    code: z.enum([
      'invalid_request', 'unsafe_url', 'dns_rejected', 'redirect_rejected', 'download_failed',
      'manifest_too_large', 'manifest_invalid', 'manifest_digest_mismatch', 'file_digest_mismatch',
      'file_size_mismatch', 'path_rejected', 'already_installed', 'storage_failed',
    ]),
  }),
]);

const BuilderEchoImplementationSchema = z.strictObject({
  kind: z.literal('echo'),
  argument: z.string().regex(SAFE_TOOL),
});

const BuilderConstantImplementationSchema = z.strictObject({
  kind: z.literal('constant_json'),
  value: z.json(),
});

const BuilderHttpImplementationSchema = z.strictObject({
  kind: z.literal('http_json'),
  baseUrl: McpHttpsUrlSchema,
  routeTemplate: z.string().min(1).max(2_000)
    .regex(/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?{}-]*$/u)
    .refine((value) => !/[{}]/u.test(value.replace(/\{[A-Za-z_][A-Za-z0-9_.-]*\}/gu, '')), {
      message: 'Route contains a malformed placeholder',
    }),
  method: z.enum(['GET', 'POST']),
  bearerSecretEnv: McpEnvironmentNameSchema.nullable(),
});

export const McpBuilderImplementationSchema = z.discriminatedUnion('kind', [
  BuilderEchoImplementationSchema,
  BuilderConstantImplementationSchema,
  BuilderHttpImplementationSchema,
]);

export const McpBuilderToolSpecificationSchema = McpDeclaredToolSchema.extend({
  implementation: McpBuilderImplementationSchema,
}).strict();

export const McpBuilderSpecificationSchema = z.strictObject({
  contractVersion: z.literal(MCP_PACKAGE_CONTRACT_VERSION),
  packageId: McpPackageIdSchema,
  version: McpPackageVersionSchema,
  name: safeText(200),
  description: safeText(8_000),
  tools: z.array(McpBuilderToolSpecificationSchema).min(1).max(MCP_INSTALL_LIMITS.tools),
  environment: z.array(McpSecretBindingSchema).max(MCP_INSTALL_LIMITS.environment),
}).superRefine((specification, context) => {
  const toolNames = specification.tools.map((tool) => tool.name);
  if (new Set(toolNames).size !== toolNames.length) {
    context.addIssue({ code: 'custom', path: ['tools'], message: 'Tool names must be unique' });
  }
  const environment = new Set(specification.environment.map((item) => item.name));
  for (let index = 0; index < specification.tools.length; index += 1) {
    const tool = specification.tools[index];
    if (!tool) continue;
    if (tool.implementation.kind === 'http_json' && tool.implementation.bearerSecretEnv
      && !environment.has(tool.implementation.bearerSecretEnv)) {
      context.addIssue({
        code: 'custom',
        path: ['tools', index, 'implementation', 'bearerSecretEnv'],
        message: 'HTTP secret must be declared in environment',
      });
    }
    const properties = tool.inputSchema.properties;
    const propertyNames = properties && typeof properties === 'object' && !Array.isArray(properties)
      ? new Set(Object.keys(properties)) : new Set<string>();
    if (tool.implementation.kind === 'echo' && !propertyNames.has(tool.implementation.argument)) {
      context.addIssue({
        code: 'custom', path: ['tools', index, 'implementation', 'argument'],
        message: 'Echo argument must exist in input schema',
      });
    }
    if (tool.implementation.kind === 'http_json') {
      const placeholders = [...tool.implementation.routeTemplate.matchAll(/\{([A-Za-z_][A-Za-z0-9_.-]*)\}/gu)]
        .map((match) => match[1]!);
      for (const placeholder of placeholders) {
        if (!propertyNames.has(placeholder)) {
          context.addIssue({
            code: 'custom', path: ['tools', index, 'implementation', 'routeTemplate'],
            message: `Route placeholder '${placeholder}' is not declared in input schema`,
          });
        }
      }
    }
  }
});

export const McpBuilderRequestSchema = z.strictObject({
  operationId: z.string().uuid(),
  requirement: safeText(MCP_INSTALL_LIMITS.requirement),
  requestedPackageId: McpPackageIdSchema,
});

export const McpBuilderResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    operationId: z.string().uuid(),
    record: McpInstalledRecordSchema,
    outcome: z.enum(['pending_probe', 'enabled']),
  }),
  z.strictObject({
    ok: z.literal(false),
    operationId: z.string().uuid(),
    code: z.enum([
      'invalid_request', 'provider_failed', 'spec_invalid', 'package_id_mismatch',
      'schema_unsupported', 'generation_failed', 'installation_failed',
      'static_validation_failed', 'probe_failed', 'cleanup_failed',
    ]),
  }),
]);

export const McpProbeResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    tools: z.array(McpDeclaredToolSchema).min(1).max(MCP_INSTALL_LIMITS.tools),
    protocolVersion: safeText(64),
  }),
  z.strictObject({ ok: z.literal(false), code: safeText(256) }),
]);

export type McpPackageManifest = z.infer<typeof McpPackageManifestSchema>;
export type McpInstalledRecord = z.infer<typeof McpInstalledRecordSchema>;
export type McpUrlInstallRequest = z.infer<typeof McpUrlInstallRequestSchema>;
export type McpUrlInstallResponse = z.infer<typeof McpUrlInstallResponseSchema>;
export type McpBuilderSpecification = z.infer<typeof McpBuilderSpecificationSchema>;
export type McpBuilderRequest = z.infer<typeof McpBuilderRequestSchema>;
export type McpBuilderResponse = z.infer<typeof McpBuilderResponseSchema>;
export type McpProbeResult = z.infer<typeof McpProbeResultSchema>;
