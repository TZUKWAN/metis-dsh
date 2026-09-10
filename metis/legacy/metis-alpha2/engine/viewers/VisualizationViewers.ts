/**
 * Chart (METIS-705) + Network/Argument graph (METIS-706/707) + Timeline/Map (METIS-708) +
 * Manuscript editor (METIS-709) + Artifact Inspector (METIS-710) + lazy-load (METIS-711).
 *
 * Each viewer's testable core: spec validation, node-count performance tiering, evidence
 * cross-link, manuscript citation resolution, and artifact inspector assembly. React render
 * components consume these; visual pixel regression is METIS-1003.
 */

import type { ArtifactManifest } from '../artifacts/ArtifactManifest.js';
import type { Claim } from '../persistence/researchModel.js';

// ─── METIS-705 Chart (declarative Vega-Lite-style spec) ───────

export type ChartMark = 'bar' | 'line' | 'scatter' | 'area' | 'boxplot' | 'point';

export interface ChartSpec {
  artifactId: string;
  mark: ChartMark;
  title: string;
  /** Data is referenced, never inlined into the spec for large sets. */
  dataRef: string;
  encoding: {
    x?: { field: string; type: 'quantitative' | 'nominal' | 'temporal' };
    y?: { field: string; type: 'quantitative' | 'nominal' | 'temporal' };
    color?: { field: string; type: 'nominal' };
  };
  /** The methods + sources backing the chart (METIS-705: every chart has data+spec+method+source). */
  methodNote: string;
  citedSourceIds: string[];
}

export const VALID_MARKS: readonly ChartMark[] = ['bar', 'line', 'scatter', 'area', 'boxplot', 'point'];

export function validateChartSpec(spec: ChartSpec): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!VALID_MARKS.includes(spec.mark)) errors.push(`invalid mark: ${spec.mark}`);
  if (!spec.encoding.x && !spec.encoding.y) errors.push('chart needs at least one encoding axis');
  if (!spec.dataRef) errors.push('chart must reference its data (dataRef)');
  if (spec.citedSourceIds.length === 0) errors.push('chart must cite at least one source (METIS-705)');
  return { valid: errors.length === 0, errors };
}

export type ChartExportFormat = 'svg' | 'pdf' | 'png';

/** Declare the export targets — actual rendering is platform-specific (browser print / server). */
export function chartExportTargets(): ChartExportFormat[] {
  // vector formats preferred for publication
  return ['svg', 'pdf', 'png'];
}

// ─── METIS-706 Knowledge/concept network ──────────────────────

export interface GraphNode { id: string; label: string; kind: string; weight?: number; sourceId?: string; }
export interface GraphEdge { source: string; target: string; kind: string; weight?: number; }
export interface NetworkGraph { nodes: GraphNode[]; edges: GraphEdge[]; }

export type PerformanceTier = 'small' | 'medium' | 'large';

/** Classify render strategy by node count (METIS-706: 100/1000/10000 performance tiers). */
export function networkPerformanceTier(nodeCount: number): PerformanceTier {
  if (nodeCount <= 100) return 'small';
  if (nodeCount <= 1000) return 'medium';
  return 'large';
}

/** Filter a graph by node kind (for focused analysis, not decoration). */
export function filterGraphByKind(graph: NetworkGraph, kinds: Set<string>): NetworkGraph {
  const nodes = graph.nodes.filter((n) => kinds.has(n.kind));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  return { nodes, edges };
}

/** Jump to the source backing a node (METIS-706: used for analysis, not just a static circle). */
export function sourceForNode(graph: NetworkGraph, nodeId: string): string | undefined {
  return graph.nodes.find((n) => n.id === nodeId)?.sourceId;
}

// ─── METIS-707 Argument/evidence graph ────────────────────────

export interface ArgumentNode { claimId: string; statement: string; status: Claim['status']; }
export interface ArgumentLink { claimId: string; evidenceId: string; relation: 'supports' | 'contradicts' | 'qualifies'; }

export interface ArgumentGraph {
  nodes: ArgumentNode[];
  links: ArgumentLink[];
}

/** Find claims that LACK supporting evidence (METIS-707: shows where an argument is unsupported). */
export function unsupportedClaims(graph: ArgumentGraph): ArgumentNode[] {
  const supported = new Set(graph.links.filter((l) => l.relation === 'supports').map((l) => l.claimId));
  return graph.nodes.filter((n) => !supported.has(n.claimId));
}

/** From a manuscript paragraph, locate the argument nodes it cites (METIS-707 reverse-link). */
export function claimsCitedByParagraph(paragraphClaimIds: string[], graph: ArgumentGraph): ArgumentNode[] {
  const set = new Set(paragraphClaimIds);
  return graph.nodes.filter((n) => set.has(n.claimId));
}

// ─── METIS-708 Timeline / Map ─────────────────────────────────

export interface TimelineEvent {
  id: string;
  label: string;
  /** ISO date OR year; uncertain dates use a range. */
  dateStart: string;
  dateEnd?: string;
  uncertain?: boolean;
  sourceId: string;
  location?: { lat: number; lng: number; label: string };
}

export interface Timeline { events: TimelineEvent[]; }

/** Every event must trace back to a source (METIS-708 completion). */
export function validateTimeline(tl: Timeline): { valid: boolean; unsourced: string[] } {
  const unsourced = tl.events.filter((e) => !e.sourceId).map((e) => e.id);
  return { valid: unsourced.length === 0, unsourced };
}

/** Filter events by date range (for diffusion / comparative analysis). */
export function eventsInRange(tl: Timeline, fromYear: number, toYear: number): TimelineEvent[] {
  return tl.events.filter((e) => {
    const y = Number.parseInt(e.dateStart.slice(0, 4), 10);
    return y >= fromYear && y <= toYear;
  });
}

// ─── METIS-709 Manuscript editor ──────────────────────────────

export interface ManuscriptSection {
  id: string;
  heading: string;
  body: string;
  /** Claim ids cited inline in this section (METIS-806: writing must cite registered sources). */
  citedClaimIds: string[];
}

export interface Manuscript {
  artifactId: string;
  title: string;
  sections: ManuscriptSection[];
}

/** Resolve every citation to a registered claim id — return any that don't resolve (METIS-806). */
export function unresolvedCitations(ms: Manuscript, knownClaimIds: Set<string>): string[] {
  const unresolved: string[] = [];
  for (const s of ms.sections) {
    for (const cid of s.citedClaimIds) {
      if (!knownClaimIds.has(cid)) unresolved.push(cid);
    }
  }
  return unresolved;
}

// ─── METIS-710 Artifact Inspector ─────────────────────────────

export interface ArtifactInspectorView {
  manifest: ArtifactManifest;
  /** Provenance + lineage, method, data, code, model, sources, review, versions. */
  provenanceLineage: string[];
  reproducerSteps: string[];
  reviewSummary: { status: string; checks: number; passed: number };
}

/** Assemble the "how was this artifact generated" inspector view (METIS-710). */
export function buildArtifactInspector(manifest: ArtifactManifest, lineage: string[], checks: { passed: number; total: number }): ArtifactInspectorView {
  return {
    manifest,
    provenanceLineage: lineage,
    reproducerSteps: [
      `能力：${manifest.generatedBy.capabilityId}`,
      `方法：${manifest.generatedBy.method}`,
      manifest.generatedBy.model ? `模型：${manifest.generatedBy.model}` : '',
      manifest.generatedBy.codeRef ? `代码：${manifest.generatedBy.codeRef}` : '',
      `输入：${manifest.inputs.map((i) => `${i.kind}:${i.id}`).join(', ') || '(无)'}`,
    ].filter(Boolean),
    reviewSummary: { status: manifest.reviewStatus, checks: checks.total, passed: checks.passed },
  };
}

// ─── METIS-711 lazy-load chunk mapping ────────────────────────

/** Map a viewer kind to the Vite chunk it lives in (METIS-711: load on demand). */
export function chunkForViewer(kind: string): string {
  switch (kind) {
    case 'pdf': return 'viewer-pdf';
    case 'audio': return 'viewer-audio';
    case 'corpus_table': return 'viewer-table';
    case 'chart_vega': return 'viewer-charts';
    case 'network':
    case 'argument_graph': return 'viewer-graphs';
    case 'timeline':
    case 'map': return 'viewer-timeline-map';
    case 'manuscript': return 'viewer-manuscript';
    default: return 'viewer-text';
  }
}
