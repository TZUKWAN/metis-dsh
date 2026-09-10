/**
 * CapabilityRouter — fail-closed tool resolution. Only tools registered
 * in the active ToolRegistry may be routed; phantom/disconnected tools
 * return an explicit unavailable result instead of silently failing.
 */
import type { ToolRegistry } from '../tools/ToolRegistry.js';

export interface RouterResult {
  available: boolean;
  toolName: string;
  reason?: string;
}

export function resolveTool(registry: ToolRegistry, toolName: string): RouterResult {
  try {
    const spec = registry.get(toolName);
    if (!spec) return { available: false, toolName, reason: `Tool "${toolName}" is not registered` };
    return { available: true, toolName };
  } catch {
    return { available: false, toolName, reason: `Tool registry unavailable` };
  }
}

export function resolveToolSet(registry: ToolRegistry, toolNames: string[]): RouterResult[] {
  return toolNames.map((name) => resolveTool(registry, name));
}

export function allAvailable(results: RouterResult[]): boolean {
  return results.every((r) => r.available);
}
