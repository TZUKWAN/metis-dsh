import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import type { AgentExecutionEvent } from '../../engine/runtime/ChatRuntimeContract.js';

function event(sequence: number): AgentExecutionEvent {
  return {
    version: 1,
    eventId: `run-ledger:${sequence}`,
    runId: 'run-ledger',
    sessionId: 'session-ledger',
    turnId: 'turn-ledger',
    sequence,
    correlationId: 'turn-ledger',
    event: {
      type: 'action',
      action: 'model.request',
      status: 'running',
      timestamp: sequence,
      summary: 'model.request',
    },
  };
}

describe('PersistenceStore AgentEvent ledger', () => {
  let directory: string;
  let store: PersistenceStore;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-agent-ledger-'));
    store = new PersistenceStore(path.join(directory, 'events.db'));
    store.createSession('session-ledger');
  });

  afterEach(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('deduplicates event retries and replays strictly after a sequence', () => {
    const first = event(0);
    expect(store.appendAgentEvent(first)).toBe(true);
    expect(store.appendAgentEvent(first)).toBe(false);
    expect(store.appendAgentEvent(event(1))).toBe(true);

    expect(store.getAgentEventsAfter('session-ledger', 'run-ledger', 0)).toEqual([event(1)]);
  });

  it('keeps a bounded per-run ledger and survives reopening the database', () => {
    for (let sequence = 0; sequence < 4; sequence += 1) {
      store.appendAgentEvent(event(sequence), 2);
    }
    expect(store.getAgentEventsAfter('session-ledger', 'run-ledger', -1)).toEqual([event(2), event(3)]);

    store.close();
    store = new PersistenceStore(path.join(directory, 'events.db'));
    expect(store.getAgentEventsAfter('session-ledger', 'run-ledger', 2)).toEqual([event(3)]);
  });

  it('persists run metadata, enforces session ownership, and cascades deletion', () => {
    const startedAt = 100;
    expect(store.beginAgentRun({
      runId: 'run-ledger',
      sessionId: 'session-ledger',
      turnId: 'turn-ledger',
      projectId: 'project-a',
      startedAt,
      metadata: { source: 'chat' },
    })).toBe(true);
    expect(store.appendAgentEvent(event(0))).toBe(true);

    const running = store.getAgentRun('run-ledger', 'session-ledger');
    expect(running).toMatchObject({
      runId: 'run-ledger',
      sessionId: 'session-ledger',
      turnId: 'turn-ledger',
      projectId: 'project-a',
      status: 'running',
      startedAt,
      lastSequence: 0,
      eventsPruned: false,
      metadata: { source: 'chat' },
    });

    expect(store.finishAgentRun({
      runId: 'run-ledger',
      sessionId: 'other-session',
      status: 'completed',
      completedAt: 200,
    })).toBe(false);
    expect(store.finishAgentRun({
      runId: 'run-ledger',
      sessionId: 'session-ledger',
      status: 'completed',
      completedAt: 200,
      terminalReason: 'agent_complete',
    })).toBe(true);
    expect(store.getAgentRun('run-ledger', 'session-ledger')).toMatchObject({
      status: 'completed',
      completedAt: 200,
      terminalReason: 'agent_complete',
      lastSequence: 0,
    });

    store.deleteSession('session-ledger');
    expect(store.getAgentRun('run-ledger', 'session-ledger')).toBeUndefined();
    expect(store.getAgentEventsAfter('session-ledger', 'run-ledger', -1)).toEqual([]);
  });
});
