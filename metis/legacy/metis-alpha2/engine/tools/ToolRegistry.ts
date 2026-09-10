/**
 * Tool registry — stores tool definitions and provides lookup.
 *
 * Ported from metis/tools/registry.py.
 */

import type { ToolSpec } from '../core/types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();

  register(spec: ToolSpec): void {
    if (this.tools.has(spec.name)) {
      throw new Error(`Duplicate tool registration: ${spec.name}`);
    }
    this.tools.set(spec.name, spec);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  /** Return OpenAI function-calling format schemas. */
  schemas(allowedTools?: string[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    const tools = allowedTools
      ? [...this.tools.values()].filter((t) => allowedTools.includes(t.name))
      : [...this.tools.values()];

    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  get size(): number {
    return this.tools.size;
  }
}
