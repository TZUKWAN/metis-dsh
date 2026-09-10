/**
 * Fail-closed export truth gates.
 *
 * Citation-bearing syntax is parsed into a structured AST. Every citation used by
 * project/artifact prose must resolve to a citation-scope record carrying a fresh
 * truth attestation. Numeric/data claims require an explicit evidence binding, and
 * figure/table references require a matching artifact field or image caption.
 */

import type { ExportScope } from '../runtime/ExportRuntimeContract.js';
import type { ResearchExportRecord } from '../export/ResearchExportBuilder.js';
import {
  CitationTruthAttestationSchema,
  isTrustedCitationAttestation,
  parseCitationAst,
  type CitationAstNode,
  type CitationTruthAttestation,
} from './CitationTruth.js';
import {
  DeliverableProfileBindingSchema,
  getDeliverableProfile,
} from './DeliverableProfile.js';

export type GateSeverity = 'warning' | 'error';

export interface GateIssue {
  gate: string;
  severity: GateSeverity;
  message: string;
  scope?: ExportScope;
}

export interface GateResult {
  passed: boolean;
  issues: GateIssue[];
}

const NARRATIVE_SCOPES: readonly ExportScope[] = ['project', 'artifact'];
const LEGACY_CITATION_REF = /\[(?:cite|ref|citation)[:\s]+([A-Za-z0-9_\-:.]+)\]/giu;
const EVIDENCE_REF = /\[evidence:([A-Za-z0-9_\-:.]+)\]/giu;
const FIGURE_REF = /\b(?:Fig(?:ure|\.)\s*\d+|Table\s*\d+)\b|(?:图|表)\s*\d+/giu;
const NUMERIC_CLAIM = /(?<![A-Z0-9])\d+(?:\.\d+)?\s*(?:%|percent|倍|times|fold)(?=$|[^A-Z0-9])/giu;
const DATA_KEYWORD = /\b(?:dataset|corpus|sample size|n\s*=|participants)\b|数据集|语料库|样本量/giu;

function normalized(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/doi\.org\//u, '')
    .replace(/^doi\s*:\s*/u, '')
    .replace(/[.,;:]$/u, '')
    .replace(/[“”"'‘’()[\]{}]/gu, '')
    .replace(/\s+/gu, ' ');
}

function fields(record: ResearchExportRecord): Map<string, string> {
  return new Map(record.fields.map((field) => [field.key, field.value]));
}

function parseAttestation(record: ResearchExportRecord): CitationTruthAttestation | null {
  const values = fields(record);
  const identifier = values.get('identifier') ?? '';
  const citationKeys = (values.get('citationKeys') ?? record.id)
    .split(';')
    .map((key) => key.trim())
    .filter(Boolean);
  const candidate = {
    sourceId: record.id,
    citationKeys,
    identifierType: values.get('identifierType'),
    identifier,
    locator: values.get('locator') ?? '',
    triangulation: values.get('triangulation'),
    passport: values.get('passport'),
    retraction: values.get('retraction'),
    journalIntegrity: values.get('journalIntegrity'),
    checkedAt: Number(values.get('checkedAt')),
  };
  const parsed = CitationTruthAttestationSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function bibliographyKey(record: ResearchExportRecord): string {
  const values = fields(record);
  return normalized(values.get('bibliographyKey') ?? record.id);
}

function familyName(author: string): string {
  const trimmed = author.trim();
  if (trimmed.includes(',')) return normalized(trimmed.split(',', 1)[0] ?? '');
  const parts = trimmed.split(/\s+/u).filter(Boolean);
  return normalized(parts.length > 1 ? parts.at(-1) ?? '' : trimmed);
}

function derivedAuthorYearKey(record: ResearchExportRecord): string | null {
  const values = fields(record);
  const authors = (values.get('authors') ?? '').split(';').map(familyName).filter(Boolean);
  const year = values.get('year')?.trim();
  if (authors.length === 0 || !year) return null;
  const label = authors.length === 1
    ? authors[0]!
    : authors.length === 2
      ? `${authors[0]} & ${authors[1]}`
      : `${authors[0]} et al.`;
  return normalized(`${label}, ${year}`);
}

function nodeResolvesRecord(node: CitationAstNode, record: ResearchExportRecord): boolean {
  const values = fields(record);
  if (node.kind === 'doi') {
    return values.get('identifierType') === 'doi'
      && Boolean(node.doi)
      && normalized(node.doi ?? '') === normalized(values.get('identifier') ?? '');
  }
  if (node.kind === 'author_year') {
    const expected = derivedAuthorYearKey(record);
    return expected !== null && node.keys.some((key) => normalized(key) === expected);
  }
  if (node.kind === 'numeric') {
    const index = normalized(values.get('bibliographyIndex') ?? '');
    return index !== '' && node.keys.some((key) => normalized(key) === index);
  }
  const expected = bibliographyKey(record);
  return expected !== '' && node.keys.some((key) => normalized(key) === expected);
}

function pushError(issues: GateIssue[], gate: string, message: string, scope?: ExportScope): void {
  issues.push({ gate, severity: 'error', message, ...(scope ? { scope } : {}) });
}

function evidenceRefsIn(text: string): string[] {
  const refs: string[] = [];
  EVIDENCE_REF.lastIndex = 0;
  for (let match = EVIDENCE_REF.exec(text); match; match = EVIDENCE_REF.exec(text)) {
    if (match[1]) refs.push(match[1]);
  }
  EVIDENCE_REF.lastIndex = 0;
  return refs;
}

function evidenceRefsAfterClaim(
  text: string,
  claim: RegExpMatchArray,
  nextClaim: RegExpMatchArray | undefined,
): string[] {
  const claimStart = claim.index ?? 0;
  const afterClaim = claimStart + claim[0].length;
  const sentenceRemainder = text.slice(afterClaim);
  const sentenceBoundary = sentenceRemainder.search(/[.!?;。！？；\n]/u);
  const sentenceEnd = sentenceBoundary < 0 ? text.length : afterClaim + sentenceBoundary;
  const nextStart = nextClaim?.index ?? text.length;
  return evidenceRefsIn(text.slice(afterClaim, Math.min(sentenceEnd, nextStart)));
}

function canonicalFigureId(value: string): string | null {
  const match = value.trim().match(/^(figure|fig\.?|table|图|表)\s*(\d+)$/iu);
  if (!match?.[1] || !match[2]) return null;
  const kind = /^(?:figure|fig\.?)$/iu.test(match[1]) || match[1] === '图' ? 'figure' : 'table';
  return `${kind}:${Number(match[2])}`;
}

function validateCitationTruth(
  node: CitationAstNode,
  citationRecords: readonly ResearchExportRecord[],
  issues: GateIssue[],
  scope: ExportScope,
): void {
  const candidates = citationRecords.filter((record) => nodeResolvesRecord(node, record));
  if (candidates.length === 0) {
    pushError(issues, 'citation', `Unresolved ${node.kind} citation: ${node.raw}`, scope);
    return;
  }
  if (candidates.length > 1) {
    pushError(issues, 'citation', `Ambiguous ${node.kind} citation resolves to multiple sources: ${node.raw}`, scope);
    return;
  }
  const attestation = parseAttestation(candidates[0]!);
  if (!attestation) {
    pushError(issues, 'citation_truth', `Citation ${node.raw} has no valid truth attestation.`, scope);
    return;
  }
  const truth = isTrustedCitationAttestation(attestation);
  if (!truth.ok) {
    pushError(
      issues,
      'citation_truth',
      `Citation ${node.raw} is not release-trusted: ${truth.reasons.join(', ')}`,
      scope,
    );
  }
}

function validateLegacyCitation(
  refId: string,
  citationRecords: readonly ResearchExportRecord[],
  issues: GateIssue[],
  scope: ExportScope,
): void {
  const record = citationRecords.find((candidate) => normalized(candidate.id) === normalized(refId));
  if (!record) {
    pushError(issues, 'citation', `Citation reference "${refId}" is unresolved.`, scope);
    return;
  }
  const attestation = parseAttestation(record);
  const truth = attestation ? isTrustedCitationAttestation(attestation) : { ok: false, reasons: ['invalid_attestation'] };
  if (!truth.ok) {
    pushError(issues, 'citation_truth', `Citation reference "${refId}" is not release-trusted: ${truth.reasons.join(', ')}`, scope);
  }
}

export function runExportGates(
  records: ReadonlyMap<ExportScope, ResearchExportRecord[]>,
  privacyProfile: string,
  containsSensitiveFields: boolean,
): GateResult {
  const issues: GateIssue[] = [];
  const citationRecords = records.get('citations') ?? [];
  const evidenceIds = new Set((records.get('evidence') ?? []).map((record) => record.id));
  const artifactRecords = records.get('artifact') ?? [];

  for (const artifact of artifactRecords) {
    const artifactFields = fields(artifact);
    if (artifactFields.get('reviewStatus') !== 'verified') {
      pushError(issues, 'artifact_trust', `Artifact "${artifact.id}" is not verified and cannot be exported.`, 'artifact');
      continue;
    }
    const binding = DeliverableProfileBindingSchema.safeParse({
      id: artifactFields.get('deliverableProfileId'),
      schemaVersion: Number(artifactFields.get('deliverableProfileSchemaVersion')),
      profileVersion: artifactFields.get('deliverableProfileVersion'),
    });
    const profile = binding.success ? getDeliverableProfile(binding.data.id) : undefined;
    if (
      !binding.success
      || !profile
      || profile.schemaVersion !== binding.data.schemaVersion
      || profile.profileVersion !== binding.data.profileVersion
    ) {
      pushError(issues, 'artifact_trust', `Artifact "${artifact.id}" has no current deliverable profile binding.`, 'artifact');
    }
  }

  for (const scope of NARRATIVE_SCOPES) {
    for (const record of records.get(scope) ?? []) {
      const citationAst = parseCitationAst(record.content);
      for (const node of citationAst) validateCitationTruth(node, citationRecords, issues, scope);

      LEGACY_CITATION_REF.lastIndex = 0;
      for (let match = LEGACY_CITATION_REF.exec(record.content); match; match = LEGACY_CITATION_REF.exec(record.content)) {
        if (match[1]) validateLegacyCitation(match[1], citationRecords, issues, scope);
      }
      LEGACY_CITATION_REF.lastIndex = 0;

      const evidenceRefs = new Set(evidenceRefsIn(record.content));
      for (const evidenceId of evidenceRefs) {
        if (!evidenceIds.has(evidenceId)) {
          pushError(issues, 'evidence', `Evidence reference "${evidenceId}" is unresolved.`, scope);
        }
      }

      NUMERIC_CLAIM.lastIndex = 0;
      const numericClaims = [...record.content.matchAll(NUMERIC_CLAIM)];
      NUMERIC_CLAIM.lastIndex = 0;
      for (let index = 0; index < numericClaims.length; index += 1) {
        const claim = numericClaims[index]!;
        const bound = evidenceRefsAfterClaim(record.content, claim, numericClaims[index + 1]);
        if (bound.length === 0 || bound.some((evidenceId) => !evidenceIds.has(evidenceId))) {
          pushError(issues, 'number', `Numeric claim "${claim[0]}" lacks a same-claim evidence binding.`, scope);
        }
      }

      DATA_KEYWORD.lastIndex = 0;
      const dataClaims = [...record.content.matchAll(DATA_KEYWORD)];
      DATA_KEYWORD.lastIndex = 0;
      for (let index = 0; index < dataClaims.length; index += 1) {
        const claim = dataClaims[index]!;
        const bound = evidenceRefsAfterClaim(record.content, claim, dataClaims[index + 1]);
        if (bound.length === 0 || bound.some((evidenceId) => !evidenceIds.has(evidenceId))) {
          pushError(issues, 'data', `Data claim "${claim[0]}" lacks a same-claim evidence binding.`, scope);
        }
      }

      FIGURE_REF.lastIndex = 0;
      const figureRefs = [...record.content.matchAll(FIGURE_REF)]
        .map((match) => canonicalFigureId(match[0]))
        .filter((value): value is string => value !== null);
      FIGURE_REF.lastIndex = 0;
      for (const figureRef of figureRefs) {
        const matched = artifactRecords.some((artifact) => (
          artifact.images.some((image) => (
            image.ordinal === undefined
              ? canonicalFigureId(image.caption) === figureRef
              : `figure:${image.ordinal + 1}` === figureRef
          ))
          || artifact.fields.some((field) => (
            /^(?:figureId|tableId|figureRef)$/u.test(field.key)
            && canonicalFigureId(field.value) === figureRef
          ))
        ));
        if (!matched) pushError(issues, 'figure', `Figure/table reference "${figureRef}" has no matching artifact entry.`, scope);
      }
    }
  }

  const auditRecords = records.get('audit') ?? [];
  if (auditRecords.length > 0 && evidenceIds.size === 0) {
    issues.push({
      gate: 'evidence',
      severity: 'warning',
      message: 'Audit records exist but no evidence records are present.',
    });
  }

  if (containsSensitiveFields && privacyProfile !== 'private-local') {
    pushError(issues, 'privacy', 'Residual sensitive fields detected after redaction with a non-local privacy profile. Export blocked.');
  }

  return { passed: !issues.some((issue) => issue.severity === 'error'), issues };
}

// ── Current Affairs export gates ──────────────────────────────────

export interface CurrentAffairsGateInput {
  sourceIds: string[];
  verifiedSourceIds: string[];
  correctionStates: Map<string, string>;
  temporalCheckPassed: boolean;
  correctionReviewComplete: boolean;
  approved: boolean;
  factCount: number;
  factEvidenceBindings: Map<string, string[]>;
}

export function runCurrentAffairsGates(input: CurrentAffairsGateInput): GateResult {
  const issues: GateIssue[] = [];

  // Gate 1: All sources must be verified
  for (const sourceId of input.sourceIds) {
    if (!input.verifiedSourceIds.includes(sourceId)) {
      pushError(issues, 'ca_source_verification', `Source "${sourceId}" is not verified.`, 'artifact');
    }
  }

  // Gate 2: No retracted or correction-pending sources in export
  for (const [sourceId, state] of input.correctionStates) {
    if (state === 'retracted') {
      pushError(issues, 'ca_source_retracted', `Source "${sourceId}" is retracted and must not be exported.`, 'artifact');
    }
    if (state === 'correction_pending') {
      pushError(issues, 'ca_source_correction', `Source "${sourceId}" has a pending correction. Export blocked until resolved.`, 'artifact');
    }
  }

  // Gate 3: Temporal validity must pass
  if (!input.temporalCheckPassed) {
    pushError(issues, 'ca_temporal', 'Temporal validity check failed. Sources may be expired or future-dated.', 'artifact');
  }

  // Gate 4: Correction review must be complete
  if (!input.correctionReviewComplete) {
    pushError(issues, 'ca_correction_review', 'Correction review is not complete. All source corrections must be reviewed.', 'artifact');
  }

  // Gate 5: Approval required for export
  if (!input.approved) {
    pushError(issues, 'ca_approval', 'Current affairs report is not approved for export.', 'artifact');
  }

  // Gate 6: Every fact must have at least one verified evidence source
  for (const [claimId, evidenceIds] of input.factEvidenceBindings) {
    const hasVerified = evidenceIds.some((eid) => input.verifiedSourceIds.includes(eid));
    if (!hasVerified) {
      pushError(issues, 'ca_fact_evidence', `Fact "${claimId}" lacks verified evidence binding.`, 'artifact');
    }
  }

  // Gate 7: Minimum sources required
  if (input.sourceIds.length < 1) {
    pushError(issues, 'ca_min_sources', 'Current affairs report requires at least one source.', 'artifact');
  }

  return { passed: !issues.some((issue) => issue.severity === 'error'), issues };
}

/**
 * Build CurrentAffairsGateInput from a manifest and workflow state.
 * This is the production bridge from the CurrentAffairs domain to the
 * ExportGate validation chain.
 */
export function prepareCurrentAffairsGateInput(
  manifest: import('./CurrentAffairsProfile.js').CurrentAffairsManifest,
  state: import('./CurrentAffairsWorkflow.js').CurrentAffairsWorkflowState,
): CurrentAffairsGateInput {
  const correctionStates = new Map<string, string>();
  for (const source of manifest.sources) {
    correctionStates.set(source.sourceId, source.correctionState);
  }

  const factEvidenceBindings = new Map<string, string[]>();
  for (const fact of manifest.facts ?? []) {
    factEvidenceBindings.set(fact.claimId, fact.evidenceSourceIds);
  }

  return {
    sourceIds: manifest.sources.map((s) => s.sourceId),
    verifiedSourceIds: state.verifiedSourceIds,
    correctionStates,
    temporalCheckPassed: state.temporalCheckPassed,
    correctionReviewComplete: state.correctionReviewComplete,
    approved: state.approved,
    factCount: manifest.facts?.length ?? 0,
    factEvidenceBindings,
  };
}
