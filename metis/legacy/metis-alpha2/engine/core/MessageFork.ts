/**
 * Message fork helpers (O16).
 *
 * When a user regenerates an assistant answer, the previous answer is kept as
 * an inactive sibling branch rather than deleted. These pure helpers manage
 * which sibling is the displayed one, so the logic is testable outside the
 * React component tree.
 */

export interface ForkLikeMessage {
  forkId?: string;
  forkIndex?: number;
  forkCount?: number;
  forkActive?: boolean;
}

/**
 * Flip which sibling of a fork group is active. Returns a new array; messages
 * not in the fork group are returned unchanged.
 */
export function toggleForkActive<T extends ForkLikeMessage>(
  messages: T[],
  forkId: string,
  targetIndex: number,
): T[] {
  return messages.map((m) => {
    if (m.forkId !== forkId) return m;
    return { ...m, forkActive: m.forkIndex === targetIndex };
  });
}

/** The visible (active) messages after fork filtering. */
export function visibleMessages<T extends ForkLikeMessage>(messages: T[]): T[] {
  return messages.filter((m) => !(m.forkId && m.forkActive === false));
}

/** The active sibling of a fork group, if any. */
export function activeForkSibling<T extends ForkLikeMessage>(
  messages: T[],
  forkId: string,
): T | undefined {
  return messages.find((m) => m.forkId === forkId && m.forkActive === true);
}

// ─── Fork persistence (O16) ───────────────────────────────────
//
// The main process owns normal chat persistence (role+content only, no
// metadata), so fork bookkeeping is kept in a session-scoped side table keyed
// by session id. The renderer persists the fork map on every branch change and
// rehydrates it when a session is restored.

export interface ForkRecord {
  forkId: string;
  forkIndex: number;
  forkCount: number;
  /** Full content of the sibling — kept so old branches survive a reload. */
  content: string;
  /** Timestamp for display ordering. */
  timestamp: number;
}

const FORK_STORAGE_PREFIX = 'metis-fork-map:';

/**
 * Load the fork map for a session. `storage` is injected so this module stays
 * DOM-free (engine rules); pass window.localStorage from the renderer.
 */
export function loadForkMap(
  sessionId: string,
  storage: Pick<Storage, 'getItem'> | null,
): Map<string, ForkRecord> {
  if (!storage) return new Map();
  try {
    const raw = storage.getItem(FORK_STORAGE_PREFIX + sessionId);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as ForkRecord[];
    return new Map(parsed.map((r) => [r.forkId, r]));
  } catch {
    return new Map();
  }
}

/** Persist a fork map for a session (best-effort). */
export function saveForkMap(
  sessionId: string,
  map: Map<string, ForkRecord>,
  storage: Pick<Storage, 'setItem'> | null,
): void {
  if (!storage) return;
  try {
    storage.setItem(FORK_STORAGE_PREFIX + sessionId, JSON.stringify([...map.values()]));
  } catch {
    // Storage full/unavailable — best-effort.
  }
}

/** Update the fork map with a new sibling record. */
export function upsertForkRecord(
  sessionId: string,
  record: ForkRecord,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
): void {
  const map = loadForkMap(sessionId, storage);
  map.set(record.forkId, record);
  saveForkMap(sessionId, map, storage);
}
