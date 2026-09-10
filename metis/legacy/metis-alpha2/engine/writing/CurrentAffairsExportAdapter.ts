import type { CurrentAffairsManifest } from './CurrentAffairsProfile.js';
import type { CurrentAffairsWorkflowState } from './CurrentAffairsWorkflow.js';
import type { ResearchExportRecord, ResearchExportField } from '../export/ResearchExportBuilder.js';
import { runCurrentAffairsGates, prepareCurrentAffairsGateInput } from './ExportGate.js';
import { createHash } from 'node:crypto';

function field(key: string, value: string): ResearchExportField {
  return { key, value, sensitivity: 'none' as const };
}

function caRecord(id: string, title: string, content: string, fields: ResearchExportField[]): ResearchExportRecord {
  return { id, title, content, sensitivity: 'none' as const, fields, images: [] };
}

export interface ExportPreview {
  title: string;
  summary: string;
  sections: ExportSection[];
  sourceCount: number;
  factCount: number;
  timestamp: number;
  exportReady: boolean;
}

export interface ExportSection {
  heading: string;
  content: string;
}

/**
 * Convert a CurrentAffairsManifest + WorkflowState into real ResearchExportRecords
 * for the production ResearchExportBuilder chain. This replaces the old
 * string-concatenation-only buildExportPreview with structured records that
 * pass through ExportGate fail-closed validation.
 */
export function buildExportRecords(
  manifest: CurrentAffairsManifest,
  state: CurrentAffairsWorkflowState,
): ResearchExportRecord[] {
  const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const now = Date.now();
  const records: ResearchExportRecord[] = [];

  // Project-scope
  records.push(caRecord(
    `ca_project_${manifest.profileId}`,
    manifest.title,
    manifest.title,
    [
      field('artifactKind', 'current_affairs_report'),
      field('profileId', manifest.profileId),
      field('contentDigest', digest),
      field('sourceCount', String(manifest.sources.length)),
      field('factCount', String(manifest.facts?.length ?? 0)),
      field('exportReady', String(state.exportReady)),
      field('createdAt', String(manifest.createdAt)),
      field('updatedAt', String(manifest.updatedAt)),
    ],
  ));

  // Source-scope
  for (const source of manifest.sources) {
    const verified = state.verifiedSourceIds.includes(source.sourceId);
    records.push(caRecord(
      `ca_src_${source.sourceId}`,
      source.title,
      `${verified ? '✓' : '✗'} ${source.title} (${source.kind})${source.correctionState !== 'clean' ? ` [${source.correctionState}]` : ''}`,
      [
        field('sourceId', source.sourceId),
        field('kind', source.kind),
        field('title', source.title),
        field('authors', source.authors.join('; ')),
        field('verified', String(verified)),
        field('correctionState', source.correctionState),
        field('publishedAt', String(source.publishedAt ?? '')),
        field('fetchedAt', String(source.fetchedAt)),
        field('url', source.url ?? ''),
        field('contentDigest', source.contentDigest ?? ''),
      ],
    ));
  }

  // Fact-scope
  if (manifest.facts) {
    for (const fact of manifest.facts) {
      records.push(caRecord(
        `ca_fact_${fact.claimId}`,
        fact.statement.slice(0, 100),
        fact.statement,
        [
          field('claimId', fact.claimId),
          field('statement', fact.statement),
          field('evidenceSourceIds', fact.evidenceSourceIds.join('; ')),
          field('verifiedAt', String(fact.verifiedAt ?? now)),
          field('verificationMethod', fact.verificationMethod ?? ''),
        ],
      ));
    }
  }

  // Stance-scope
  if (manifest.stances) {
    for (const stance of manifest.stances) {
      records.push(caRecord(
        `ca_stance_${stance.claimId}`,
        `Stance: ${stance.stance}`,
        `[${stance.stance}] ${stance.rationale}`,
        [
          field('claimId', stance.claimId),
          field('stance', stance.stance),
          field('rationale', stance.rationale),
          field('sourceId', stance.sourceId),
        ],
      ));
    }
  }

  // Interpretation-scope
  if (manifest.interpretations) {
    for (const interp of manifest.interpretations) {
      records.push(caRecord(
        `ca_interp_${interp.claimId}`,
        `Interpretation: ${interp.claimId}`,
        interp.interpretation,
        [
          field('claimId', interp.claimId),
          field('interpretation', interp.interpretation),
          field('synthesizesClaimIds', interp.synthesizesClaimIds.join('; ')),
          field('authorId', interp.authorId),
        ],
      ));
    }
  }

  // Temporal gate record
  records.push(caRecord(
    `ca_temporal_${manifest.profileId}`,
    'Temporal Check',
    state.temporalCheckPassed ? '✓ 时间一致性检查通过' : '✗ 时间一致性检查未通过',
    [
      field('temporalCheckPassed', String(state.temporalCheckPassed)),
      field('correctionReviewComplete', String(state.correctionReviewComplete)),
      field('approved', String(state.approved)),
      field('rejectedSourceIds', state.rejectedSourceIds.join('; ')),
      field('errors', state.errors.join('; ')),
    ],
  ));

  return records;
}

export function buildExportPreview(
  manifest: CurrentAffairsManifest,
  state: CurrentAffairsWorkflowState,
): ExportPreview {
  const sections: ExportSection[] = [];

  sections.push({ heading: '一、研究概述', content: manifest.title });

  sections.push({
    heading: '二、来源核验',
    content: manifest.sources
      .map((s) => {
        const verified = state.verifiedSourceIds.includes(s.sourceId) ? '✓' : '✗';
        const retracted = s.correctionState !== 'clean' ? ` [${s.correctionState}]` : '';
        return `${verified} ${s.title} (${s.kind})${retracted}`;
      })
      .join('\n'),
  });

  if (manifest.facts && manifest.facts.length > 0) {
    sections.push({
      heading: '三、事实陈述',
      content: manifest.facts.map((f) => `- ${f.statement}`).join('\n'),
    });
  }

  if (manifest.stances && manifest.stances.length > 0) {
    sections.push({
      heading: '四、立场分析',
      content: manifest.stances
        .map((s) => `[${s.stance}] ${s.rationale}`)
        .join('\n'),
    });
  }

  if (manifest.interpretations && manifest.interpretations.length > 0) {
    sections.push({
      heading: '五、综合解读',
      content: manifest.interpretations.map((i) => i.interpretation).join('\n\n'),
    });
  }

  const temporalNote = state.temporalCheckPassed
    ? '✓ 时间一致性检查通过'
    : '✗ 时间一致性检查未通过（包含过期/未来/撤回来源）';

  sections.push({ heading: '六、时间一致性', content: temporalNote });

  if (state.rejectedSourceIds.length > 0) {
    sections.push({
      heading: '七、未通过来源',
      content: state.rejectedSourceIds.join(', '),
    });
  }

  if (state.errors.length > 0) {
    sections.push({
      heading: '八、审查警告',
      content: state.errors.join('\n'),
    });
  }

  return {
    title: manifest.title,
    summary: `时政研究报告：${manifest.sources.length}个来源，${manifest.facts?.length ?? 0}项事实`,
    sections,
    sourceCount: manifest.sources.length,
    factCount: manifest.facts?.length ?? 0,
    timestamp: Date.now(),
    exportReady: state.exportReady,
  };
}

export function invalidatePreviewAfterCorrection(
  manifest: CurrentAffairsManifest,
): boolean {
  return manifest.sources.some((s) => s.correctionState !== 'clean');
}

export function bindDigestToPreview(preview: ExportPreview, contentDigest: string): ExportPreview & { contentDigest: string } {
  return { ...preview, contentDigest };
}

// ── Production export bridge ──────────────────────────────────────

export interface CurrentAffairsExportResult {
  ok: boolean;
  exportReady: boolean;
  gateResult: { passed: boolean; issues: Array<{ gate: string; severity: 'warning' | 'error'; message: string }> };
  preview: ExportPreview;
  records: ResearchExportRecord[];
  contentDigest: string;
  workflowErrors: string[];
}

/**
 * Real production export chain for current affairs reports.
 * Accepts a pre-computed WorkflowState (caller is responsible for
 * running the service workflow beforehand). This function only runs
 * gates / records / preview — it does NOT re-execute the workflow.
 *
 * Production callers (RuntimeService.export) pass ctx.state after
 * approval; tests pass state from service.executeWorkflow().
 */
export function executeCurrentAffairsExport(
  manifest: CurrentAffairsManifest,
  state: import('./CurrentAffairsWorkflow.js').CurrentAffairsWorkflowState,
  repository?: import('./CurrentAffairsRepositoryService.js').CurrentAffairsRepositoryService,
): CurrentAffairsExportResult {
  const errors = state.errors ?? [];

  // Repository-backed source truth verification (fail-closed)
  const repoIssues: Array<{ gate: string; severity: 'warning' | 'error'; message: string }> = [];
  if (repository) {
    const repoResults = repository.verifyManifest(manifest);
    for (const r of repoResults) {
      if (!r.verified) {
        const reason = r.deleted ? 'source is deleted'
          : !r.correctionMatches ? `correction mismatch: manifest=${manifest.sources.find(s => s.sourceId === r.sourceId)?.correctionState}, repo=${r.correctionState}`
          : !r.exists ? 'source not found in repository'
          : r.reason ?? 'verification failed';
        repoIssues.push({ gate: 'ca_repository', severity: 'error', message: `Source ${r.sourceId}: ${reason}` });
      }
    }
  }

  // Gate the export through real fail-closed gates
  const gateInput = prepareCurrentAffairsGateInput(manifest, state);
  const gateResult = runCurrentAffairsGates(gateInput);

  // Merge repository issues into gate result (fail-closed)
  const allIssues = [...gateResult.issues, ...repoIssues];
  const passed = gateResult.passed && repoIssues.length === 0;

  // Build real structured records for the export builder chain
  const records = buildExportRecords(manifest, state);

  // Build human-readable preview
  const preview = buildExportPreview(manifest, state);

  // Content digest for version binding
  const contentDigest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');

  return {
    ok: passed && state.exportReady && errors.length === 0,
    exportReady: state.exportReady,
    gateResult: { passed, issues: allIssues },
    preview,
    records,
    contentDigest,
    workflowErrors: errors,
  };
}
