/**
 * MCP client — connects to MCP servers via stdio JSON-RPC 2.0.
 *
 * Ported from metis/mcp/client.py.
 *
 * In Tauri v2, actual process spawning will use Tauri's shell Command API.
 * This implementation uses Node.js child_process for development/testing.
 * The transport layer is pluggable via the Transport interface.
 */

import type {
  MCPServerConfig,
  MCPTool,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from './protocol.js';
import { MCPError, MCP_ERROR_CODES, makeRequest, makeNotification } from './protocol.js';

// ─── Transport Interface ──────────────────────────────────────

/**
 * Pluggable transport for MCP JSON-RPC communication.
 * Default implementation uses Node.js child_process stdio.
 * Tauri integration will provide a transport using Tauri's shell API.
 */
export interface MCPTransport {
  start(command: string[], env?: Record<string, string>): Promise<void>;
  send(message: string): void;
  onMessage(handler: (message: string) => void): void;
  onError?(handler: (error: Error) => void): void;
  close(): Promise<void>;
}

// ─── MCP Client ───────────────────────────────────────────────

export class MCPClient {
  private readonly config: MCPServerConfig;
  private readonly transport: MCPTransport;
  private connected = false;
  private negotiatedProtocolVersion: string | null = null;
  private pendingRequests = new Map<number, {
    resolve: (response: JsonRpcResponse) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  constructor(config: MCPServerConfig, transport: MCPTransport) {
    this.config = config;
    this.transport = transport;
  }

  get name(): string {
    return this.config.name;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Protocol version returned by the server during the active initialization handshake. */
  get protocolVersion(): string | null {
    return this.negotiatedProtocolVersion;
  }

  /**
   * Connect to the MCP server:
   * 1. Start the server process
   * 2. Send initialize request
   * 3. Send initialized notification
   */
  async connect(timeout = 30_000): Promise<void> {
    if (this.connected) return;
    this.negotiatedProtocolVersion = null;

    // Set up message and lifecycle routing before launch so an early child-process
    // failure cannot be missed between start() and the initialize request.
    this.transport.onMessage((msg) => this.handleMessage(msg));
    this.transport.onError?.((error) => this.handleTransportError(error));

    try {
      // Start the process
      await this.transport.start(this.config.command, this.config.env);

      // Perform MCP initialization handshake
      const initRequest = makeRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'metis-mcp-client',
          version: '0.1.0',
        },
      });

      const response = await this.sendRequest(initRequest, timeout);

      if (response.error) {
        throw new MCPError(
          response.error.code,
          `MCP initialization failed: ${response.error.message}`,
          response.error.data,
        );
      }

      this.negotiatedProtocolVersion = extractProtocolVersion(response.result);

      // Send initialized notification
      const notification = makeNotification('notifications/initialized');
      this.sendNotification(notification);

      this.connected = true;
    } catch (error) {
      this.connected = false;
      this.negotiatedProtocolVersion = null;
      await this.transport.close().catch(() => {});
      throw error;
    }
  }

  /**
   * List available tools from the MCP server.
   */
  async listTools(): Promise<MCPTool[]> {
    this.ensureConnected();

    const request = makeRequest('tools/list');
    const response = await this.sendRequest(request);

    if (response.error) {
      throw new MCPError(response.error.code, response.error.message, response.error.data);
    }

    return parseMCPTools(response.result);
  }

  /**
   * Call a tool on the MCP server.
   */
  async callTool(name: string, arguments_: Record<string, unknown>): Promise<string> {
    this.ensureConnected();

    const request = makeRequest('tools/call', {
      name,
      arguments: arguments_,
    });

    const response = await this.sendRequest(request, 60_000); // Tools may take longer

    if (response.error) {
      throw new MCPError(response.error.code, response.error.message, response.error.data);
    }

    if (isToolExecutionError(response.result)) {
      // Tool content may contain credentials or remote diagnostics. Keep the
      // client error fixed so callers cannot accidentally reflect it outward.
      throw new MCPError(MCP_ERROR_CODES.TOOL_EXECUTION_ERROR, 'MCP tool execution failed');
    }

    return extractToolResultText(response.result);
  }

  /**
   * Close the connection and terminate the server process.
   * Idempotent: safe to call multiple times (MCPManager invokes close in both the
   * success and error paths of connect/testConnection).
   */
  async close(): Promise<void> {
    this.negotiatedProtocolVersion = null;
    if (!this.connected && this.pendingRequests.size === 0) {
      // Already closed (or never started) — still ensure transport is torn down.
      await this.transport.close();
      return;
    }
    this.connected = false;

    // Clear pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();

    await this.transport.close();
  }

  // ─── Internals ─────────────────────────────────────────────

  private sendRequest(request: JsonRpcRequest, timeoutMs = 30_000): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new MCPError(-1, `Request timeout: ${request.method} (id=${request.id})`));
      }, timeoutMs);

      this.pendingRequests.set(request.id, { resolve, reject, timeout });

      const message = JSON.stringify(request);
      try {
        this.transport.send(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(request.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendNotification(notification: JsonRpcNotification): void {
    const message = JSON.stringify(notification);
    this.transport.send(message);
  }

  private handleTransportError(error: Error): void {
    this.connected = false;
    this.negotiatedProtocolVersion = null;
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private handleMessage(raw: string): void {
    // Handle newline-delimited JSON
    const lines = raw.split('\n').filter((line) => line.trim());
    for (const line of lines) {
      try {
        const message = JSON.parse(line) as JsonRpcResponse;
        if (message.id !== undefined && this.pendingRequests.has(message.id)) {
          const pending = this.pendingRequests.get(message.id)!;
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(message.id);
          pending.resolve(message);
        }
        // Ignore notifications from server for now
      } catch {
        // Ignore malformed messages
      }
    }
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new MCPError(
        MCP_ERROR_CODES.SERVER_NOT_INITIALIZED,
        'MCP client is not connected. Call connect() first.',
      );
    }
  }
}

// ─── Batch Operations ─────────────────────────────────────────

/**
 * Connect to multiple MCP servers in parallel.
 * Returns connected clients and any connection errors.
 */
export async function connectMCPClients(
  configs: MCPServerConfig[],
  transportFactory: (config: MCPServerConfig) => MCPTransport,
): Promise<{ clients: MCPClient[]; errors: Array<{ name: string; error: string }> }> {
  const clients: MCPClient[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  const results = await Promise.allSettled(
    configs.map(async (config) => {
      const client = new MCPClient(config, transportFactory(config));
      await client.connect();
      return client;
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === 'fulfilled') {
      clients.push(result.value);
    } else {
      const config = configs[i]!;
      errors.push({
        name: config.name,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  return { clients, errors };
}

// ─── Helpers ──────────────────────────────────────────────────

function parseMCPTools(result: unknown): MCPTool[] {
  if (!result || typeof result !== 'object') return [];
  const obj = result as Record<string, unknown>;
  const tools = obj.tools;
  if (!Array.isArray(tools)) return [];

  return tools
    .filter((t: unknown) => typeof t === 'object' && t !== null)
    .map((t: unknown) => {
      const tool = t as Record<string, unknown>;
      return {
        name: String(tool.name ?? ''),
        description: String(tool.description ?? ''),
        inputSchema: (tool.inputSchema ?? tool.input_schema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      };
    })
    .filter((t) => t.name);
}

function extractToolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return JSON.stringify(result);

  const obj = result as Record<string, unknown>;
  const content = obj.content;

  // MCP tool results have a content array with text items
  if (Array.isArray(content)) {
    return content
      .filter((c: unknown) => typeof c === 'object' && c !== null)
      .map((c: unknown) => {
        const item = c as Record<string, unknown>;
        if (item.type === 'text' && typeof item.text === 'string') return item.text;
        return JSON.stringify(item);
      })
      .join('\n');
  }

  return JSON.stringify(result);
}

function extractProtocolVersion(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const version = (result as Record<string, unknown>).protocolVersion;
  if (typeof version !== 'string' || version.length === 0 || version.length > 64) return null;
  // eslint-disable-next-line no-control-regex -- protocol versions are single-line tokens
  return /[\u0000-\u001f\u007f-\u009f]/u.test(version) ? null : version;
}

function isToolExecutionError(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && !Array.isArray(result)
    && (result as Record<string, unknown>).isError === true);
}
