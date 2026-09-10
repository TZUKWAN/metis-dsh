/**
 * Memory tools (METIS-F12) — let the agent explicitly remember and recall
 * project-scoped facts across conversations.
 *
 * The active project scope comes from ToolContext.projectId (forwarded from
 * AgentRunRequest.projectId). Without a project scope, writes land in global
 * memory and the tool says so — memory never silently leaks across projects.
 */

import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';
import type { PersistenceStore } from '../../persistence/PersistenceStore.js';

const MEMORY_LIMITS = Object.freeze({
  contentChars: 8000,
  keyChars: 128,
  categoryChars: 64,
  recallLimit: 20,
} as const);

export const MEMORY_REMEMBER_TOOL: ToolSpec = {
  name: 'memory_remember',
  description: 'Persist a fact, decision, or preference so future conversations in the same project can recall it. Use for stable user constraints, verified facts, and decisions that should persist across sessions.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The fact/decision/preference to remember (plain text).' },
      key: { type: 'string', description: 'Optional stable identifier (defaults to a timestamped key).' },
      category: { type: 'string', description: 'Optional category: general | key_decision | preference (default general).' },
    },
    required: ['content'],
  },
};

export const MEMORY_RECALL_TOOL: ToolSpec = {
  name: 'memory_recall',
  description: 'Recall memories saved for the current project plus global memories. Returns the most recently updated entries, newest first.',
  parameters: {
    type: 'object',
    properties: {
      category: { type: 'string', description: 'Optional category filter: general | key_decision | preference.' },
      limit: { type: 'number', description: 'Max entries to return (default 10, max 20).' },
    },
    required: [],
  },
};

export function getMemoryToolSpecs(): ToolSpec[] {
  return [MEMORY_REMEMBER_TOOL, MEMORY_RECALL_TOOL];
}

/** Internal key prefix that would leak into agent-visible text; strip it for display. */
function displayKey(key: string): string {
  return key.replace(/^p:[^:]+:/, '');
}

export function getMemoryToolHandlers(store?: PersistenceStore): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set(MEMORY_REMEMBER_TOOL.name, async (args, context) => {
    if (!store) return 'memory_unavailable: memory store is not connected';
    const content = String(args.content ?? '').trim();
    if (!content) return 'memory_remember_error: content is required';
    if (content.length > MEMORY_LIMITS.contentChars) {
      return `memory_remember_error: content exceeds ${MEMORY_LIMITS.contentChars} chars`;
    }
    const rawKey = String(args.key ?? '').trim();
    const key = (rawKey.slice(0, MEMORY_LIMITS.keyChars) || `note:${Date.now()}`);
    const category = (String(args.category ?? 'general').trim().slice(0, MEMORY_LIMITS.categoryChars) || 'general');
    const projectId = context.projectId;
    if (projectId) {
      store.setMemoryScoped(projectId, key, content, category);
      return `memory_remembered: key=${displayKey(key)} category=${category} project=${projectId}`;
    }
    store.setMemory(key, content, category);
    return `memory_remembered: key=${key} category=${category} scope=global`;
  });

  handlers.set(MEMORY_RECALL_TOOL.name, async (args, context) => {
    if (!store) return 'memory_unavailable: memory store is not connected';
    const category = String(args.category ?? '').trim() || undefined;
    const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), MEMORY_LIMITS.recallLimit);
    const projectId = context.projectId;

    const collect = (cat: string) => {
      const projectEntries = projectId ? store.getMemoryByCategory(cat, projectId) : [];
      const globalEntries = store.getMemoryByCategory(cat);
      return [...projectEntries, ...globalEntries];
    };
    const entries = category
      ? collect(category)
      : ['key_decision', 'preference', 'general'].flatMap((cat) => collect(cat));

    const sorted = [...entries].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    if (sorted.length === 0) return 'memory_recall_empty: no memories found';
    return sorted.map((entry) => `- [${entry.category}] ${displayKey(entry.key)}: ${entry.value}`).join('\n');
  });

  return handlers;
}
