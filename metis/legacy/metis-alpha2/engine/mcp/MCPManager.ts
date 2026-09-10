/**
 * MCPManager — manages MCP server connections and tool registration.
 *
 * Responsibilities:
 *   - Load server configs from SQLite
 *   - Connect/disconnect servers
 *   - Register MCP tools into ToolRegistry
 *   - Expose connection status
 */

import type { PersistenceStore } from '../persistence/PersistenceStore.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import { MCPClient } from './MCPClient.js';
import { StdioTransport } from './StdioTransport.js';
import type { MCPTool } from './protocol.js';
import { buildArgsDecoder } from '../tools/ArgsValidator.js';

export interface MCPServerStatus {
  id: string;
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export class MCPManager {
  private readonly store: PersistenceStore;
  private readonly registry: ToolRegistry;
  private readonly clients = new Map<string, MCPClient>();
  private readonly toolsByServer = new Map<string, MCPTool[]>();

  constructor(store: PersistenceStore, registry: ToolRegistry) {
    this.store = store;
    this.registry = registry;
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  /**
   * Load all enabled MCP servers from persistence and connect.
   */
  async loadAndConnectAll(): Promise<void> {
    const servers = this.store.getMCPServers().filter((s) => s.enabled);
    for (const server of servers) {
      await this.connectServer(server);
    }
  }

  /**
   * Disconnect all MCP servers.
   */
  async disconnectAll(): Promise<void> {
    for (const [, client] of this.clients) {
      await client.close().catch(() => {});
    }
    this.clients.clear();
    this.toolsByServer.clear();
  }

  // ─── Server Management ──────────────────────────────────────

  async addServer(config: {
    id: string;
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    enabled: boolean;
  }): Promise<MCPServerStatus> {
    this.store.saveMCPServer({
      ...config,
      createdAt: Date.now(),
    });

    if (config.enabled) {
      return this.connectServer(config);
    }

    return { id: config.id, name: config.name, connected: false, toolCount: 0 };
  }

  async removeServer(id: string): Promise<void> {
    await this.disconnectServer(id);
    this.store.deleteMCPServer(id);
  }

  async toggleServer(id: string, enabled: boolean): Promise<MCPServerStatus> {
    this.store.toggleMCPServer(id, enabled);
    const servers = this.store.getMCPServers();
    const server = servers.find((s) => s.id === id);
    if (!server) throw new Error(`Server '${id}' not found`);

    if (enabled) {
      return this.connectServer(server);
    } else {
      await this.disconnectServer(id);
      return { id, name: server.name, connected: false, toolCount: 0 };
    }
  }

  async testConnection(config: {
    command: string;
    args: string[];
    env: Record<string, string>;
  }): Promise<{ success: boolean; error?: string; toolCount?: number }> {
    const client = new MCPClient(
      { name: 'test', command: [config.command, ...config.args], env: config.env },
      new StdioTransport(),
    );

    try {
      await client.connect(3_000);
      const tools = await client.listTools();
      await client.close();
      return { success: true, toolCount: tools.length };
    } catch (err) {
      await client.close().catch(() => {});
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── Status ─────────────────────────────────────────────────

  getStatus(): MCPServerStatus[] {
    const servers = this.store.getMCPServers();
    return servers.map((s) => {
      const client = this.clients.get(s.id);
      const tools = this.toolsByServer.get(s.id);
      return {
        id: s.id,
        name: s.name,
        connected: client?.isConnected ?? false,
        toolCount: tools?.length ?? 0,
      };
    });
  }

  getAllTools(): MCPTool[] {
    const all: MCPTool[] = [];
    for (const [, tools] of this.toolsByServer) {
      all.push(...tools);
    }
    return all;
  }

  // ─── Helpers ────────────────────────────────────────────────

  private async connectServer(server: {
    id: string;
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
  }): Promise<MCPServerStatus> {
    // Disconnect existing if any
    await this.disconnectServer(server.id);

    const client = new MCPClient(
      { name: server.name, command: [server.command, ...server.args], env: server.env },
      new StdioTransport(),
    );

    try {
      await client.connect(5_000);
      const tools = await client.listTools();
      this.clients.set(server.id, client);
      this.toolsByServer.set(server.id, tools.filter((t) => {
        try { buildArgsDecoder(t.inputSchema); return true; } catch { return false; }
      }));

      // Register tools in ToolRegistry with mcp_ prefix to avoid collisions.
      // Pre-compile each tool's inputSchema; tools with unsupported schemas
      // are rejected at registration time (fail-closed) and never exposed.
      let registeredCount = 0;
      for (const tool of tools) {
        try {
          buildArgsDecoder(tool.inputSchema);
        } catch {
          // Schema validation failed — skip this tool, handler0 guaranteed.
          continue;
        }
        this.registry.register({
          name: `mcp_${server.name}_${tool.name}`,
          description: `[${server.name}] ${tool.description}`,
          parameters: tool.inputSchema,
        });
        registeredCount++;
      }

      return {
        id: server.id,
        name: server.name,
        connected: true,
        toolCount: registeredCount,
      };
    } catch (err) {
      await client.close().catch(() => {});
      return {
        id: server.id,
        name: server.name,
        connected: false,
        toolCount: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async disconnectServer(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (client) {
      // Unregister tools
      const tools = this.toolsByServer.get(id);
      if (tools) {
        const serverName = this.store.getMCPServers().find((s) => s.id === id)?.name ?? id;
        for (const tool of tools) {
          this.registry.unregister(`mcp_${serverName}_${tool.name}`);
        }
      }
      await client.close().catch(() => {});
      this.clients.delete(id);
      this.toolsByServer.delete(id);
    }
  }
}
