/**
 * Tests for MCP client — using a mock transport.
 */

import { describe, it, expect } from 'vitest';
import { MCPClient, connectMCPClients } from '../../engine/mcp/MCPClient.js';
import type { MCPTransport } from '../../engine/mcp/MCPClient.js';
import type { MCPServerConfig, JsonRpcResponse } from '../../engine/mcp/protocol.js';
import { MCPError, makeRequest, makeNotification } from '../../engine/mcp/protocol.js';

// ─── Mock Transport ───────────────────────────────────────────

class MockTransport implements MCPTransport {
  private messageHandler?: (message: string) => void;
  private errorHandler?: (error: Error) => void;
  private started = false;
  public sentMessages: string[] = [];

  async start(): Promise<void> {
    this.started = true;
  }

  send(message: string): void {
    this.sentMessages.push(message);
  }

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  async close(): Promise<void> {
    this.started = false;
  }

  /** Simulate receiving a message from the server. */
  simulateMessage(response: JsonRpcResponse): void {
    if (this.messageHandler) {
      this.messageHandler(JSON.stringify(response));
    }
  }

  simulateError(error: Error): void {
    this.errorHandler?.(error);
  }

  get isStarted(): boolean {
    return this.started;
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function makeConfig(name = 'test-server'): MCPServerConfig {
  return {
    name,
    command: ['echo', 'test'],
  };
}

function makeClient(config?: MCPServerConfig): { client: MCPClient; transport: MockTransport } {
  const cfg = config ?? makeConfig();
  const transport = new MockTransport();
  const client = new MCPClient(cfg, transport);
  return { client, transport };
}

// ─── Tests ────────────────────────────────────────────────────

describe('MCPClient', () => {
  it('connects and performs initialization handshake', async () => {
    const { client, transport } = makeClient();

    // Start the connect and handle the init response
    const connectPromise = client.connect();

    // Wait a tick for the request to be sent
    await new Promise((r) => setTimeout(r, 10));

    // Simulate server's initialize response
    const sentReq = JSON.parse(transport.sentMessages[0]);
    expect(sentReq.method).toBe('initialize');
    expect(sentReq.params.protocolVersion).toBe('2024-11-05');

    transport.simulateMessage({
      jsonrpc: '2.0',
      id: sentReq.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'test-server', version: '1.0.0' },
      },
    });

    await connectPromise;

    expect(client.isConnected).toBe(true);
    expect(client.name).toBe('test-server');
    expect(client.protocolVersion).toBe('2024-11-05');

    // Should have sent the initialized notification
    const notification = JSON.parse(transport.sentMessages[1]);
    expect(notification.method).toBe('notifications/initialized');
  });

  it('lists tools from server', async () => {
    const { client, transport } = makeClient();

    // Connect first
    const connectPromise = client.connect();
    await new Promise((r) => setTimeout(r, 10));
    const initReq = JSON.parse(transport.sentMessages[0]);
    transport.simulateMessage({ jsonrpc: '2.0', id: initReq.id, result: { capabilities: {} } });
    await connectPromise;

    // Now list tools
    const listPromise = client.listTools();
    await new Promise((r) => setTimeout(r, 10));

    const listReq = JSON.parse(transport.sentMessages[2]);
    expect(listReq.method).toBe('tools/list');

    transport.simulateMessage({
      jsonrpc: '2.0',
      id: listReq.id,
      result: {
        tools: [
          {
            name: 'read_file',
            description: 'Read a file',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
          },
          {
            name: 'search',
            description: 'Search the web',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      },
    });

    const tools = await listPromise;
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('read_file');
    expect(tools[1].name).toBe('search');
  });

  it('calls a tool and extracts text result', async () => {
    const { client, transport } = makeClient();

    // Connect
    const connectPromise = client.connect();
    await new Promise((r) => setTimeout(r, 10));
    const initReq = JSON.parse(transport.sentMessages[0]);
    transport.simulateMessage({ jsonrpc: '2.0', id: initReq.id, result: {} });
    await connectPromise;

    // Call tool
    const callPromise = client.callTool('read_file', { path: '/test.txt' });
    await new Promise((r) => setTimeout(r, 10));

    const callReq = JSON.parse(transport.sentMessages[2]);
    expect(callReq.method).toBe('tools/call');
    expect(callReq.params.name).toBe('read_file');
    expect(callReq.params.arguments).toEqual({ path: '/test.txt' });

    transport.simulateMessage({
      jsonrpc: '2.0',
      id: callReq.id,
      result: {
        content: [
          { type: 'text', text: 'File contents here' },
        ],
      },
    });

    const result = await callPromise;
    expect(result).toBe('File contents here');
  });

  it('throws on init failure', async () => {
    const { client, transport } = makeClient();

    const connectPromise = client.connect();
    await new Promise((r) => setTimeout(r, 10));

    const initReq = JSON.parse(transport.sentMessages[0]);
    transport.simulateMessage({
      jsonrpc: '2.0',
      id: initReq.id,
      error: { code: -32601, message: 'Method not found' },
    });

    await expect(connectPromise).rejects.toThrow('MCP initialization failed');
    expect(client.protocolVersion).toBeNull();
  });

  it('treats an MCP tool result with isError=true as a failed call without echoing its content', async () => {
    const { client, transport } = makeClient();
    const connectPromise = client.connect();
    await new Promise((r) => setTimeout(r, 10));
    const initReq = JSON.parse(transport.sentMessages[0]);
    transport.simulateMessage({
      jsonrpc: '2.0', id: initReq.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } },
    });
    await connectPromise;

    const callPromise = client.callTool('read_file', {});
    await new Promise((r) => setTimeout(r, 10));
    const callReq = JSON.parse(transport.sentMessages[2]);
    transport.simulateMessage({
      jsonrpc: '2.0', id: callReq.id,
      result: { content: [{ type: 'text', text: 'secret remote failure detail' }], isError: true },
    });

    await expect(callPromise).rejects.toThrow('MCP tool execution failed');
    await expect(callPromise).rejects.not.toThrow('secret remote failure detail');
  });

  it('throws when not connected', async () => {
    const { client } = makeClient();

    await expect(client.listTools()).rejects.toThrow('not connected');
  });

  it('rejects a pending handshake when the transport fails', async () => {
    const { client, transport } = makeClient();
    const connectPromise = client.connect(5_000);
    await new Promise((r) => setTimeout(r, 10));

    transport.simulateError(new Error('child exited'));

    await expect(connectPromise).rejects.toThrow('child exited');
    expect(client.isConnected).toBe(false);
  });

  it('cleans up immediately when sending the handshake throws', async () => {
    const { client, transport } = makeClient();
    transport.send = () => {
      throw new Error('stdin closed');
    };

    await expect(client.connect(5_000)).rejects.toThrow('stdin closed');
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('closes and clears state', async () => {
    const { client, transport } = makeClient();

    // Connect first
    const connectPromise = client.connect();
    await new Promise((r) => setTimeout(r, 10));
    const initReq = JSON.parse(transport.sentMessages[0]);
    transport.simulateMessage({ jsonrpc: '2.0', id: initReq.id, result: {} });
    await connectPromise;

    expect(client.isConnected).toBe(true);

    await client.close();

    expect(client.isConnected).toBe(false);
    expect(client.protocolVersion).toBeNull();
  });
});

// ─── Protocol Helpers ─────────────────────────────────────────

describe('Protocol helpers', () => {
  it('makeRequest creates valid JSON-RPC request', () => {
    const req = makeRequest('test/method', { key: 'value' });
    expect(req.jsonrpc).toBe('2.0');
    expect(req.method).toBe('test/method');
    expect(req.id).toBeGreaterThan(0);
    expect(req.params).toEqual({ key: 'value' });
  });

  it('makeNotification creates request without id', () => {
    const notif = makeNotification('test/event', { data: 123 });
    expect(notif.jsonrpc).toBe('2.0');
    expect(notif.method).toBe('test/event');
    expect(notif.params).toEqual({ data: 123 });
    expect('id' in notif).toBe(false);
  });

  it('MCPError serializes correctly', () => {
    const err = new MCPError(-32000, 'Tool failed', { tool: 'test' });
    expect(err.code).toBe(-32000);
    expect(err.message).toBe('Tool failed');
    expect(err.toJSON()).toEqual({ code: -32000, message: 'Tool failed', data: { tool: 'test' } });
  });
});

// ─── Batch Connect ────────────────────────────────────────────

describe('connectMCPClients', () => {
  it('connects to multiple servers and reports errors', async () => {
    const configs = [
      makeConfig('server-1'),
      makeConfig('server-2'),
    ];

    // We need to handle the async connection flow
    const result = await connectMCPClients(configs, (config) => {
      const transport = new MockTransport();
      // Override send to auto-respond with init result
      const origSend = transport.send.bind(transport);
      transport.send = (msg: string) => {
        origSend(msg);
        const parsed = JSON.parse(msg);
        if (parsed.method === 'initialize') {
          setTimeout(() => {
            transport.simulateMessage({
              jsonrpc: '2.0',
              id: parsed.id,
              result: { capabilities: {}, serverInfo: { name: config.name } },
            });
          }, 5);
        }
      };
      return transport;
    });

    expect(result.clients).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
    expect(result.clients[0].name).toBe('server-1');
    expect(result.clients[1].name).toBe('server-2');
  });
});
