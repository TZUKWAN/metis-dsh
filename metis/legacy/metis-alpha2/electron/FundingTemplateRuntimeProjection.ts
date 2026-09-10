import { createHash } from 'node:crypto';
import {
  canonicalizeFundingTemplateValue,
  diffFundingTemplatePackages,
  verifyFundingTemplatePackage,
} from '../engine/personalization/FundingTemplateAnalyzer.js';
import {
  FundingTemplateAgentStructureSchema,
  FundingTemplateDiffViewSchema,
  FundingTemplateSummarySchema,
  FundingTemplateVersionViewSchema,
  type FundingTemplateAgentStructure,
  type FundingTemplateDiffView,
  type FundingTemplateRuntimeFailureCode,
  type FundingTemplateSummary,
  type FundingTemplateVersionView,
} from '../engine/runtime/FundingTemplateRuntimeContract.js';
import type {
  FundingTemplateRepositoryFailureCode,
  FundingTemplateStoredRecord,
  FundingTemplateVersionRecord,
} from './FundingTemplateRepository.js';

type EvidenceAssertion<T> = {
  state: 'observed' | 'uncertain' | 'not_observed';
  value: T | null;
  confidence: number;
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Maps only real repository outcomes to the public fixed-code vocabulary. */
export function mapFundingTemplateRepositoryFailure(
  code: FundingTemplateRepositoryFailureCode,
): FundingTemplateRuntimeFailureCode {
  if (code === 'invalid_request') return 'invalid_request';
  if (code === 'not_found') return 'not_found';
  if (code === 'archived') return 'archived';
  if (code === 'cas_conflict' || code === 'version_conflict' || code === 'already_exists') return 'cas_conflict';
  if (code === 'repository_busy') return 'repository_busy';
  if (code === 'repository_corrupt' || code === 'invalid_package') return 'repository_corrupt';
  if (code === 'sensitive_content') return 'sensitive_content';
  if (code === 'source_unchanged') return 'source_unchanged';
  return 'persist_failed';
}

/** Projects repository identity/version metadata and never source content. */
export function projectFundingTemplateSummary(
  record: FundingTemplateStoredRecord,
): FundingTemplateSummary | null {
  const active = record.versions.find((version) => version.version === record.activeVersion);
  const latest = record.versions[record.versions.length - 1];
  if (!active || !latest) return null;
  const parsed = FundingTemplateSummarySchema.safeParse({
    ownerId: record.ownerId,
    projectId: record.projectId,
    templateId: record.templateId,
    templateRevision: record.revision,
    activeVersion: record.activeVersion,
    activeDigest: active.packageDigest,
    latestVersion: latest.version,
    archivedAt: record.archivedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
  return parsed.success ? parsed.data : null;
}

function projectedLayoutEvidence(
  version: FundingTemplateVersionRecord,
): FundingTemplateVersionView['structure']['layoutEvidence'] {
  const states = [version.template.layout.pageSizePt.state, version.template.layout.marginsPt.state];
  if (states.every((state) => state === 'observed')) return 'observed';
  if (states.every((state) => state === 'not_observed')) return 'not_observed';
  return 'partial';
}

/** Revalidates the package and emits counts/evidence state only. */
export function projectFundingTemplateVersion(
  version: FundingTemplateVersionRecord,
): FundingTemplateVersionView | null {
  const verified = verifyFundingTemplatePackage(version.template);
  if (!verified.ok || !verified.template
    || verified.template.templateVersion !== version.version
    || verified.template.canonicalDigest !== version.packageDigest
    || verified.template.source.sourceDigest !== version.sourceDigest
    || verified.template.source.observationDigest !== version.observationDigest) return null;
  const template = verified.template;
  const parsed = FundingTemplateVersionViewSchema.safeParse({
    templateVersion: version.version,
    packageDigest: version.packageDigest,
    sourceDigest: version.sourceDigest,
    observationDigest: version.observationDigest,
    savedAt: version.savedAt,
    sourceFormat: template.source.sourceFormat,
    pageCount: template.source.pageCount,
    quality: {
      status: template.quality.status,
      overallConfidence: template.quality.overallConfidence,
      issues: [...template.quality.issues],
    },
    structure: {
      sectionCount: template.sections.length,
      instructionCount: template.instructions.length,
      tableCount: template.tables.length,
      contentSlotCount: template.contentSlots.length,
      fieldMappingCount: template.fieldMappings.length,
      typographyRuleCount: template.typography.length,
      layoutEvidence: projectedLayoutEvidence(version),
    },
  });
  return parsed.success ? parsed.data : null;
}

function projectAssertion<T>(assertion: EvidenceAssertion<T>): {
  state: EvidenceAssertion<T>['state'];
  value: T | null;
  confidence: number;
} {
  return {
    state: assertion.state,
    value: assertion.state === 'not_observed' ? null : assertion.value,
    confidence: assertion.state === 'not_observed' ? 0 : assertion.confidence,
  };
}

/**
 * Revalidates a stored package and exposes only its normalized blank-form
 * structure to the Agent runtime. Evidence excerpts, raw source text, paths,
 * bytes, and any excluded applicant content remain unavailable.
 */
export function projectFundingTemplateAgentStructure(
  version: FundingTemplateVersionRecord,
): FundingTemplateAgentStructure | null {
  const verified = verifyFundingTemplatePackage(version.template);
  if (!verified.ok || !verified.template
    || verified.template.templateVersion !== version.version
    || verified.template.canonicalDigest !== version.packageDigest
    || verified.template.source.sourceDigest !== version.sourceDigest
    || verified.template.source.observationDigest !== version.observationDigest) return null;
  const template = verified.template;
  const sectionTitles = new Map(template.sections.map((section) => [section.sectionId, section.normalizedTitle]));
  const mappings = new Map(template.fieldMappings.map((mapping) => [mapping.slotId, mapping]));
  const family = template.source.fundingFamily;
  const familyProjection: FundingTemplateAgentStructure['family'] = family.state === 'not_observed'
    ? {
        code: 'custom',
        displayName: '自定义上传模板 / Custom uploaded template',
        evidenceState: family.state,
        confidence: 0,
      }
    : family.state === 'uncertain'
      ? {
          code: 'needs_review',
          displayName: '模板类型待复核 / Template family needs review',
          evidenceState: family.state,
          confidence: family.confidence,
        }
      : family.value === 'national_social_science_fund'
        ? {
            code: 'nssfc',
            displayName: '国家社会科学基金 / National Social Science Fund',
            evidenceState: family.state,
            confidence: family.confidence,
          }
        : {
            code: 'moe_humanities',
            displayName: '教育部人文社会科学研究项目 / MOE Humanities and Social Sciences',
            evidenceState: family.state,
            confidence: family.confidence,
          };
  const parsed = FundingTemplateAgentStructureSchema.safeParse({
    family: familyProjection,
    sections: template.sections.map((section) => ({
      title: section.normalizedTitle,
      level: section.level,
      order: section.order,
      required: section.required.state === 'not_observed' ? null : section.required.value,
      confidence: section.confidence,
    })),
    instructions: template.instructions.map((instruction) => ({
      sectionTitle: instruction.sectionId === null ? null : sectionTitles.get(instruction.sectionId) ?? null,
      kind: instruction.kind,
      text: instruction.normalizedText,
      maxLength: instruction.maxLength,
      confidence: instruction.confidence,
    })),
    fields: template.contentSlots.map((slot) => ({
      sectionTitle: slot.sectionId === null ? null : sectionTitles.get(slot.sectionId) ?? null,
      label: slot.normalizedLabel,
      canonicalField: mappings.get(slot.slotId)?.canonicalField ?? 'custom',
      kind: slot.kind,
      required: slot.required.state === 'not_observed' ? null : slot.required.value,
      maxLength: slot.maxLength === null
        ? null
        : { value: slot.maxLength.value, unit: slot.maxLength.unit },
    })),
    tables: template.tables.map((table) => ({
      sectionTitle: table.sectionId === null ? null : sectionTitles.get(table.sectionId) ?? null,
      rowCount: table.rowCount,
      columnCount: table.columnCount,
      headers: table.headers.map((header) => ({
        columnIndex: header.columnIndex,
        label: header.normalizedLabel,
      })),
    })),
    layout: {
      pageSizePt: projectAssertion(template.layout.pageSizePt),
      marginsPt: projectAssertion(template.layout.marginsPt),
      typography: template.typography.map((rule) => ({
        scope: rule.scope,
        fontFamily: projectAssertion(rule.fontFamily),
        fontSizePt: projectAssertion(rule.fontSizePt),
        fontWeight: projectAssertion(rule.fontWeight),
        alignment: projectAssertion(rule.alignment),
        lineSpacingPt: projectAssertion(rule.lineSpacingPt),
        paragraphBeforePt: projectAssertion(rule.paragraphBeforePt),
        paragraphAfterPt: projectAssertion(rule.paragraphAfterPt),
      })),
    },
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Recomputes the adjacent diff from verified immutable packages, requires it
 * to equal the stored diff, and hashes internal entity keys before projection.
 */
export function projectFundingTemplateDiff(
  record: FundingTemplateStoredRecord,
  fromVersion: number,
  toVersion: number,
): FundingTemplateDiffView | null {
  if (toVersion !== fromVersion + 1) return null;
  const previous = record.versions.find((version) => version.version === fromVersion);
  const next = record.versions.find((version) => version.version === toVersion);
  if (!previous || !next || next.diffFromPrevious === null
    || projectFundingTemplateVersion(previous) === null
    || projectFundingTemplateVersion(next) === null) return null;
  let recomputed;
  try {
    recomputed = diffFundingTemplatePackages(previous.template, next.template);
  } catch {
    return null;
  }
  if (canonicalizeFundingTemplateValue(recomputed)
    !== canonicalizeFundingTemplateValue(next.diffFromPrevious)) return null;
  const parsed = FundingTemplateDiffViewSchema.safeParse({
    schemaVersion: 1,
    templateId: recomputed.templateId,
    fromVersion: recomputed.fromVersion,
    toVersion: recomputed.toVersion,
    fromDigest: recomputed.fromDigest,
    toDigest: recomputed.toDigest,
    changes: recomputed.changes.map((change) => ({
      kind: change.kind,
      entity: change.entity,
      entityKeyDigest: sha256(change.key),
      beforeDigest: change.beforeDigest,
      afterDigest: change.afterDigest,
    })),
    breaking: recomputed.breaking,
    diffDigest: recomputed.diffDigest,
  });
  return parsed.success ? parsed.data : null;
}
