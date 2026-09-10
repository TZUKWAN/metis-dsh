/**
 * WorkspaceHost state store (METIS-503).
 *
 * Preserves per-mode, per-object UI state (scroll position, selection, draft text) across
 * mode switches, so switching converse→read→analyze→write never loses the user's place
 * (METIS-503 completion: "switching does not lose draft or current reading position").
 *
 * Pure logic + framework-agnostic; the React binding consumes it via hooks in the component.
 */

import type { WorkspaceMode } from './ProjectShell.js';

export interface ObjectState {
  scrollTop: number;
  selectionId: string | null;
  draftText: string;
}

export interface WorkspaceStateStore {
  /** mode -> objectId -> state */
  save(mode: WorkspaceMode, objectId: string, partial: Partial<ObjectState>): void;
  load(mode: WorkspaceMode, objectId: string): ObjectState | undefined;
  /** All object ids ever visited in a mode (for restoring the "recent" list per mode). */
  visited(mode: WorkspaceMode): string[];
  clear(mode: WorkspaceMode): void;
}

export function createWorkspaceStateStore(): WorkspaceStateStore {
  const store = new Map<WorkspaceMode, Map<string, ObjectState>>();

  const ensure = (mode: WorkspaceMode) => {
    let m = store.get(mode);
    if (!m) { m = new Map(); store.set(mode, m); }
    return m;
  };

  return {
    save(mode, objectId, partial) {
      const m = ensure(mode);
      const existing = m.get(objectId) ?? { scrollTop: 0, selectionId: null, draftText: '' };
      m.set(objectId, { ...existing, ...partial });
    },
    load(mode, objectId) {
      return ensure(mode).get(objectId);
    },
    visited(mode) {
      return [...ensure(mode).keys()];
    },
    clear(mode) {
      store.delete(mode);
    },
  };
}
