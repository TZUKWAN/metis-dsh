import { describe, it, expect } from 'vitest';
import { HookBus } from '../../engine/core/HookBus.js';
import { validateConfig } from '../../engine/core/Config.js';

describe('HookBus', () => {
  it('should register and emit sync handlers', () => {
    const bus = new HookBus();
    const results: string[] = [];

    bus.register('test', () => { results.push('a'); });
    bus.register('test', () => { results.push('b'); });

    bus.emit('test');
    expect(results).toEqual(['a', 'b']);
  });

  it('should respect priority ordering', () => {
    const bus = new HookBus();
    const results: string[] = [];

    bus.register('test', () => { results.push('low'); }, { priority: 100 });
    bus.register('test', () => { results.push('high'); }, { priority: 1 });
    bus.register('test', () => { results.push('mid'); }, { priority: 50 });

    bus.emit('test');
    expect(results).toEqual(['high', 'mid', 'low']);
  });

  it('should block chain when handler returns null', () => {
    const bus = new HookBus();
    const results: string[] = [];

    bus.register('test', () => { results.push('first'); return null; }, { priority: 1 });
    bus.register('test', () => { results.push('second'); }, { priority: 2 });

    bus.emit('test');
    expect(results).toEqual(['first']);
  });

  it('should handle async handlers in emitAsync', async () => {
    const bus = new HookBus();
    const results: string[] = [];

    bus.register('test', async () => {
      await Promise.resolve();
      results.push('async');
    });
    bus.register('test', () => { results.push('sync'); }, { priority: 1 });

    await bus.emitAsync('test');
    expect(results).toEqual(['sync', 'async']);
  });

  it('should pass context through handlers', () => {
    const bus = new HookBus();

    bus.register('test', (ctx) => {
      ctx.value = (ctx.value as number) + 1;
    });

    const result = bus.emit('test', { value: 0 });
    expect(result.value).toBe(1);
  });

  it('should support unregister', () => {
    const bus = new HookBus();
    const results: string[] = [];

    bus.register('test', () => { results.push('a'); }, { name: 'handler-a' });
    bus.register('test', () => { results.push('b'); }, { name: 'handler-b' });

    bus.unregister('test', 'handler-a');
    bus.emit('test');
    expect(results).toEqual(['b']);
  });

  it('should report event names and handler count', () => {
    const bus = new HookBus();
    bus.register('a', () => {});
    bus.register('b', () => {});

    expect(bus.eventNames).toContain('a');
    expect(bus.eventNames).toContain('b');
    expect(bus.handlerCount('a')).toBe(1);
    expect(bus.handlerCount('c')).toBe(0);
  });
});

describe('Config', () => {
  it('should validate without warnings in default config', () => {
    const warnings = validateConfig();
    expect(warnings).toEqual([]);
  });
});
