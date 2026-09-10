import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../tools/ToolRegistry.js';
import { resolveTool, resolveToolSet, allAvailable } from '../CapabilityRouter.js';

describe('CapabilityRouter', () => {
  it('returns available for registered tool', () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'search_papers', description: 'Search', parameters: {} });
    expect(resolveTool(registry, 'search_papers').available).toBe(true);
  });

  it('returns unavailable for phantom tool', () => {
    const registry = new ToolRegistry();
    expect(resolveTool(registry, 'phantom_tool').available).toBe(false);
    expect(resolveTool(registry, 'phantom_tool').reason).toContain('not registered');
  });

  it('resolves tool set with mixed results', () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'a', description: '', parameters: {} });
    registry.register({ name: 'b', description: '', parameters: {} });
    const results = resolveToolSet(registry, ['a', 'b', 'c']);
    expect(results.map((r) => r.available)).toEqual([true, true, false]);
    expect(allAvailable(results)).toBe(false);
  });

  it('allAvailable returns true when all tools present', () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'x', description: '', parameters: {} });
    expect(allAvailable(resolveToolSet(registry, ['x']))).toBe(true);
  });
});
