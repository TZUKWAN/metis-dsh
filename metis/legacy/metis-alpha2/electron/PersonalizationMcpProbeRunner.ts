import fs from 'node:fs';
import path from 'node:path';
import { MCPClient, type MCPTransport } from '../engine/mcp/MCPClient.js';
import { ExactEnvironmentStdioTransport } from '../engine/mcp/ExactEnvironmentStdioTransport.js';
import type { MCPServerConfig, MCPTool } from '../engine/mcp/protocol.js';
import {
  MCP_INSTALL_LIMITS,
  McpProbeResultSchema,
  McpToolNameSchema,
  type McpProbeResult,
} from '../engine/runtime/McpInstallationContract.js';
import { buildArgsDecoder } from '../engine/tools/ArgsValidator.js';
import type {
  McpControlledProbeRequest,
  McpControlledProbeRunner,
} from './PersonalizationMcpInstaller.js';

const INSTALLATION_ID = /^mcp_[a-f0-9]{32}$/u;
const SECRET_REF = /^\$\{secret:[A-Z_][A-Z0-9_]{0,127}\}$/u;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
// eslint-disable-next-line no-control-regex -- process arguments and secrets cannot contain control bytes
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_TIMEOUT_MS = 30_000;
const MAX_SECRET_CHARS = 65_536;
const MAX_SAMPLE_CALL_BYTES = 64 * 1024;
const CLEANUP_TIMEOUT_MS = 2_000;
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-06-18']);

export interface PersonalizationMcpProbeSecretContext {
  installationId: string;
  environmentName: string;
}

export interface PersonalizationMcpProbeSecretResolver {
  resolve(
    secretRef: string,
    context: PersonalizationMcpProbeSecretContext,
  ): string | undefined | Promise<string | undefined>;
}

/**
 * Optional call plan authored by the trusted Builder path.
 *
 * A probe runner must never derive this from an arbitrary server's tool name,
 * description, annotations, or schema. Absence means handshake + tools/list only.
 */
export interface TrustedMcpSampleCall {
  toolName: string;
  arguments: Readonly<Record<string, unknown>>;
}

/** Internal main-process extension; the public installer contract remains list-only. */
export interface TrustedMcpControlledProbeRequest extends McpControlledProbeRequest {
  sampleCall?: TrustedMcpSampleCall;
}

export interface PersonalizationMcpProbeClient {
  readonly protocolVersion: string | null;
  connect(timeoutMs?: number): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, arguments_: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export interface PersonalizationMcpProbeRunnerOptions {
  /** Test seam. Production uses MCPClient with ExactEnvironmentStdioTransport. */
  clientFactory?: (config: MCPServerConfig, transport: MCPTransport) => PersonalizationMcpProbeClient;
  /** Test seam. Production always launches through the exact-environment stdio transport. */
  transportFactory?: (workingDirectory: string) => MCPTransport;
}

type ProbeFailureCode =
  | 'probe_request_rejected'
  | 'probe_secret_unavailable'
  | 'probe_handshake_failed'
  | 'probe_protocol_rejected'
  | 'probe_list_failed'
  | 'probe_tool_contract_rejected'
  | 'probe_sample_tool_unavailable'
  | 'probe_sample_arguments_rejected'
  | 'probe_sample_failed'
  | 'probe_timeout'
  | 'probe_cleanup_failed';

class ProbeFailure extends Error {
  readonly code: ProbeFailureCode;

  constructor(code: ProbeFailureCode) {
    super(code);
    this.name = 'ProbeFailure';
    this.code = code;
  }
}

type DeadlineOutcome<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' };

/**
 * Main-process-only controlled MCP probe.
 *
 * It launches an executable directly (never a shell), supplies only an explicit
 * environment, bounds the entire probe, suppresses remote output/errors, and
 * always closes the client before returning an enablement result.
 */
export class PersonalizationMcpProbeRunner implements McpControlledProbeRunner {
  readonly #secrets: PersonalizationMcpProbeSecretResolver;
  readonly #clientFactory: NonNullable<PersonalizationMcpProbeRunnerOptions['clientFactory']>;
  readonly #transportFactory: NonNullable<PersonalizationMcpProbeRunnerOptions['transportFactory']>;

  constructor(
    secrets: PersonalizationMcpProbeSecretResolver,
    options: PersonalizationMcpProbeRunnerOptions = {},
  ) {
    this.#secrets = secrets;
    this.#clientFactory = options.clientFactory
      ?? ((config, transport) => new MCPClient(config, transport));
    this.#transportFactory = options.transportFactory
      ?? ((workingDirectory) => new ExactEnvironmentStdioTransport(workingDirectory));
  }

  async probe(rawRequest: McpControlledProbeRequest): Promise<McpProbeResult> {
    let request: TrustedMcpControlledProbeRequest | undefined;
    try { request = validateRequest(rawRequest); } catch { request = undefined; }
    if (!request) return failure('probe_request_rejected');

    let cancelled = false;
    let client: PersonalizationMcpProbeClient | undefined;
    const environment: Record<string, string> = {};
    const secretValues = new Set<string>();

    const operation = (async (): Promise<McpProbeResult> => {
      await this.#resolveEnvironment(request, environment, secretValues, () => cancelled);
      if (cancelled) throw new ProbeFailure('probe_timeout');

      let transport: MCPTransport;
      try {
        transport = this.#transportFactory(request.workingDirectory);
        client = this.#clientFactory({
          name: request.installationId,
          command: [request.command, ...request.args],
          env: environment,
        }, transport);
        await client.connect(request.timeoutMs);
      } catch {
        throw new ProbeFailure('probe_handshake_failed');
      }
      if (cancelled) throw new ProbeFailure('probe_timeout');

      const protocolVersion = client.protocolVersion;
      if (!validProtocolVersion(protocolVersion)) throw new ProbeFailure('probe_protocol_rejected');

      let tools: MCPTool[];
      try { tools = await client.listTools(); } catch { throw new ProbeFailure('probe_list_failed'); }
      if (cancelled) throw new ProbeFailure('probe_timeout');

      const parsedResult = McpProbeResultSchema.safeParse({ ok: true, tools, protocolVersion });
      if (!parsedResult.success) throw new ProbeFailure('probe_tool_contract_rejected');

      if (request.sampleCall) {
        const tool = tools.find((candidate) => candidate.name === request.sampleCall?.toolName);
        if (!tool) throw new ProbeFailure('probe_sample_tool_unavailable');
        let decodedArguments: Record<string, unknown>;
        try {
          decodedArguments = buildArgsDecoder(tool.inputSchema)({ ...request.sampleCall.arguments });
        } catch {
          throw new ProbeFailure('probe_sample_arguments_rejected');
        }
        if (containsResolvedSecret(decodedArguments, secretValues)) {
          throw new ProbeFailure('probe_sample_arguments_rejected');
        }
        try {
          // The output is deliberately discarded. It can contain remote errors or secrets.
          await client.callTool(request.sampleCall.toolName, decodedArguments);
        } catch {
          throw new ProbeFailure('probe_sample_failed');
        }
        if (cancelled) throw new ProbeFailure('probe_timeout');
      }

      return parsedResult.data;
    })();

    const outcome = await deadline(operation, request.timeoutMs);
    if (outcome.kind === 'timeout') cancelled = true;

    const cleanup = client
      ? await deadline(Promise.resolve().then(() => client?.close()), CLEANUP_TIMEOUT_MS)
      : { kind: 'value', value: undefined } as const;
    clearRecord(environment);
    secretValues.clear();

    if (cleanup.kind !== 'value') return failure('probe_cleanup_failed');
    if (outcome.kind === 'timeout') return failure('probe_timeout');
    if (outcome.kind === 'error') {
      return failure(outcome.error instanceof ProbeFailure ? outcome.error.code : 'probe_handshake_failed');
    }
    return outcome.value;
  }

  async #resolveEnvironment(
    request: TrustedMcpControlledProbeRequest,
    environment: Record<string, string>,
    secretValues: Set<string>,
    isCancelled: () => boolean,
  ): Promise<void> {
    Object.assign(environment, request.fixedEnvironment);
    for (const [environmentName, secretRef] of Object.entries(request.secretRefs)) {
      let value: string | undefined;
      try {
        value = await this.#secrets.resolve(secretRef, {
          installationId: request.installationId,
          environmentName,
        });
      } catch {
        throw new ProbeFailure('probe_secret_unavailable');
      }
      if (isCancelled()) throw new ProbeFailure('probe_timeout');
      if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SECRET_CHARS || CONTROL.test(value)) {
        throw new ProbeFailure('probe_secret_unavailable');
      }
      environment[environmentName] = value;
      secretValues.add(value);
    }
  }
}

function validateRequest(raw: McpControlledProbeRequest): TrustedMcpControlledProbeRequest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (raw.shell !== false || raw.inheritParentEnvironment !== false) return undefined;
  if (!INSTALLATION_ID.test(raw.installationId)
    || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 1 || raw.timeoutMs > MAX_TIMEOUT_MS) return undefined;
  if (!canonicalFile(raw.command) || !canonicalDirectory(raw.workingDirectory)) return undefined;
  if (!Array.isArray(raw.args) || raw.args.length === 0 || raw.args.length > MCP_INSTALL_LIMITS.arguments + 1
    || raw.args.some((argument) => typeof argument !== 'string'
      || argument.length === 0 || argument.length > 4_096 || CONTROL.test(argument))) return undefined;
  const entry = raw.args[0];
  if (!entry || !contained(raw.workingDirectory, entry) || !canonicalFile(entry)) return undefined;

  if (!isPlainRecord(raw.fixedEnvironment) || !isPlainRecord(raw.secretRefs)) return undefined;
  const fixedEntries = Object.entries(raw.fixedEnvironment);
  if (fixedEntries.some(([name, value]) => name !== 'ELECTRON_RUN_AS_NODE' || value !== '1')) return undefined;
  const secretEntries = Object.entries(raw.secretRefs);
  if (secretEntries.length > MCP_INSTALL_LIMITS.environment
    || secretEntries.some(([name, reference]) => !ENVIRONMENT_NAME.test(name)
      || !SECRET_REF.test(reference) || Object.hasOwn(raw.fixedEnvironment, name))) return undefined;

  const sample = readSampleCall(raw);
  if (sample === null) return undefined;
  return {
    installationId: raw.installationId,
    command: raw.command,
    args: [...raw.args],
    workingDirectory: raw.workingDirectory,
    secretRefs: Object.fromEntries(secretEntries),
    timeoutMs: raw.timeoutMs,
    shell: false,
    inheritParentEnvironment: false,
    fixedEnvironment: Object.fromEntries(fixedEntries),
    ...(sample ? { sampleCall: sample } : {}),
  };
}

function readSampleCall(raw: McpControlledProbeRequest): TrustedMcpSampleCall | undefined | null {
  const candidate = (raw as TrustedMcpControlledProbeRequest).sampleCall;
  if (candidate === undefined) return undefined;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  if (!sameKeys(candidate as unknown as Record<string, unknown>, ['arguments', 'toolName'])) return null;
  if (!McpToolNameSchema.safeParse(candidate.toolName).success || !isPlainRecord(candidate.arguments)) return null;
  if (!isJsonValue(candidate.arguments, new Set(), 0)) return null;
  let serialized: string;
  try { serialized = JSON.stringify(candidate.arguments); } catch { return null; }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SAMPLE_CALL_BYTES) return null;
  return { toolName: candidate.toolName, arguments: JSON.parse(serialized) as Record<string, unknown> };
}

function canonicalFile(candidate: string): boolean {
  try {
    if (!path.isAbsolute(candidate)) return false;
    const stat = fs.lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink() && samePath(fs.realpathSync.native(candidate), candidate);
  } catch {
    return false;
  }
}

function canonicalDirectory(candidate: string): boolean {
  try {
    if (!path.isAbsolute(candidate)) return false;
    const stat = fs.lstatSync(candidate);
    return stat.isDirectory() && !stat.isSymbolicLink() && samePath(fs.realpathSync.native(candidate), candidate);
  } catch {
    return false;
  }
}

function contained(root: string, candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function validProtocolVersion(value: string | null): value is string {
  return typeof value === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(value);
}

function failure(code: ProbeFailureCode): McpProbeResult {
  return McpProbeResultSchema.parse({ ok: false, code });
}

function clearRecord(record: Record<string, string>): void {
  for (const key of Object.keys(record)) delete record[key];
}

function sameKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const desired = [...expected].sort();
  return actual.length === desired.length && actual.every((key, index) => key === desired[index]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, seen: Set<object>, depth: number): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 32 || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen, depth + 1))
    : isPlainRecord(value) && Object.values(value).every((item) => isJsonValue(item, seen, depth + 1));
  seen.delete(value);
  return valid;
}

function containsResolvedSecret(value: unknown, secretValues: ReadonlySet<string>): boolean {
  if (typeof value === 'string') return secretValues.has(value);
  if (Array.isArray(value)) return value.some((item) => containsResolvedSecret(item, secretValues));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .some((item) => containsResolvedSecret(item, secretValues));
  }
  return false;
}

function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<DeadlineOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: DeadlineOutcome<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    promise.then(
      (value) => finish({ kind: 'value', value }),
      (error: unknown) => finish({ kind: 'error', error }),
    );
  });
}
