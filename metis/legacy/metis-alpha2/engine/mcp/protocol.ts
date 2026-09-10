/**
 * MCP types — server config, tool definitions, resources.
 *
 * Ported from metis/mcp/spec.py.
 */

// ─── Server Config ────────────────────────────────────────────

export interface MCPServerConfig {
  /** Display name for this MCP server. */
  name: string;
  /** Command to launch the server (e.g., ['npx', '-y', '@anthropic/mcp-server']). */
  command: string[];
  /** Environment variables to pass to the server process. */
  env?: Record<string, string>;
  /** Optional prefix for tool descriptions. */
  descriptionPrefix?: string;
}

// ─── MCP Tool ─────────────────────────────────────────────────

export interface MCPTool {
  /** Tool name as reported by the MCP server. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;
}

// ─── MCP Resource ─────────────────────────────────────────────

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

// ─── JSON-RPC 2.0 ─────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ─── MCP Error Codes ──────────────────────────────────────────

export const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_NOT_INITIALIZED: -32002,
  UNKNOWN_TOOL: -32001,
  TOOL_EXECUTION_ERROR: -32000,
} as const;

export class MCPError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(
    code: number,
    message: string,
    data?: unknown,
  ) {
    super(message);
    this.name = 'MCPError';
    this.code = code;
    this.data = data;
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, data: this.data };
  }
}

// ─── Message Builders ─────────────────────────────────────────

let nextRequestId = 1;

export function makeRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: nextRequestId++,
    method,
    ...(params ? { params } : {}),
  };
}

export function makeNotification(method: string, params?: Record<string, unknown>): JsonRpcNotification {
  return {
    jsonrpc: '2.0',
    method,
    ...(params ? { params } : {}),
  };
}

export function resetRequestId(): void {
  nextRequestId = 1;
}
