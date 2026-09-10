import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../engine/core/types.js';
import {
  buildFundingTemplateBuiltinDraft,
  isFundingTemplateBuiltinDraftReady,
} from '../../engine/personalization/FundingTemplateBuiltinDraft.js';
import { PersonalizationResolver } from '../../engine/personalization/PersonalizationResolver.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import {
  FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME,
  FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME,
  FUNDING_TEMPLATE_LIST_TOOL_NAME,
} from '../../engine/runtime/FundingTemplateRuntimeContract.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import type { ExecutionOwnerIdentity } from '../../electron/ExecutionCapabilityRegistry.js';
import { FileCapabilityRegistry } from '../../electron/FileCapabilityRegistry.js';
import { FundingTemplateIpcService } from '../../electron/FundingTemplateIpcService.js';
import { FundingTemplateRepository } from '../../electron/FundingTemplateRepository.js';
import { FundingTemplateService } from '../../electron/FundingTemplateService.js';
import {
  FUNDING_TEMPLATE_GET_ACTIVE_TOOL,
  FundingTemplateToolService,
} from '../../electron/FundingTemplateToolService.js';

const OWNER_A: ExecutionOwnerIdentity = {
  webContentsId: 4101,
  mainFrameProcessId: 5101,
  mainFrameRoutingId: 6101,
};
const OWNER_B: ExecutionOwnerIdentity = {
  webContentsId: 4102,
  mainFrameProcessId: 5102,
  mainFrameRoutingId: 6102,
};
const LOCAL_OWNER = 'local-funding-owner';
const PROJECT = 'project-funding-a';
const OTHER_PROJECT = 'project-funding-b';
const TEMPLATE = 'user:funding-truth-attack';

let root = '';
let clock = 1_900_700_000_000;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-funding-truth-attacks-'));
  clock = 1_900_700_000_000;
});

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function operation(ordinal: number): string {
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
}

function makePdf(marker: string): Buffer {
  const content = [
    `BT /F1 18 Tf 72 740 Td (Funding Application ${marker}) Tj ET`,
    'BT /F1 10 Tf 72 700 Td (Applicant alice.private@example.com) Tj ET',
    'BT /F1 10 Tf 72 670 Td (Local path C:/Users/Alice/secret-application.pdf) Tj ET',
    'BT /F1 10 Tf 72 640 Td (Required. Maximum 5000 words. token:do-not-reflect) Tj ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream`,
  ];
  let output = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, 'ascii'));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output, 'ascii');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, 'ascii');
}

function harness() {
  const repositoryBase = path.join(root, 'repository');
  fs.mkdirSync(repositoryBase);
  const repository = new FundingTemplateRepository(repositoryBase, { now: () => clock++ });
  const service = new FundingTemplateService(repository, { now: () => clock++ });
  const fileCapabilities = new FileCapabilityRegistry();

  const ipcFor = (owner: ExecutionOwnerIdentity) => new FundingTemplateIpcService({
    repository,
    service,
    projectExists: (projectId) => projectId === PROJECT,
    consumeFundingFile: (capabilityId) => {
      const consumed = fileCapabilities.consume(
        { capabilityId, operation: 'file' },
        owner,
        'funding-template',
      );
      return consumed.ok
        ? { filePath: consumed.resolvedPath, trustedRoot: path.dirname(consumed.resolvedPath) }
        : null;
    },
  });

  return { repository, service, fileCapabilities, ipcFor };
}

function issueFile(
  registry: FileCapabilityRegistry,
  owner: ExecutionOwnerIdentity,
  ordinal: number,
  purpose: 'funding-template' | 'personalization-skill-package' = 'funding-template',
) {
  const filePath = path.join(root, `private-person-${ordinal}.pdf`);
  fs.writeFileSync(filePath, makePdf(`revision-${ordinal}`));
  const issued = registry.issue({
    path: filePath,
    kind: 'file',
    mime: 'application/pdf',
    displayName: `alice-private-${ordinal}.pdf`,
    operations: ['file'],
    purpose,
  }, owner);
  if (!issued.success) throw new Error('Real FileCapability issuance failed');
  return { filePath, capabilityId: issued.capability.capabilityId };
}

function importRequest(capabilityId: string, ordinal: number, projectId = PROJECT) {
  return {
    contractVersion: 1 as const,
    operationId: operation(ordinal),
    action: 'import' as const,
    projectId,
    templateId: TEMPLATE,
    fileCapabilityId: capabilityId,
    capabilityUse: 'consume_once' as const,
    expectedTemplateRevision: 0,
    expectedActiveVersion: null,
    expectedActiveDigest: null,
  };
}

async function importFirst(
  setup: ReturnType<typeof harness>,
  owner: ExecutionOwnerIdentity = OWNER_A,
  ordinal = 1,
) {
  const issued = issueFile(setup.fileCapabilities, owner, ordinal);
  const response = await setup.ipcFor(owner).handle(
    LOCAL_OWNER,
    importRequest(issued.capabilityId, ordinal),
  );
  if (!response.ok || response.action !== 'import') throw new Error(`Real import failed: ${response.code}`);
  return response;
}

describe('funding-template owner, project, capability, and response attacks', () => {
  it('rejects a secondary-window owner without consuming the capability, then accepts the issuing owner', async () => {
    const setup = harness();
    const issued = issueFile(setup.fileCapabilities, OWNER_A, 1);
    const stolen = await setup.ipcFor(OWNER_B).handle(
      LOCAL_OWNER,
      importRequest(issued.capabilityId, 1),
    );
    expect(stolen).toMatchObject({ ok: false, action: 'import', code: 'file_capability_unavailable' });
    const legitimate = await setup.ipcFor(OWNER_A).handle(
      LOCAL_OWNER,
      importRequest(issued.capabilityId, 2),
    );
    expect(legitimate).toMatchObject({ ok: true, action: 'import', ownerId: LOCAL_OWNER, projectId: PROJECT });
    expect(setup.repository.getTemplate('attacker-owner', PROJECT, TEMPLATE, true)).toEqual({ ok: false, code: 'not_found' });
  });

  it('rejects cross-project import before capability consumption, then accepts the bound project', async () => {
    const setup = harness();
    const issued = issueFile(setup.fileCapabilities, OWNER_A, 2);
    const crossProject = await setup.ipcFor(OWNER_A).handle(
      LOCAL_OWNER,
      importRequest(issued.capabilityId, 3, OTHER_PROJECT),
    );
    expect(crossProject).toMatchObject({ ok: false, action: 'import', code: 'not_found', projectId: OTHER_PROJECT });
    expect(await setup.ipcFor(OWNER_A).handle(
      LOCAL_OWNER,
      importRequest(issued.capabilityId, 4),
    )).toMatchObject({ ok: true, action: 'import', projectId: PROJECT });
    expect(setup.repository.listTemplates(LOCAL_OWNER, OTHER_PROJECT, true)).toEqual({ ok: true, value: [] });
  });

  it('rejects purpose mismatch without consuming the grant for its actual purpose', async () => {
    const setup = harness();
    const issued = issueFile(setup.fileCapabilities, OWNER_A, 3, 'personalization-skill-package');
    expect(await setup.ipcFor(OWNER_A).handle(
      LOCAL_OWNER,
      importRequest(issued.capabilityId, 5),
    )).toMatchObject({ ok: false, action: 'import', code: 'file_capability_unavailable' });
    expect(setup.fileCapabilities.consume(
      { capabilityId: issued.capabilityId, operation: 'file' },
      OWNER_A,
      'personalization-skill-package',
    ).ok).toBe(true);
  });

  it('consumes a funding capability once and suppresses paths, labels, prose, PII, and secrets in the response', async () => {
    const setup = harness();
    const issued = issueFile(setup.fileCapabilities, OWNER_A, 4);
    const request = importRequest(issued.capabilityId, 6);
    const first = await setup.ipcFor(OWNER_A).handle(LOCAL_OWNER, request);
    expect(first).toMatchObject({ ok: true, action: 'import' });
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(issued.filePath);
    expect(serialized).not.toMatch(/alice-private|alice\.private@example\.com|C:\/Users\/Alice|Maximum 5000|token:do-not-reflect|Funding Application/iu);
    const replay = await setup.ipcFor(OWNER_A).handle(LOCAL_OWNER, { ...request, operationId: operation(7) });
    expect(replay).toMatchObject({ ok: false, action: 'import', code: 'file_capability_unavailable' });
  });

  it('rejects stale reanalysis CAS after consuming the one-shot file and preserves the stored version', async () => {
    const setup = harness();
    await importFirst(setup, OWNER_A, 5);
    const next = issueFile(setup.fileCapabilities, OWNER_A, 6);
    const stale = await setup.ipcFor(OWNER_A).handle(
      LOCAL_OWNER,
      importRequest(next.capabilityId, 8),
    );
    expect(stale).toMatchObject({ ok: false, action: 'import', code: 'cas_conflict' });
    expect(setup.fileCapabilities.consume(
      { capabilityId: next.capabilityId, operation: 'file' },
      OWNER_A,
      'funding-template',
    ).ok).toBe(false);
    const stored = setup.repository.getTemplate(LOCAL_OWNER, PROJECT, TEMPLATE, true);
    expect(stored).toMatchObject({ ok: true, value: { revision: 1, activeVersion: 1 } });
    if (stored.ok) expect(stored.value.versions).toHaveLength(1);
  });
});

describe('funding-template archive and Agent tool attacks', () => {
  it('blocks renderer and Agent reads after archive while retaining the archived record for restoration', async () => {
    const setup = harness();
    const imported = await importFirst(setup, OWNER_A, 7);
    const archived = await setup.ipcFor(OWNER_A).handle(LOCAL_OWNER, {
      contractVersion: 1,
      operationId: operation(9),
      action: 'archive',
      projectId: PROJECT,
      templateId: TEMPLATE,
      expectedTemplateRevision: imported.template.templateRevision,
      expectedActiveVersion: imported.template.activeVersion,
      expectedActiveDigest: imported.template.activeDigest,
    });
    expect(archived).toMatchObject({ ok: true, action: 'archive', template: { archivedAt: expect.any(Number) } });
    const get = await setup.ipcFor(OWNER_A).handle(LOCAL_OWNER, {
      contractVersion: 1,
      operationId: operation(10),
      action: 'get',
      projectId: PROJECT,
      templateId: TEMPLATE,
      templateVersion: 1,
      packageDigest: imported.template.activeDigest,
    });
    expect(get).toMatchObject({ ok: false, action: 'get', code: 'archived' });

    const toolService = new FundingTemplateToolService(setup.repository, {
      resolveScope: () => ({ ownerId: LOCAL_OWNER, projectId: PROJECT }),
    });
    const raw = await toolService.getHandlers().get(FUNDING_TEMPLATE_GET_ACTIVE_TOOL)!({
      operationId: operation(11),
      ownerId: LOCAL_OWNER,
      projectId: PROJECT,
      templateId: TEMPLATE,
      expectedTemplateRevision: imported.template.templateRevision + 1,
      expectedActiveVersion: 1,
      expectedActiveDigest: imported.template.activeDigest,
    }, { sessionId: 'funding-session', workspace: root, turnIndex: 0 });
    expect(JSON.parse(raw)).toMatchObject({ ok: false, code: 'archived' });
    expect(setup.repository.getTemplate(LOCAL_OWNER, PROJECT, TEMPLATE, true)).toMatchObject({
      ok: true,
      value: { archivedAt: expect.any(Number) },
    });
  });

  it('rejects forged owner/project tool arguments and extra path arguments through the real registry/dispatcher', async () => {
    const setup = harness();
    const imported = await importFirst(setup, OWNER_A, 8);
    const toolRegistry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(toolRegistry);
    const context: ToolContext = { sessionId: 'trusted-session', workspace: root, turnIndex: 0 };
    new FundingTemplateToolService(setup.repository, {
      resolveScope: (candidate) => candidate.sessionId === context.sessionId
        ? { ownerId: LOCAL_OWNER, projectId: PROJECT }
        : null,
    }).register(toolRegistry, dispatcher);
    const baseArgs = {
      operationId: operation(12),
      ownerId: LOCAL_OWNER,
      projectId: PROJECT,
      templateId: TEMPLATE,
      expectedTemplateRevision: imported.template.templateRevision,
      expectedActiveVersion: imported.template.activeVersion,
      expectedActiveDigest: imported.template.activeDigest,
    };

    for (const [ordinal, arguments_] of [
      [13, { ...baseArgs, operationId: operation(13), ownerId: 'attacker-owner' }],
      [14, { ...baseArgs, operationId: operation(14), projectId: OTHER_PROJECT }],
    ] as const) {
      const result = await dispatcher.dispatch({
        id: `forged-scope-${ordinal}`,
        name: FUNDING_TEMPLATE_GET_ACTIVE_TOOL,
        arguments: arguments_,
      }, context);
      expect(result.status).toBe('ok');
      expect(JSON.parse(result.content)).toMatchObject({ ok: false, code: 'invalid_request' });
    }

    const injected = await dispatcher.dispatch({
      id: 'forged-path',
      name: FUNDING_TEMPLATE_GET_ACTIVE_TOOL,
      arguments: { ...baseArgs, operationId: operation(15), filePath: 'C:\\Users\\Alice\\secret.pdf' },
    }, context);
    expect(injected).toMatchObject({ status: 'error', content: '' });

    const wrongSession = await dispatcher.dispatch({
      id: 'forged-session',
      name: FUNDING_TEMPLATE_GET_ACTIVE_TOOL,
      arguments: { ...baseArgs, operationId: operation(16) },
    }, { ...context, sessionId: 'attacker-session' });
    expect(wrongSession.status).toBe('ok');
    expect(JSON.parse(wrongSession.content)).toMatchObject({ ok: false, code: 'invalid_request' });
  });
});

describe('funding built-in activation and reserved presentation attacks', () => {
  it('does not activate the funding Skill merely because a service object exists without real ToolRegistry registration', () => {
    const setup = harness();
    const unregisteredService = new FundingTemplateToolService(setup.repository, {
      resolveScope: () => ({ ownerId: LOCAL_OWNER, projectId: PROJECT }),
    });
    expect(unregisteredService.getSpecs()).toHaveLength(3);
    const toolRegistry = new ToolRegistry();
    const registeredIds = new Set(toolRegistry.list().map((tool) => tool.name));
    expect(isFundingTemplateBuiltinDraftReady(registeredIds)).toBe(false);
    expect(toolRegistry.has(FUNDING_TEMPLATE_LIST_TOOL_NAME)).toBe(false);
    expect(toolRegistry.has(FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME)).toBe(false);
    expect(toolRegistry.has(FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME)).toBe(false);
    expect(unregisteredService.getSpecs()).toHaveLength(3);

    const definitions = buildBuiltinPersonalizationDefinitions({
      fundingTemplateRegisteredToolIds: registeredIds,
    });
    expect(definitions.find((definition) => definition.id === 'builtin:skills/funding-template-analysis')).toBeUndefined();
    expect(definitions.find((definition) => definition.id === 'builtin:agents/fund-uploaded-template')).toMatchObject({
      kind: 'agent',
      skillIds: expect.not.arrayContaining(['builtin:skills/funding-template-analysis']),
    });
  });

  it('keeps the standalone draft disabled and requires both exact registered tool names', () => {
    const draft = buildFundingTemplateBuiltinDraft();
    const toolRegistry = new ToolRegistry();
    expect(draft.skill.enabled).toBe(false);
    expect(draft.agent.enabled).toBe(false);
    expect(isFundingTemplateBuiltinDraftReady(new Set(toolRegistry.list().map((tool) => tool.name)))).toBe(false);
    const draftRepositoryBase = path.join(root, 'draft-repository');
    fs.mkdirSync(draftRepositoryBase);
    const service = new FundingTemplateToolService(new FundingTemplateRepository(draftRepositoryBase), {
      resolveScope: () => null,
    });
    service.register(toolRegistry, new ToolDispatcher(toolRegistry));
    expect(isFundingTemplateBuiltinDraftReady(new Set(toolRegistry.list().map((tool) => tool.name)))).toBe(true);
  });

  it('cannot resolve or execute the disabled, behavior-free PPT reserved scenario', () => {
    const definitions = buildBuiltinPersonalizationDefinitions();
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
    const presentation = byId.get('builtin:scenarios/presentation-reserved');
    expect(presentation).toMatchObject({
      kind: 'scenario',
      enabled: false,
      capability: 'presentation_reserved',
      workflow: [],
      agentIds: [],
      skillIds: [],
      mcpIds: [],
      triggerPhrases: [],
    });
    const resolver = new PersonalizationResolver({
      get: (id) => byId.get(id),
      list: (kind, includeDisabled) => definitions.filter((definition) => {
        if (kind && definition.kind !== kind) return false;
        return includeDisabled || definition.enabled;
      }),
    });
    expect(resolver.resolve({
      sessionId: 'ppt-attack-session',
      projectId: PROJECT,
      scenarioId: 'builtin:scenarios/presentation-reserved',
      createdAt: clock,
    })).toMatchObject({ ok: false, code: 'scenario_disabled' });
  });
});
