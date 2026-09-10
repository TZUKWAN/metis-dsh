import { z } from 'zod';
import type { ToolContext, ToolSpec } from '../engine/core/types.js';
import {
  FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
  FUNDING_TEMPLATE_LIST_TOOL_NAME,
  FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME,
  FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME,
  FundingTemplateDiffResponseSchema,
  FundingTemplateListResponseSchema,
  FundingTemplateRuntimeDigestSchema,
  FundingTemplateRuntimeScopeIdSchema,
  FundingTemplateToolGetResponseSchema,
  type FundingTemplateDiffResponse,
  type FundingTemplateDiffView,
  type FundingTemplateListResponse,
  type FundingTemplateRuntimeFailureCode,
  type FundingTemplateToolGetResponse,
} from '../engine/runtime/FundingTemplateRuntimeContract.js';
import type { ToolPresentation } from '../engine/runtime/ToolPresentationContract.js';
import type { ToolDispatcher, ToolHandler } from '../engine/tools/ToolDispatcher.js';
import type { ToolRegistry } from '../engine/tools/ToolRegistry.js';
import {
  FundingTemplateRepository,
} from './FundingTemplateRepository.js';
import {
  mapFundingTemplateRepositoryFailure,
  projectFundingTemplateAgentStructure,
  projectFundingTemplateDiff,
  projectFundingTemplateSummary,
  projectFundingTemplateVersion,
} from './FundingTemplateRuntimeProjection.js';

export const FUNDING_TEMPLATE_LIST_TOOL = FUNDING_TEMPLATE_LIST_TOOL_NAME;
export const FUNDING_TEMPLATE_GET_ACTIVE_TOOL = FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME;
export const FUNDING_TEMPLATE_GET_DIFF_TOOL = FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME;

const ZERO_OPERATION_ID = '00000000-0000-4000-8000-000000000000' as const;
const DECODE_SCOPE = 'decode-failure' as const;
const MAX_SAFE_REVISION = Number.MAX_SAFE_INTEGER - 1;
const OperationIdSchema = z.string().uuid();
const PositiveVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const PositiveRevisionSchema = z.number().int().positive().max(MAX_SAFE_REVISION);

const ScopeShape = {
  operationId: OperationIdSchema,
  ownerId: FundingTemplateRuntimeScopeIdSchema,
  projectId: FundingTemplateRuntimeScopeIdSchema,
  templateId: FundingTemplateRuntimeScopeIdSchema,
};

const ListScopeShape = {
  operationId: OperationIdSchema,
  ownerId: FundingTemplateRuntimeScopeIdSchema,
  projectId: FundingTemplateRuntimeScopeIdSchema,
};

export const FundingTemplateToolListArgsSchema = z.strictObject(ListScopeShape);

export const FundingTemplateToolGetActiveArgsSchema = z.strictObject({
  ...ScopeShape,
  expectedTemplateRevision: PositiveRevisionSchema,
  expectedActiveVersion: PositiveVersionSchema,
  expectedActiveDigest: FundingTemplateRuntimeDigestSchema,
});

export const FundingTemplateToolGetDiffArgsSchema = z.strictObject({
  ...ScopeShape,
  expectedTemplateRevision: PositiveRevisionSchema,
  fromVersion: PositiveVersionSchema,
  toVersion: PositiveVersionSchema,
  fromDigest: FundingTemplateRuntimeDigestSchema,
  toDigest: FundingTemplateRuntimeDigestSchema,
}).superRefine((request, context) => {
  if (request.toVersion !== request.fromVersion + 1) {
    context.addIssue({ code: 'custom', path: ['toVersion'], message: 'Only an adjacent stored diff can be read' });
  }
  if (request.fromDigest === request.toDigest) {
    context.addIssue({ code: 'custom', path: ['toDigest'], message: 'A diff must advance the package digest' });
  }
});

export type FundingTemplateToolGetActiveArgs = z.infer<typeof FundingTemplateToolGetActiveArgsSchema>;
export type FundingTemplateToolGetDiffArgs = z.infer<typeof FundingTemplateToolGetDiffArgsSchema>;
export type FundingTemplateToolListArgs = z.infer<typeof FundingTemplateToolListArgsSchema>;

export interface FundingTemplateToolScope {
  ownerId: string;
  projectId: string;
}

export interface FundingTemplateToolServiceDependencies {
  /** The main process derives this from the current run; tool arguments never grant scope. */
  resolveScope(context: ToolContext): FundingTemplateToolScope | null;
}

type RuntimeFailureCode = FundingTemplateRuntimeFailureCode;

const SCOPE_JSON_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 160,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$',
} as const;
const DIGEST_JSON_SCHEMA = { type: 'string', pattern: '^[a-f0-9]{64}$' } as const;
const OPERATION_JSON_SCHEMA = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
} as const;
const POSITIVE_INTEGER_JSON_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;

const LIST_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operationId: OPERATION_JSON_SCHEMA,
    ownerId: SCOPE_JSON_SCHEMA,
    projectId: SCOPE_JSON_SCHEMA,
  },
  required: ['operationId', 'ownerId', 'projectId'],
};

const GET_ACTIVE_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operationId: OPERATION_JSON_SCHEMA,
    ownerId: SCOPE_JSON_SCHEMA,
    projectId: SCOPE_JSON_SCHEMA,
    templateId: SCOPE_JSON_SCHEMA,
    expectedTemplateRevision: { ...POSITIVE_INTEGER_JSON_SCHEMA, maximum: MAX_SAFE_REVISION },
    expectedActiveVersion: POSITIVE_INTEGER_JSON_SCHEMA,
    expectedActiveDigest: DIGEST_JSON_SCHEMA,
  },
  required: [
    'operationId', 'ownerId', 'projectId', 'templateId',
    'expectedTemplateRevision', 'expectedActiveVersion', 'expectedActiveDigest',
  ],
};

const GET_DIFF_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operationId: OPERATION_JSON_SCHEMA,
    ownerId: SCOPE_JSON_SCHEMA,
    projectId: SCOPE_JSON_SCHEMA,
    templateId: SCOPE_JSON_SCHEMA,
    expectedTemplateRevision: { ...POSITIVE_INTEGER_JSON_SCHEMA, maximum: MAX_SAFE_REVISION },
    fromVersion: POSITIVE_INTEGER_JSON_SCHEMA,
    toVersion: POSITIVE_INTEGER_JSON_SCHEMA,
    fromDigest: DIGEST_JSON_SCHEMA,
    toDigest: DIGEST_JSON_SCHEMA,
  },
  required: [
    'operationId', 'ownerId', 'projectId', 'templateId', 'expectedTemplateRevision',
    'fromVersion', 'toVersion', 'fromDigest', 'toDigest',
  ],
};

function fixedInvalidListResponse(): FundingTemplateListResponse {
  return {
    ok: false,
    contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
    action: 'list',
    operationId: ZERO_OPERATION_ID,
    ownerId: DECODE_SCOPE,
    projectId: DECODE_SCOPE,
    code: 'invalid_request',
  };
}

function fixedInvalidGetResponse(): FundingTemplateToolGetResponse {
  return {
    ok: false,
    contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
    action: 'get',
    operationId: ZERO_OPERATION_ID,
    ownerId: DECODE_SCOPE,
    projectId: DECODE_SCOPE,
    code: 'invalid_request',
  };
}

function fixedInvalidDiffResponse(): FundingTemplateDiffResponse {
  return {
    ok: false,
    contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
    action: 'diff',
    operationId: ZERO_OPERATION_ID,
    ownerId: DECODE_SCOPE,
    projectId: DECODE_SCOPE,
    code: 'invalid_request',
  };
}

function listFailure(args: FundingTemplateToolListArgs, code: RuntimeFailureCode): FundingTemplateListResponse {
  return {
    ok: false,
    contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
    action: 'list',
    operationId: args.operationId,
    ownerId: args.ownerId,
    projectId: args.projectId,
    code,
  };
}

function getFailure(args: FundingTemplateToolGetActiveArgs, code: RuntimeFailureCode): FundingTemplateToolGetResponse {
  return {
    ok: false,
    contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
    action: 'get',
    operationId: args.operationId,
    ownerId: args.ownerId,
    projectId: args.projectId,
    code,
  };
}

function diffFailure(args: FundingTemplateToolGetDiffArgs, code: RuntimeFailureCode): FundingTemplateDiffResponse {
  return {
    ok: false,
    contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
    action: 'diff',
    operationId: args.operationId,
    ownerId: args.ownerId,
    projectId: args.projectId,
    code,
  };
}

function safePresenter(
  toolName: string,
  schema: typeof FundingTemplateListResponseSchema
    | typeof FundingTemplateToolGetResponseSchema
    | typeof FundingTemplateDiffResponseSchema,
): NonNullable<ToolSpec['decodeResult']> {
  return (raw, status): ToolPresentation => {
    if (status !== 'ok') {
      return { toolName, status: 'tool_failed', summary: 'Funding template lookup failed' };
    }
    try {
      const decoded = schema.safeParse(JSON.parse(raw) as unknown);
      if (!decoded.success) {
        return { toolName, status: 'tool_failed', summary: 'Funding template result suppressed' };
      }
      if (!decoded.data.ok) {
        return { toolName, status: 'tool_failed', summary: 'Funding template lookup failed' };
      }
      return {
        toolName,
        status: 'ok',
        summary: toolName === FUNDING_TEMPLATE_LIST_TOOL
          ? 'Funding templates discovered'
          : toolName === FUNDING_TEMPLATE_GET_ACTIVE_TOOL
            ? 'Active funding template structure verified'
            : 'Funding template diff verified',
        detail: JSON.stringify(decoded.data),
      };
    } catch {
      return { toolName, status: 'tool_failed', summary: 'Funding template result suppressed' };
    }
  };
}

/**
 * Read-only Agent tool adapter. It deliberately exposes neither import nor any
 * mutation. File selection/import remains a renderer-initiated, one-time
 * FileCapability flow in the main process.
 */
export class FundingTemplateToolService {
  readonly #repository: FundingTemplateRepository;
  readonly #resolveScope: FundingTemplateToolServiceDependencies['resolveScope'];

  constructor(
    repository: FundingTemplateRepository,
    dependencies: FundingTemplateToolServiceDependencies,
  ) {
    this.#repository = repository;
    this.#resolveScope = dependencies.resolveScope;
  }

  getSpecs(): readonly ToolSpec[] {
    return [
      {
        name: FUNDING_TEMPLATE_LIST_TOOL,
        description: 'Discover active funding templates previously imported into the current owner and project. Returns exact revision, active version, and digest bindings needed for a verified structure read.',
        parameters: LIST_PARAMETERS,
        permissions: [],
        decodeArgs: (raw) => FundingTemplateToolListArgsSchema.parse(raw),
        decodeResult: safePresenter(FUNDING_TEMPLATE_LIST_TOOL, FundingTemplateListResponseSchema),
      },
      {
        name: FUNDING_TEMPLATE_GET_ACTIVE_TOOL,
        description: 'Read a previously imported funding template active version by exact owner, project, revision, version, and digest. Returns verified normalized family, sections, fields, instructions, layout, typography, quality, and evidence state without file paths or applicant prose.',
        parameters: GET_ACTIVE_PARAMETERS,
        permissions: [],
        decodeArgs: (raw) => FundingTemplateToolGetActiveArgsSchema.parse(raw),
        decodeResult: safePresenter(FUNDING_TEMPLATE_GET_ACTIVE_TOOL, FundingTemplateToolGetResponseSchema),
      },
      {
        name: FUNDING_TEMPLATE_GET_DIFF_TOOL,
        description: 'Read and reverify a stored adjacent-version funding template diff by exact owner, project, revision, versions, and digests. Returns hashed entity keys only.',
        parameters: GET_DIFF_PARAMETERS,
        permissions: [],
        decodeArgs: (raw) => FundingTemplateToolGetDiffArgsSchema.parse(raw),
        decodeResult: safePresenter(FUNDING_TEMPLATE_GET_DIFF_TOOL, FundingTemplateDiffResponseSchema),
      },
    ];
  }

  getHandlers(): ReadonlyMap<string, ToolHandler> {
    return new Map<string, ToolHandler>([
      [FUNDING_TEMPLATE_LIST_TOOL, this.#list],
      [FUNDING_TEMPLATE_GET_ACTIVE_TOOL, this.#getActive],
      [FUNDING_TEMPLATE_GET_DIFF_TOOL, this.#getDiff],
    ]);
  }

  register(registry: ToolRegistry, dispatcher: ToolDispatcher): void {
    const specs = this.getSpecs();
    if (specs.some((spec) => registry.has(spec.name))) throw new Error('Funding template tool is already registered');
    for (const spec of specs) registry.register(spec);
    for (const [name, handler] of this.getHandlers()) dispatcher.registerHandler(name, handler);
  }

  #scope(context: ToolContext): FundingTemplateToolScope | null {
    try {
      return this.#resolveScope(context);
    } catch {
      return null;
    }
  }

  readonly #list: ToolHandler = async (raw, context) => {
    const decoded = FundingTemplateToolListArgsSchema.safeParse(raw);
    if (!decoded.success) return JSON.stringify(fixedInvalidListResponse());
    const args = decoded.data;
    const scope = this.#scope(context);
    if (!scope || scope.ownerId !== args.ownerId || scope.projectId !== args.projectId) {
      return JSON.stringify(listFailure(args, 'invalid_request'));
    }
    const listed = this.#repository.listTemplates(args.ownerId, args.projectId, false);
    if (!listed.ok) return JSON.stringify(listFailure(args, mapFundingTemplateRepositoryFailure(listed.code)));
    const templates = [];
    for (const item of listed.value) {
      const loaded = this.#repository.getTemplate(args.ownerId, args.projectId, item.templateId, false);
      if (!loaded.ok) return JSON.stringify(listFailure(args, mapFundingTemplateRepositoryFailure(loaded.code)));
      const summary = projectFundingTemplateSummary(loaded.value);
      if (!summary) return JSON.stringify(listFailure(args, 'repository_corrupt'));
      templates.push(summary);
    }
    try {
      return JSON.stringify(FundingTemplateListResponseSchema.parse({
        ok: true,
        contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
        action: 'list',
        operationId: args.operationId,
        ownerId: args.ownerId,
        projectId: args.projectId,
        templates,
      }));
    } catch {
      return JSON.stringify(listFailure(args, 'repository_corrupt'));
    }
  };

  readonly #getActive: ToolHandler = async (raw, context) => {
    const decoded = FundingTemplateToolGetActiveArgsSchema.safeParse(raw);
    if (!decoded.success) return JSON.stringify(fixedInvalidGetResponse());
    const args = decoded.data;
    const scope = this.#scope(context);
    if (!scope || scope.ownerId !== args.ownerId || scope.projectId !== args.projectId) {
      return JSON.stringify(getFailure(args, 'invalid_request'));
    }
    const loaded = this.#repository.getTemplate(args.ownerId, args.projectId, args.templateId, true);
    if (!loaded.ok) return JSON.stringify(getFailure(args, mapFundingTemplateRepositoryFailure(loaded.code)));
    const record = loaded.value;
    if (record.archivedAt !== null) return JSON.stringify(getFailure(args, 'archived'));
    const active = record.versions.find((version) => version.version === record.activeVersion);
    if (!active) return JSON.stringify(getFailure(args, 'repository_corrupt'));
    if (record.revision !== args.expectedTemplateRevision
      || record.activeVersion !== args.expectedActiveVersion
      || active.packageDigest !== args.expectedActiveDigest) {
      return JSON.stringify(getFailure(args, 'cas_conflict'));
    }
    const summary = projectFundingTemplateSummary(record);
    const projectedVersion = projectFundingTemplateVersion(active);
    const agentStructure = projectFundingTemplateAgentStructure(active);
    if (!summary || !projectedVersion || !agentStructure) return JSON.stringify(getFailure(args, 'repository_corrupt'));
    try {
      return JSON.stringify(FundingTemplateToolGetResponseSchema.parse({
        ok: true,
        contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
        action: 'get',
        operationId: args.operationId,
        ownerId: args.ownerId,
        projectId: args.projectId,
        template: summary,
        version: projectedVersion,
        agentStructure,
      }));
    } catch {
      return JSON.stringify(getFailure(args, 'repository_corrupt'));
    }
  };

  readonly #getDiff: ToolHandler = async (raw, context) => {
    const decoded = FundingTemplateToolGetDiffArgsSchema.safeParse(raw);
    if (!decoded.success) return JSON.stringify(fixedInvalidDiffResponse());
    const args = decoded.data;
    const scope = this.#scope(context);
    if (!scope || scope.ownerId !== args.ownerId || scope.projectId !== args.projectId) {
      return JSON.stringify(diffFailure(args, 'invalid_request'));
    }
    const loaded = this.#repository.getTemplate(args.ownerId, args.projectId, args.templateId, true);
    if (!loaded.ok) return JSON.stringify(diffFailure(args, mapFundingTemplateRepositoryFailure(loaded.code)));
    const record = loaded.value;
    if (record.archivedAt !== null) return JSON.stringify(diffFailure(args, 'archived'));
    const previous = record.versions.find((version) => version.version === args.fromVersion);
    const next = record.versions.find((version) => version.version === args.toVersion);
    if (record.revision !== args.expectedTemplateRevision
      || !previous || !next
      || previous.packageDigest !== args.fromDigest
      || next.packageDigest !== args.toDigest) {
      return JSON.stringify(diffFailure(args, 'cas_conflict'));
    }
    let view: FundingTemplateDiffView;
    try {
      const resolvedView = projectFundingTemplateDiff(record, args.fromVersion, args.toVersion);
      if (!resolvedView) return JSON.stringify(diffFailure(args, 'repository_corrupt'));
      view = resolvedView;
    } catch {
      return JSON.stringify(diffFailure(args, 'repository_corrupt'));
    }
    if (view.fromDigest !== args.fromDigest || view.toDigest !== args.toDigest) {
      return JSON.stringify(diffFailure(args, 'repository_corrupt'));
    }
    try {
      return JSON.stringify(FundingTemplateDiffResponseSchema.parse({
        ok: true,
        contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
        action: 'diff',
        operationId: args.operationId,
        ownerId: args.ownerId,
        projectId: args.projectId,
        diff: view,
      }));
    } catch {
      return JSON.stringify(diffFailure(args, 'repository_corrupt'));
    }
  };
}
