/**
 * Child-process leak gate — MCP stdio servers (Task 5 §9).
 *
 * Drives the production MCPManager + StdioTransport over a real temporary
 * store for N start/stop cycles with REAL OS child processes, then performs an
 * OS-level census (Windows process list, matched by a unique command-line
 * marker) asserting that no child survives the disconnects.
 *
 * Terminal (node-pty) and GenOffice sidecar leak checks live in
 * scripts/child-process-leak-gate.cjs — they exercise plain-node/native
 * binaries and the built output respectively.
 */
import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { MCPManager } from '../../engine/mcp/MCPManager.js';

const CYCLES = 20;

describe('MCP stdio child-process leak gate', () => {
  it(`spawns and stops ${CYCLES} real MCP stdio servers and reaps every child`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mcp-leak-'));
    const runId = `metis-mcp-leak-census-${Date.now()}`;
    // Real MCP-speaking stdio server (answers initialize/tools/list over
    // newline-delimited JSON-RPC). The census marker rides in the command
    // line via a no-op extra arg so survivors are attributable.
    const serverEntry = path.resolve(__dirname, '../fixtures/mcp/leak-probe-server.mjs');
    if (!fs.existsSync(serverEntry)) throw new Error(`fixture missing: ${serverEntry}`);

    const store = new PersistenceStore(path.join(dir, 'metis.db'));
    const manager = new MCPManager(store, new ToolRegistry());
    let connected = 0;
    const cycleLog: Array<{ cycle: number; disconnectMs: number }> = [];
    try {
      for (let i = 0; i < CYCLES; i++) {
        const status = await manager.addServer({
          id: `leak-gate-${i}`,
          name: `leak gate ${i}`,
          command: process.execPath,
          args: [serverEntry, runId],
          env: {},
          enabled: true,
        });
        if (status?.connected) connected += 1;
        else throw new Error(`cycle ${i}: server failed to connect: ${JSON.stringify(status)}`);
        const t0 = Date.now();
        await manager.disconnectServer(`leak-gate-${i}`);
        cycleLog.push({ cycle: i, connectMs: status?.connected ? -1 : -1, disconnectMs: Date.now() - t0 });
      }
      expect(connected).toBe(CYCLES);
    } finally {
      await manager.disconnectAll().catch(() => { /* already drained */ });
      store.close();
    }

    // OS-level census: survivors carrying the marker are leaked children.
    // The node.exe filter excludes the census's own cmd/powershell wrapper
    // processes, whose command lines embed the marker string too.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const census = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*${runId}*' } | Select-Object ProcessId | ForEach-Object { $_.ProcessId }"`,
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
    );
    const survivors = census.split(/\r?\n/u).map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
    if (survivors.length > 0) {
      const detailCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*${runId}*' } | ForEach-Object { $_.ProcessId.ToString() + '||' + $_.CreationDate }"`;
      const detail = execSync(detailCmd, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      console.log('[leak-gate] SURVIVOR DETAILS: ' + detail);
      console.log('[leak-gate] CYCLE LOG: ' + JSON.stringify(cycleLog));
    }
    expect(survivors, `leaked MCP stdio children: ${JSON.stringify(survivors)}`).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
