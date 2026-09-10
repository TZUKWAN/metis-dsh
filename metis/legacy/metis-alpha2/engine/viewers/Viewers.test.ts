/**
 * METIS-701 ~ 711 — Core viewers tests.
 */

import { describe, it, expect } from 'vitest';
import {
  searchPdf, visibleThumbnailRange, anchorFromPdfSelection, classifyPdfTextQuality,
  webSelectionAnchor, imageRegionAnchor,
  type PdfDocument,
} from './DocumentViewers.js';
import {
  turnAt, audioAnchor, seekTargetForEvidence,
  dataTableWindow, filterAndSort, sampleRows,
  addAiSuggestedCode, addHumanCode, reviewAiCode, interCoderAgreement,
  type AudioTranscript, type DataTable, type QualitativeCodingState,
} from './MediaViewers.js';
import {
  validateChartSpec, chartExportTargets, networkPerformanceTier, filterGraphByKind, sourceForNode,
  unsupportedClaims, claimsCitedByParagraph, validateTimeline, eventsInRange,
  unresolvedCitations, buildArtifactInspector, chunkForViewer,
  type ChartSpec, type NetworkGraph, type ArgumentGraph, type Timeline, type Manuscript,
} from './VisualizationViewers.js';
import type { ArtifactManifest } from '../artifacts/ArtifactManifest.js';

// ── 701 PDF/Web/Image ──
describe('METIS-701 PDF/Web/Image viewers', () => {
  const doc: PdfDocument = {
    sourceId: 's1', pageCount: 3,
    pages: new Map([
      [1, { pageNumber: 1, text: 'Transformer 架构介绍', width: 612, height: 792, thumbnail: null }],
      [2, { pageNumber: 2, text: '注意力机制是核心', width: 612, height: 792, thumbnail: null }],
      [3, { pageNumber: 3, text: '', width: 612, height: 792, thumbnail: null }],
    ]),
  };
  it('searchPdf finds hits across pages', () => {
    const hits = searchPdf(doc, '注意力');
    expect(hits.length).toBe(1);
    expect(hits[0]!.pageNumber).toBe(2);
  });
  it('visibleThumbnailRange bounds for virtualization', () => {
    const r = visibleThumbnailRange(1000, 600, 120, 500);
    expect(r.start).toBeLessThanOrEqual(r.end);
    expect(r.end).toBeLessThanOrEqual(500);
  });
  it('anchorFromPdfSelection builds a char_range anchor', () => {
    const a = anchorFromPdfSelection('s1', 2, 0, 4, '注意力');
    expect(a.anchor.type).toBe('char_range');
    expect(a.anchor.pageNumber).toBe(2);
  });
  it('classifyPdfTextQuality detects scanned vs text', () => {
    const textDoc: PdfDocument = {
      sourceId: 's1', pageCount: 3,
      pages: new Map([
        [1, { pageNumber: 1, text: '这是一段足够长的中文文本，用于测试 PDF 文本质量分类器能够正确识别为文本型而非扫描型文档。', width: 612, height: 792, thumbnail: null }],
        [2, { pageNumber: 2, text: '第二页同样包含足够长度的文本内容，确保分类正确。', width: 612, height: 792, thumbnail: null }],
        [3, { pageNumber: 3, text: '第三页也有文本内容供分类。', width: 612, height: 792, thumbnail: null }],
      ]),
    };
    expect(classifyPdfTextQuality(textDoc)).toBe('text');
    const scanned: PdfDocument = { sourceId: 's', pageCount: 2, pages: new Map([[1, { pageNumber: 1, text: '', width: 1, height: 1, thumbnail: null }], [2, { pageNumber: 2, text: '', width: 1, height: 1, thumbnail: null }]]) };
    expect(classifyPdfTextQuality(scanned)).toBe('scanned');
  });
  it('webSelectionAnchor resolves selection to char range', () => {
    const a = webSelectionAnchor('s', '原文段落内容', '段落');
    expect(a?.anchor.start).toBe(2);
  });
  it('imageRegionAnchor builds a region anchor', () => {
    expect(imageRegionAnchor('s', { x: 10, y: 20, w: 30, h: 40 }).anchor.type).toBe('region');
  });
});

// ── 702 Audio ──
describe('METIS-702 Audio/Interview viewer', () => {
  const t: AudioTranscript = {
    sourceId: 'a1', durationSec: 100,
    turns: [
      { speakerId: 'A', speakerLabel: '访谈者', startSec: 0, endSec: 10, text: '问：请谈谈' },
      { speakerId: 'B', speakerLabel: '受访者', startSec: 10, endSec: 30, text: '答：我的经历' },
    ],
  };
  it('turnAt finds the active turn', () => {
    expect(turnAt(t, 15)?.speakerId).toBe('B');
    expect(turnAt(t, 5)?.speakerId).toBe('A');
  });
  it('audioAnchor builds a timestamp anchor', () => {
    const a = audioAnchor('a1', 10, 30, '答：我的经历');
    expect(a.anchor.type).toBe('timestamp');
  });
  it('seekTargetForEvidence returns the timestamp', () => {
    expect(seekTargetForEvidence({ type: 'timestamp', timestamp: 42 })).toBe(42);
  });
});

// ── 703 Corpus/Data table ──
describe('METIS-703 Corpus/Data table viewer', () => {
  const table: DataTable = {
    sourceId: 'd1',
    columns: [{ name: 'id', type: 'number' }, { name: 'city', type: 'string' }],
    rows: Array.from({ length: 10000 }, (_, i) => ({ id: i, city: i % 2 === 0 ? '北京' : '上海' })),
  };
  it('dataTableWindow returns a bounded slice (virtualization)', () => {
    const w = dataTableWindow(table, 0, 600, 24);
    expect(w.rows.length).toBeLessThan(100);
    expect(w.totalRows).toBe(10000);
  });
  it('filterAndSort filters without mutating source', () => {
    const filtered = filterAndSort(table, { column: 'city', query: '北京' });
    expect(filtered.length).toBe(5000);
    expect(table.rows.length).toBe(10000); // source unchanged
  });
  it('sampleRows never returns more than requested', () => {
    expect(sampleRows(table, 50).length).toBe(50);
  });
});

// ── 704 Qualitative coding ──
describe('METIS-704 Qualitative coding workspace', () => {
  const state: QualitativeCodingState = { codebook: [{ code: '工作强度', definition: 'd' }], codings: [] };
  it('AI suggestions start pending and are strictly separated from human codes', () => {
    const s = addAiSuggestedCode(state, { id: 'c1', code: '工作强度', evidenceId: 'e1', textSpan: '很累', confidence: 0.8, createdAt: 1 });
    expect(s.codings[0]!.author).toBe('ai');
    expect(s.codings[0]!.accepted).toBe('pending');
  });
  it('human codes are accepted by default', () => {
    const s = addHumanCode(state, { id: 'c2', code: '家庭冲突', evidenceId: 'e2', textSpan: '没时间陪家人', confidence: 1, createdAt: 2 });
    expect(s.codings[0]!.author).toBe('human');
    expect(s.codings[0]!.accepted).toBe('accepted');
  });
  it('reviewAiCode only affects AI codes (not human)', () => {
    let s = addAiSuggestedCode(state, { id: 'c1', code: 'x', evidenceId: null, textSpan: 'sp', confidence: 0.5, createdAt: 1 });
    s = addHumanCode(s, { id: 'c2', code: 'x', evidenceId: null, textSpan: 'sp', confidence: 1, createdAt: 2 });
    s = reviewAiCode(s, 'c1', 'accepted');
    expect(s.codings.find((c) => c.id === 'c1')!.accepted).toBe('accepted');
    // human code unaffected
    expect(s.codings.find((c) => c.id === 'c2')!.accepted).toBe('accepted');
  });
  it('interCoderAgreement computes agreement rate', () => {
    let s: QualitativeCodingState = { codebook: [], codings: [] };
    s = addHumanCode(s, { id: '1', code: 'A', evidenceId: null, textSpan: 'span1', confidence: 1, createdAt: 1 });
    s = addHumanCode(s, { id: '2', code: 'A', evidenceId: null, textSpan: 'span2', confidence: 1, createdAt: 2 });
    s = addHumanCode(s, { id: '3', code: 'B', evidenceId: null, textSpan: 'span1', confidence: 1, createdAt: 3 });
    const agg = interCoderAgreement(s);
    // span1 has codes {A,B} => disagree; span2 has {A} => agree
    expect(agg.total).toBe(2);
    expect(agg.agreed).toBe(1);
  });
});

// ── 705 Chart ──
describe('METIS-705 Chart viewer', () => {
  const validSpec: ChartSpec = {
    artifactId: 'a1', mark: 'bar', title: 'T', dataRef: 'data-1',
    encoding: { x: { field: 'city', type: 'nominal' }, y: { field: 'pop', type: 'quantitative' } },
    methodNote: 'DID', citedSourceIds: ['s1'],
  };
  it('validates a complete spec', () => {
    expect(validateChartSpec(validSpec).valid).toBe(true);
  });
  it('rejects a spec with no cited sources', () => {
    expect(validateChartSpec({ ...validSpec, citedSourceIds: [] }).valid).toBe(false);
  });
  it('rejects a spec with no encoding', () => {
    expect(validateChartSpec({ ...validSpec, encoding: {} }).valid).toBe(false);
  });
  it('chartExportTargets includes vector formats for publication', () => {
    expect(chartExportTargets()).toContain('svg');
    expect(chartExportTargets()).toContain('pdf');
  });
});

// ── 706 Network ──
describe('METIS-706 Network graph viewer', () => {
  const graph: NetworkGraph = {
    nodes: [{ id: 'n1', label: 'A', kind: 'paper', sourceId: 's1' }, { id: 'n2', label: 'B', kind: 'author' }],
    edges: [{ source: 'n1', target: 'n2', kind: 'wrote' }],
  };
  it('performanceTier classifies by node count', () => {
    expect(networkPerformanceTier(50)).toBe('small');
    expect(networkPerformanceTier(500)).toBe('medium');
    expect(networkPerformanceTier(5000)).toBe('large');
  });
  it('filterGraphByKind keeps only matching nodes + edges', () => {
    const f = filterGraphByKind(graph, new Set(['paper']));
    expect(f.nodes.length).toBe(1);
    expect(f.edges.length).toBe(0); // n2 filtered out
  });
  it('sourceForNode resolves the backing source', () => {
    expect(sourceForNode(graph, 'n1')).toBe('s1');
  });
});

// ── 707 Argument graph ──
describe('METIS-707 Argument/evidence graph viewer', () => {
  const graph: ArgumentGraph = {
    nodes: [
      { claimId: 'c1', statement: 'A', status: 'supported' },
      { claimId: 'c2', statement: 'B', status: 'unsupported' },
    ],
    links: [{ claimId: 'c1', evidenceId: 'e1', relation: 'supports' }],
  };
  it('unsupportedClaims finds claims with no support', () => {
    const u = unsupportedClaims(graph);
    expect(u.map((n) => n.claimId)).toEqual(['c2']);
  });
  it('claimsCitedByParagraph reverse-links', () => {
    expect(claimsCitedByParagraph(['c1'], graph).map((n) => n.claimId)).toEqual(['c1']);
  });
});

// ── 708 Timeline ──
describe('METIS-708 Timeline viewer', () => {
  const tl: Timeline = {
    events: [
      { id: 'e1', label: '事件A', dateStart: '1990-01-01', sourceId: 's1' },
      { id: 'e2', label: '事件B', dateStart: '2000-01-01', sourceId: 's2' },
      { id: 'e3', label: '无源', dateStart: '2010-01-01', sourceId: '' },
    ],
  };
  it('validateTimeline flags unsourced events', () => {
    const r = validateTimeline(tl);
    expect(r.valid).toBe(false);
    expect(r.unsourced).toContain('e3');
  });
  it('eventsInRange filters by year', () => {
    expect(eventsInRange(tl, 1980, 1995).map((e) => e.id)).toEqual(['e1']);
  });
});

// ── 709 Manuscript editor ──
describe('METIS-709 Manuscript editor', () => {
  const ms: Manuscript = {
    artifactId: 'a1', title: 'T',
    sections: [{ id: 's1', heading: '引言', body: '...', citedClaimIds: ['c1', 'cX'] }],
  };
  it('unresolvedCitations finds unregistered claim ids', () => {
    expect(unresolvedCitations(ms, new Set(['c1']))).toEqual(['cX']);
  });
});

// ── 710 Artifact inspector ──
describe('METIS-710 Artifact inspector', () => {
  it('builds a how-was-this-generated view', () => {
    const manifest: ArtifactManifest = {
      id: 'a1', projectId: 'p1', title: 'T', artifactType: 'chart', reviewStatus: 'verified',
      inputs: [{ kind: 'dataset', id: 'd1' }],
      generatedBy: { capabilityId: 'quantitative-analysis', method: 'DID', model: 'glm-4.5' },
      citedSourceIds: ['s1'], renderer: { kind: 'vega_lite' }, reviewTrail: [], version: 1,
      createdAt: 1, updatedAt: 1,
    };
    const view = buildArtifactInspector(manifest, ['source:s1', 'dataset:d1', 'artifact:a1'], { passed: 3, total: 3 });
    expect(view.reproducerSteps.join(' ')).toMatch(/DID/);
    expect(view.reviewSummary.status).toBe('verified');
    expect(view.provenanceLineage.length).toBeGreaterThan(0);
  });
});

// ── 711 lazy-load ──
describe('METIS-711 Viewer lazy-load chunking', () => {
  it('chunkForViewer maps each kind to a dedicated chunk', () => {
    expect(chunkForViewer('pdf')).toBe('viewer-pdf');
    expect(chunkForViewer('audio')).toBe('viewer-audio');
    expect(chunkForViewer('network')).toBe('viewer-graphs');
    expect(chunkForViewer('unknown')).toBe('viewer-text'); // fallback
  });
});
