import { describe, expect, it } from 'vitest';
import {
  FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME,
  FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME,
  FUNDING_TEMPLATE_LIST_TOOL_NAME,
} from '../../engine/runtime/FundingTemplateRuntimeContract.js';
import { PersonalizationDefinitionSchema } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import {
  buildFundingTemplateBuiltinDraft,
  isFundingTemplateBuiltinDraftReady,
} from '../../engine/personalization/FundingTemplateBuiltinDraft.js';

describe('funding template built-in definition draft', () => {
  it('provides strict, disabled skill and agent definitions pending real tool registration', () => {
    const draft = buildFundingTemplateBuiltinDraft();
    expect(draft.status).toBe('inactive_pending_tool_registration');
    expect(PersonalizationDefinitionSchema.safeParse(draft.skill).success).toBe(true);
    expect(PersonalizationDefinitionSchema.safeParse(draft.agent).success).toBe(true);
    expect(draft.skill).toMatchObject({
      id: 'builtin:skills/funding-template-analysis', kind: 'skill', enabled: false,
    });
    expect(draft.agent).toMatchObject({
      id: 'builtin:agents/funding-template-analysis', kind: 'agent', enabled: false,
      skillIds: ['builtin:skills/funding-template-analysis'],
    });
    expect(draft.requiredToolIds).toEqual([
      FUNDING_TEMPLATE_LIST_TOOL_NAME,
      FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME,
      FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME,
    ]);
    expect(draft.skill.toolIds).toEqual(draft.requiredToolIds);
    expect(draft.agent.toolIds).toEqual(draft.requiredToolIds);
  });

  it('contains only read-only, evidence-bound instructions and no phantom import or mutation tool', () => {
    const draft = buildFundingTemplateBuiltinDraft();
    const serialized = JSON.stringify(draft);
    expect(serialized).not.toMatch(/funding_template_(?:import|activate|archive|restore|delete|write)/iu);
    expect(draft.skill.systemPrompt).toMatch(/read-only|previously imported/iu);
    expect(draft.skill.systemPrompt).toMatch(/first call funding_template_list|discover saved templates/iu);
    expect(draft.skill.systemPrompt).toMatch(/verified normalized family, sections, blank-form fields, instructions/iu);
    expect(draft.skill.systemPrompt).toMatch(/revision|version|digest/iu);
    expect(draft.skill.systemPrompt).toMatch(/never invent.*(?:section|field|instruction|applicant fact)/iu);
    expect(draft.agent.systemPrompt).toMatch(/main process|registered/iu);
    expect(draft.agent.output).toMatchObject({
      requireEvidenceEnvelope: true,
      includeIntegrityReport: true,
    });
  });

  it('reports readiness only when all real read-only tool registrations exist', () => {
    expect(isFundingTemplateBuiltinDraftReady(new Set())).toBe(false);
    expect(isFundingTemplateBuiltinDraftReady(new Set([FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME]))).toBe(false);
    expect(isFundingTemplateBuiltinDraftReady(new Set([FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME]))).toBe(false);
    expect(isFundingTemplateBuiltinDraftReady(new Set([
      FUNDING_TEMPLATE_LIST_TOOL_NAME,
      FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME,
    ]))).toBe(false);
    expect(isFundingTemplateBuiltinDraftReady(new Set([
      FUNDING_TEMPLATE_LIST_TOOL_NAME,
      FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME,
      FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME,
    ]))).toBe(true);
  });

  it('does not silently insert the inactive draft into the current built-in catalog', () => {
    const ids = new Set(buildBuiltinPersonalizationDefinitions().map((definition) => definition.id));
    expect(ids.has('builtin:skills/funding-template-analysis')).toBe(false);
    expect(ids.has('builtin:agents/funding-template-analysis')).toBe(false);
  });

  it('activates the safe skill and rewires the uploaded-template scenario only after real tools are registered', () => {
    const definitions = buildBuiltinPersonalizationDefinitions({
      fundingTemplateRegisteredToolIds: new Set([
        FUNDING_TEMPLATE_LIST_TOOL_NAME,
        FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME,
        FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME,
      ]),
    });
    const skill = definitions.find((definition) => definition.id === 'builtin:skills/funding-template-analysis');
    const scenario = definitions.find((definition) => definition.id === 'builtin:scenarios/fund-uploaded-template');
    expect(skill).toMatchObject({ kind: 'skill', enabled: true, toolIds: [
      FUNDING_TEMPLATE_LIST_TOOL_NAME,
      FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME,
      FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME,
    ] });
    expect(scenario?.kind).toBe('scenario');
    if (scenario?.kind !== 'scenario') return;
    const inspect = scenario.workflow.find((step) => step.id === 'inspect-template');
    expect(inspect?.skillIds).toEqual(['builtin:skills/funding-template-analysis']);
    expect(inspect?.toolIds).toEqual([
      FUNDING_TEMPLATE_LIST_TOOL_NAME,
      FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME,
      FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME,
    ]);
    expect(JSON.stringify(inspect)).not.toContain('read_pdf');
  });

  it('returns independent copies so draft inspection cannot mutate future definitions', () => {
    const first = buildFundingTemplateBuiltinDraft();
    const second = buildFundingTemplateBuiltinDraft();
    first.skill.toolIds.push('phantom_tool');
    first.agent.systemPrompt = 'mutated';
    expect(second.skill.toolIds).toEqual([
      FUNDING_TEMPLATE_LIST_TOOL_NAME,
      FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME,
      FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME,
    ]);
    expect(second.agent.systemPrompt).not.toBe('mutated');
  });
});
