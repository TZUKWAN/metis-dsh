/**
 * Selection context bridge (METIS-605) + Viewer Registry (METIS-606).
 *
 * METIS-605: when the user clicks a paragraph / node / data point / time range, the AI gets
 * a PRECISE context (the object's stable id + type + coordinates), not just a visible label.
 * This forbids passing only "what's on screen" and losing the source id (METIS-605's core
 * anti-pattern). Covers PDF / chart / network / timeline / table / manuscript selections.
 *
 * METIS-606: maps an artifact/source TYPE to the right viewer module, with lazy-load + a
 * fallback text viewer so a single broken viewer never crashes the whole workbench.
 */

// ─── Selection bridge (METIS-605) ─────────────────────────────

export type SelectionTargetKind = 'pdf_paragraph' | 'pdf_region' | 'chart_datapoint' | 'network_node' | 'network_edge' | 'timeline_event' | 'table_cell' | 'table_row' | 'manuscript_paragraph' | 'manuscript_range';

export interface SelectionContext {
  kind: SelectionTargetKind;
  /** Stable id of the source/artifact the selection is in. */
  containerId: string;
  /** The specific object id within the container (paragraph id, node id, row id, etc.). */
  objectId: string;
  /** Precise coordinates / anchor, so the AI can re-locate it. */
  coordinates: {
    page?: number;
    charStart?: number;
    charEnd?: number;
    x?: number; y?: number; w?: number; h?: number; // region / datapoint bbox
    rowIndex?: number; colIndex?: number;
    timestamp?: number;
  };
  /** Snapshot text at selection time (so AI has the content even if the file is gone). */
  textSnapshot: string;
}

export interface AskMetisRequest {
  selection: SelectionContext;
  userQuestion: string;
  /** The full context the AI will receive — always includes the stable containerId + objectId. */
  contextForModel: { kind: string; containerId: string; objectId: string; text: string; coordinates: Record<string, unknown> };
}

/**
 * Build an "ask Metis about this selection" request. CRITICAL: the contextForModel always
 * carries the stable containerId + objectId, never just the visible label — so the AI can
 * accurately cite the selected object (METIS-605 completion).
 */
export function buildAskFromSelection(selection: SelectionContext, userQuestion: string): AskMetisRequest {
  if (!selection.containerId || !selection.objectId) {
    throw new Error('Selection must include stable containerId and objectId (METIS-605: never pass only a visible label).');
  }
  return {
    selection,
    userQuestion,
    contextForModel: {
      kind: selection.kind,
      containerId: selection.containerId,
      objectId: selection.objectId,
      text: selection.textSnapshot,
      coordinates: selection.coordinates,
    },
  };
}

// ─── Viewer Registry (METIS-606) ──────────────────────────────

export type ViewerKind = 'pdf' | 'audio' | 'corpus_table' | 'qualitative_coding' | 'chart_vega' | 'network' | 'argument_graph' | 'timeline' | 'map' | 'manuscript' | 'text_fallback';

export interface ViewerRegistration {
  /** The artifact/source kinds this viewer handles. */
  handles: string[];
  /** Lazy-load module id (METIS-711: loaded on demand, not in initial bundle). */
  moduleId: string;
  kind: ViewerKind;
}

const REGISTRY = new Map<ViewerKind, ViewerRegistration>();
const FALLBACK: ViewerRegistration = { handles: ['*'], moduleId: 'TextViewer', kind: 'text_fallback' };

export function registerViewer(reg: ViewerRegistration): void {
  REGISTRY.set(reg.kind, reg);
}

/** Resolve which viewer handles a given artifact/source kind. Falls back to text_fallback. */
export function resolveViewer(kind: string): ViewerRegistration {
  for (const reg of REGISTRY.values()) {
    if (reg.handles.includes(kind)) return reg;
  }
  return FALLBACK;
}

/** A single broken viewer must not crash the workbench (METIS-606). Wraps load in try/catch. */
export async function safeLoadViewer(reg: ViewerRegistration, loader: (moduleId: string) => Promise<unknown>): Promise<{ ok: true; module: unknown } | { ok: false; error: string; fallback: ViewerRegistration }> {
  try {
    const mod = await loader(reg.moduleId);
    return { ok: true, module: mod };
  } catch (err) {
    return { ok: false, error: (err as Error).message, fallback: FALLBACK };
  }
}

export function resetViewerRegistry(): void {
  REGISTRY.clear();
}
