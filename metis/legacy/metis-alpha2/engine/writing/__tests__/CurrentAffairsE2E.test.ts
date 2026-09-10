import { describe, it, expect } from 'vitest';
import { CurrentAffairsManifestSchema, isExpired, needsCorrectionReview } from '../CurrentAffairsProfile.js';
import type { CurrentAffairsSourceRecord } from '../CurrentAffairsProfile.js';
import { createWorkflowState, verifySource, advancePhase } from '../CurrentAffairsWorkflow.js';

const NOW = 1750000000000;

function makeChineseManifest() {
  return {
    schemaVersion: 1 as const,
    projectId: 'proj-china',
    workflowId: 'wf-china-2026-q2',
    manifestVersion: 1,
    profileId: 'ca-china-2026-q2',
    title: '2026年第二季度中国经济政策分析',
    timeWindow: {
      fetchedAt: NOW,
      timeSensitive: true,
      applicabilityStart: NOW - 90 * 86400000,
      applicabilityEnd: NOW + 90 * 86400000,
      maxSourceAgeDays: 180,
    },
    sources: [
      {
        sourceId: 'src-gov-001',
        kind: 'policy_document' as const,
        title: '关于促进民营经济发展壮大的若干措施',
        authors: ['国家发展改革委'],
        publishedAt: NOW - 60 * 86400000,
        fetchedAt: NOW - 86400000,
        effectiveAt: NOW - 30 * 86400000,
        url: 'https://www.gov.cn/zhengce/content/2026-05/content_policy_001.htm',
        correctionState: 'clean' as const,
      },
      {
        sourceId: 'src-stats-001',
        kind: 'official_statistics' as const,
        title: '2026年1-5月全国固定资产投资数据',
        authors: ['国家统计局'],
        publishedAt: NOW - 15 * 86400000,
        fetchedAt: NOW - 86400000,
        url: 'https://www.stats.gov.cn/sj/ndsj/2026/indexch.htm',
        correctionState: 'clean' as const,
      },
    ],
    facts: [
      { claimId: 'c1', statement: '2026年二季度民间投资同比增长8.3%', evidenceSourceIds: ['src-stats-001'], verifiedAt: NOW },
      { claimId: 'c2', statement: '民营经济促进措施于2026年5月生效', evidenceSourceIds: ['src-gov-001'], verifiedAt: NOW },
    ],
    stances: [
      { claimId: 'st1', stance: 'supports' as const, rationale: '数据与政策方向一致', sourceId: 'src-gov-001', annotatedAt: NOW },
    ],
    interpretations: [
      { claimId: 'i1', interpretation: '民营经济政策正在产生可测量的积极效果', synthesizesClaimIds: ['c1', 'c2'], authorId: 'a1', authoredAt: NOW },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('CurrentAffairs E2E Chinese policy research', () => {
  it('complete manifest passes schema validation', () => {
    const manifest = makeChineseManifest();
    expect(CurrentAffairsManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('workflow advances through all phases', () => {
    const manifest = CurrentAffairsManifestSchema.parse(makeChineseManifest());
    let state = createWorkflowState(manifest);
    expect(state.phase).toBe('retrieve');

    // Verify all sources
    for (const source of manifest.sources) {
      const result = verifySource(source, NOW);
      expect(result.verified).toBe(true);
      if (result.verified) state.verifiedSourceIds.push(source.sourceId);
    }
    expect(state.verifiedSourceIds.length).toBe(2);

    // Advance through phases
    state = advancePhase(state, 'verify');
    state = advancePhase(state, 'fact_split');
    expect(manifest.facts?.length).toBe(2);
    state = advancePhase(state, 'temporal_check');
    expect(isExpired(manifest.timeWindow, NOW)).toBe(false);
    state.temporalCheckPassed = true;
    state = advancePhase(state, 'correction_monitor');
    expect(manifest.sources.every((s) => !needsCorrectionReview(s))).toBe(true);

    state = advancePhase(state, 'approval');
    state.approved = true;
    state = advancePhase(state, 'preview');
    state = advancePhase(state, 'export');
    state.exportReady = true;
    expect(state.phase).toBe('export');
  });

  it('rejects expired source in temporal check', () => {
    const manifest = CurrentAffairsManifestSchema.parse(makeChineseManifest());
    const expiredWindow = { ...manifest.timeWindow, applicabilityEnd: NOW - 1 };
    expect(isExpired(expiredWindow, NOW)).toBe(true);
  });

  it('rejects retracted source in verify phase', () => {
    const retracted = {
      ...makeChineseManifest().sources[0] as CurrentAffairsSourceRecord,
      correctionState: 'retracted' as const,
    };
    expect(verifySource(retracted, NOW).verified).toBe(false);
    expect(verifySource(retracted, NOW).reason).toBe('Retracted');
  });

  it('rejects source with future publication date', () => {
    const future = {
      ...makeChineseManifest().sources[0] as CurrentAffairsSourceRecord,
      publishedAt: NOW + 365 * 86400000,
    };
    const result = verifySource(future, NOW);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('Future publication date');
  });

  it('cannot regress workflow phase', () => {
    const manifest = CurrentAffairsManifestSchema.parse(makeChineseManifest());
    let state = createWorkflowState(manifest);
    state = advancePhase(state, 'verify');
    state = advancePhase(state, 'fact_split');
    // Try to go back
    state = advancePhase(state, 'retrieve');
    expect(state.errors).toContain('Cannot regress from fact_split to retrieve');
  });
});
