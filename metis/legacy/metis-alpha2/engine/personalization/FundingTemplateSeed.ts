import { PersonalizationDefinitionSchema } from '../runtime/PersonalizationRuntimeContract.js';
import type { PersonalizationDefinition } from '../runtime/PersonalizationRuntimeContract.js';
import {
  buildFundingTemplateBuiltinDraft,
  isFundingTemplateBuiltinDraftReady,
} from './FundingTemplateBuiltinDraft.js';

/**
 * Production seeding for the funding-template builtin definitions.
 *
 * The legacy builtin catalog lives in a test fixture; the funding-template
 * draft is the one builtin that has real registered tools behind it. When the
 * three read-only tools passed the ToolRegistry audit, this seed promotes the
 * draft's skill and agent from `inactive_pending_tool_registration` to enabled
 * definitions so users can actually run template analysis. Without the tools
 * the seed is empty and the repository keeps whatever it already has.
 */
export function buildFundingTemplateSeed(registeredToolIds: ReadonlySet<string>): PersonalizationDefinition[] {
  if (!isFundingTemplateBuiltinDraftReady(registeredToolIds)) return [];
  const draft = buildFundingTemplateBuiltinDraft();
  const skill: PersonalizationDefinition = {
    ...draft.skill,
    enabled: true,
    description: 'Read-only, integrity-bound analysis of funding template structure and adjacent version differences.',
    tags: draft.skill.tags.filter((tag) => tag !== 'draft'),
    provenance: { ...draft.skill.provenance, version: '1.0.0' },
  } as PersonalizationDefinition;
  const agent: PersonalizationDefinition = {
    ...draft.agent,
    enabled: true,
    description: 'Conservative funding-template analysis agent bound to the verified read-only template tools.',
    tags: draft.agent.tags.filter((tag) => tag !== 'draft'),
    provenance: { ...draft.agent.provenance, version: '1.0.0' },
  } as PersonalizationDefinition;
  return [skill, agent].map((definition) => PersonalizationDefinitionSchema.parse(definition));
}
