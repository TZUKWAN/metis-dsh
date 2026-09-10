import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../engine/core/types.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import { PersonalizationResolver } from '../../engine/personalization/PersonalizationResolver.js';
import {
  FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME,
  FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME,
  FUNDING_TEMPLATE_LIST_TOOL_NAME,
  FundingTemplateListResponseSchema,
  FundingTemplateToolGetResponseSchema,
} from '../../engine/runtime/FundingTemplateRuntimeContract.js';
import type { PersonalizationDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { FundingTemplateRepository } from '../../electron/FundingTemplateRepository.js';
import { FundingTemplateService } from '../../electron/FundingTemplateService.js';
import {
  FUNDING_TEMPLATE_GET_ACTIVE_TOOL,
  FUNDING_TEMPLATE_LIST_TOOL,
  FundingTemplateToolService,
} from '../../electron/FundingTemplateToolService.js';
import {
  realFundingPdfFixture,
  realFundingPdfFixtureSha256,
  type RealFundingPdfFixtureName,
} from '../fixtures/funding/realFundingPdfFixtures.js';

const OWNER = 'owner-real-pdf';
const PROJECT = 'project-real-pdf';
const LIST_OPERATION = '00000000-0000-4000-8000-000000000201';
const GET_OPERATIONS = [
  '00000000-0000-4000-8000-000000000211',
  '00000000-0000-4000-8000-000000000212',
  '00000000-0000-4000-8000-000000000213',
] as const;

let root = '';
let uploadsRoot = '';
let repositoryRoot = '';
let clock = 1_900_080_000_000;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'metis-funding-real-pdf-'));
  uploadsRoot = path.join(root, 'uploads');
  repositoryRoot = path.join(root, 'repository');
  await fs.mkdir(uploadsRoot, { recursive: true });
  await fs.mkdir(repositoryRoot, { recursive: true });
  clock = 1_900_080_000_000;
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

class DefinitionReader {
  readonly #definitions: Map<string, PersonalizationDefinition>;

  constructor(definitions: readonly PersonalizationDefinition[]) {
    this.#definitions = new Map(definitions.map((definition) => [definition.id, definition]));
  }

  get(id: string): PersonalizationDefinition | undefined {
    return this.#definitions.get(id);
  }

  list(kind?: PersonalizationDefinition['kind'], includeDisabled = false): PersonalizationDefinition[] {
    return [...this.#definitions.values()].filter((definition) => (
      (kind === undefined || definition.kind === kind)
      && (includeDisabled || definition.enabled)
    ));
  }
}

describe('real funding PDF lifecycle', () => {
  it('imports, analyzes, persists, discovers, reads in the scenario, and survives repository restart', async () => {
    const fixtures: Array<{
      name: RealFundingPdfFixtureName;
      templateId: string;
      expectedSha256: string;
      expectedFamily: 'nssfc' | 'moe_humanities' | 'custom';
      expectedSection: string;
      expectedField: string;
      expectedLimits: number[];
      expectedInstructionCount: number;
    }> = [
      {
        name: 'nssfc',
        templateId: 'user:nssfc-template',
        expectedSha256: '2e1c3d1f02cf55c42b32a53d186009150e64995e4a30c6ce79f986be36125bb2',
        expectedFamily: 'nssfc',
        expectedSection: '课题论证',
        expectedField: '项目名称',
        expectedLimits: [300, 7_000, 2_000],
        expectedInstructionCount: 4,
      },
      {
        name: 'moe',
        templateId: 'user:moe-template',
        expectedSha256: '4188d18dc1d95c28d083df78b8551162a459d9b104063b58989f6350edc33dd9',
        expectedFamily: 'moe_humanities',
        expectedSection: '研究内容',
        expectedField: '研究方法',
        expectedLimits: [500, 5_000],
        expectedInstructionCount: 3,
      },
      {
        name: 'custom',
        templateId: 'user:custom-template',
        expectedSha256: 'c0133bcc53aaa742b9a1f6e9047816e9ed05d26f4fb2cf8843f350337e017524',
        expectedFamily: 'custom',
        expectedSection: '实施方案',
        expectedField: '负责人',
        expectedLimits: [400],
        expectedInstructionCount: 1,
      },
    ];
    const persistedPackageDigests = new Map<string, string>();
    const repository = new FundingTemplateRepository(repositoryRoot, { now: () => clock++ });
    const service = new FundingTemplateService(repository, { now: () => clock++ });

    for (const fixture of fixtures) {
      expect(realFundingPdfFixtureSha256(fixture.name)).toBe(fixture.expectedSha256);
      const filePath = path.join(uploadsRoot, `${fixture.name}.pdf`);
      await fs.writeFile(filePath, realFundingPdfFixture(fixture.name));
      const imported = await service.importOrReanalyze({
        ownerId: OWNER,
        projectId: PROJECT,
        templateId: fixture.templateId,
        filePath,
        trustedRoot: uploadsRoot,
        expectedTemplateRevision: 0,
        expectedActiveVersion: null,
        expectedActiveDigest: null,
      });
      if (!imported.ok) throw new Error(`${fixture.name}:${imported.code}`);
      expect(imported).toMatchObject({
        ok: true,
        value: { templateVersion: 1, templateRevision: 1, activeVersion: 1 },
      });
      expect(imported.value.sourceDigest).toBe(fixture.expectedSha256);
      persistedPackageDigests.set(fixture.templateId, imported.value.packageDigest);
      const active = service.getActive(OWNER, PROJECT, fixture.templateId);
      if (!active.ok) throw new Error(`${fixture.name}:${active.code}`);
      expect(active.value.source.pageCount).toBe(2);
      expect(active.value.sections.length).toBeGreaterThanOrEqual(3);
      expect(active.value.contentSlots.length).toBeGreaterThanOrEqual(4);
      expect(active.value.instructions).toHaveLength(fixture.expectedInstructionCount);
      expect(active.value.sections.map((section) => section.normalizedTitle)).toContain(fixture.expectedSection);
      expect(active.value.contentSlots.map((slot) => slot.normalizedLabel)).toContain(fixture.expectedField);
      expect(active.value.instructions.flatMap((instruction) => (
        instruction.maxLength === null ? [] : [instruction.maxLength.value]
      ))).toEqual(fixture.expectedLimits);
      if (fixture.name === 'custom') {
        expect(active.value.contentSlots.map((slot) => slot.normalizedLabel))
          .not.toContain('区域协同研究项目申报模板');
      }
    }

    expect(await fs.readdir(path.join(repositoryRoot, 'funding-templates'))).toEqual(expect.arrayContaining([
      '.repository.ptr.json',
      expect.stringMatching(/^repository\.[01]\.json$/u),
    ]));

    const restartedRepository = new FundingTemplateRepository(repositoryRoot, { now: () => clock++ });
    const restartedService = new FundingTemplateService(restartedRepository, { now: () => clock++ });
    const restartedList = restartedService.list(OWNER, PROJECT);
    expect(restartedList).toMatchObject({ ok: true, value: expect.arrayContaining([
      expect.objectContaining({ templateId: 'user:nssfc-template', activeVersion: 1 }),
      expect.objectContaining({ templateId: 'user:moe-template', activeVersion: 1 }),
      expect.objectContaining({ templateId: 'user:custom-template', activeVersion: 1 }),
    ]) });
    if (!restartedList.ok) throw new Error(restartedList.code);
    expect(restartedList.value).toHaveLength(3);
    for (const item of restartedList.value) {
      expect(item.activeDigest).toBe(persistedPackageDigests.get(item.templateId));
    }

    const context: ToolContext = {
      sessionId: 'session-real-pdf',
      workspace: root,
      turnIndex: 0,
    };
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    new FundingTemplateToolService(restartedRepository, {
      resolveScope: (toolContext) => toolContext.sessionId === context.sessionId
        ? { ownerId: OWNER, projectId: PROJECT }
        : null,
    }).register(registry, dispatcher);
    const listedResult = await dispatcher.dispatch({
      id: 'real-funding-list',
      name: FUNDING_TEMPLATE_LIST_TOOL,
      arguments: { operationId: LIST_OPERATION, ownerId: OWNER, projectId: PROJECT },
    }, context);
    expect(listedResult.status).toBe('ok');
    const listed = FundingTemplateListResponseSchema.parse(JSON.parse(listedResult.content) as unknown);
    if (!listed.ok) throw new Error(listed.code);
    expect(listed.templates).toHaveLength(3);

    const structures = new Map<string, Extract<
      ReturnType<typeof FundingTemplateToolGetResponseSchema.parse>,
      { ok: true }
    >['agentStructure']>();
    for (const [index, template] of listed.templates.entries()) {
      const result = await dispatcher.dispatch({
        id: `real-funding-get-${index}`,
        name: FUNDING_TEMPLATE_GET_ACTIVE_TOOL,
        arguments: {
          operationId: GET_OPERATIONS[index],
          ownerId: OWNER,
          projectId: PROJECT,
          templateId: template.templateId,
          expectedTemplateRevision: template.templateRevision,
          expectedActiveVersion: template.activeVersion,
          expectedActiveDigest: template.activeDigest,
        },
      }, context);
      expect(result.status).toBe('ok');
      const decoded = FundingTemplateToolGetResponseSchema.parse(JSON.parse(result.content) as unknown);
      if (!decoded.ok) throw new Error(decoded.code);
      expect(decoded.version.packageDigest).toBe(persistedPackageDigests.get(template.templateId));
      structures.set(template.templateId, decoded.agentStructure);
      expect(decoded.agentStructure.sections.length).toBeGreaterThanOrEqual(3);
      expect(decoded.agentStructure.fields.length).toBeGreaterThanOrEqual(4);
      expect(decoded.agentStructure.instructions.length).toBeGreaterThanOrEqual(1);
      expect(decoded.agentStructure.layout.pageSizePt.state).toBe('observed');
      expect(decoded.agentStructure.layout.marginsPt.state).toBe('not_observed');
      expect(decoded.agentStructure.tables).toEqual([]);
    }
    for (const fixture of fixtures) {
      const structure = structures.get(fixture.templateId);
      expect(structure?.family.code).toBe(fixture.expectedFamily);
      expect(structure?.sections.map((section) => section.title)).toContain(fixture.expectedSection);
      expect(structure?.fields.map((field) => field.label)).toContain(fixture.expectedField);
      expect(structure?.instructions.flatMap((instruction) => (
        instruction.maxLength === null ? [] : [instruction.maxLength.value]
      ))).toEqual(fixture.expectedLimits);
    }

    const definitions = buildBuiltinPersonalizationDefinitions({
      fundingTemplateRegisteredToolIds: new Set([
        FUNDING_TEMPLATE_LIST_TOOL_NAME,
        FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME,
        FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME,
      ]),
    });
    const scenario = definitions.find((definition) => definition.id === 'builtin:scenarios/fund-uploaded-template');
    expect(scenario?.kind).toBe('scenario');
    if (scenario?.kind !== 'scenario') throw new Error('Uploaded funding scenario missing');
    const inspect = scenario.workflow.find((step) => step.id === 'inspect-template');
    expect(inspect?.toolIds).toEqual([
      FUNDING_TEMPLATE_LIST_TOOL_NAME,
      FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME,
      FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME,
    ]);
    const resolved = new PersonalizationResolver(new DefinitionReader(definitions)).resolve({
      sessionId: context.sessionId,
      projectId: PROJECT,
      scenarioId: scenario.id,
      createdAt: clock++,
    });
    expect(resolved).toMatchObject({ ok: true, scenario: { id: scenario.id } });
    if (!resolved.ok) throw new Error(resolved.issues.join('; '));
    expect(resolved.skills.some((skill) => skill.id === 'builtin:skills/funding-template-analysis')).toBe(true);
    expect(resolved.systemPrompt).toContain(FUNDING_TEMPLATE_LIST_TOOL_NAME);
  }, 30_000);
});
