/**
 * Task 3 test — preload public API snapshot (DoD item 10).
 *
 * Loads the real preload module with a mocked `electron` and captures the
 * exact object handed to contextBridge.exposeInMainWorld('metis', api).
 * The key set is frozen in a baseline JSON: the renderer-visible API surface
 * must not drift (no accidental removals/renames from the domain split).
 *
 * Regenerate the baseline deliberately with:
 *   METIS_UPDATE_API_SNAPSHOT=1 npx vitest run tests/electron/PreloadApiSnapshot.test.ts --project node
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const exposed: Record<string, unknown> = {};

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((_name: string, api: Record<string, unknown>) => {
      Object.assign(exposed, api);
    }),
  },
  ipcRenderer: {
    invoke: vi.fn(async () => null),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    send: vi.fn(),
  },
}));

const BASELINE_PATH = path.join(__dirname, 'fixtures', 'metis-api-snapshot.json');

describe('window.metis public API snapshot', () => {
  beforeAll(async () => {
    vi.resetModules();
    await import('../../electron/preload');
  });

  it('exposes the frozen method surface', () => {
    const keys = Object.keys(exposed).sort();
    expect(keys.length).toBeGreaterThan(300);
    if (process.env.METIS_UPDATE_API_SNAPSHOT) {
      fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(keys, null, 2)}\n`);
      console.log(`[snapshot] baseline written (${keys.length} methods)`);
    }
    expect(fs.existsSync(BASELINE_PATH)).toBe(true);
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as string[];
    expect(keys).toEqual(baseline);
  });

  it('keeps methods from every migrated domain bridge reachable', () => {
    for (const name of [
      // submissionBridge
      'createSubmission', 'runSubmissionPreflight', 'exportSubmissionPackage',
      // outcomeBridge
      'listOutcomes', 'saveOutcome', 'exportOutcomePptx',
      // topicBridge
      'topicCreateSession', 'topicGetBrief',
      // freeModelBridge
      'freeModelListSources', 'mailboxAdd',
      // systemBridge
      'storageChooseLocation', 'clipboardReadText', 'flashcardList',
    ]) {
      expect(typeof exposed[name]).toBe('function');
    }
    // hot-zone methods that intentionally stayed in preload.ts
    for (const name of ['externalRefList', 'updateStatus', 'officePromptProfiles']) {
      if (typeof exposed[name] !== 'undefined') expect(typeof exposed[name]).toBe('function');
    }
  });
});
