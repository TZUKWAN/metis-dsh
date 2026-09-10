import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MCPClient } from '../engine/mcp/MCPClient.js';
import { ExactEnvironmentStdioTransport } from '../engine/mcp/ExactEnvironmentStdioTransport.js';
import { McpToolNameSchema } from '../engine/runtime/McpInstallationContract.js';
import {
  ManagedMcpInvokeRequestSchema,
  ManagedMcpInvokeResponseSchema,
  ManagedMcpStartRequestSchema,
  ManagedMcpStartResponseSchema,
  ManagedMcpStopRequestSchema,
  ManagedMcpStopResponseSchema,
  type ManagedMcpDefinition,
  type ManagedMcpInvokeResponse,
  type ManagedMcpOwner,
  type ManagedMcpStartResponse,
  type ManagedMcpStopResponse,
} from '../engine/runtime/ManagedMcpRuntimeContract.js';
import { PERSONALIZATION_CONTRACT_VERSION } from '../engine/runtime/PersonalizationRuntimeContract.js';
import { buildArgsDecoder } from '../engine/tools/ArgsValidator.js';
import type { EvidenceEnvelope } from '../engine/runtime/EvidenceEnvelopeContract.js';
import type { MCPTool } from '../engine/mcp/protocol.js';
import type { McpLaunchDescriptor, PersonalizationMcpInstaller } from './PersonalizationMcpInstaller.js';

const FALLBACK_OPERATION_ID = '00000000-0000-4000-8000-000000000000';
const HANDSHAKE_TIMEOUT_MS = 5_000;
const OUTPUT_MAX_BYTES = 256 * 1024;
const MAX_REMEMBERED_OPERATIONS = 20_000;
const INSTALLATION_ID = /^mcp_[a-f0-9]{32}$/u;
const SECRET_REF = /^\$\{secret:[A-Z_][A-Z0-9_]{0,127}\}$/u;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
// eslint-disable-next-line no-control-regex -- child-process environment cannot contain NUL
const NUL = /\u0000/u;
// eslint-disable-next-line no-control-regex -- launch arguments are single-line data, never shell syntax
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex -- evidence text permits tab/newline but rejects the remaining C0/C1 range
const UNSAFE_OUTPUT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

type ArgsDecoder = (raw: Record<string, unknown>) => Record<string, unknown>;

export interface ManagedMcpSecretContext {
  sessionId: string;
  projectId: string;
  owner: ManagedMcpOwner;
  definitionId: string;
  installationId: string;
  environmentName: string;
}

export interface ManagedMcpSecretResolver {
  resolve(secretRef: string, context: ManagedMcpSecretContext): string | undefined | Promise<string | undefined>;
}

export interface ManagedMcpEvidenceSigner {
  issue(raw: unknown): EvidenceEnvelope | undefined;
  verify(raw: unknown): raw is EvidenceEnvelope;
}

interface RuntimeState {
  token: string;
  key: string;
  sessionId: string;
  projectId: string;
  owner: ManagedMcpOwner;
  definition: ManagedMcpDefinition;
  installationId: string;
  snapshotDirectory: string;
  client: MCPClient;
  decoders: Map<string, ArgsDecoder>;
  secretValues: Set<string>;
  closing: boolean;
}

type DeadlineResult<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

export class ManagedPersonalizationMcpRuntime {
  readonly #installer: Pick<PersonalizationMcpInstaller, 'getLaunchDescriptor'>;
  readonly #secrets: ManagedMcpSecretResolver;
  readonly #evidence: ManagedMcpEvidenceSigner;
  readonly #now: () => number;
  readonly #randomToken: () => string;
  readonly #runtimes = new Map<string, RuntimeState>();
  readonly #runtimeKeys = new Map<string, string>();
  readonly #startingKeys = new Set<string>();
  readonly #operations = new Set<string>();
  readonly #snapshotRoot: string;

  constructor(
    installer: Pick<PersonalizationMcpInstaller, 'getLaunchDescriptor'>,
    secrets: ManagedMcpSecretResolver,
    evidence: ManagedMcpEvidenceSigner,
    options?: {
      now?: () => number;
      randomToken?: () => string;
      runtimeSnapshotRoot?: string;
      recoverStaleSnapshots?: boolean;
    },
  ) {
    this.#installer = installer;
    this.#secrets = secrets;
    this.#evidence = evidence;
    this.#now = options?.now ?? Date.now;
    this.#randomToken = options?.randomToken ?? (() => `mmcp_${randomBytes(32).toString('hex')}`);
    const snapshotBase = options?.runtimeSnapshotRoot
      ?? path.join(os.tmpdir(), `metis-managed-mcp-runtime-${process.pid}`);
    this.#snapshotRoot = createRuntimeSnapshotRoot(snapshotBase, options?.recoverStaleSnapshots ?? false);
  }

  get activeRuntimeCount(): number {
    return this.#runtimes.size;
  }

  async start(raw: unknown): Promise<ManagedMcpStartResponse> {
    const operationId = extractOperationId(raw);
    const parsed = ManagedMcpStartRequestSchema.safeParse(raw);
    if (!parsed.success) return startFailure(operationId, 'invalid_request');
    const request = parsed.data;
    if (!this.#claimOperation(request.operationId)) return startFailure(request.operationId, 'replay_rejected');

    const key = runtimeKey(request.owner, request.sessionId, request.projectId, request.definition.id);
    if (this.#startingKeys.has(key) || this.#runtimeKeys.has(key)) {
      return startFailure(request.operationId, 'already_running');
    }
    this.#startingKeys.add(key);

    let client: MCPClient | undefined;
    let snapshotDirectory: string | undefined;
    try {
      const installationId = request.definition.args[0]!;
      let descriptor: McpLaunchDescriptor | null;
      try { descriptor = this.#installer.getLaunchDescriptor(installationId); } catch { descriptor = null; }
      if (!descriptor) return startFailure(request.operationId, 'installation_unavailable');
      if (!validDescriptor(descriptor, request.definition)) {
        return startFailure(request.operationId, 'descriptor_rejected');
      }

      let runtimeDescriptor: McpLaunchDescriptor;
      try {
        const snapshot = createRuntimeSnapshot(this.#snapshotRoot, descriptor);
        runtimeDescriptor = snapshot.descriptor;
        snapshotDirectory = snapshot.directory;
      } catch {
        return startFailure(request.operationId, 'descriptor_rejected');
      }

      const resolved = await this.#resolveEnvironment(runtimeDescriptor, request);
      if (!resolved) return startFailure(request.operationId, 'secret_unavailable');
      if (!validDescriptor(runtimeDescriptor, request.definition)) {
        return startFailure(request.operationId, 'descriptor_rejected');
      }

      client = new MCPClient(
        {
          name: request.definition.id,
          command: [runtimeDescriptor.command, ...runtimeDescriptor.args],
          env: resolved.environment,
        },
        new ExactEnvironmentStdioTransport(runtimeDescriptor.workingDirectory, OUTPUT_MAX_BYTES * 2),
      );
      try {
        await client.connect(HANDSHAKE_TIMEOUT_MS);
      } catch {
        return startFailure(request.operationId, 'handshake_failed');
      }

      const listed = await deadline(client.listTools(), HANDSHAKE_TIMEOUT_MS);
      if (listed.kind !== 'value') {
        return startFailure(request.operationId, 'handshake_failed');
      }
      const tools = validateToolHandshake(listed.value, runtimeDescriptor, request.definition);
      if (tools.code) return startFailure(request.operationId, tools.code);

      let runtimeToken: string;
      try { runtimeToken = this.#randomToken(); } catch { return startFailure(request.operationId, 'handshake_failed'); }
      if (!/^mmcp_[a-f0-9]{64}$/u.test(runtimeToken) || this.#runtimes.has(runtimeToken)) {
        return startFailure(request.operationId, 'handshake_failed');
      }
      const state: RuntimeState = {
        token: runtimeToken,
        key,
        sessionId: request.sessionId,
        projectId: request.projectId,
        owner: request.owner,
        definition: request.definition,
        installationId,
        snapshotDirectory,
        client,
        decoders: tools.decoders,
        secretValues: resolved.secretValues,
        closing: false,
      };
      this.#runtimes.set(runtimeToken, state);
      this.#runtimeKeys.set(key, runtimeToken);
      client = undefined;
      snapshotDirectory = undefined;
      return ManagedMcpStartResponseSchema.parse({
        ok: true,
        contractVersion: PERSONALIZATION_CONTRACT_VERSION,
        operationId: request.operationId,
        runtimeToken,
        exposedTools: [...state.decoders.keys()],
        startedAt: this.#now(),
      });
    } finally {
      this.#startingKeys.delete(key);
      if (client) await client.close().catch(() => {});
      if (snapshotDirectory) removeRuntimeSnapshot(snapshotDirectory, this.#snapshotRoot);
    }
  }

  async invoke(raw: unknown, signal?: AbortSignal): Promise<ManagedMcpInvokeResponse> {
    const operationId = extractOperationId(raw);
    const parsed = ManagedMcpInvokeRequestSchema.safeParse(raw);
    if (!parsed.success) return invokeFailure(operationId, 'invalid_request');
    const request = parsed.data;
    const state = this.#runtimes.get(request.runtimeToken);
    if (!state || state.closing) return invokeFailure(request.operationId, 'runtime_unavailable');
    if (!sameBinding(state, request.owner, request.sessionId, request.projectId)) {
      return invokeFailure(request.operationId, 'binding_mismatch');
    }
    if (!this.#claimOperation(request.operationId)) return invokeFailure(request.operationId, 'replay_rejected');
    const decode = state.decoders.get(request.toolName);
    if (!decode) return invokeFailure(request.operationId, 'tool_unavailable');
    let arguments_: Record<string, unknown>;
    try { arguments_ = decode(request.arguments); } catch { return invokeFailure(request.operationId, 'arguments_rejected'); }
    if (signal?.aborted) return invokeFailure(request.operationId, 'aborted');

    const result = await deadline(state.client.callTool(request.toolName, arguments_), request.timeoutMs, signal);
    if (result.kind === 'timeout' || result.kind === 'aborted') {
      await this.#terminate(state);
      return invokeFailure(request.operationId, result.kind);
    }
    if (result.kind === 'error') {
      await this.#terminate(state);
      return invokeFailure(request.operationId, 'transport_failed');
    }
    const output = result.value;
    if (Buffer.byteLength(output, 'utf8') > OUTPUT_MAX_BYTES) {
      await this.#terminate(state);
      return invokeFailure(request.operationId, 'output_too_large');
    }
    if (UNSAFE_OUTPUT.test(output)) {
      await this.#terminate(state);
      return invokeFailure(request.operationId, 'output_rejected');
    }
    if ([...state.secretValues].some((secret) => secret.length > 0 && output.includes(secret))) {
      await this.#terminate(state);
      return invokeFailure(request.operationId, 'secret_leak_blocked');
    }

    let envelope: EvidenceEnvelope | undefined;
    try {
      envelope = this.#evidence.issue({
        contractVersion: PERSONALIZATION_CONTRACT_VERSION,
        sessionId: request.sessionId,
        projectId: request.projectId,
        operationId: request.operationId,
        runManifestDigest: request.runManifestDigest,
        sourceDefinitionId: state.definition.id,
        sourceDefinitionRevision: state.definition.revision,
        sourceKind: 'mcp',
        observedAt: this.#now(),
        sourceUrl: state.definition.sourceUrl,
        locator: `managed-mcp:${state.installationId}:${request.toolName}`,
        payload: { kind: 'text', content: output },
      });
    } catch {
      envelope = undefined;
    }
    if (!envelope || !this.#evidence.verify(envelope)) {
      return invokeFailure(request.operationId, 'evidence_failed');
    }
    return ManagedMcpInvokeResponseSchema.parse({
      ok: true,
      contractVersion: PERSONALIZATION_CONTRACT_VERSION,
      operationId: request.operationId,
      envelope,
    });
  }

  async stop(raw: unknown): Promise<ManagedMcpStopResponse> {
    const operationId = extractOperationId(raw);
    const parsed = ManagedMcpStopRequestSchema.safeParse(raw);
    if (!parsed.success) return stopFailure(operationId, 'invalid_request');
    const request = parsed.data;
    const state = this.#runtimes.get(request.runtimeToken);
    if (!state || state.closing) return stopFailure(request.operationId, 'runtime_unavailable');
    if (!sameBinding(state, request.owner, request.sessionId, request.projectId)) {
      return stopFailure(request.operationId, 'binding_mismatch');
    }
    if (!this.#claimOperation(request.operationId)) return stopFailure(request.operationId, 'replay_rejected');
    await this.#terminate(state);
    return ManagedMcpStopResponseSchema.parse({
      ok: true,
      contractVersion: PERSONALIZATION_CONTRACT_VERSION,
      operationId: request.operationId,
      stopped: true,
    });
  }

  async shutdownOwner(owner: ManagedMcpOwner): Promise<void> {
    const targets = [...this.#runtimes.values()].filter((state) => sameOwner(state.owner, owner));
    await Promise.all(targets.map((state) => this.#terminate(state)));
  }

  /** Main-process navigation/destroy cleanup when only the WebContents ID remains available. */
  async shutdownWebContents(webContentsId: number): Promise<void> {
    if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) return;
    const targets = [...this.#runtimes.values()]
      .filter((state) => state.owner.webContentsId === webContentsId);
    await Promise.all(targets.map((state) => this.#terminate(state)));
  }

  async shutdownSession(sessionId: string, projectId: string): Promise<void> {
    const targets = [...this.#runtimes.values()]
      .filter((state) => state.sessionId === sessionId && state.projectId === projectId);
    await Promise.all(targets.map((state) => this.#terminate(state)));
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.#runtimes.values()].map((state) => this.#terminate(state)));
  }

  async #resolveEnvironment(
    descriptor: McpLaunchDescriptor,
    request: z.infer<typeof ManagedMcpStartRequestSchema>,
  ): Promise<{ environment: Record<string, string>; secretValues: Set<string> } | undefined> {
    const environment: Record<string, string> = { ...descriptor.fixedEnvironment };
    const secretValues = new Set<string>();
    try {
      for (const [environmentName, secretRef] of Object.entries(descriptor.secretRefs)) {
        const value = await this.#secrets.resolve(secretRef, {
          sessionId: request.sessionId,
          projectId: request.projectId,
          owner: request.owner,
          definitionId: request.definition.id,
          installationId: descriptor.installationId,
          environmentName,
        });
        if (typeof value !== 'string' || value.length === 0 || value.length > 65_536 || NUL.test(value)) return undefined;
        environment[environmentName] = value;
        secretValues.add(value);
      }
      return { environment, secretValues };
    } catch {
      return undefined;
    }
  }

  #claimOperation(operationId: string): boolean {
    if (this.#operations.has(operationId)) return false;
    this.#operations.add(operationId);
    if (this.#operations.size > MAX_REMEMBERED_OPERATIONS) {
      const oldest = this.#operations.values().next().value as string | undefined;
      if (oldest) this.#operations.delete(oldest);
    }
    return true;
  }

  async #terminate(state: RuntimeState): Promise<void> {
    if (state.closing) return;
    state.closing = true;
    this.#runtimes.delete(state.token);
    if (this.#runtimeKeys.get(state.key) === state.token) this.#runtimeKeys.delete(state.key);
    state.secretValues.clear();
    await state.client.close().catch(() => {});
    removeRuntimeSnapshot(state.snapshotDirectory, this.#snapshotRoot);
  }
}

function extractOperationId(raw: unknown): string {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const candidate = (raw as Record<string, unknown>).operationId;
    if (typeof candidate === 'string' && z.string().uuid().safeParse(candidate).success) return candidate;
  }
  return FALLBACK_OPERATION_ID;
}

function runtimeKey(owner: ManagedMcpOwner, sessionId: string, projectId: string, definitionId: string): string {
  return `${owner.webContentsId}:${owner.processId}:${owner.routingId}:${owner.generation}\0${sessionId}\0${projectId}\0${definitionId}`;
}

function sameOwner(left: ManagedMcpOwner, right: ManagedMcpOwner): boolean {
  return left.webContentsId === right.webContentsId
    && left.processId === right.processId
    && left.routingId === right.routingId
    && left.generation === right.generation;
}

function sameBinding(
  state: RuntimeState,
  owner: ManagedMcpOwner,
  sessionId: string,
  projectId: string,
): boolean {
  return sameOwner(state.owner, owner) && state.sessionId === sessionId && state.projectId === projectId;
}

function createRuntimeSnapshotRoot(baseInput: string, recoverStale: boolean): string {
  const base = path.resolve(baseInput);
  assertNoExistingSymlinkAncestor(base);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(base);
  const real = fs.realpathSync.native(base);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(real, base)) {
    throw new Error('Unsafe managed MCP runtime snapshot root');
  }
  if (recoverStale) {
    for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
      if (!/^runtime-(?:instance|run)-[a-f0-9-]+$/u.test(entry.name)) {
        throw new Error('Unknown entry in managed MCP runtime snapshot root');
      }
      const candidate = path.join(real, entry.name);
      const candidateStat = fs.lstatSync(candidate);
      if (candidateStat.isSymbolicLink()) {
        fs.unlinkSync(candidate);
      } else if (candidateStat.isDirectory()) {
        const candidateReal = fs.realpathSync.native(candidate);
        if (!contained(real, candidateReal)) throw new Error('Stale runtime snapshot escapes its root');
        fs.rmSync(candidateReal, { recursive: true, force: false });
      } else {
        throw new Error('Unsafe entry in managed MCP runtime snapshot root');
      }
    }
    fsyncDirectory(real);
  }
  const instance = path.join(real, `runtime-instance-${randomUUID()}`);
  fs.mkdirSync(instance, { mode: 0o700 });
  fsyncDirectory(real);
  return fs.realpathSync.native(instance);
}

function createRuntimeSnapshot(
  snapshotRoot: string,
  source: McpLaunchDescriptor,
): { directory: string; descriptor: McpLaunchDescriptor } {
  const directory = path.join(snapshotRoot, `runtime-run-${randomUUID()}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  try {
    const verifiedFiles: Array<McpLaunchDescriptor['verifiedFiles'][number]> = [];
    for (const file of source.verifiedFiles) {
      const bytes = readStableVerifiedFile(file.absolutePath, file.size, file.sha256);
      const target = path.resolve(directory, ...file.path.split('/'));
      if (!contained(directory, target)) throw new Error('Runtime snapshot path escapes its root');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(target, 'wx', 0o400);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.chmodSync(target, 0o400);
      verifiedFiles.push({
        path: file.path,
        absolutePath: target,
        size: file.size,
        sha256: file.sha256,
      });
    }
    fsyncDirectoryTree(directory);
    const sourceEntry = source.args[0]!;
    const entryBinding = source.verifiedFiles.find((file) => samePath(file.absolutePath, sourceEntry));
    if (!entryBinding) throw new Error('Runtime snapshot entry is not integrity-bound');
    const snapshotEntry = verifiedFiles.find((file) => file.path === entryBinding.path)?.absolutePath;
    if (!snapshotEntry) throw new Error('Runtime snapshot entry is missing');
    const descriptor: McpLaunchDescriptor = {
      ...source,
      args: [snapshotEntry, ...source.args.slice(1)],
      workingDirectory: directory,
      verifiedFiles,
    };
    return { directory, descriptor };
  } catch (error) {
    removeRuntimeSnapshot(directory, snapshotRoot);
    throw error;
  }
}

function readStableVerifiedFile(filePath: string, expectedSize: number, expectedSha256: string): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const before = fs.fstatSync(fd);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (!before.isFile() || before.size !== expectedSize || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || (process.platform !== 'win32' && (before.dev !== after.dev || before.ino !== after.ino))
      || bytes.length !== expectedSize
      || createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
      throw new Error('Managed MCP source changed before runtime snapshot');
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function removeRuntimeSnapshot(directory: string, snapshotRoot: string): void {
  try {
    const resolved = path.resolve(directory);
    if (!contained(snapshotRoot, resolved)) return;
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(resolved);
    } else if (stat.isDirectory()) {
      const real = fs.realpathSync.native(resolved);
      if (!contained(snapshotRoot, real)) return;
      fs.chmodSync(real, 0o700);
      makeTreeWritable(real);
      fs.rmSync(real, { recursive: true, force: true });
    }
    fsyncDirectory(snapshotRoot);
  } catch {
    // Best-effort cleanup; the next production startup removes stale snapshot directories.
  }
}

function makeTreeWritable(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(candidate);
    } else if (stat.isDirectory()) {
      fs.chmodSync(candidate, 0o700);
      makeTreeWritable(candidate);
    } else if (stat.isFile()) {
      fs.chmodSync(candidate, 0o600);
    }
  }
}

function fsyncDirectoryTree(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) fsyncDirectoryTree(path.join(directory, entry.name));
  }
  fs.chmodSync(directory, 0o500);
  fsyncDirectory(directory);
}

function fsyncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch {
    if (process.platform !== 'win32') throw new Error('Managed MCP runtime directory sync failed');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function assertNoExistingSymlinkAncestor(target: string): void {
  const parsed = path.parse(target);
  const segments = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('Managed MCP runtime snapshot path contains a symbolic link');
    }
  }
}

function validDescriptor(descriptor: McpLaunchDescriptor, definition: ManagedMcpDefinition): boolean {
  try {
    if (descriptor.installationId !== definition.args[0] || !INSTALLATION_ID.test(descriptor.installationId)) return false;
    if (descriptor.shell !== false || descriptor.inheritParentEnvironment !== false) return false;
    if (!path.isAbsolute(descriptor.command) || !path.isAbsolute(descriptor.workingDirectory)) return false;
    const commandStat = fs.lstatSync(descriptor.command);
    const workingStat = fs.lstatSync(descriptor.workingDirectory);
    if (!commandStat.isFile() || commandStat.isSymbolicLink()
      || !workingStat.isDirectory() || workingStat.isSymbolicLink()) return false;
    if (!samePath(fs.realpathSync.native(descriptor.command), descriptor.command)
      || !samePath(fs.realpathSync.native(descriptor.workingDirectory), descriptor.workingDirectory)) return false;
    if (descriptor.args.length === 0 || descriptor.args.length > 65) return false;
    if (descriptor.args.some((argument) => typeof argument !== 'string'
      || argument.length === 0 || argument.length > 4_096 || CONTROL.test(argument))) return false;
    const entry = descriptor.args[0]!;
    if (!path.isAbsolute(entry) || !contained(descriptor.workingDirectory, entry)) return false;
    const entryStat = fs.lstatSync(entry);
    if (!entryStat.isFile() || entryStat.isSymbolicLink() || !samePath(fs.realpathSync.native(entry), entry)) return false;
    if (descriptor.verifiedFiles.length === 0
      || new Set(descriptor.verifiedFiles.map((file) => file.path)).size !== descriptor.verifiedFiles.length) return false;
    for (const file of descriptor.verifiedFiles) {
      if (!contained(descriptor.workingDirectory, file.absolutePath)) return false;
      const relative = path.relative(descriptor.workingDirectory, file.absolutePath).split(path.sep).join('/');
      if (relative !== file.path || file.size <= 0 || !/^[a-f0-9]{64}$/u.test(file.sha256)) return false;
      if (!stableFileMatches(file.absolutePath, file.size, file.sha256)) return false;
    }
    const entryBinding = descriptor.verifiedFiles.find((file) => samePath(file.absolutePath, entry));
    if (!entryBinding) return false;

    const fixedEntries = Object.entries(descriptor.fixedEnvironment);
    if (fixedEntries.some(([name, value]) => name !== 'ELECTRON_RUN_AS_NODE' || value !== '1')) return false;
    const secretEntries = Object.entries(descriptor.secretRefs);
    if (secretEntries.some(([name, value]) => !ENVIRONMENT_NAME.test(name) || !SECRET_REF.test(value))) return false;
    if (!sameStringSet(secretEntries.map(([name]) => name), Object.keys(definition.environment))) return false;
    if (!sameStringSet(descriptor.tools.map((tool) => tool.name), definition.exposedTools)) return false;
    if (descriptor.tools.length === 0 || new Set(descriptor.tools.map((tool) => tool.name)).size !== descriptor.tools.length) return false;
    return descriptor.tools.every((tool) => McpToolNameSchema.safeParse(tool.name).success);
  } catch {
    return false;
  }
}

function stableFileMatches(filePath: string, expectedSize: number, expectedSha256: string): boolean {
  let fd: number | undefined;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedSize
      || !samePath(fs.realpathSync.native(filePath), filePath)) return false;
    fd = fs.openSync(filePath, 'r');
    const before = fs.fstatSync(fd);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    return before.isFile()
      && before.size === after.size
      && before.mtimeMs === after.mtimeMs
      && (process.platform === 'win32' || (before.dev === after.dev && before.ino === after.ino))
      && bytes.length === expectedSize
      && createHash('sha256').update(bytes).digest('hex') === expectedSha256;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateToolHandshake(
  observed: MCPTool[],
  descriptor: McpLaunchDescriptor,
  definition: ManagedMcpDefinition,
): { decoders: Map<string, ArgsDecoder>; code?: 'tool_drift' | 'schema_rejected' } {
  const expected = new Map(descriptor.tools.map((tool) => [tool.name, canonicalJson(tool.inputSchema)]));
  if (observed.length !== expected.size || new Set(observed.map((tool) => tool.name)).size !== observed.length
    || !sameStringSet(observed.map((tool) => tool.name), definition.exposedTools)) {
    return { decoders: new Map(), code: 'tool_drift' };
  }
  const decoders = new Map<string, ArgsDecoder>();
  try {
    for (const tool of observed) {
      if (!McpToolNameSchema.safeParse(tool.name).success || expected.get(tool.name) !== canonicalJson(tool.inputSchema)) {
        return { decoders: new Map(), code: 'tool_drift' };
      }
      decoders.set(tool.name, buildArgsDecoder(tool.inputSchema));
    }
  } catch {
    return { decoders: new Map(), code: 'schema_rejected' };
  }
  return { decoders };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function contained(root: string, target: string): boolean {
  const relation = path.relative(root, target);
  return relation.length > 0 && !relation.startsWith(`..${path.sep}`) && relation !== '..' && !path.isAbsolute(relation);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32'
    ? path.normalize(value).toLowerCase()
    : path.normalize(value);
  return normalize(left) === normalize(right);
}

async function deadline<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<DeadlineResult<T>> {
  if (signal?.aborted) return { kind: 'aborted' };
  return new Promise<DeadlineResult<T>>((resolve) => {
    let settled = false;
    const finish = (result: DeadlineResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    const onAbort = () => finish({ kind: 'aborted' });
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish({ kind: 'value', value }),
      (error: unknown) => finish({ kind: 'error', error }),
    );
  });
}

function startFailure(
  operationId: string,
  code: Extract<ManagedMcpStartResponse, { ok: false }>['code'],
): ManagedMcpStartResponse {
  return ManagedMcpStartResponseSchema.parse({ ok: false, contractVersion: 1, operationId, code });
}

function invokeFailure(
  operationId: string,
  code: Extract<ManagedMcpInvokeResponse, { ok: false }>['code'],
): ManagedMcpInvokeResponse {
  return ManagedMcpInvokeResponseSchema.parse({ ok: false, contractVersion: 1, operationId, code });
}

function stopFailure(
  operationId: string,
  code: Extract<ManagedMcpStopResponse, { ok: false }>['code'],
): ManagedMcpStopResponse {
  return ManagedMcpStopResponseSchema.parse({ ok: false, contractVersion: 1, operationId, code });
}
