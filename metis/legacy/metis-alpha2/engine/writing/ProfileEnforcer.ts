import { z } from 'zod';
import type { ResearchDecision, Source } from '../persistence/researchModel.js';
import {
  AcademicCitationStyleSchema,
  DeliverableProfileBindingSchema,
  getDeliverableProfile,
  type DeliverableProfileBinding,
} from './DeliverableProfile.js';

export const DeliverableSourceKindSchema = z.enum([
  'peer_reviewed',
  'primary',
  'policy',
  'news',
  'statistics',
  'archive',
  'dataset',
]);

export const DeliverableRuleKindSchema = z.enum(['template', 'venue', 'school']);

export const DeliverableContextSchema = z.strictObject({
  templateId: z.string().min(1),
  templateSourceId: z.string().min(1),
  contentFormat: z.enum(['latex', 'docx', 'markdown']),
  citationStyle: AcademicCitationStyleSchema,
  venueRuleSourceId: z.string().min(1).nullable().default(null),
  schoolRuleSourceId: z.string().min(1).nullable().default(null),
});

export type DeliverableContext = z.infer<typeof DeliverableContextSchema>;

export const DeliverableComplianceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  checkedAt: z.number().int().positive(),
  profileId: DeliverableProfileBindingSchema.shape.id,
  templateId: z.string().min(1),
  templateSourceId: z.string().min(1),
  contentFormat: z.enum(['latex', 'docx', 'markdown']),
  citationStyle: AcademicCitationStyleSchema,
  sourceIds: z.array(z.string().min(1)),
  approvalDecisionIds: z.array(z.string().min(1)),
  approvalArtifactVersion: z.number().int().positive(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});

export type DeliverableCompliance = z.infer<typeof DeliverableComplianceSchema>;

export type ProfileEnforcementIssue =
  | 'profile_binding_invalid'
  | 'template_not_allowed'
  | 'content_format_not_allowed'
  | 'citation_style_not_allowed'
  | 'required_section_missing'
  | 'source_missing_or_deleted'
  | 'source_kind_not_allowed'
  | 'stable_identifier_missing'
  | 'minimum_independent_sources'
  | 'source_stale'
  | 'rule_source_missing'
  | 'rule_source_stale'
  | 'approval_stage_missing';

export interface ProfileEnforcementResult {
  passed: boolean;
  issues: ProfileEnforcementIssue[];
  compliance?: DeliverableCompliance;
}

export interface ProfileEnforcementInput {
  projectId: string;
  artifactId: string;
  binding: DeliverableProfileBinding;
  context: DeliverableContext;
  content: string;
  citedSourceIds: readonly string[];
  sources: readonly Source[];
  decisions: readonly ResearchDecision[];
  approvalArtifactVersion: number;
  contentDigest: string;
  now?: number;
}

function normalize(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function contentSections(content: string): Set<string> {
  const sections = new Set<string>();
  const markdown = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gmu;
  for (let match = markdown.exec(content); match; match = markdown.exec(content)) {
    if (match[1]) sections.add(normalize(match[1]));
  }
  const latex = /\\(?:part|chapter|section|subsection|subsubsection)\*?\s*\{([^{}]+)\}/gu;
  for (let match = latex.exec(content); match; match = latex.exec(content)) {
    if (match[1]) sections.add(normalize(match[1]));
  }
  return sections;
}

function metadataString(source: Source, key: string): string | undefined {
  const value = source.metadata[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stableSourceIdentity(source: Source): string | undefined {
  if (source.identifierType === 'other' || !source.identifier.trim()) return undefined;
  return `${source.identifierType}:${normalize(source.identifier)}`;
}

function validRuleSource(
  source: Source | undefined,
  projectId: string,
  ruleKind: 'venue' | 'school',
  maximumAgeMs: number,
  now: number,
): 'ok' | 'missing' | 'stale' {
  if (
    !source
    || source.projectId !== projectId
    || source.deletedAt !== null
    || metadataString(source, 'deliverableRuleKind') !== ruleKind
  ) return 'missing';
  return source.updatedAt <= now && now - source.updatedAt <= maximumAgeMs ? 'ok' : 'stale';
}

/**
 * Main-side, deterministic profile enforcement.  No path/keyword inference is
 * used for source or rule identity: callers must persist explicit structured
 * classifications on current source records.
 */
export function enforceDeliverableProfile(input: ProfileEnforcementInput): ProfileEnforcementResult {
  const issues: ProfileEnforcementIssue[] = [];
  const parsedBinding = DeliverableProfileBindingSchema.safeParse(input.binding);
  const profile = parsedBinding.success ? getDeliverableProfile(parsedBinding.data.id) : undefined;
  if (
    !profile
    || profile.schemaVersion !== input.binding.schemaVersion
    || profile.profileVersion !== input.binding.profileVersion
  ) {
    return { passed: false, issues: ['profile_binding_invalid'] };
  }
  const now = input.now ?? Date.now();
  if (!profile.template.templateIds.includes(input.context.templateId)) issues.push('template_not_allowed');
  if (!profile.template.acceptedFormats.includes(input.context.contentFormat)) issues.push('content_format_not_allowed');
  if (!profile.citation.allowedStyles.includes(input.context.citationStyle)) issues.push('citation_style_not_allowed');

  const sections = contentSections(input.content);
  if (profile.structure.requiredSections.some((section) => !sections.has(normalize(section)))) {
    issues.push('required_section_missing');
  }

  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const currentSources: Source[] = [];
  const independent = new Set<string>();
  for (const sourceId of input.citedSourceIds) {
    const source = sourceById.get(sourceId);
    if (!source || source.projectId !== input.projectId || source.deletedAt !== null) {
      issues.push('source_missing_or_deleted');
      continue;
    }
    currentSources.push(source);
    const sourceKind = DeliverableSourceKindSchema.safeParse(metadataString(source, 'deliverableSourceKind'));
    if (!sourceKind.success || !profile.source.requiredKinds.includes(sourceKind.data)) {
      issues.push('source_kind_not_allowed');
    }
    const identity = stableSourceIdentity(source);
    if (profile.source.requireStableIdentifier && !identity) issues.push('stable_identifier_missing');
    if (identity) independent.add(identity);
    if (
      profile.source.freshnessDays !== null
      && (source.updatedAt > now || now - source.updatedAt > profile.source.freshnessDays * 86_400_000)
    ) issues.push('source_stale');
  }
  if (independent.size < profile.source.minimumIndependentSources) issues.push('minimum_independent_sources');

  const ruleChecks: Array<['venue' | 'school', string | null, boolean, number]> = [
    ['venue', input.context.venueRuleSourceId, profile.venue.required, profile.venue.expiresAfterDays],
    ['school', input.context.schoolRuleSourceId, profile.school.required, profile.school.expiresAfterDays],
  ];
  if (profile.template.sourceRequired) {
    const templateSource = sourceById.get(input.context.templateSourceId);
    if (
      !templateSource
      || templateSource.projectId !== input.projectId
      || templateSource.deletedAt !== null
      || metadataString(templateSource, 'deliverableRuleKind') !== 'template'
    ) issues.push('rule_source_missing');
  }
  for (const [kind, sourceId, required, expiryDays] of ruleChecks) {
    if (!required) continue;
    const status = validRuleSource(
      sourceId ? sourceById.get(sourceId) : undefined,
      input.projectId,
      kind,
      expiryDays * 86_400_000,
      now,
    );
    if (status === 'missing') issues.push('rule_source_missing');
    if (status === 'stale') issues.push('rule_source_stale');
  }

  const acceptedStages = new Map<string, string>();
  for (const decision of input.decisions) {
    if (
      decision.projectId !== input.projectId
      || decision.targetKind !== 'artifact'
      || decision.targetId !== input.artifactId
      || decision.origin !== 'human'
      || decision.decision !== 'accept'
      || decision.undoneAt !== null
    ) continue;
    const stage = decision.afterValue.deliverableApprovalStage;
    const artifactVersion = decision.afterValue.deliverableApprovalArtifactVersion;
    const contentDigest = decision.afterValue.deliverableApprovalContentDigest;
    if (
      typeof stage === 'string'
      && artifactVersion === input.approvalArtifactVersion
      && contentDigest === input.contentDigest
      && !acceptedStages.has(stage)
    ) acceptedStages.set(stage, decision.id);
  }
  if (profile.approval.requiredStages.some((stage) => !acceptedStages.has(stage))) {
    issues.push('approval_stage_missing');
  }

  const uniqueIssues = [...new Set(issues)];
  if (uniqueIssues.length > 0) return { passed: false, issues: uniqueIssues };
  return {
    passed: true,
    issues: [],
    compliance: DeliverableComplianceSchema.parse({
      schemaVersion: 1,
      checkedAt: now,
      profileId: profile.id,
      templateId: input.context.templateId,
      templateSourceId: input.context.templateSourceId,
      contentFormat: input.context.contentFormat,
      citationStyle: input.context.citationStyle,
      sourceIds: currentSources.map((source) => source.id),
      approvalDecisionIds: profile.approval.requiredStages.map((stage) => acceptedStages.get(stage)!),
      approvalArtifactVersion: input.approvalArtifactVersion,
      contentDigest: input.contentDigest,
    }),
  };
}
