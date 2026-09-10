/**
 * Minimal but REAL MCP stdio server used by the child-process leak gate.
 * Speaks newline-delimited JSON-RPC exactly as engine/mcp/StdioTransport
 * frames it: answers `initialize`, `notifications/initialized`, and
 * `tools/list`. Exits when stdin disconnects (transport close) or after a
 * bounded lifetime so a leaked instance cannot outlive the test run silently.
 */
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'metis-leak-probe', version: '1.0.0' },
      },
    })}\n`);
    return;
  }
  if (msg.method === 'tools/list') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [{
          name: 'probe',
          description: 'Leak-gate probe tool',
          inputSchema: { type: 'object', properties: {} },
        }],
      },
    })}\n`);
    return;
  }
  if (msg.id !== undefined && msg.method) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`);
  }
});
process.on('disconnect', () => process.exit(0));
// Real MCP servers exit when their stdin closes — the transport ends stdin on
// close(), so this is the graceful path. The timeout below only bounds a
// pathological leak; it must not be the primary exit path.
rl.on('close', () => process.exit(0));
setTimeout(() => process.exit(0), 120_000);
