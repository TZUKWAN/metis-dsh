import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCapabilityRegistry } from '../../electron/FileCapabilityRegistry.js';
import type { ExecutionOwnerIdentity } from '../../electron/ExecutionCapabilityRegistry.js';

const OWNER_A: ExecutionOwnerIdentity = {
  webContentsId: 71,
  mainFrameProcessId: 72,
  mainFrameRoutingId: 73,
};
const OWNER_B: ExecutionOwnerIdentity = {
  webContentsId: 81,
  mainFrameProcessId: 82,
  mainFrameRoutingId: 83,
};
const BINDINGS = [
  { purpose: 'personalization-skill-package', kind: 'file', operation: 'file' },
  { purpose: 'personalization-skill-directory', kind: 'folder', operation: 'folder' },
] as const;
const roots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-skill-capability-'));
  roots.push(root);
  const zip = path.join(root, 'skill.zip');
  const directory = path.join(root, 'skill-directory');
  fs.writeFileSync(zip, 'zip fixture');
  fs.mkdirSync(directory);
  return { root, zip, directory };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('skill package capability kind/purpose attacks', () => {
  it('consumes ZIP and directory grants exactly once through their trusted bindings', () => {
    const { zip, directory } = fixture();
    const registry = new FileCapabilityRegistry();
    const zipGrant = registry.issue({
      path: zip,
      kind: 'file',
      mime: 'application/zip',
      operations: ['file'],
      purpose: 'personalization-skill-package',
    }, OWNER_A);
    const directoryGrant = registry.issue({
      path: directory,
      kind: 'folder',
      mime: 'inode/directory',
      operations: ['folder'],
      purpose: 'personalization-skill-directory',
    }, OWNER_A);
    expect(zipGrant.success).toBe(true);
    expect(directoryGrant.success).toBe(true);
    if (!zipGrant.success || !directoryGrant.success) throw new Error('Capability fixture issuance failed');
    expect(JSON.stringify(zipGrant.capability)).not.toContain(zip);
    expect(JSON.stringify(directoryGrant.capability)).not.toContain(directory);

    expect(registry.consumeMatching(zipGrant.capability.capabilityId, OWNER_A, BINDINGS)).toMatchObject({
      ok: true,
      capability: { kind: 'file', operations: ['file'] },
      request: { operation: 'file' },
      resolvedPath: fs.realpathSync.native(zip),
    });
    expect(registry.consumeMatching(zipGrant.capability.capabilityId, OWNER_A, BINDINGS).ok).toBe(false);
    expect(registry.consumeMatching(directoryGrant.capability.capabilityId, OWNER_A, BINDINGS)).toMatchObject({
      ok: true,
      capability: { kind: 'folder', operations: ['folder'] },
      request: { operation: 'folder' },
      resolvedPath: fs.realpathSync.native(directory),
    });
    expect(registry.consumeMatching(directoryGrant.capability.capabilityId, OWNER_A, BINDINGS).ok).toBe(false);
  });

  it('rejects cross-purpose, cross-kind, and cross-owner reuse without fallback', () => {
    const { zip, directory } = fixture();
    const registry = new FileCapabilityRegistry();
    const wrongPurpose = registry.issue({
      path: directory,
      kind: 'folder',
      mime: 'inode/directory',
      operations: ['folder'],
      purpose: 'funding-template',
    }, OWNER_A);
    const importedFileForDirectoryPurpose = registry.issue({
      path: zip,
      kind: 'file',
      mime: 'application/zip',
      operations: ['file'],
      purpose: 'personalization-skill-directory',
    }, OWNER_A);
    const overprivilegedZip = registry.issue({
      path: zip,
      kind: 'file',
      mime: 'application/zip',
      operations: ['file', 'read'],
      purpose: 'personalization-skill-package',
    }, OWNER_A);
    const otherOwner = registry.issue({
      path: directory,
      kind: 'folder',
      mime: 'inode/directory',
      operations: ['folder'],
      purpose: 'personalization-skill-directory',
    }, OWNER_A);
    expect(wrongPurpose.success && registry.consumeMatching(wrongPurpose.capability.capabilityId, OWNER_A, BINDINGS).ok).toBe(false);
    expect(importedFileForDirectoryPurpose.success
      && registry.consumeMatching(importedFileForDirectoryPurpose.capability.capabilityId, OWNER_A, BINDINGS).ok).toBe(false);
    expect(overprivilegedZip.success
      && registry.consumeMatching(overprivilegedZip.capability.capabilityId, OWNER_A, BINDINGS).ok).toBe(false);
    expect(otherOwner.success && registry.consumeMatching(otherOwner.capability.capabilityId, OWNER_B, BINDINGS).ok).toBe(false);

    if (!otherOwner.success) throw new Error('Owner isolation fixture issuance failed');
    expect(registry.consumeMatching(otherOwner.capability.capabilityId, OWNER_A, BINDINGS).ok).toBe(true);
  });

  it('rejects ambiguous or malformed trusted binding tables without consuming the grant', () => {
    const { directory } = fixture();
    const registry = new FileCapabilityRegistry();
    const issued = registry.issue({
      path: directory,
      kind: 'folder',
      mime: 'inode/directory',
      operations: ['folder'],
      purpose: 'personalization-skill-directory',
    }, OWNER_A);
    expect(issued.success).toBe(true);
    if (!issued.success) throw new Error('Binding ambiguity fixture issuance failed');
    const duplicate = [BINDINGS[1], BINDINGS[1]];
    expect(registry.consumeMatching(issued.capability.capabilityId, OWNER_A, duplicate).ok).toBe(false);
    expect(registry.consumeMatching(issued.capability.capabilityId, OWNER_A, []).ok).toBe(false);
    expect(registry.consumeMatching(issued.capability.capabilityId, OWNER_A, BINDINGS).ok).toBe(true);
  });
});
