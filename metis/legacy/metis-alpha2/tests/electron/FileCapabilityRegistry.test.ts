import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileCapabilityUseRequestSchema,
  decodeFileCapabilityUseRequest,
} from '../../engine/runtime/FileCapabilityContract.js';
import { FileCapabilityRegistry } from '../../electron/FileCapabilityRegistry.js';
import type { ExecutionOwnerIdentity } from '../../electron/ExecutionCapabilityRegistry.js';

const OWNER_A = {
  webContentsId: 101,
  mainFrameProcessId: 201,
  mainFrameRoutingId: 301,
} as const;
const OWNER_B = {
  webContentsId: 102,
  mainFrameProcessId: 202,
  mainFrameRoutingId: 302,
} as const;
const OWNER_A_RELOADED = {
  webContentsId: 101,
  mainFrameProcessId: 211,
  mainFrameRoutingId: 311,
} as const;

describe('P0 owner-bound file capability registry', () => {
  let temporaryRoot: string;
  let filePath: string;
  let registry: FileCapabilityRegistry;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-file-owner-'));
    filePath = path.join(temporaryRoot, 'research.png');
    fs.writeFileSync(filePath, Buffer.from('bounded test file'));
    registry = new FileCapabilityRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    registry.clear();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function issue(
    operations: Array<'file' | 'folder' | 'read' | 'extract'> = ['read'],
    owner: ExecutionOwnerIdentity = OWNER_A,
    ttlMs?: number,
  ) {
    const result = registry.issue({
      path: filePath,
      kind: 'file',
      mime: 'application/octet-stream',
      displayName: 'research.png',
      operations,
      ...(ttlMs === undefined ? {} : { ttlMs }),
    }, owner);
    if (!result.success) throw new Error('Test capability issuance failed');
    return result.capability;
  }

  it('keeps descriptors pathless/ownerless and rejects a secondary window owner', () => {
    const capability = issue();
    const serialized = JSON.stringify(capability);
    expect(serialized).not.toContain(temporaryRoot);
    expect(serialized).not.toContain('owner');
    expect(serialized).not.toContain('webContentsId');
    expect(serialized).not.toContain('processId');
    expect(serialized).not.toContain('routingId');

    expect(registry.resolve({
      capabilityId: capability.capabilityId,
      operation: 'read',
      maxBytes: 1024,
    }, OWNER_B).ok).toBe(false);
    expect(registry.resolve({
      capabilityId: capability.capabilityId,
      operation: 'read',
      maxBytes: 1024,
    }, OWNER_A).ok).toBe(true);
  });

  it('binds the full canonical owner tuple, including frame process/routing identity', () => {
    const capability = issue();
    expect(registry.resolve({
      capabilityId: capability.capabilityId,
      operation: 'read',
      maxBytes: 1024,
    }, OWNER_A_RELOADED).ok).toBe(false);
    expect(registry.resolve({
      capabilityId: capability.capabilityId,
      operation: 'read',
      maxBytes: 1024,
    }, OWNER_A).ok).toBe(true);
  });

  it('consumes once for the same owner and rejects replay', () => {
    const capability = issue();
    const request = {
      capabilityId: capability.capabilityId,
      operation: 'read' as const,
      maxBytes: 1024,
    };
    expect(registry.consume(request, OWNER_A).ok).toBe(true);
    expect(registry.consume(request, OWNER_A).ok).toBe(false);
    expect(registry.resolve(request, OWNER_A).ok).toBe(false);
  });

  it('consumes a package-selection capability once through the main-process matching path', () => {
    const grant = registry.issue({
      path: filePath,
      kind: 'file',
      mime: 'application/zip',
      displayName: 'research-skill.zip',
      operations: ['file'],
      purpose: 'personalization-skill-package',
    }, OWNER_A);
    if (!grant.success) throw new Error('Test package capability issuance failed');
    const requirements = [{
      purpose: 'personalization-skill-package',
      kind: 'file',
      operation: 'file',
    }] as const;
    expect(registry.consumeMatching(grant.capability.capabilityId, OWNER_A, requirements).ok).toBe(true);
    expect(registry.consumeMatching(grant.capability.capabilityId, OWNER_A, requirements).ok).toBe(false);
  });

  it('rejects a wrong operation without consuming the valid grant', () => {
    const capability = issue(['read']);
    expect(registry.consume({
      capabilityId: capability.capabilityId,
      operation: 'extract',
      maxChars: 100,
    }, OWNER_A).ok).toBe(false);
    expect(registry.consume({
      capabilityId: capability.capabilityId,
      operation: 'read',
      maxBytes: 1024,
    }, OWNER_A).ok).toBe(true);
  });

  it('binds a main-only purpose and rejects cross-purpose capability reuse without consuming it', () => {
    const result = registry.issue({
      path: filePath,
      kind: 'file',
      mime: 'application/pdf',
      displayName: 'application.pdf',
      operations: ['file'],
      purpose: 'funding-template',
    }, OWNER_A);
    if (!result.success) throw new Error('Test capability issuance failed');
    expect(JSON.stringify(result.capability)).not.toContain('"purpose"');
    expect(registry.consume({
      capabilityId: result.capability.capabilityId,
      operation: 'file',
    }, OWNER_A, 'personalization-skill-package').ok).toBe(false);
    expect(registry.consume({
      capabilityId: result.capability.capabilityId,
      operation: 'file',
    }, OWNER_A, 'funding-template').ok).toBe(true);
  });

  it('rejects and prunes an expired grant', () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const capability = issue(['read'], OWNER_A, 1_000);
    vi.mocked(Date.now).mockReturnValue(now + 1_001);
    expect(registry.resolve({
      capabilityId: capability.capabilityId,
      operation: 'read',
      maxBytes: 1024,
    }, OWNER_A).ok).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('rejects renderer attempts to inject owner fields into strict use requests', () => {
    const capability = issue();
    const spoofed = {
      capabilityId: capability.capabilityId,
      operation: 'read',
      maxBytes: 1024,
      owner: OWNER_A,
      ownerKey: '101:201:301',
    };
    expect(FileCapabilityUseRequestSchema.safeParse(spoofed).success).toBe(false);
    expect(decodeFileCapabilityUseRequest(spoofed).ok).toBe(false);
  });

  it('cleans exact owners and all grants for a destroyed webContents', () => {
    const first = issue(['read'], OWNER_A);
    const second = issue(['read'], OWNER_A_RELOADED);
    const other = issue(['read'], OWNER_B);
    registry.clearOwner(OWNER_A);
    expect(registry.resolve({
      capabilityId: first.capabilityId,
      operation: 'read',
      maxBytes: 1024,
    }, OWNER_A).ok).toBe(false);
    expect(registry.resolve({
      capabilityId: second.capabilityId,
      operation: 'read',
      maxBytes: 1024,
    }, OWNER_A_RELOADED).ok).toBe(true);

    registry.clearWebContents(OWNER_A.webContentsId);
    expect(registry.resolve({
      capabilityId: second.capabilityId,
      operation: 'read',
      maxBytes: 1024,
    }, OWNER_A_RELOADED).ok).toBe(false);
    expect(registry.resolve({
      capabilityId: other.capabilityId,
      operation: 'read',
      maxBytes: 1024,
    }, OWNER_B).ok).toBe(true);
  });

  it('rejects malformed main-side owner identities at issuance', () => {
    const invalidOwner = { ...OWNER_A, mainFrameRoutingId: -1 };
    const result = registry.issue({
      path: filePath,
      kind: 'file',
      operations: ['read'],
    }, invalidOwner);
    expect(result).toEqual({ success: false, code: 'file_capability_unavailable' });
    expect(registry.size).toBe(0);
  });
});
