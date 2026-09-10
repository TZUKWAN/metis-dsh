import { createHash } from 'node:crypto';
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../engine/core/types.js';
import {
  analyzeFundingTemplate,
  canonicalizeFundingTemplateValue,
} from '../../engine/personalization/FundingTemplateAnalyzer.js';
import {
  FundingTemplateDiffResponseSchema,
  FundingTemplateListResponseSchema,
  FundingTemplateToolGetResponseSchema,
} from '../../engine/runtime/FundingTemplateRuntimeContract.js';
import type { FundingTemplatePackage } from '../../engine/runtime/FundingTemplateContract.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { FundingTemplateRepository } from '../../electron/FundingTemplateRepository.js';
import {
  FUNDING_TEMPLATE_GET_ACTIVE_TOOL,
  FUNDING_TEMPLATE_GET_DIFF_TOOL,
  FUNDING_TEMPLATE_LIST_TOOL,
  FundingTemplateToolService,
} from '../../electron/FundingTemplateToolService.js';

const OWNER = 'owner-tool';
const PROJECT = 'project-tool';
const TEMPLATE = 'user:tool-template';
const GET_OPERATION = '00000000-0000-4000-8000-000000000101';
const DIFF_OPERATION = '00000000-0000-4000-8000-000000000102';
const LIST_OPERATION = '00000000-0000-4000-8000-000000000103';
let tempRoot = '';
let clock = 1_900_020_000_000;

beforeEach(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'metis-funding-tool-'));
  clock = 1_900_020_000_000;
});

afterEach(async () => {
  if (tempRoot) await fsp.rm(tempRoot, { recursive: true, force: true });
});

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function makePackage(version: number, revision: string): FundingTemplatePackage {
  const analyzed = analyzeFundingTemplate({
    templateId: TEMPLATE,
    templateVersion: version,
    createdAt: 1_900_010_000_000 + version,
    document: {
      contractVersion: 1,
      documentId: 'tool-observation',
      sourceFormat: 'pdf',
      sourceDigest: digest(`source:${revision}`),
      extractedAt: 1_900_010_000_000 + version,
      extractor: { name: 'tool-service-test', version: '1.0.0' },
      pageCount: 1,
      pages: [{
        pageNumber: 1, widthPt: 595, heightPt: 842,
        observedMarginsPt: { top: 72, right: 72, bottom: 72, left: 72 },
      }],
      styles: [
        {
          styleId: 'heading', fontFamily: 'Source Han Serif SC', fontSizePt: 18,
          fontWeight: 'bold', italic: false, alignment: 'center', lineSpacingPt: 24,
          paragraphBeforePt: 0, paragraphAfterPt: 12,
        },
        {
          styleId: 'body', fontFamily: 'Source Han Serif SC', fontSizePt: 10.5,
          fontWeight: 'normal', italic: false, alignment: 'left', lineSpacingPt: 18,
          paragraphBeforePt: 0, paragraphAfterPt: 6,
        },
      ],
      blocks: [
        {
          kind: 'paragraph', blockId: 'title', pageNumber: 1, ordinal: 0,
          bounds: { x: 72, y: 50, width: 451, height: 30 },
          text: `Funding Application Form ${revision}`, contentRole: 'template_label', styleId: 'heading',
        },
        {
          kind: 'paragraph', blockId: 'applicant-field', pageNumber: 1, ordinal: 1,
          bounds: { x: 72, y: 100, width: 180, height: 20 },
          text: 'Project Title:', contentRole: 'template_label', styleId: 'body',
        },
        {
          kind: 'paragraph', blockId: 'instruction', pageNumber: 1, ordinal: 2,
          bounds: { x: 72, y: 130, width: 300, height: 20 },
          text: 'Required. Maximum 5000 words.', contentRole: 'instruction', styleId: 'body',
        },
      ],
    },
  });
  if (!analyzed.ok) throw new Error(analyzed.code);
  return analyzed.template;
}

function saveFirst(repository: FundingTemplateRepository) {
  const saved = repository.saveVersion({
    ownerId: OWNER,
    projectId: PROJECT,
    template: makePackage(1, 'v1'),
    expectedTemplateRevision: 0,
    expectedActiveVersion: null,
    expectedActiveDigest: null,
  });
  if (!saved.ok) throw new Error(saved.code);
  return saved.value;
}

function saveSecond(repository: FundingTemplateRepository) {
  const first = saveFirst(repository);
  const saved = repository.saveVersion({
    ownerId: OWNER,
    projectId: PROJECT,
    template: makePackage(2, 'v2'),
    expectedTemplateRevision: first.revision,
    expectedActiveVersion: first.activeVersion,
    expectedActiveDigest: first.versions[0]!.packageDigest,
  });
  if (!saved.ok) throw new Error(saved.code);
  return saved.value;
}

const context: ToolContext = {
  sessionId: 'session-owner-tool',
  workspace: '.',
  turnIndex: 0,
};

function service(repository: FundingTemplateRepository) {
  return new FundingTemplateToolService(repository, {
    resolveScope: (toolContext) => toolContext.sessionId === context.sessionId
      ? { ownerId: OWNER, projectId: PROJECT }
      : null,
  });
}

function getArgs(record: ReturnType<typeof saveFirst>) {
  return {
    operationId: GET_OPERATION,
    ownerId: OWNER,
    projectId: PROJECT,
    templateId: TEMPLATE,
    expectedTemplateRevision: record.revision,
    expectedActiveVersion: record.activeVersion,
    expectedActiveDigest: record.versions[record.activeVersion - 1]!.packageDigest,
  };
}

function diffArgs(record: ReturnType<typeof saveSecond>) {
  return {
    operationId: DIFF_OPERATION,
    ownerId: OWNER,
    projectId: PROJECT,
    templateId: TEMPLATE,
    expectedTemplateRevision: record.revision,
    fromVersion: 1,
    toVersion: 2,
    fromDigest: record.versions[0]!.packageDigest,
    toDigest: record.versions[1]!.packageDigest,
  };
}

describe('FundingTemplateToolService registration and active reads', () => {
  it('registers exactly three read-only tools with strict schemas and no import or mutation capability', () => {
    const repository = new FundingTemplateRepository(tempRoot);
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    service(repository).register(registry, dispatcher);
    expect(registry.list().map((tool) => tool.name).sort()).toEqual([
      FUNDING_TEMPLATE_GET_ACTIVE_TOOL,
      FUNDING_TEMPLATE_GET_DIFF_TOOL,
      FUNDING_TEMPLATE_LIST_TOOL,
    ]);
    expect(registry.list().every((tool) => tool.parameters.additionalProperties === false)).toBe(true);
    expect(registry.list().some((tool) => /import|archive|restore|activate/iu.test(tool.name))).toBe(false);
  });

  it('discovers active templates with the exact bindings required by the active read', async () => {
    const repository = new FundingTemplateRepository(tempRoot, { now: () => clock++ });
    const record = saveFirst(repository);
    const raw = await service(repository).getHandlers().get(FUNDING_TEMPLATE_LIST_TOOL)!({
      operationId: LIST_OPERATION,
      ownerId: OWNER,
      projectId: PROJECT,
    }, context);
    const decoded = FundingTemplateListResponseSchema.parse(JSON.parse(raw) as unknown);
    expect(decoded).toMatchObject({
      ok: true,
      action: 'list',
      operationId: LIST_OPERATION,
      templates: [{
        templateId: TEMPLATE,
        templateRevision: record.revision,
        activeVersion: record.activeVersion,
        activeDigest: record.versions[0]!.packageDigest,
      }],
    });
  });

  it('returns a reverified active-version DTO with verified blank-form structure but no paths or bytes', async () => {
    const repository = new FundingTemplateRepository(tempRoot, { now: () => clock++ });
    const record = saveFirst(repository);
    const toolService = service(repository);
    const raw = await toolService.getHandlers().get(FUNDING_TEMPLATE_GET_ACTIVE_TOOL)!(getArgs(record), context);
    const decoded = FundingTemplateToolGetResponseSchema.parse(JSON.parse(raw) as unknown);
    expect(decoded).toMatchObject({
      ok: true,
      action: 'get',
      operationId: GET_OPERATION,
      template: { templateRevision: 1, activeVersion: 1 },
      version: { templateVersion: 1, sourceFormat: 'pdf' },
      agentStructure: {
        sections: expect.arrayContaining([expect.objectContaining({ title: 'Funding Application Form v1' })]),
        fields: expect.arrayContaining([expect.objectContaining({ label: 'Project Title', canonicalField: 'project_name' })]),
        instructions: expect.arrayContaining([expect.objectContaining({ text: 'Required. Maximum 5000 words.' })]),
      },
    });
    expect(raw).not.toMatch(/[A-Za-z]:\\|Uint8Array/iu);
  });

  it('runs through ToolRegistry/ToolDispatcher and presents only the strict safe DTO', async () => {
    const repository = new FundingTemplateRepository(tempRoot, { now: () => clock++ });
    const record = saveFirst(repository);
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    const toolService = service(repository);
    toolService.register(registry, dispatcher);
    const result = await dispatcher.dispatch({
      id: 'funding-call-1',
      name: FUNDING_TEMPLATE_GET_ACTIVE_TOOL,
      arguments: getArgs(record),
    }, context);
    expect(result.status).toBe('ok');
    const spec = registry.get(FUNDING_TEMPLATE_GET_ACTIVE_TOOL)!;
    const presentation = spec.decodeResult!(result.content, result.status === 'ok' ? 'ok' : 'error');
    expect(presentation).toMatchObject({ toolName: FUNDING_TEMPLATE_GET_ACTIVE_TOOL, status: 'ok' });
    expect(presentation.detail).toContain('"templateVersion":1');
    expect(presentation.detail).toContain('Project Title');
    expect(presentation.detail).toContain('Maximum 5000 words');
    expect(presentation.detail).not.toMatch(/[A-Za-z]:\\/u);
  });

  it('rejects cross-owner context and stale revision/version/digest without exposing repository state', async () => {
    const repository = new FundingTemplateRepository(tempRoot, { now: () => clock++ });
    const record = saveFirst(repository);
    const toolService = service(repository);
    const handler = toolService.getHandlers().get(FUNDING_TEMPLATE_GET_ACTIVE_TOOL)!;
    const crossOwner = JSON.parse(await handler(getArgs(record), { ...context, sessionId: 'attacker' })) as unknown;
    expect(crossOwner).toMatchObject({ ok: false, code: 'invalid_request' });
    for (const stale of [
      { ...getArgs(record), expectedTemplateRevision: 2 },
      { ...getArgs(record), expectedActiveVersion: 2 },
      { ...getArgs(record), expectedActiveDigest: 'f'.repeat(64) },
    ]) {
      expect(JSON.parse(await handler(stale, context))).toMatchObject({ ok: false, code: 'cas_conflict' });
    }
  });

  it('fails strict decoding before handler execution for extra keys or missing bindings', async () => {
    const repository = new FundingTemplateRepository(tempRoot, { now: () => clock++ });
    const record = saveFirst(repository);
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    service(repository).register(registry, dispatcher);
    for (const args of [
      { ...getArgs(record), filePath: 'C:\\private\\application.pdf' },
      { ...getArgs(record), expectedActiveDigest: undefined },
      { ...getArgs(record), ownerId: 'private.person@example.com' },
    ]) {
      const result = await dispatcher.dispatch({ id: digest(JSON.stringify(args)), name: FUNDING_TEMPLATE_GET_ACTIVE_TOOL, arguments: args }, context);
      expect(result).toMatchObject({ status: 'error', content: '' });
    }
  });
});

describe('FundingTemplateToolService stored diff reads', () => {
  it('returns only integrity-bound adjacent-version changes with hashed internal keys', async () => {
    const repository = new FundingTemplateRepository(tempRoot, { now: () => clock++ });
    const record = saveSecond(repository);
    const raw = await service(repository).getHandlers().get(FUNDING_TEMPLATE_GET_DIFF_TOOL)!(diffArgs(record), context);
    const decoded = FundingTemplateDiffResponseSchema.parse(JSON.parse(raw) as unknown);
    expect(decoded).toMatchObject({
      ok: true, action: 'diff', operationId: DIFF_OPERATION,
      diff: { fromVersion: 1, toVersion: 2, fromDigest: record.versions[0]!.packageDigest, toDigest: record.versions[1]!.packageDigest },
    });
    if (!decoded.ok) throw new Error(decoded.code);
    expect(decoded.diff.changes.length).toBeGreaterThan(0);
    expect(decoded.diff.changes.every((change) => /^[a-f0-9]{64}$/u.test(change.entityKeyDigest))).toBe(true);
    expect(raw).not.toMatch(/source:upload|layout:page|Applicant|Funding Application Form|Maximum 5000/iu);
  });

  it('rejects stale or forged version/digest/revision bindings', async () => {
    const repository = new FundingTemplateRepository(tempRoot, { now: () => clock++ });
    const record = saveSecond(repository);
    const handler = service(repository).getHandlers().get(FUNDING_TEMPLATE_GET_DIFF_TOOL)!;
    for (const attack of [
      { ...diffArgs(record), expectedTemplateRevision: 1 },
      { ...diffArgs(record), fromDigest: 'f'.repeat(64) },
      { ...diffArgs(record), toDigest: 'e'.repeat(64) },
    ]) expect(JSON.parse(await handler(attack, context))).toMatchObject({ ok: false, code: 'cas_conflict' });
  });

  it('recomputes the diff from verified packages and rejects a re-signed but false stored diff', async () => {
    const repository = new FundingTemplateRepository(tempRoot, { now: () => clock++ });
    const record = saveSecond(repository);
    const pointer = JSON.parse(fs.readFileSync(path.join(repository.repositoryRoot, '.repository.ptr.json'), 'utf8')) as { slot: 0 | 1 };
    const activePath = path.join(repository.repositoryRoot, `repository.${pointer.slot}.json`);
    const state = JSON.parse(fs.readFileSync(activePath, 'utf8')) as {
      stateDigest: string;
      templates: Array<{ versions: Array<{ diffFromPrevious: Record<string, unknown> | null }> }>;
      [key: string]: unknown;
    };
    const storedDiff = state.templates[0]!.versions[1]!.diffFromPrevious!;
    storedDiff.changes = [];
    storedDiff.breaking = false;
    const { diffDigest: _diffDigest, ...diffWithoutDigest } = storedDiff;
    void _diffDigest;
    storedDiff.diffDigest = digest(canonicalizeFundingTemplateValue(diffWithoutDigest));
    const { stateDigest: _stateDigest, ...stateWithoutDigest } = state;
    void _stateDigest;
    state.stateDigest = digest(canonicalizeFundingTemplateValue(stateWithoutDigest));
    fs.writeFileSync(activePath, JSON.stringify(state), 'utf8');

    const raw = await service(repository).getHandlers().get(FUNDING_TEMPLATE_GET_DIFF_TOOL)!(diffArgs(record), context);
    expect(JSON.parse(raw)).toMatchObject({ ok: false, code: 'repository_corrupt' });
  });

  it('suppresses malformed or hostile raw tool output instead of reflecting it to the model', () => {
    const repository = new FundingTemplateRepository(tempRoot);
    const spec = service(repository).getSpecs().find((candidate) => candidate.name === FUNDING_TEMPLATE_GET_DIFF_TOOL)!;
    for (const raw of [
      'C:\\Users\\person\\application.pdf',
      JSON.stringify({ ok: true, applicantText: 'private narrative' }),
      JSON.stringify({ ok: false, message: 'api_key=secret-value' }),
    ]) {
      const presentation = spec.decodeResult!(raw, 'ok');
      expect(presentation).toEqual({
        toolName: FUNDING_TEMPLATE_GET_DIFF_TOOL,
        status: 'tool_failed',
        summary: 'Funding template result suppressed',
      });
    }
  });
});
