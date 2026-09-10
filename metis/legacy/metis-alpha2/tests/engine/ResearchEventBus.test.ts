/**
 * ResearchEventBus — pub/sub contract tests.
 */

import { describe, it, expect, vi } from 'vitest';
import { ResearchEventBus } from '../../engine/research/ResearchEventBus.js';

describe('ResearchEventBus', () => {
  it('delivers events to all subscribers', () => {
    const bus = new ResearchEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);

    bus.emit({ type: 'engine-started', sessionId: 's1', goal: 'g', plan: [{ phase: 'idea', name: 'Idea' }] });

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(a).toHaveBeenCalledWith(expect.objectContaining({ type: 'engine-started', sessionId: 's1' }));
  });

  it('unsubscribe stops delivery', () => {
    const bus = new ResearchEventBus();
    const listener = vi.fn();
    const unsub = bus.subscribe(listener);
    unsub();
    bus.emit({ type: 'engine-interrupted', sessionId: 's1', reason: 'test' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('a failing listener does not block other listeners', () => {
    const bus = new ResearchEventBus();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwing = vi.fn(() => { throw new Error('boom'); });
    const after = vi.fn();
    bus.subscribe(throwing);
    bus.subscribe(after);

    bus.emit({ type: 'engine-completed', sessionId: 's1', summary: 'done', artifactIds: [] });

    expect(throwing).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it('reports listener count', () => {
    const bus = new ResearchEventBus();
    expect(bus.listenerCount).toBe(0);
    bus.subscribe(() => {});
    expect(bus.listenerCount).toBe(1);
  });
});
