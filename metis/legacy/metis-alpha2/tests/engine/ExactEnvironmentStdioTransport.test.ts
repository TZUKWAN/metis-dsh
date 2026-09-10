import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MCPClient } from '../../engine/mcp/MCPClient.js';
import { ExactEnvironmentStdioTransport } from '../../engine/mcp/ExactEnvironmentStdioTransport.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('ExactEnvironmentStdioTransport', () => {
  it('waits for a stubborn child to be killed before close resolves', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mcp-stubborn-'));
    roots.push(root);
    const entry = path.join(root, 'stubborn.mjs');
    fs.writeFileSync(entry, "process.stdin.on('end', () => {}); setInterval(() => {}, 1000);", 'utf8');
    const transport = new ExactEnvironmentStdioTransport(root);
    await transport.start([process.execPath, entry], {});
    const started = Date.now();
    await transport.close();
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });

  it('does not inherit the Metis parent environment and never invokes a shell', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mcp-exact-env-'));
    roots.push(root);
    const entry = path.join(root, 'server.mjs');
    fs.writeFileSync(entry, `
import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin });
const inherited = Object.keys(process.env).sort().join(',');
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'env-probe', version: '1' }
    } }) + '\\n');
  } else if (message.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{
      name: 'environment_probe', description: inherited,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    }] } }) + '\\n');
  }
});
`, 'utf8');
    process.env.METIS_PARENT_SECRET_SENTINEL = 'must-not-cross-boundary';
    const client = new MCPClient(
      { name: 'env-probe', command: [process.execPath, entry], env: { ONLY_ALLOWED: 'present' } },
      new ExactEnvironmentStdioTransport(root),
    );
    try {
      await client.connect(3_000);
      const tools = await client.listTools();
      expect(tools[0]?.description).toContain('ONLY_ALLOWED');
      expect(tools[0]?.description).not.toContain('METIS_PARENT_SECRET_SENTINEL');
      expect(tools[0]?.description).not.toContain('API_KEY');
    } finally {
      await client.close();
      delete process.env.METIS_PARENT_SECRET_SENTINEL;
    }
  });

  it('rejects newline injection at the stdio message boundary', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mcp-line-boundary-'));
    roots.push(root);
    const entry = path.join(root, 'idle.mjs');
    fs.writeFileSync(entry, 'setInterval(() => {}, 1000);', 'utf8');
    const transport = new ExactEnvironmentStdioTransport(root);
    try {
      await transport.start([process.execPath, entry], {});
      expect(() => transport.send('{"jsonrpc":"2.0"}\n{"injected":true}')).toThrow(/newline-delimited/u);
    } finally {
      await transport.close();
    }
  });
});
