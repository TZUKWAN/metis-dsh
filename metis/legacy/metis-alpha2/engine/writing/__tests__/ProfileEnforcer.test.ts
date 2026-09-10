import { describe, expect, it } from 'vitest';
import type { ResearchDecision, Source } from '../../persistence/researchModel.js';
import { bindDeliverableProfile, getDeliverableProfile } from '../DeliverableProfile.js';
import { enforceDeliverableProfile, type DeliverableContext } from '../ProfileEnforcer.js';

const NOW = 1_800_000_000_000;
const STAGES = ['outline', 'sources', 'draft', 'citation_audit', 'format_preview', 'release'] as const;

function source(
  id: string,
  identifier: string,
  deliverableSourceKind: string,
  extra: Partial<Source> = {},
): Source {
  return {
    id,
    projectId: 'project-1',
    kind: 'paper',
    title: `Source ${id}`,
    authors: ['Alice Smith'],
    year: 2024,
    venue: 'Journal',
    identifier,
    identifierType: 'doi',
    filePath: null,
    externalUrl: null,
    tags: [],
    metadata: { deliverableSourceKind },
    sourceVersionHash: 'source-hash',
    provenance: { origin: 'test' },
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    deletedAt: null,
    ...extra,
  };
}

function decisions(): ResearchDecision[] {
  return STAGES.map((stage, index) => ({
    id: `decision-${stage}`,
    projectId: 'project-1',
    runId: null,
    targetKind: 'artifact',
    targetId: 'artifact-1',
    decision: 'accept',
    origin: 'human',
    beforeValue: {},
    afterValue: {
      deliverableApprovalStage: stage,
      deliverableApprovalArtifactVersion: 1,
      deliverableApprovalContentDigest: 'f'.repeat(64),
    },
    note: '',
    createdAt: NOW - 500 + index,
    undoneAt: null,
  }));
}

function validInput() {
  return {
    projectId: 'project-1',
    artifactId: 'artifact-1',
    binding: bindDeliverableProfile('sci'),
    context: {
      templateId: 'sci-journal-author-guidelines',
      templateSourceId: 'template-source',
      contentFormat: 'markdown' as const,
      citationStyle: 'apa' as DeliverableContext['citationStyle'],
      venueRuleSourceId: 'venue-rules',
      schoolRuleSourceId: null,
    },
    content: [
      '# Abstract', '# Introduction', '# Methods', '# Results', '# Discussion', '# References',
    ].join('\n\nSubstantive content.\n\n'),
    citedSourceIds: ['source-1', 'source-2'],
    sources: [
      source('source-1', '10.1234/one', 'peer_reviewed'),
      source('source-2', '10.1234/two', 'primary'),
      source('template-source', 'https://journal.example/template', 'primary', {
        kind: 'web',
        identifierType: 'url',
        metadata: { deliverableSourceKind: 'primary', deliverableRuleKind: 'template' },
      }),
      source('venue-rules', 'https://journal.example/rules', 'primary', {
        kind: 'web',
        identifierType: 'url',
        metadata: { deliverableSourceKind: 'primary', deliverableRuleKind: 'venue' },
      }),
    ],
    decisions: decisions(),
    approvalArtifactVersion: 1,
    contentDigest: 'f'.repeat(64),
    now: NOW,
  };
}

describe('ProfileEnforcer production invariants', () => {
  it('accepts only a fully structured current profile/source/rule/approval set', () => {
    const result = enforceDeliverableProfile(validInput());
    expect(result.passed).toBe(true);
    expect(result.compliance).toMatchObject({
      profileId: 'sci',
      templateId: 'sci-journal-author-guidelines',
      templateSourceId: 'template-source',
      sourceIds: ['source-1', 'source-2'],
      approvalDecisionIds: STAGES.map((stage) => `decision-${stage}`),
    });
  });

  it.each([
    ['template_not_allowed', (input: ReturnType<typeof validInput>) => { input.context.templateId = 'lookalike'; }],
    ['citation_style_not_allowed', (input: ReturnType<typeof validInput>) => { input.context.citationStyle = 'gbt7714'; }],
    ['required_section_missing', (input: ReturnType<typeof validInput>) => { input.content = '# Abstract'; }],
    ['source_kind_not_allowed', (input: ReturnType<typeof validInput>) => { input.sources[0]!.metadata.deliverableSourceKind = 'news'; }],
    ['stable_identifier_missing', (input: ReturnType<typeof validInput>) => { input.sources[0]!.identifierType = 'other'; input.sources[0]!.identifier = ''; }],
    ['minimum_independent_sources', (input: ReturnType<typeof validInput>) => { input.sources[1]!.identifier = input.sources[0]!.identifier; }],
    ['source_missing_or_deleted', (input: ReturnType<typeof validInput>) => { input.sources[0]!.deletedAt = NOW; }],
    ['rule_source_missing', (input: ReturnType<typeof validInput>) => { input.sources[3]!.metadata.deliverableRuleKind = 'school'; }],
    ['rule_source_missing', (input: ReturnType<typeof validInput>) => { input.sources[2]!.deletedAt = NOW; }],
    ['rule_source_stale', (input: ReturnType<typeof validInput>) => { input.sources[3]!.updatedAt = NOW - 181 * 86_400_000; }],
    ['approval_stage_missing', (input: ReturnType<typeof validInput>) => { input.decisions.at(-1)!.undoneAt = NOW; }],
    ['approval_stage_missing', (input: ReturnType<typeof validInput>) => { input.decisions[0]!.afterValue.deliverableApprovalContentDigest = '0'.repeat(64); }],
  ] as const)('fails closed with exact structured issue %s', (issue, mutate) => {
    const input = validInput();
    mutate(input);
    const result = enforceDeliverableProfile(input);
    expect(result.passed).toBe(false);
    expect(result.issues).toContain(issue);
  });

  it('enforces a freshness window for the research-report profile', () => {
    const input = validInput();
    const profile = getDeliverableProfile('research_report')!;
    input.binding = bindDeliverableProfile('research_report');
    input.context.templateId = profile.template.templateIds[0]!;
    input.context.citationStyle = profile.citation.defaultStyle;
    input.content = profile.structure.requiredSections.map((section) => `# ${section}\n\nContent.`).join('\n\n');
    input.sources[0]!.metadata.deliverableSourceKind = 'primary';
    input.sources[0]!.updatedAt = NOW - 31 * 86_400_000;
    const result = enforceDeliverableProfile(input);
    expect(result.passed).toBe(false);
    expect(result.issues).toContain('source_stale');
  });
});
