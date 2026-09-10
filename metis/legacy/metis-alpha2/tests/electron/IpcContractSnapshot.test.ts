/**
 * IPC contract snapshot gate.
 *
 * Pins the renderer-facing IPC surface (main handlers, preload direct invokes,
 * main→renderer send events, contract version constants) to a committed golden
 * snapshot. Adding or removing a channel must be an explicit, reviewed change:
 * run `npm run ipc:snapshot:update` and commit the updated snapshot together
 * with the code change.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

import { scanIpcContract } from '../../scripts/ipc-contract-scan.mjs';

const ROOT = resolve(__dirname, '../..');
const SNAPSHOT_PATH = resolve(ROOT, 'tests/fixtures/ipc/ipc-inventory.snapshot.json');
const UPDATE_HINT = 'IPC surface drifted from tests/fixtures/ipc/ipc-inventory.snapshot.json. If intentional, run `npm run ipc:snapshot:update`, review preload exposure + renderer authorization for every added channel, and commit the snapshot with the change.';

/**
 * Preload channels that are invoked by the renderer but have NO main-process
 * handler. Each entry is a known, reported defect owned by another domain; the
 * gate keeps failing on any NEW orphan and also fails once a listed orphan is
 * fixed so the entry gets removed.
 */
// FINDING-IPC-001 (dialog:openReferenceFiles) was FIXED: the system domain
// registrar now owns the channel (electron/ipc/registerSystemIpc.ts) and
// tests/electron/DialogOpenReferenceFiles.test.ts locks the contract.
const KNOWN_ORPHAN_PRELOAD_CHANNELS: Record<string, string> = {};

interface Snapshot {
  schemaVersion: number;
  counts: { invoke: number; rendererInvoke: number; send: number };
  invoke: string[];
  rendererInvoke: string[];
  send: string[];
  contractVersions: Record<string, number>;
}

function loadSnapshot(): Snapshot {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;
}

function setDiff(golden: string[], current: string[]) {
  const g = new Set(golden);
  const c = new Set(current);
  return {
    added: current.filter((ch) => !g.has(ch)),
    removed: golden.filter((ch) => !c.has(ch)),
  };
}

describe('IPC contract snapshot', () => {
  const golden = loadSnapshot();
  const current = scanIpcContract();

  it('snapshot file is well-formed and non-trivial', () => {
    expect(golden.schemaVersion).toBe(1);
    expect(golden.invoke.length).toBeGreaterThan(300);
    expect(golden.rendererInvoke.length).toBeGreaterThan(300);
    expect(golden.send.length).toBeGreaterThan(0);
    expect(Object.keys(golden.contractVersions).length).toBeGreaterThan(5);
    // Sorted + unique so diffs stay reviewable.
    for (const key of ['invoke', 'rendererInvoke', 'send'] as const) {
      const list = golden[key];
      expect(list).toEqual([...new Set(list)].sort());
    }
  });

  it('main-process handler channels match the snapshot exactly', () => {
    const { added, removed } = setDiff(golden.invoke, current.invoke);
    expect({ added, removed }, UPDATE_HINT).toEqual({ added: [], removed: [] });
  });

  it('preload direct-invoke channels match the snapshot exactly', () => {
    const { added, removed } = setDiff(golden.rendererInvoke, current.rendererInvoke);
    expect({ added, removed }, UPDATE_HINT).toEqual({ added: [], removed: [] });
  });

  it('main→renderer send event channels match the snapshot exactly', () => {
    const { added, removed } = setDiff(golden.send, current.send);
    expect({ added, removed }, UPDATE_HINT).toEqual({ added: [], removed: [] });
  });

  it('contract version constants match the snapshot (bump = explicit review)', () => {
    expect(current.contractVersions, UPDATE_HINT).toEqual(golden.contractVersions);
  });

  it('every preload-invoked channel has a main handler, except known reported orphans', () => {
    const handlers = new Set(current.invoke);
    const orphans = current.rendererInvoke.filter((ch) => !handlers.has(ch));
    const unexpected = orphans.filter((ch) => !(ch in KNOWN_ORPHAN_PRELOAD_CHANNELS));
    expect(unexpected, 'preload invokes channel(s) with no main handler — the renderer call would reject at runtime').toEqual([]);

    // Self-cleaning: once a known orphan gains a handler, this fails so the
    // allowlist entry (and the finding) get closed out.
    const fixed = Object.keys(KNOWN_ORPHAN_PRELOAD_CHANNELS).filter((ch) => handlers.has(ch));
    expect(fixed, 'known orphan channel(s) now have handlers — remove them from KNOWN_ORPHAN_PRELOAD_CHANNELS').toEqual([]);
  });
});
