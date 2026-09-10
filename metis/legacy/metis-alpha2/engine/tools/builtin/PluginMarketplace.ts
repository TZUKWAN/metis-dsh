/**
 * Plugin Marketplace SDK — extend Metis via community-contributed MCP tools.
 *
 * Provides:
 *   - Plugin manifest format (name, description, tools, version)
 *   - Plugin registry (install, enable, disable, list)
 *   - Plugin discovery (search by name/tag/description)
 *   - Integration with ToolDispatcher/ToolRegistry
 *
 * No external dependencies. Plugins are self-contained TS/JS modules
 * that export tool specs and handlers following the ToolSpec/ToolHandler contract.
 */

import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';

// ─── Plugin Manifest ───────────────────────────────────────

export interface PluginManifest {
  /** Unique plugin ID (npm-style: "@scope/name") */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this plugin does */
  description: string;
  /** Semver version */
  version: string;
  /** Author info */
  author?: string;
  /** Plugin homepage/repo URL */
  homepage?: string;
  /** Categories for discovery */
  tags?: string[];
  /** Minimum Metis engine version required */
  minEngineVersion?: string;
  /** Tool specs provided by this plugin */
  tools: ToolSpec[];
  /** Handlers for the provided tools */
  handlers: Map<string, ToolHandler>;
}

// ─── Plugin State ──────────────────────────────────────────

export type PluginStatus = 'installed' | 'enabled' | 'disabled' | 'error';

export interface PluginEntry {
  manifest: PluginManifest;
  status: PluginStatus;
  installedAt: number;
  enabledAt?: number;
  error?: string;
}

// ─── Plugin Registry ──────────────────────────────────────

export class PluginRegistry {
  private readonly plugins = new Map<string, PluginEntry>();

  /** Install a plugin from its manifest. */
  install(manifest: PluginManifest): void {
    if (this.plugins.has(manifest.id)) {
      throw new Error(`Plugin '${manifest.id}' is already installed`);
    }
    this.plugins.set(manifest.id, {
      manifest,
      status: 'enabled',
      installedAt: Date.now(),
      enabledAt: Date.now(),
    });
  }

  /** Uninstall a plugin. */
  uninstall(id: string): boolean {
    return this.plugins.delete(id);
  }

  /** Enable a disabled plugin. */
  enable(id: string): void {
    const entry = this.plugins.get(id);
    if (!entry) throw new Error(`Plugin '${id}' not found`);
    entry.status = 'enabled';
    entry.enabledAt = Date.now();
    entry.error = undefined;
  }

  /** Disable a plugin without uninstalling. */
  disable(id: string): void {
    const entry = this.plugins.get(id);
    if (!entry) throw new Error(`Plugin '${id}' not found`);
    entry.status = 'disabled';
  }

  /** Mark a plugin as errored. */
  markError(id: string, error: string): void {
    const entry = this.plugins.get(id);
    if (!entry) return;
    entry.status = 'error';
    entry.error = error;
  }

  /** Get a plugin entry by ID. */
  get(id: string): PluginEntry | undefined {
    return this.plugins.get(id);
  }

  /** List all installed plugins. */
  list(): PluginEntry[] {
    return [...this.plugins.values()];
  }

  /** List plugins by status. */
  listByStatus(status: PluginStatus): PluginEntry[] {
    return this.list().filter((p) => p.status === status);
  }

  /** Search plugins by name, description, or tags. */
  search(query: string): PluginEntry[] {
    const q = query.toLowerCase();
    return this.list().filter((p) =>
      p.manifest.name.toLowerCase().includes(q) ||
      p.manifest.description.toLowerCase().includes(q) ||
      p.manifest.tags?.some((t) => t.toLowerCase().includes(q))
    );
  }

  /** Get all tool specs from enabled plugins. */
  getEnabledToolSpecs(): ToolSpec[] {
    return this.listByStatus('enabled').flatMap((p) => p.manifest.tools);
  }

  /** Get all handlers from enabled plugins. */
  getEnabledHandlers(): Map<string, ToolHandler> {
    const map = new Map<string, ToolHandler>();
    for (const plugin of this.listByStatus('enabled')) {
      for (const [name, handler] of plugin.manifest.handlers) {
        map.set(name, handler);
      }
    }
    return map;
  }

  /** Count plugins by status. */
  stats(): Record<PluginStatus, number> {
    const counts: Record<PluginStatus, number> = {
      installed: 0, enabled: 0, disabled: 0, error: 0,
    };
    for (const plugin of this.plugins.values()) {
      counts[plugin.status]++;
    }
    return counts;
  }
}

// ─── Singleton ─────────────────────────────────────────────

let _instance: PluginRegistry | null = null;

export function getPluginRegistry(): PluginRegistry {
  if (!_instance) {
    _instance = new PluginRegistry();
  }
  return _instance;
}

// ─── Plugin Tools ──────────────────────────────────────────

export const PLUGIN_TOOLS: ToolSpec[] = [
  {
    name: 'plugin_list',
    description: 'List all installed plugins with their status, version, and description.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: enabled, disabled, installed, error (optional)' },
      },
    },
  },
  {
    name: 'plugin_search',
    description: 'Search installed plugins by name, description, or tags.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'plugin_info',
    description: 'Get detailed information about a specific plugin.',
    parameters: {
      type: 'object',
      properties: {
        pluginId: { type: 'string', description: 'Plugin ID to inspect' },
      },
      required: ['pluginId'],
    },
  },
];

export const pluginListHandler: ToolHandler = async (args) => {
  try {
    const { getPluginRegistry } = await import('./PluginMarketplace.js');
    const registry = getPluginRegistry();

    const status = args.status ? String(args.status) as PluginStatus : undefined;
    const plugins = status ? registry.listByStatus(status) : registry.list();

    if (plugins.length === 0) {
      return 'No plugins installed. Use the MCP SDK to create and install plugins.';
    }

    const lines = plugins.map((p) =>
      `- **${p.manifest.id}** v${p.manifest.version} [${p.status}] — ${p.manifest.description}`
    );
    const stats = registry.stats();
    return `Plugin Marketplace (${plugins.length} plugin(s)):\n` +
      `Enabled: ${stats.enabled} | Disabled: ${stats.disabled} | Error: ${stats.error}\n\n` +
      lines.join('\n');
  } catch (err) {
    return `Plugin list failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const pluginSearchHandler: ToolHandler = async (args) => {
  try {
    const { getPluginRegistry } = await import('./PluginMarketplace.js');
    const registry = getPluginRegistry();
    const query = String(args.query ?? '');
    const results = registry.search(query);

    if (results.length === 0) return `No plugins match '${query}'.`;

    return results.map((p) =>
      `- **${p.manifest.id}** v${p.manifest.version} — ${p.manifest.description} (by ${p.manifest.author ?? 'unknown'})`
    ).join('\n');
  } catch (err) {
    return `Plugin search failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const pluginInfoHandler: ToolHandler = async (args) => {
  try {
    const { getPluginRegistry } = await import('./PluginMarketplace.js');
    const registry = getPluginRegistry();
    const pluginId = String(args.pluginId ?? '');

    const entry = registry.get(pluginId);
    if (!entry) return `Plugin '${pluginId}' not found.`;

    const m = entry.manifest;
    const lines = [
      `# ${m.name} (${m.id})`,
      `Version: ${m.version}`,
      `Status: ${entry.status}`,
      `Description: ${m.description}`,
      m.author ? `Author: ${m.author}` : null,
      m.homepage ? `Homepage: ${m.homepage}` : null,
      m.tags?.length ? `Tags: ${m.tags.join(', ')}` : null,
      '',
      `## Tools (${m.tools.length})`,
      ...m.tools.map((t) => `- **${t.name}**: ${t.description}`),
    ];
    return lines.filter(Boolean).join('\n');
  } catch (err) {
    return `Plugin info failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export function getPluginToolHandlers(): Map<string, ToolHandler> {
  const map = new Map<string, ToolHandler>();
  map.set('plugin_list', pluginListHandler);
  map.set('plugin_search', pluginSearchHandler);
  map.set('plugin_info', pluginInfoHandler);
  return map;
}
