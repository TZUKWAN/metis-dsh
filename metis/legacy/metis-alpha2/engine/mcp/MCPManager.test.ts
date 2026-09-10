/**
 * Tests for MCPManager.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MCPManager } from './MCPManager.js';
import { PersistenceStore } from '../persistence/PersistenceStore.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mcp-test-'));
}

describe('MCPManager', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;
  let registry: ToolRegistry;
  let manager: MCPManager;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
    registry = new ToolRegistry();
    manager = new MCPManager(store, registry);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('adds a disabled server without connecting', async () => {
    const status = await manager.addServer({
      id: 'srv-1',
      name: 'test-server',
      command: 'echo',
      args: ['hello'],
      env: {},
      enabled: false,
    });
    expect(status.connected).toBe(false);
    expect(status.name).toBe('test-server');
  });

  it('lists server status', async () => {
    await manager.addServer({
      id: 'srv-1',
      name: 'test-server',
      command: 'echo',
      args: ['hello'],
      env: {},
      enabled: false,
    });
    const statuses = manager.getStatus();
    expect(statuses.length).toBe(1);
    expect(statuses[0]?.name).toBe('test-server');
  });

  it('removes a server', async () => {
    await manager.addServer({
      id: 'srv-1',
      name: 'test-server',
      command: 'echo',
      args: ['hello'],
      env: {},
      enabled: false,
    });
    await manager.removeServer('srv-1');
    expect(manager.getStatus().length).toBe(0);
  });

  it('toggles server enabled state', async () => {
    await manager.addServer({
      id: 'srv-1',
      name: 'test-server',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: {},
      enabled: false,
    });
    const status = await manager.toggleServer('srv-1', true);
    expect(status).toMatchObject({
      id: 'srv-1',
      connected: false,
      toolCount: 0,
    });
    expect(status.error).toContain('MCP server exited');
  }, 5_000);

  it('testConnection returns failure for non-MCP command', async () => {
    const result = await manager.testConnection({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('MCP server exited');
  }, 5_000);

  it('persists servers across manager instances', async () => {
    await manager.addServer({
      id: 'srv-1',
      name: 'test-server',
      command: 'echo',
      args: ['hello'],
      env: {},
      enabled: false,
    });

    // Create new manager with same store
    const manager2 = new MCPManager(store, new ToolRegistry());
    const statuses = manager2.getStatus();
    expect(statuses.length).toBe(1);
    expect(statuses[0]?.name).toBe('test-server');
  });
});
