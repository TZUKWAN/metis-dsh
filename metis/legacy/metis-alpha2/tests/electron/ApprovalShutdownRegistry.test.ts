import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalShutdownRegistry, ScenarioApprovalRegistry } from '../../electron/ApprovalShutdownRegistry.js';
import { RuntimeShutdownCoordinator } from '../../electron/RuntimeShutdownCoordinator.js';

describe('ApprovalShutdownRegistry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails every pending approval closed during the runtime drain', async () => {
    const runtimeShutdown = new RuntimeShutdownCoordinator();
    const registry = new ApprovalShutdownRegistry(runtimeShutdown, 'hitl-approval');
    const approvals = ['request-1', 'request-2'].map((requestId) => registry.request(requestId, {
      timeoutMs: 300_000,
      present: vi.fn(),
    }));

    expect(registry.pendingCount).toBe(2);
    const draining = runtimeShutdown.drain(1_000);

    await expect(Promise.all(approvals)).resolves.toEqual([false, false]);
    await expect(draining).resolves.toEqual({ timedOut: false, pending: [] });
    expect(registry.pendingCount).toBe(0);
  });

  it('clears the timer and presentation cleanup, then rejects a late response', async () => {
    vi.useFakeTimers();
    const runtimeShutdown = new RuntimeShutdownCoordinator();
    const registry = new ApprovalShutdownRegistry(runtimeShutdown, 'hitl-approval');
    const cleanup = vi.fn();
    const approval = registry.request('request-2', {
      timeoutMs: 300_000,
      present: vi.fn(() => cleanup),
    });

    expect(registry.resolve('request-2', true)).toBe(true);
    await expect(approval).resolves.toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(registry.resolve('request-2', false)).toBe(false);
    expect(registry.pendingCount).toBe(0);
    await vi.runOnlyPendingTimersAsync();
    expect(registry.pendingCount).toBe(0);
  });

  it('keeps the shutdown registration until the approval consumer continuation runs', async () => {
    const runtimeShutdown = new RuntimeShutdownCoordinator();
    const registry = new ApprovalShutdownRegistry(runtimeShutdown, 'hitl-approval');
    const approval = registry.request('request-order', {
      timeoutMs: 300_000,
      present: vi.fn(),
    });
    let consumerFinished = false;
    const consumer = approval.then(() => {
      consumerFinished = true;
    });

    expect(registry.resolve('request-order', false)).toBe(true);
    let drainFinished = false;
    const draining = runtimeShutdown.drain().then((result) => {
      drainFinished = true;
      return result;
    });
    await consumer;
    expect(consumerFinished).toBe(true);
    expect(drainFinished).toBe(false);
    await expect(draining).resolves.toEqual({ timedOut: false, pending: [] });
  });

  it('fails closed on timeout and rejects new requests after shutdown', async () => {
    vi.useFakeTimers();
    const runtimeShutdown = new RuntimeShutdownCoordinator();
    const registry = new ApprovalShutdownRegistry(runtimeShutdown, 'hitl-approval');
    const cleanup = vi.fn();
    const present = vi.fn(() => cleanup);
    const approval = registry.request('request-3', { timeoutMs: 20, present });

    await vi.advanceTimersByTimeAsync(20);
    await expect(approval).resolves.toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(registry.pendingCount).toBe(0);

    await runtimeShutdown.drain();
    const latePresent = vi.fn();
    await expect(registry.request('request-4', { timeoutMs: 20, present: latePresent })).resolves.toBe(false);
    expect(latePresent).not.toHaveBeenCalled();
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('rejects new approvals while an existing drain is still waiting', async () => {
    const runtimeShutdown = new RuntimeShutdownCoordinator();
    const registry = new ScenarioApprovalRegistry(runtimeShutdown);
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => { releaseBlocker = resolve; });
    runtimeShutdown.register({ id: 'shutdown-blocker', promise: blocker, abort: vi.fn() });

    const draining = runtimeShutdown.drain(1_000);
    const latePresent = vi.fn();
    await expect(registry.request('scenario-late', {
      timeoutMs: 300_000,
      present: latePresent,
    })).resolves.toBe(false);
    expect(latePresent).not.toHaveBeenCalled();
    expect(registry.pendingCount).toBe(0);

    releaseBlocker();
    await expect(draining).resolves.toEqual({ timedOut: false, pending: [] });
  });

  it('uses the same fail-closed lifecycle for scenario approvals', async () => {
    const runtimeShutdown = new RuntimeShutdownCoordinator();
    const registry = new ScenarioApprovalRegistry(runtimeShutdown);
    const approval = registry.request('scenario-1', {
      timeoutMs: 300_000,
      present: vi.fn(),
    });

    const draining = runtimeShutdown.drain();
    expect(registry.resolve('scenario-1', true)).toBe(false);
    await expect(approval).resolves.toBe(false);
    await expect(draining).resolves.toEqual({ timedOut: false, pending: [] });
    expect(registry.pendingCount).toBe(0);
  });

  it('does not allow a late renderer decision to write after the store closes', async () => {
    const runtimeShutdown = new RuntimeShutdownCoordinator();
    const registry = new ApprovalShutdownRegistry(runtimeShutdown, 'hitl-approval');
    let storeClosed = false;
    let writes = 0;
    const approval = registry.request('request-late-response', {
      timeoutMs: 300_000,
      present: vi.fn(),
    });
    const continuation = approval.then((approved) => {
      if (!storeClosed && approved) writes += 1;
    });

    const draining = runtimeShutdown.drain();
    await expect(approval).resolves.toBe(false);
    await continuation;
    expect(storeClosed).toBe(false);
    expect(writes).toBe(0);

    await expect(draining).resolves.toEqual({ timedOut: false, pending: [] });
    storeClosed = true;
    expect(registry.resolve('request-late-response', true)).toBe(false);
    expect(writes).toBe(0);
    expect(registry.pendingCount).toBe(0);
  });
});
