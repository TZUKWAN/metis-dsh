import { createHash } from 'node:crypto';
import { buildArgsDecoder } from '../engine/tools/ArgsValidator.js';
import {
  McpBuilderRequestSchema,
  McpBuilderResponseSchema,
  McpBuilderSpecificationSchema,
  McpPackageManifestSchema,
  type McpBuilderResponse,
  type McpBuilderSpecification,
  type McpPackageManifest,
} from '../engine/runtime/McpInstallationContract.js';
import {
  PersonalizationMcpInstaller,
  type McpControlledProbeRunner,
} from './PersonalizationMcpInstaller.js';

/** Provider adapter deliberately returns unknown. The strict DSL is the trust boundary. */
export interface McpBuilderProvider {
  createSpecification(input: Readonly<{
    requirement: string;
    requestedPackageId: string;
    contractVersion: 1;
  }>): Promise<unknown>;
}

export interface McpGeneratedBundle {
  manifest: McpPackageManifest;
  files: ReadonlyArray<{ path: string; body: Uint8Array }>;
}

const FALLBACK_OPERATION_ID = '00000000-0000-4000-8000-000000000000';

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function operationIdFrom(raw: unknown): string {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const candidate = (raw as Record<string, unknown>).operationId;
    if (typeof candidate === 'string' && McpBuilderRequestSchema.shape.operationId.safeParse(candidate).success) {
      return candidate;
    }
  }
  return FALLBACK_OPERATION_ID;
}

export class McpBuilderService {
  readonly #installer: PersonalizationMcpInstaller;
  readonly #provider: McpBuilderProvider;

  constructor(installer: PersonalizationMcpInstaller, provider: McpBuilderProvider) {
    this.#installer = installer;
    this.#provider = provider;
  }

  /**
   * Converts a natural-language requirement into the bounded Builder DSL and a
   * deterministic MCP server. Without a controlled probe runner the result is
   * intentionally left disabled in `static_verified` state.
   */
  async build(raw: unknown, runner?: McpControlledProbeRunner): Promise<McpBuilderResponse> {
    const operationId = operationIdFrom(raw);
    const request = McpBuilderRequestSchema.safeParse(raw);
    if (!request.success) return this.#failure(operationId, 'invalid_request');

    let providerOutput: unknown;
    try {
      providerOutput = await this.#provider.createSpecification({
        requirement: request.data.requirement,
        requestedPackageId: request.data.requestedPackageId,
        contractVersion: 1,
      });
    } catch {
      return this.#failure(operationId, 'provider_failed');
    }
    const specification = McpBuilderSpecificationSchema.safeParse(providerOutput);
    if (!specification.success) return this.#failure(operationId, 'spec_invalid');
    if (specification.data.packageId !== request.data.requestedPackageId) {
      return this.#failure(operationId, 'package_id_mismatch');
    }
    try {
      for (const tool of specification.data.tools) buildArgsDecoder(tool.inputSchema);
    } catch {
      return this.#failure(operationId, 'schema_unsupported');
    }

    let bundle: McpGeneratedBundle;
    try { bundle = generateMcpBundle(specification.data); } catch {
      return this.#failure(operationId, 'generation_failed');
    }
    let installation;
    try { installation = this.#installer.installGeneratedPackage(bundle.manifest, bundle.files); } catch {
      installation = this.#installer.resumeExactUnactivatedGeneratedPackage(bundle.manifest, bundle.files);
      if (!installation) return this.#failure(operationId, 'installation_failed');
    }
    const staticResult = this.#installer.staticValidate(installation.installationId);
    if (!staticResult.ok || !staticResult.record) {
      if (!this.#installer.removeUnactivatedInstallation(installation.installationId)) {
        return this.#failure(operationId, 'cleanup_failed');
      }
      return this.#failure(operationId, 'static_validation_failed');
    }
    if (!runner) {
      return McpBuilderResponseSchema.parse({
        ok: true,
        operationId,
        record: staticResult.record,
        outcome: 'pending_probe',
      });
    }
    const probeResult = await this.#installer.probeAndEnable(installation.installationId, runner);
    if (!probeResult.ok || !probeResult.record) {
      if (!this.#installer.removeUnactivatedInstallation(installation.installationId)) {
        return this.#failure(operationId, 'cleanup_failed');
      }
      return this.#failure(operationId, 'probe_failed');
    }
    return McpBuilderResponseSchema.parse({
      ok: true,
      operationId,
      record: probeResult.record,
      outcome: 'enabled',
    });
  }

  #failure(operationId: string, code: Extract<McpBuilderResponse, { ok: false }>['code']): McpBuilderResponse {
    return McpBuilderResponseSchema.parse({ ok: false, operationId, code });
  }
}

/** Generates a dependency-free newline-delimited JSON-RPC stdio MCP server. */
export function generateMcpBundle(raw: unknown): McpGeneratedBundle {
  const specification = McpBuilderSpecificationSchema.parse(raw);
  for (const tool of specification.tools) buildArgsDecoder(tool.inputSchema);
  const entry = 'server.mjs';
  const source = generateServerSource(specification);
  const sourceBytes = Buffer.from(source, 'utf8');
  const sourceUrl = `https://generated.metis.invalid/${encodeURIComponent(specification.packageId)}/${entry}`;
  const manifest = McpPackageManifestSchema.parse({
    format: 'metis-mcp-package',
    contractVersion: 1,
    packageId: specification.packageId,
    version: specification.version,
    name: specification.name,
    description: specification.description,
    transport: 'stdio',
    runtime: 'node',
    entry,
    args: [],
    environment: specification.environment,
    tools: specification.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    files: [{ path: entry, url: sourceUrl, sha256: sha256(sourceBytes), size: sourceBytes.length }],
  });
  return { manifest, files: [{ path: entry, body: sourceBytes }] };
}

function generateServerSource(specification: McpBuilderSpecification): string {
  const toolDefinitions = specification.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  const implementations = Object.fromEntries(specification.tools.map((tool) => [tool.name, tool.implementation]));
  // Values are serialized as JSON literals, never interpolated into executable source fragments.
  return `import readline from 'node:readline';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

const TOOLS = ${JSON.stringify(toolDefinitions)};
const IMPLEMENTATIONS = ${JSON.stringify(implementations)};
const BLOCKED_IPV6 = new net.BlockList();
for (const [subnet, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 32], ['2001:2::', 48], ['2001:10::', 28],
  ['2001:20::', 28], ['2001:db8::', 32], ['2002::', 16], ['5f00::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) BLOCKED_IPV6.addSubnet(subnet, prefix, 'ipv6');

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function validate(schema, value) {
  if (!schema || schema.type !== 'object' || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);
  for (const key of required) if (!(key in value)) return false;
  for (const key of Object.keys(value)) if (!(key in properties)) return false;
  for (const [key, item] of Object.entries(value)) {
    const expected = properties[key] && properties[key].type;
    if (expected === 'string' && typeof item !== 'string') return false;
    if (expected === 'number' && typeof item !== 'number') return false;
    if (expected === 'integer' && (!Number.isInteger(item))) return false;
    if (expected === 'boolean' && typeof item !== 'boolean') return false;
  }
  return true;
}

function expandRoute(template, args) {
  return template.replace(/\\{([A-Za-z_][A-Za-z0-9_.-]*)\\}/g, (_whole, key) => encodeURIComponent(String(args[key])));
}

function privateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const [a = -1, b = -1] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 0 || b === 168)) return true;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
    if (a === 203 && b === 0) return true;
    return false;
  }
  if (version === 6) {
    return BLOCKED_IPV6.check(address, 'ipv6');
  }
  return true;
}

async function requestJson(target, method, headers, requestBody) {
  const resolved = await dns.lookup(target.hostname, { all: true, verbatim: true });
  if (resolved.length === 0 || resolved.some((item) => privateAddress(item.address))) {
    throw new Error('Endpoint resolved to a forbidden network');
  }
  const chosen = resolved[0];
  return await new Promise((resolve, reject) => {
    const request = https.request(target, {
      method,
      headers,
      servername: target.hostname,
      lookup: (_hostname, _options, callback) => callback(null, chosen.address, chosen.family),
    }, (response) => {
      const status = response.statusCode || 0;
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error('Remote endpoint returned HTTP ' + status));
        return;
      }
      const contentType = String(response.headers['content-type'] || '');
      if (!/^application\\/(?:[A-Za-z0-9.+-]+\\+)?json(?:;|$)/i.test(contentType)) {
        response.resume();
        reject(new Error('Remote endpoint did not return JSON'));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > 2 * 1024 * 1024) response.destroy(new Error('Remote response is too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Remote endpoint returned invalid JSON')); }
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error('Remote endpoint timed out')));
    request.on('error', reject);
    if (requestBody !== undefined) request.write(requestBody);
    request.end();
  });
}

async function invoke(name, args) {
  const definition = TOOLS.find((tool) => tool.name === name);
  const implementation = IMPLEMENTATIONS[name];
  if (!definition || !implementation) throw new Error('Unknown tool');
  if (!validate(definition.inputSchema, args)) throw new Error('Invalid tool arguments');
  if (implementation.kind === 'echo') return args[implementation.argument];
  if (implementation.kind === 'constant_json') return implementation.value;
  if (implementation.kind === 'http_json') {
    const target = new URL(expandRoute(implementation.routeTemplate, args), implementation.baseUrl);
    if (target.origin !== new URL(implementation.baseUrl).origin) throw new Error('Endpoint origin changed');
    const headers = { accept: 'application/json', 'content-type': 'application/json' };
    if (implementation.bearerSecretEnv) {
      const secret = process.env[implementation.bearerSecretEnv];
      if (!secret) throw new Error('Required secret is unavailable');
      headers.authorization = 'Bearer ' + secret;
    }
    return await requestJson(
      target,
      implementation.method,
      headers,
      implementation.method === 'POST' ? JSON.stringify(args) : undefined,
    );
  }
  throw new Error('Unsupported implementation');
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: ${JSON.stringify(specification.packageId)}, version: ${JSON.stringify(specification.version)} },
    } });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    try {
      const result = await invoke(message.params && message.params.name, (message.params && message.params.arguments) || {});
      send({ jsonrpc: '2.0', id: message.id, result: {
        content: [{ type: 'text', text: JSON.stringify(result) }], isError: false,
      } });
    } catch (cause) {
      send({ jsonrpc: '2.0', id: message.id, result: {
        content: [{ type: 'text', text: cause instanceof Error ? cause.message : 'Tool failed' }], isError: true,
      } });
    }
    return;
  }
  error(message.id, -32601, 'Method not found');
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  void handle(message);
});
`;
}
