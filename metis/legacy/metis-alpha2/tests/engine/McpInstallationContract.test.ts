import { describe, expect, it } from 'vitest';
import {
  McpBuilderSpecificationSchema,
  McpHttpsUrlSchema,
  McpPackageManifestSchema,
  McpUrlInstallRequestSchema,
} from '../../engine/runtime/McpInstallationContract.js';

const INPUT_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
  additionalProperties: false,
};

function manifest() {
  return {
    format: 'metis-mcp-package',
    contractVersion: 1,
    packageId: 'literature-search',
    version: '1.0.0',
    name: 'Literature Search',
    description: 'Searches a configured literature endpoint.',
    transport: 'stdio',
    runtime: 'node',
    entry: 'server.mjs',
    args: [],
    environment: [{
      name: 'LITERATURE_TOKEN',
      secretRef: '${secret:LITERATURE_TOKEN}',
      required: true,
      description: 'Access token',
    }],
    tools: [{ name: 'search', description: 'Search literature', inputSchema: INPUT_SCHEMA }],
    files: [{
      path: 'server.mjs',
      url: 'https://packages.example.org/literature/server.mjs',
      sha256: 'a'.repeat(64),
      size: 20,
    }],
  };
}

describe('MCP installation contract', () => {
  it('accepts a strict stdio package with secret references but no secret values', () => {
    expect(McpPackageManifestSchema.parse(manifest()).transport).toBe('stdio');
  });

  it.each([
    'https://user:password@example.org/manifest.json',
    'http://example.org/manifest.json',
    'https://localhost/manifest.json',
    'https://127.0.0.1/manifest.json',
    'https://[::1]/manifest.json',
    'https://example.org:8443/manifest.json',
    'https://example.org/manifest.json#credential',
  ])('rejects unsafe install URL %s', (url) => {
    expect(McpHttpsUrlSchema.safeParse(url).success).toBe(false);
  });

  it('rejects renderer smuggling and literal environment secrets', () => {
    expect(McpUrlInstallRequestSchema.safeParse({
      operationId: crypto.randomUUID(),
      manifestUrl: 'https://example.org/manifest.json',
      expectedManifestSha256: null,
      command: 'powershell',
    }).success).toBe(false);
    const value = manifest();
    value.environment = [{
      name: 'LITERATURE_TOKEN',
      secretRef: 'actual-secret-value',
      required: true,
      description: 'Access token',
    }];
    expect(McpPackageManifestSchema.safeParse(value).success).toBe(false);
  });

  it.each(['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'])(
    'rejects runtime-control environment injection through %s', (name) => {
      const value = manifest();
      value.environment[0] = {
        name,
        secretRef: `\${secret:${name}}`,
        required: true,
        description: 'Attempted runtime injection',
      };
      expect(McpPackageManifestSchema.safeParse(value).success).toBe(false);
    },
  );

  it.each(['../escape.mjs', 'nested/../escape.mjs', 'nested/./escape.mjs', 'C:/escape.mjs', '/root.mjs'])(
    'rejects package path traversal %s', (entry) => {
      const value = manifest();
      value.entry = entry;
      value.files[0]!.path = entry;
      expect(McpPackageManifestSchema.safeParse(value).success).toBe(false);
    },
  );

  it('rejects duplicate files, tools, and undeclared entries', () => {
    const duplicateFile = manifest();
    duplicateFile.files.push({ ...duplicateFile.files[0]! });
    expect(McpPackageManifestSchema.safeParse(duplicateFile).success).toBe(false);

    const duplicateTool = manifest();
    duplicateTool.tools.push({ ...duplicateTool.tools[0]! });
    expect(McpPackageManifestSchema.safeParse(duplicateTool).success).toBe(false);

    const missingEntry = manifest();
    missingEntry.entry = 'missing.mjs';
    expect(McpPackageManifestSchema.safeParse(missingEntry).success).toBe(false);
  });

  it('rejects malicious or extra manifest fields', () => {
    expect(McpPackageManifestSchema.safeParse({ ...manifest(), shell: true }).success).toBe(false);
    expect(McpPackageManifestSchema.safeParse({ ...manifest(), command: 'cmd.exe' }).success).toBe(false);
  });
});

describe('MCP Builder intermediate specification', () => {
  function specification() {
    return {
      contractVersion: 1,
      packageId: 'literature-builder',
      version: '1.0.0',
      name: 'Literature Builder',
      description: 'Generated from a bounded declarative specification.',
      environment: [],
      tools: [{
        name: 'search',
        description: 'Search',
        inputSchema: INPUT_SCHEMA,
        implementation: { kind: 'echo', argument: 'query' },
      }],
    };
  }

  it('accepts a bounded implementation DSL rather than authored source code', () => {
    expect(McpBuilderSpecificationSchema.parse(specification()).tools[0]?.implementation.kind).toBe('echo');
    expect(McpBuilderSpecificationSchema.safeParse({ ...specification(), sourceCode: 'process.exit()' }).success).toBe(false);
  });

  it('rejects phantom arguments and undeclared secret bindings', () => {
    const phantom = specification();
    phantom.tools[0]!.implementation = { kind: 'echo', argument: 'missing' };
    expect(McpBuilderSpecificationSchema.safeParse(phantom).success).toBe(false);

    const secret = specification();
    secret.tools[0]!.implementation = {
      kind: 'http_json',
      baseUrl: 'https://api.example.org',
      routeTemplate: '/search/{query}',
      method: 'GET',
      bearerSecretEnv: 'API_TOKEN',
    };
    expect(McpBuilderSpecificationSchema.safeParse(secret).success).toBe(false);
  });

  it('rejects endpoint host injection and route placeholders absent from the schema', () => {
    const value = specification();
    value.tools[0]!.implementation = {
      kind: 'http_json',
      baseUrl: 'https://api.example.org',
      routeTemplate: '/search/{host}',
      method: 'GET',
      bearerSecretEnv: null,
    };
    expect(McpBuilderSpecificationSchema.safeParse(value).success).toBe(false);
  });
});
