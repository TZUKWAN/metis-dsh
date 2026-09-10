/** Behavioral coverage for the application shutdown drain coordinator. */
import { describe, expect, it, vi } from 'vitest';
import {
  registerRuntimeRunOrRollback,
  RuntimeShutdownCoordinator,
  trackEphemeralOperation,
} from './RuntimeShutdownCoordinator.js';

describe('RuntimeShutdownCoordinator', () => {
  it('aborts registered work, waits for settlement, and rejects new registrations', async () => {
    const coordinator = new RuntimeShutdownCoordinator();
    let resolve!: () => void;
    const completion = new Promise<void>((r) => { resolve = r; });
    const abort = vi.fn();
    const unregister = coordinator.register({ id: 'chat:s1', promise: completion, abort });
    expect(unregister).toEqual(expect.any(Function));
    const draining = coordinator.drain(1000);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(coordinator.isDraining()).toBe(true);
    expect(coordinator.register({ id: 'late', promise: Promise.resolve(), abort: vi.fn() })).toBeNull();
    resolve();
    await expect(draining).resolves.toEqual({ timedOut: false, pending: [] });
  });

  it('continues when an abort callback throws and reports timeout pending ids', async () => {
    const coordinator = new RuntimeShutdownCoordinator();
    const never = new Promise<void>(() => undefined);
    const throwing = vi.fn(() => { throw new Error('abort failed'); });
    coordinator.register({ id: 'throwing', promise: Promise.resolve(), abort: throwing });
    coordinator.register({ id: 'stuck', promise: never, abort: vi.fn() });
    await expect(coordinator.drain(1)).resolves.toEqual({ timedOut: true, pending: ['stuck'] });
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(coordinator.drain(1)).resolves.toBeDefined();
  });

  it('unregisters a settled registration and makes an empty drain terminal', async () => {
    const coordinator = new RuntimeShutdownCoordinator();
    const promise = Promise.resolve();
    const unregister = coordinator.register({ id: 'done', promise, abort: vi.fn() });
    expect(unregister).toEqual(expect.any(Function));
    await promise;
    await Promise.resolve();
    expect(await coordinator.drain()).toEqual({ timedOut: false, pending: [] });
    expect(coordinator.register({ id: 'after', promise: Promise.resolve(), abort: vi.fn() })).toBeNull();
  });

  it('aborts and rolls back published state when registration is rejected', async () => {
    const coordinator = new RuntimeShutdownCoordinator();
    await expect(coordinator.drain()).resolves.toEqual({ timedOut: false, pending: [] });

    const abort = vi.fn();
    const rollback = vi.fn();
    const execute = vi.fn();
    const completion = Promise.resolve();
    const unregister = registerRuntimeRunOrRollback(
      coordinator,
      { id: 'late-run', promise: completion, abort },
      rollback,
    );
    const admit = () => {
      if (unregister) execute();
    };

    admit();
    expect(unregister).toBeNull();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps a registered run available and does not roll it back', () => {
    const coordinator = new RuntimeShutdownCoordinator();
    const abort = vi.fn();
    const rollback = vi.fn();
    const unregister = registerRuntimeRunOrRollback(
      coordinator,
      { id: 'live-run', promise: new Promise<void>(() => undefined), abort },
      rollback,
    );

    expect(unregister).toEqual(expect.any(Function));
    expect(abort).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    unregister?.();
  });

  it('rejects ephemeral admission after drain without starting work', async () => {
    const coordinator = new RuntimeShutdownCoordinator();
    await coordinator.drain();
    const tracked = trackEphemeralOperation(coordinator, {
      id: 'late-ephemeral',
      rejection: { code: 'application_shutting_down' },
    });

    expect(tracked).toEqual({ admitted: false, rejection: { code: 'application_shutting_down' } });
    expect(tracked.admitted).toBe(false);
  });

  it('aborts an admitted ephemeral operation and cleanup removes it from the drain', async () => {
    const coordinator = new RuntimeShutdownCoordinator();
    const tracked = trackEphemeralOperation(coordinator, {
      id: 'ephemeral',
      rejection: { code: 'application_shutting_down' },
    });
    expect(tracked.admitted).toBe(true);
    if (!tracked.admitted) return;

    const draining = coordinator.drain(1000);
    expect(tracked.signal.aborted).toBe(true);
    tracked.cleanup();
    await expect(draining).resolves.toEqual({ timedOut: false, pending: [] });
  });
});
