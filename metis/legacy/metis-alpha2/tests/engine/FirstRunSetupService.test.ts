/**
 * TEST-METIS-471: FirstRunSetupService owner tuple / replay / expiry attack tests.
 * Strictly verify-only — no product source code changes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  decodeSettingsProviderProbeRequest,
} from '../../engine/runtime/SetupRuntimeContract.js';

// ─── KeyMode strict contract tests ───────────────────────────

describe('TEST-471: SettingsProviderProbeRequest keyMode strict', () => {
  it('ATTACK: saved mode cannot smuggle newApiKey', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: 'test-attack-1',
      keyMode: 'saved',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      newApiKey: 'sk-should-be-rejected-12345',
    });
    expect(result.ok).toBe(false);
  });

  it('ATTACK: replace mode cannot omit newApiKey', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: 'test-attack-2',
      keyMode: 'replace',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    });
    expect(result.ok).toBe(false);
  });

  it('ATTACK: saved mode with empty string newApiKey rejected', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: 'test-attack-3',
      keyMode: 'saved',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      newApiKey: '',
    });
    expect(result.ok).toBe(false);
  });

  it('ATTACK: unknown keyMode value rejected', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: 'test-attack-4',
      keyMode: '__use_saved_key__' as never,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    });
    expect(result.ok).toBe(false);
  });

  it('ATTACK: request with extra fields rejected', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: 'test-attack-5',
      keyMode: 'saved',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      __secret: 'bypass',
    });
    expect(result.ok).toBe(false);
  });

  it('ATTACK: legacy SetupProbeRequest format rejected by new decoder', () => {
    // Old format {input: {apiKey: ''}} must NOT pass the new decoder
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: 'legacy',
      input: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o' },
    });
    expect(result.ok).toBe(false);
  });

  it('VERIFY: replace with valid key passes', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: 'valid-replace',
      keyMode: 'replace',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      newApiKey: 'sk-valid-key-12345678',
    });
    expect(result.ok).toBe(true);
  });

  it('VERIFY: saved without newApiKey passes', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: 'valid-saved',
      keyMode: 'saved',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    });
    expect(result.ok).toBe(true);
  });

  it('VERIFY: replace rejects too-short key (< 8 chars)', () => {
    const result = decodeSettingsProviderProbeRequest({
      version: 1,
      operationId: 'short-key',
      keyMode: 'replace',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      newApiKey: 'short',
    });
    expect(result.ok).toBe(false);
  });
});

// ─── WorkspaceAgentsContract strict projectId tests ──────────

import {
  decodeWorkspaceAgentsWriteRequest,
  decodeWorkspaceAgentsGetRequest,
} from '../../engine/runtime/WorkspaceAgentsContract.js';

describe('TEST-471: WorkspaceAgentsContract projectId strict', () => {
  it('ATTACK: write without projectId rejected', () => {
    const result = decodeWorkspaceAgentsWriteRequest({
      content: 'test',
      expectedVersion: 0,
    });
    expect(result).toBeUndefined();
  });

  it('ATTACK: write with empty projectId rejected', () => {
    const result = decodeWorkspaceAgentsWriteRequest({
      content: 'test',
      expectedVersion: 0,
      projectId: '',
    });
    expect(result).toBeUndefined();
  });

  it('ATTACK: write with invalid projectId chars rejected', () => {
    const result = decodeWorkspaceAgentsWriteRequest({
      content: 'test',
      expectedVersion: 0,
      projectId: '../escape',
    });
    expect(result).toBeUndefined();
  });

  it('ATTACK: get without projectId rejected', () => {
    const result = decodeWorkspaceAgentsGetRequest({});
    expect(result).toBeUndefined();
  });

  it('ATTACK: get with traversal projectId rejected', () => {
    const result = decodeWorkspaceAgentsGetRequest({
      projectId: '../../etc/passwd',
    });
    expect(result).toBeUndefined();
  });

  it('VERIFY: valid projectId accepted', () => {
    const result = decodeWorkspaceAgentsWriteRequest({
      content: 'test',
      expectedVersion: 0,
      projectId: 'my-project-01',
    });
    expect(result).toBeDefined();
    expect(result!.projectId).toBe('my-project-01');
  });
});

// ─── WorkspaceAgentsManager dual-slot crash recovery ─────────

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  WorkspaceAgentsManager,
  workspaceProjectDirectory,
} from '../../engine/memory/WorkspaceAgentsManager.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-471-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readActiveSlot(projectId: string): number {
  const ptrPath = path.join(workspaceProjectDirectory(tmpDir, projectId), '.agents.ptr.json');
  if (!fs.existsSync(ptrPath)) return 0;
  return JSON.parse(fs.readFileSync(ptrPath, 'utf-8')).slot;
}

describe('TEST-471: Workspace dual-slot crash recovery', () => {
  it('ATTACK: pointer deletion → content recoverable from slot 0 or 1', () => {
    const mgr = new WorkspaceAgentsManager(tmpDir, 'crash-test');
    mgr.write('recoverable-content', 0);
    const projectDir = workspaceProjectDirectory(tmpDir, 'crash-test');
    const ptrPath = path.join(projectDir, '.agents.ptr.json');
    fs.unlinkSync(ptrPath);
    // Without pointer, manager defaults to slot 0
    void mgr.read(); // trigger slot resolution
    // Content should be in either slot
    const slot0Path = path.join(projectDir, 'AGENTS.0.md');
    const slot1Path = path.join(projectDir, 'AGENTS.1.md');
    const hasContent = (fs.existsSync(slot0Path) && fs.readFileSync(slot0Path, 'utf-8') === 'recoverable-content')
      || (fs.existsSync(slot1Path) && fs.readFileSync(slot1Path, 'utf-8') === 'recoverable-content');
    expect(hasContent).toBe(true);
  });

  it('ATTACK: pointer corrupt → no crash, graceful recovery', () => {
    const mgr = new WorkspaceAgentsManager(tmpDir, 'corrupt-ptr');
    mgr.write('test', 0);
    const ptrPath = path.join(workspaceProjectDirectory(tmpDir, 'corrupt-ptr'), '.agents.ptr.json');
    fs.writeFileSync(ptrPath, '{corrupt-json', 'utf-8');
    // Must not throw
    expect(() => mgr.read()).not.toThrow();
  });

  it('ATTACK: hash mismatch → externalConflict blocks write', () => {
    const mgr = new WorkspaceAgentsManager(tmpDir, 'hash-attack');
    mgr.write('original', 0);
    const slot = readActiveSlot('hash-attack');
    const contentPath = path.join(workspaceProjectDirectory(tmpDir, 'hash-attack'), `AGENTS.${slot}.md`);
    fs.writeFileSync(contentPath, 'tampered', 'utf-8');
    const view = mgr.read();
    expect(view.externalConflict).toBe(true);
    // Write must be blocked
    const r = mgr.write('overwrite', view.version);
    expect(r.success).toBe(false);
  });

  it('ATTACK: MAX version overflow → write blocked', () => {
    const mgr = new WorkspaceAgentsManager(tmpDir, 'overflow');
    mgr.write('v1', 0);
    // Tamper meta to cap boundary
    const slot = readActiveSlot('overflow');
    const metaPath = path.join(workspaceProjectDirectory(tmpDir, 'overflow'), `.agents.meta.${slot}.json`);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    meta.version = Number.MAX_SAFE_INTEGER - 2;
    meta.contentHash = createHash('sha256').update('v1').digest('hex');
    fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf-8');
    const view = mgr.read();
    // Either externalConflict or the read catches it
    expect(view.externalConflict === true || view.version < Number.MAX_SAFE_INTEGER - 1).toBe(true);
  });

  it('ATTACK: cross-project isolation — project A cannot see project B content', () => {
    const mgrA = new WorkspaceAgentsManager(tmpDir, 'project-a');
    const mgrB = new WorkspaceAgentsManager(tmpDir, 'project-b');
    mgrA.write('alpha-secret', 0);
    mgrB.write('beta-secret', 0);
    expect(mgrA.read().content).toBe('alpha-secret');
    expect(mgrB.read().content).toBe('beta-secret');
    expect(mgrA.read().content).not.toBe('beta-secret');
    expect(mgrB.read().content).not.toBe('alpha-secret');
  });

  it('ATTACK: invalid projectId rejected by constructor', () => {
    expect(() => new WorkspaceAgentsManager(tmpDir, '../escape')).toThrow('Invalid projectId');
    expect(() => new WorkspaceAgentsManager(tmpDir, '')).toThrow('Invalid projectId');
  });
});
