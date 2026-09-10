import { describe, expect, it } from 'vitest';
import { MCPClient } from './MCPClient.js';
import { StdioTransport } from './StdioTransport.js';

function createClient(script: string): MCPClient {
  return new MCPClient(
    {
      name: 'lifecycle-test',
      command: [process.execPath, '-e', script],
    },
    new StdioTransport(),
  );
}

describe('StdioTransport lifecycle', () => {
  it('rejects when the child exits after launch but before initialize completes', async () => {
    const client = createClient('setTimeout(() => process.exit(0), 350)');
    const startedAt = Date.now();

    await expect(client.connect(5_000)).rejects.toThrow('MCP server exited');
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  }, 5_000);

  it('times out an unresponsive server and reaps it within a bounded deadline', async () => {
    const client = createClient(
      'process.stdin.resume(); setInterval(() => {}, 1_000)',
    );
    const startedAt = Date.now();

    await expect(client.connect(100)).rejects.toThrow('Request timeout: initialize');
    expect(Date.now() - startedAt).toBeLessThan(4_500);

    // connect() already closes on failure; another close must remain a no-op.
    await expect(client.close()).resolves.toBeUndefined();
  }, 5_000);

  it('rejects a missing executable without leaving teardown pending', async () => {
    const client = new MCPClient(
      {
        name: 'missing-command',
        command: [`metis-missing-mcp-${Date.now()}`],
      },
      new StdioTransport(),
    );
    const startedAt = Date.now();

    await expect(client.connect(5_000)).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(4_500);
  }, 5_000);
});
