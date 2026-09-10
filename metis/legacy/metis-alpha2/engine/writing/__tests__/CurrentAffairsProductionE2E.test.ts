import { describe, it, expect } from 'vitest';
import { CurrentAffairsManifestSchema, type CurrentAffairsSourceRecord } from '../CurrentAffairsProfile.js';
import { CurrentAffairsService } from '../CurrentAffairsService.js';
import {
  buildExportRecords,
  executeCurrentAffairsExport,
} from '../CurrentAffairsExportAdapter.js';

const NOW = 1750000000000;

function makeManifest(overrides: Record<string, unknown> = {}) {
  return CurrentAffairsManifestSchema.parse({
    schemaVersion: 1 as const, projectId: 'proj-red', workflowId: 'wf-red', manifestVersion: 1, profileId: 'prod-e2e', title: '生产链E2E时政报告',
    timeWindow: { fetchedAt: NOW, timeSensitive: true, maxSourceAgeDays: 180, applicabilityStart: NOW-90*86400000, applicabilityEnd: NOW+90*86400000 },
    sources: [
      { sourceId: 's1', kind: 'policy_document' as const, title: '政策文件', authors: ['部委A'], publishedAt: NOW-60*86400000, fetchedAt: NOW, url: 'https://gov.cn/a', correctionState: 'clean' as const },
      { sourceId: 's2', kind: 'official_statistics' as const, title: '统计数据', authors: ['统计局'], publishedAt: NOW-15*86400000, fetchedAt: NOW, url: 'https://stats.gov.cn/b', correctionState: 'clean' as const },
    ],
    facts: [{ claimId: 'c1', statement: '经济增速6.5%', evidenceSourceIds: ['s2'], verifiedAt: NOW }],
    stances: [{ claimId: 'st1', stance: 'supports' as const, rationale: '数据可靠', sourceId: 's2', annotatedAt: NOW }],
    interpretations: [{ claimId: 'c1', interpretation: '经济持续向好', synthesizesClaimIds: ['c1'], authorId: 'a1', authoredAt: NOW }],
    createdAt: NOW, updatedAt: NOW,
    ...overrides,
  });
}

describe('CurrentAffairs production E2E chain', () => {
  it('FIXED: direct export without approval fails (Service no longer auto-approves)', () => {
    const manifest = makeManifest();
    const service = new CurrentAffairsService({ now: () => NOW });
    const { state } = service.executeWorkflow(manifest);
    const result = executeCurrentAffairsExport(manifest, state);

    // Service stops at approval phase — requires Runtime approve+markApproved
    expect(result.ok).toBe(false);
    expect(result.exportReady).toBe(false);
  });

  it('real export chain: service workflow produces valid records and preview (pre-approval)', () => {
    const manifest = makeManifest();
    const service = new CurrentAffairsService({ now: () => NOW });
    const { state } = service.executeWorkflow(manifest);

    // Workflow reaches approval phase
    expect(state.phase).toBe('approval');
    expect(state.approved).toBe(false);
    expect(state.exportReady).toBe(false);

    // Records and preview are computable from state
    const records = buildExportRecords(manifest, state);
    expect(records.length).toBeGreaterThanOrEqual(7);
    const projectRecord = records.find((r) => r.id.startsWith('ca_project_'));
    expect(projectRecord).toBeDefined();
    const kindField = projectRecord!.fields.find((f) => f.key === 'artifactKind');
    expect(kindField!.value).toBe('current_affairs_report');
  });

  it('real gates: retracted source blocks export chain', () => {
    const manifest = makeManifest();
    (manifest.sources[0] as CurrentAffairsSourceRecord).correctionState = 'retracted';
    const service = new CurrentAffairsService({ now: () => NOW });
    const { state } = service.executeWorkflow(manifest);
    const result = executeCurrentAffairsExport(manifest, state);

    // Export must be blocked
    expect(result.ok).toBe(false);
    expect(result.exportReady).toBe(false);
    expect(result.gateResult.passed).toBe(false);
    expect(result.gateResult.issues.some((i) => i.gate === 'ca_source_retracted')).toBe(true);
  });

  it('real gates: correction_pending source blocks export chain', () => {
    const manifest = makeManifest();
    (manifest.sources[1] as CurrentAffairsSourceRecord).correctionState = 'correction_pending';
    const service = new CurrentAffairsService({ now: () => NOW });
    const { state } = service.executeWorkflow(manifest);
    const result = executeCurrentAffairsExport(manifest, state);

    expect(result.ok).toBe(false);
    expect(result.gateResult.passed).toBe(false);
    expect(result.gateResult.issues.some((i) => i.gate === 'ca_source_correction')).toBe(true);
  });

  it('real gates: temporal expiry blocks export', () => {
    const manifest = makeManifest();
    const expiredNow = NOW + 200 * 86400000;
    const service = new CurrentAffairsService({ now: () => expiredNow });
    const { state } = service.executeWorkflow(manifest);
    const result = executeCurrentAffairsExport(manifest, state);

    expect(result.ok).toBe(false);
    expect(result.gateResult.passed).toBe(false);
    expect(result.gateResult.issues.some((i) => i.gate === 'ca_temporal')).toBe(true);
  });

  it('real gates: unverified source blocks export', () => {
    const manifest = makeManifest();
    // Source with future date won't pass verification
    manifest.sources.push({
      sourceId: 's3', kind: 'authoritative_news' as const, title: '未来新闻',
      authors: ['记者'], publishedAt: NOW + 365 * 86400000, fetchedAt: NOW,
      correctionState: 'clean' as const,
    });
    const service = new CurrentAffairsService({ now: () => NOW });
    const { state } = service.executeWorkflow(manifest);
    const result = executeCurrentAffairsExport(manifest, state);

    expect(result.ok).toBe(false);
    expect(result.gateResult.issues.some((i) => i.gate === 'ca_source_verification')).toBe(true);
  });

  it('real records: content digest binding is immutable', () => {
    const manifest = makeManifest();
    const service = new CurrentAffairsService({ now: () => NOW });
    const { state } = service.executeWorkflow(manifest);
    const result = executeCurrentAffairsExport(manifest, state);

    const digest1 = result.contentDigest;
    // Modify manifest after export
    const mutManifest = makeManifest({ title: 'Different Title' });
    const { state: state2 } = service.executeWorkflow(mutManifest);
    const result2 = executeCurrentAffairsExport(mutManifest, state2);
    expect(result2.contentDigest).not.toBe(digest1);
  });

  it('real records: buildExportRecords produces structured fields for all layers', () => {
    const manifest = makeManifest();
    const service = new CurrentAffairsService({ now: () => NOW });
    const { state } = service.executeWorkflow(manifest);
    const records = buildExportRecords(manifest, state);

    // Verify each layer produces records
    expect(records.some((r) => r.id.startsWith('ca_project_'))).toBe(true);
    expect(records.some((r) => r.id.startsWith('ca_src_'))).toBe(true);
    expect(records.some((r) => r.id.startsWith('ca_fact_'))).toBe(true);
    expect(records.some((r) => r.id.startsWith('ca_stance_'))).toBe(true);
    expect(records.some((r) => r.id.startsWith('ca_interp_'))).toBe(true);
    expect(records.some((r) => r.id.startsWith('ca_temporal_'))).toBe(true);
  });
});
