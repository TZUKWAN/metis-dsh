/**
 * Verify that every multi-agent template references only real builtin tools.
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from './ToolRegistry.js';
import { ToolDispatcher } from './ToolDispatcher.js';
import { registerBuiltinTools } from './index.js';
import { DEFAULT_AGENT_TEMPLATES } from '../multiagent/MultiAgentOrchestrator.js';

describe('multi-agent template tool names', () => {
  it('every agent template references only tools that exist in the builtin registry', () => {
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    registerBuiltinTools(registry, dispatcher);
    const realNames = new Set(registry.list().map((t) => t.name));

    const missing: string[] = [];
    for (const agent of Object.values(DEFAULT_AGENT_TEMPLATES)) {
      for (const toolName of agent.allowedTools ?? []) {
        if (!realNames.has(toolName)) missing.push(`${agent.id}->${toolName}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
