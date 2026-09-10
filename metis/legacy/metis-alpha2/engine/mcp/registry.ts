/**
 * MCP module barrel export.
 */

export type {
  MCPServerConfig,
  MCPTool,
  MCPResource,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcError,
} from './protocol.js';

export {
  MCPError,
  MCP_ERROR_CODES,
  makeRequest,
  makeNotification,
} from './protocol.js';

export type { MCPTransport } from './MCPClient.js';
export { MCPClient, connectMCPClients } from './MCPClient.js';
