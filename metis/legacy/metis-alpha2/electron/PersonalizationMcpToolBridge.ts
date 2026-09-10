import { randomUUID } from 'node:crypto';
import type { ToolSpec, ToolContext } from '../engine/core/types.js';
import { digestResolvedManifestSnapshot } from '../engine/personalization/ScenarioRunCoordinator.js';
import { McpToolNameSchema } from '../engine/runtime/McpInstallationContract.js';
import {
  ManagedMcpDefinitionSchema,
  ManagedMcpOwnerSchema,
  type ManagedMcpDefinition,
  type ManagedMcpOwner,
} from '../engine/runtime/ManagedMcpRuntimeContract.js';
import {
  ResolvedRunManifestSchema,
  type ResolvedRunManifest,
} from '../engine/runtime/PersonalizationRuntimeContract.js';
import type { EvidenceEnvelope } from '../engine/runtime/EvidenceEnvelopeContract.js';
import { buildArgsDecoder, type JSONSchema } from '../engine/tools/ArgsValidator.js';
import type { ToolHandler } from '../engine/tools/ToolDispatcher.js';
import type { ManagedPersonalizationMcpRuntime } from './ManagedPersonalizationMcpRuntime.js';
import type { McpLaunchDescriptor } from './PersonalizationMcpInstaller.js';

const TOOL_TIMEOUT_MS = 30_000;
const FIXED_RESULT = JSON.stringify({
  status: 'external_evidence_recorded',
  truthState: 'unverified',
  reviewStatus: 'pending',
});

export interface PersonalizationMcpDefinitionSource {
  get(id: string): unknown;
}

export interface PersonalizationMcpDescriptorSource {
  getLaunchDescriptor(installationId: string): McpLaunchDescriptor | null;
}

export interface PersonalizationMcpEvidenceSink {
  record(envelope: EvidenceEnvelope): boolean | Promise<boolean>;
}

export interface PersonalizationMcpBridgePrepareInput {
  manifest: unknown;
  owner: unknown;
  sessionId: string;
  projectId: string;
  /** Names already owned by builtin or other run-scoped tools. */
  reservedToolNames: readonly string[];
  signal?: AbortSignal;
}

export interface PersonalizationMcpToolRegistration {
  readonly spec: ToolSpec;
  readonly handler: ToolHandler;
}

export type PersonalizationMcpBridgePrepareResult =
  | { ok: true; run: PersonalizationMcpToolRun }
  | {
      ok: false;
      code:
        | 'invalid_manifest'
        | 'binding_mismatch'
        | 'aborted'
        | 'definition_missing'
        | 'definition_invalid'
        | 'definition_drift'
        | 'descriptor_unavailable'
        | 'descriptor_drift'
        | 'schema_rejected'
        | 'tool_conflict'
        | 'tool_not_allowed'
        | 'runtime_start_failed';
    };

interface RuntimeBinding {
  definition: ManagedMcpDefinition;
  runtimeToken: string;
}

interface PreparedTool {
  definitionId: string;
  definitionRevision: number;
  name: string;
  parameters: Record<string, unknown>;
  decodeArgs: (raw: Record<string, unknown>) => Record<string, unknown>;
}

export class PersonalizationMcpToolRun {
  readonly #runtime: ManagedPersonalizationMcpRuntime;
  readonly #evidenceSink: PersonalizationMcpEvidenceSink;
  readonly #manifest: ResolvedRunManifest;
  readonly #owner: ManagedMcpOwner;
  readonly #bindings: Map<string, RuntimeBinding>;
  readonly #registrations: readonly PersonalizationMcpToolRegistration[];
  readonly #controller = new AbortController();
  readonly #externalSignal?: AbortSignal;
  readonly #externalAbort?: () => void;
  #closed = false;

  constructor(options: {
    runtime: ManagedPersonalizationMcpRuntime;
    evidenceSink: PersonalizationMcpEvidenceSink;
    manifest: ResolvedRunManifest;
    owner: ManagedMcpOwner;
    bindings: Map<string, RuntimeBinding>;
    tools: readonly PreparedTool[];
    signal?: AbortSignal;
  }) {
    this.#runtime = options.runtime;
    this.#evidenceSink = options.evidenceSink;
    this.#manifest = options.manifest;
    this.#owner = options.owner;
    this.#bindings = options.bindings;
    this.#externalSignal = options.signal;
    if (options.signal) {
      this.#externalAbort = () => { void this.close(); };
      options.signal.addEventListener('abort', this.#externalAbort, { once: true });
      if (options.signal.aborted) void this.close();
    }
    this.#registrations = Object.freeze(options.tools.map((tool) => Object.freeze({
      spec: Object.freeze({
        name: tool.name,
        description: `Managed external tool ${tool.name}. Results are recorded as unverified evidence.`,
        parameters: deepFreeze(tool.parameters),
        decodeArgs: tool.decodeArgs,
        decodeResult: () => ({
          toolName: tool.name,
          status: 'completed' as const,
          summary: 'External evidence recorded; verification remains pending',
        }),
      }),
      handler: this.#handler(tool),
    })));
  }

  get registrations(): readonly PersonalizationMcpToolRegistration[] {
    return this.#registrations;
  }

  get toolNames(): readonly string[] {
    return this.#registrations.map((registration) => registration.spec.name);
  }

  get closed(): boolean {
    return this.#closed;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort();
    if (this.#externalSignal && this.#externalAbort) {
      this.#externalSignal.removeEventListener('abort', this.#externalAbort);
    }
    const bindings = [...new Set(this.#bindings.values())];
    this.#bindings.clear();
    await Promise.all(bindings.map(async (binding) => {
      await this.#runtime.stop({
        contractVersion: 1,
        operationId: randomUUID(),
        sessionId: this.#manifest.sessionId,
        projectId: this.#manifest.projectId,
        owner: this.#owner,
        runtimeToken: binding.runtimeToken,
      }).catch(() => undefined);
    }));
  }

  #handler(tool: PreparedTool): ToolHandler {
    return async (args: Record<string, unknown>, context: ToolContext): Promise<string> => {
      if (this.#closed || this.#controller.signal.aborted) throw new Error('Managed MCP run is unavailable');
      if (context.sessionId !== this.#manifest.sessionId) {
        await this.close();
        throw new Error('Managed MCP run binding mismatch');
      }
      const binding = this.#bindings.get(tool.name);
      if (!binding || binding.definition.id !== tool.definitionId
        || binding.definition.revision !== tool.definitionRevision) {
        await this.close();
        throw new Error('Managed MCP tool binding is unavailable');
      }
      let strictArgs: Record<string, unknown>;
      try { strictArgs = tool.decodeArgs(args); } catch {
        throw new Error('Managed MCP arguments rejected');
      }
      const linked = linkSignals(this.#controller.signal, context.signal);
      try {
        const operationId = randomUUID();
        let response: Awaited<ReturnType<ManagedPersonalizationMcpRuntime['invoke']>>;
        try {
          response = await this.#runtime.invoke({
            contractVersion: 1,
            operationId,
            sessionId: this.#manifest.sessionId,
            projectId: this.#manifest.projectId,
            owner: this.#owner,
            runtimeToken: binding.runtimeToken,
            toolName: tool.name,
            arguments: strictArgs,
            runManifestDigest: this.#manifest.manifestDigest,
            timeoutMs: TOOL_TIMEOUT_MS,
          }, linked.signal);
        } catch {
          await this.close();
          throw new Error('Managed MCP tool execution failed');
        }
        if (!response.ok || response.operationId !== operationId) {
          await this.close();
          throw new Error('Managed MCP tool execution failed');
        }
        const envelope = response.envelope;
        if (envelope.sessionId !== this.#manifest.sessionId
          || envelope.projectId !== this.#manifest.projectId
          || envelope.operationId !== operationId
          || envelope.runManifestDigest !== this.#manifest.manifestDigest
          || envelope.sourceDefinitionId !== binding.definition.id
          || envelope.sourceDefinitionRevision !== binding.definition.revision
          || envelope.sourceKind !== 'mcp'
          || envelope.truth.state !== 'unverified'
          || envelope.truth.reviewStatus !== 'pending'
          || envelope.truth.correctionState !== 'unknown'
          || envelope.truth.claimEligible !== false
          || envelope.truth.publishEligible !== false) {
          await this.close();
          throw new Error('Managed MCP evidence binding failed');
        }
        let stored = false;
        try { stored = await this.#evidenceSink.record(envelope); } catch { stored = false; }
        if (!stored || linked.signal.aborted) {
          await this.close();
          throw new Error('Managed MCP evidence storage failed');
        }
        return FIXED_RESULT;
      } finally {
        linked.dispose();
      }
    };
  }
}

export class PersonalizationMcpToolBridge {
  readonly #runtime: ManagedPersonalizationMcpRuntime;
  readonly #definitions: PersonalizationMcpDefinitionSource;
  readonly #descriptors: PersonalizationMcpDescriptorSource;
  readonly #evidenceSink: PersonalizationMcpEvidenceSink;

  constructor(options: {
    runtime: ManagedPersonalizationMcpRuntime;
    definitions: PersonalizationMcpDefinitionSource;
    descriptors: PersonalizationMcpDescriptorSource;
    evidenceSink: PersonalizationMcpEvidenceSink;
  }) {
    this.#runtime = options.runtime;
    this.#definitions = options.definitions;
    this.#descriptors = options.descriptors;
    this.#evidenceSink = options.evidenceSink;
  }

  async prepare(input: PersonalizationMcpBridgePrepareInput): Promise<PersonalizationMcpBridgePrepareResult> {
    const manifestResult = ResolvedRunManifestSchema.safeParse(input.manifest);
    const ownerResult = ManagedMcpOwnerSchema.safeParse(input.owner);
    if (!manifestResult.success || !ownerResult.success || !validReservedNames(input.reservedToolNames)) {
      return { ok: false, code: 'invalid_manifest' };
    }
    const manifest = manifestResult.data;
    const owner = ownerResult.data;
    if (digestResolvedManifestSnapshot(manifest) !== manifest.manifestDigest) {
      return { ok: false, code: 'invalid_manifest' };
    }
    if (manifest.sessionId !== input.sessionId || manifest.projectId !== input.projectId) {
      return { ok: false, code: 'binding_mismatch' };
    }
    if (input.signal?.aborted) return { ok: false, code: 'aborted' };

    const reserved = new Set(input.reservedToolNames);
    const tools: PreparedTool[] = [];
    const definitions: ManagedMcpDefinition[] = [];
    const descriptorFingerprints = new Map<string, string>();
    for (const definitionId of manifest.mcpIds) {
      let raw: unknown;
      try { raw = this.#definitions.get(definitionId); } catch { raw = undefined; }
      if (raw === undefined) return { ok: false, code: 'definition_missing' };
      const parsed = ManagedMcpDefinitionSchema.safeParse(raw);
      if (!parsed.success || parsed.data.id !== definitionId) return { ok: false, code: 'definition_invalid' };
      const definition = parsed.data;
      if (manifest.definitionRevisions[definition.id] !== definition.revision) {
        return { ok: false, code: 'definition_drift' };
      }
      let descriptor: McpLaunchDescriptor | null;
      try { descriptor = this.#descriptors.getLaunchDescriptor(definition.args[0]!); } catch { descriptor = null; }
      if (!descriptor) return { ok: false, code: 'descriptor_unavailable' };
      const prepared = prepareDescriptorTools(descriptor, definition);
      if (!prepared.ok) return { ok: false, code: prepared.code };
      descriptorFingerprints.set(definition.id, prepared.fingerprint);
      for (const tool of prepared.tools) {
        if (reserved.has(tool.name) || tools.some((candidate) => candidate.name === tool.name)) {
          return { ok: false, code: 'tool_conflict' };
        }
        if (!manifest.allowedTools.includes(tool.name)) return { ok: false, code: 'tool_not_allowed' };
        tools.push({
          definitionId: definition.id,
          definitionRevision: definition.revision,
          ...tool,
        });
      }
      definitions.push(definition);
    }

    const bindings = new Map<string, RuntimeBinding>();
    const started: Array<{ definition: ManagedMcpDefinition; runtimeToken: string }> = [];
    const cleanupStarted = async () => {
      await Promise.all(started.map(({ runtimeToken }) => this.#runtime.stop({
        contractVersion: 1,
        operationId: randomUUID(),
        sessionId: manifest.sessionId,
        projectId: manifest.projectId,
        owner,
        runtimeToken,
      }).catch(() => undefined)));
    };
    for (const definition of definitions) {
      if (input.signal?.aborted) {
        await cleanupStarted();
        return { ok: false, code: 'aborted' };
      }
      let response: Awaited<ReturnType<ManagedPersonalizationMcpRuntime['start']>>;
      try {
        response = await this.#runtime.start({
          contractVersion: 1,
          operationId: randomUUID(),
          sessionId: manifest.sessionId,
          projectId: manifest.projectId,
          owner,
          definition,
        });
      } catch {
        await cleanupStarted();
        return { ok: false, code: 'runtime_start_failed' };
      }
      if (!response.ok || !sameStringSet(response.exposedTools, definition.exposedTools)) {
        await cleanupStarted();
        return { ok: false, code: 'runtime_start_failed' };
      }
      started.push({ definition, runtimeToken: response.runtimeToken });
      let refreshed: McpLaunchDescriptor | null;
      try { refreshed = this.#descriptors.getLaunchDescriptor(definition.args[0]!); } catch { refreshed = null; }
      const refreshedPrepared = refreshed ? prepareDescriptorTools(refreshed, definition) : undefined;
      if (!refreshedPrepared?.ok
        || refreshedPrepared.fingerprint !== descriptorFingerprints.get(definition.id)) {
        await cleanupStarted();
        await this.#runtime.stop({
          contractVersion: 1,
          operationId: randomUUID(),
          sessionId: manifest.sessionId,
          projectId: manifest.projectId,
          owner,
          runtimeToken: response.runtimeToken,
        }).catch(() => undefined);
        return { ok: false, code: 'descriptor_drift' };
      }
      for (const name of definition.exposedTools) {
        bindings.set(name, { definition, runtimeToken: response.runtimeToken });
      }
    }

    if (input.signal?.aborted) {
      await cleanupStarted();
      return { ok: false, code: 'aborted' };
    }
    return {
      ok: true,
      run: new PersonalizationMcpToolRun({
        runtime: this.#runtime,
        evidenceSink: this.#evidenceSink,
        manifest,
        owner,
        bindings,
        tools,
        signal: input.signal,
      }),
    };
  }
}

function prepareDescriptorTools(
  descriptor: McpLaunchDescriptor,
  definition: ManagedMcpDefinition,
):
  | { ok: true; tools: Array<{ name: string; parameters: Record<string, unknown>; decodeArgs: PreparedTool['decodeArgs'] }>; fingerprint: string }
  | { ok: false; code: 'descriptor_drift' | 'schema_rejected' } {
  if (descriptor.installationId !== definition.args[0]
    || !sameStringSet(descriptor.tools.map((tool) => tool.name), definition.exposedTools)) {
    return { ok: false, code: 'descriptor_drift' };
  }
  try {
    const tools = descriptor.tools.map((tool) => {
      if (!McpToolNameSchema.safeParse(tool.name).success) throw new Error('tool_name');
      const decodeArgs = buildArgsDecoder(tool.inputSchema);
      return { name: tool.name, parameters: sanitizeSchema(tool.inputSchema), decodeArgs };
    });
    return {
      ok: true,
      tools,
      fingerprint: canonicalJson({
        installationId: descriptor.installationId,
        command: descriptor.command,
        args: descriptor.args,
        workingDirectory: descriptor.workingDirectory,
        secretRefs: descriptor.secretRefs,
        fixedEnvironment: descriptor.fixedEnvironment,
        verifiedFiles: descriptor.verifiedFiles,
        tools: descriptor.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })),
      }),
    };
  } catch {
    return { ok: false, code: 'schema_rejected' };
  }
}

function sanitizeSchema(raw: Record<string, unknown>): Record<string, unknown> {
  const schema = raw as JSONSchema;
  const output: Record<string, unknown> = { type: schema.type };
  if (schema.enum !== undefined) {
    if (!schema.enum.every((value) => typeof value === 'number' && Number.isFinite(value)
      || typeof value === 'boolean'
      || typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value))) {
      throw new Error('Unsafe enum value');
    }
    output.enum = [...schema.enum];
  }
  if (schema.additionalProperties !== undefined) output.additionalProperties = schema.additionalProperties;
  if (schema.properties !== undefined) {
    const propertyNames = Object.keys(schema.properties);
    if (!propertyNames.every((name) => /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(name))) {
      throw new Error('Unsafe property name');
    }
    if (schema.required !== undefined
      && (new Set(schema.required).size !== schema.required.length
        || schema.required.some((name) => !propertyNames.includes(name)))) {
      throw new Error('Invalid required property');
    }
    output.properties = Object.fromEntries(Object.entries(schema.properties)
      .map(([name, value]) => [name, sanitizeSchema(value as unknown as Record<string, unknown>)]));
    if (schema.required !== undefined) output.required = [...schema.required];
  } else if (schema.required !== undefined && schema.required.length > 0) {
    throw new Error('Required properties are undeclared');
  }
  if (schema.items !== undefined) output.items = sanitizeSchema(schema.items as unknown as Record<string, unknown>);
  return output;
}

function validReservedNames(names: readonly string[]): boolean {
  return Array.isArray(names) && new Set(names).size === names.length
    && names.every((name) => McpToolNameSchema.safeParse(name).success);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.length === rightSorted.length
    && leftSorted.every((value, index) => value === rightSorted[index]);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}

function linkSignals(primary: AbortSignal, secondary?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  primary.addEventListener('abort', abort, { once: true });
  secondary?.addEventListener('abort', abort, { once: true });
  if (primary.aborted || secondary?.aborted) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      primary.removeEventListener('abort', abort);
      secondary?.removeEventListener('abort', abort);
    },
  };
}
