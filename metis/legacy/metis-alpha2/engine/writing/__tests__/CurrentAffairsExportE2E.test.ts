import { describe, it, expect } from 'vitest';
import type { CurrentAffairsSourceRecord } from '../CurrentAffairsProfile.js';
import { CurrentAffairsManifestSchema } from '../CurrentAffairsProfile.js';
import { CurrentAffairsService } from '../CurrentAffairsService.js';
import { buildExportPreview, invalidatePreviewAfterCorrection, bindDigestToPreview } from '../CurrentAffairsExportAdapter.js';

const NOW = 1750000000000;

function makeManifest() {
  return CurrentAffairsManifestSchema.parse({
    schemaVersion: 1 as const,
    projectId: 'proj-export',
    workflowId: 'wf-export',
    manifestVersion: 1,
    profileId: 'ca-export-test',
    title: '出口测试时政分析',
    timeWindow: { fetchedAt: NOW, timeSensitive: true, maxSourceAgeDays: 180, applicabilityStart: NOW - 90*86400000, applicabilityEnd: NOW + 90*86400000 },
    sources: [
      { sourceId: 's1', kind: 'policy_document' as const, title: '政策文件', authors: ['部委A'], publishedAt: NOW - 60*86400000, fetchedAt: NOW, url: 'https://gov.cn/p1', correctionState: 'clean' as const },
      { sourceId: 's2', kind: 'official_statistics' as const, title: '统计公报', authors: ['统计局'], publishedAt: NOW - 15*86400000, fetchedAt: NOW, url: 'https://stats.gov.cn/s1', correctionState: 'clean' as const },
    ],
    facts: [{ claimId: 'c1', statement: '经济增速6.5%', evidenceSourceIds: ['s2'], verifiedAt: NOW }],
    stances: [{ claimId: 'st1', stance: 'supports' as const, rationale: '数据可靠', sourceId: 's2', annotatedAt: NOW }],
    interpretations: [{ claimId: 'c1', interpretation: '经济持续向好', synthesizesClaimIds: ['c1'], authorId: 'a1', authoredAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe('CurrentAffairs export preview chain', () => {
  it('builds export preview from valid manifest and state', () => {
    const manifest = makeManifest();
    const service = new CurrentAffairsService({ now: () => NOW });
    const { state } = service.executeWorkflow(manifest);
    const preview = buildExportPreview(manifest, state);
    expect(preview.title).toBe('出口测试时政分析');
    expect(preview.sourceCount).toBe(2);
    expect(preview.factCount).toBe(1);
    // Service stops at approval phase — exportReady only true after Runtime approve+markApproved
    expect(preview.exportReady).toBe(false);
    expect(preview.sections.length).toBeGreaterThanOrEqual(5);
  });

  it('preview shows rejection state when sources fail', () => {
    const manifest = makeManifest();
    manifest.sources[0] = { ...manifest.sources[0], correctionState: 'retracted' as const } as CurrentAffairsSourceRecord;
    const service = new CurrentAffairsService({ now: () => NOW });
    const { state } = service.executeWorkflow(manifest);
    expect(state.exportReady).toBe(false);
    const preview = buildExportPreview(manifest, state);
    expect(preview.sections.some((s) => s.heading.includes('未通过'))).toBe(true);
  });

  it('invalidatePreviewAfterCorrection detects retracted sources', () => {
    const manifest = makeManifest();
    expect(invalidatePreviewAfterCorrection(manifest)).toBe(false);
    manifest.sources[0] = { ...manifest.sources[0], correctionState: 'retracted' as const } as CurrentAffairsSourceRecord;
    expect(invalidatePreviewAfterCorrection(manifest)).toBe(true);
  });

  it('correction_pending also invalidates preview', () => {
    const manifest = makeManifest();
    manifest.sources[1] = { ...manifest.sources[1], correctionState: 'correction_pending' as const } as CurrentAffairsSourceRecord;
    expect(invalidatePreviewAfterCorrection(manifest)).toBe(true);
  });

  it('digest binding produces versioned preview', () => {
    const manifest = makeManifest();
    const service = new CurrentAffairsService({ now: () => NOW });
    const { state } = service.executeWorkflow(manifest);
    const preview = buildExportPreview(manifest, state);
    const bound = bindDigestToPreview(preview, 'a'.repeat(64));
    expect(bound.contentDigest).toBe('a'.repeat(64));
    expect(bound.title).toBe(preview.title); // all other fields preserved
  });

  it('retraction after generation invalidates previously generated preview', () => {
    const manifest = makeManifest();
    const service = new CurrentAffairsService({ now: () => NOW });
    const first = service.executeWorkflow(manifest);
    // Service no longer auto-approves — exportReady is false until approve+markApproved
    expect(first.state.exportReady).toBe(false);
    const preview1 = buildExportPreview(manifest, first.state);
    expect(preview1.exportReady).toBe(false);

    // Retraction discovered after initial generation
    const updatedManifest = { ...manifest, sources: manifest.sources.map((s) => s.sourceId === 's1' ? { ...s, correctionState: 'retracted' as const } as CurrentAffairsSourceRecord : s) };
    expect(invalidatePreviewAfterCorrection(updatedManifest)).toBe(true);
    const second = service.executeWorkflow(updatedManifest);
    const preview2 = buildExportPreview(updatedManifest, second.state);
    expect(preview2.exportReady).toBe(false);
    expect(preview2.sections.some((s) => s.content.includes('retracted'))).toBe(true);
  });
});
