/**
 * TEST-METIS-471 Unit 1: FirstRunSetupService ownership attacks.
 *
 * Uses real service + minimal dependency fakes to cover:
 *   - Owner A probe/save
 *   - Owner B mismatch rejection
 *   - replay (same owner, different operationId)
 *   - revokeWebContents
 *   - version conflict
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  FirstRunSetupService,
  type SetupOwner,
  type FirstRunSecureStorage,
  type AbortableSetupProbeTransport,
  type SetupRuntimeRebuildProtocol,
  type PreparedSetupRuntime,
  type SetupRuntimeBuildContext,
} from '../../electron/FirstRunSetupService.js';
import type { SetupProbeRequest, SetupSaveRequest } from '../../engine/runtime/SetupRuntimeContract.js';

// ─── Fakes ────────────────────────────────────────────────────

class FakeProbeTransport implements AbortableSetupProbeTransport {
  probeCalls: string[] = [];
  reachable = true;

  async chatProbe(baseUrl: string, apiKey: string, model: string, opts?: { tools?: boolean; jsonMode?: boolean }) {
    void baseUrl; void apiKey; void model; void opts;
    this.probeCalls.push(`chat`);
    return { status: this.reachable ? 200 : 500, hasToolCalls: this.reachable, hasContent: this.reachable, jsonValid: false };
  }
  async streamProbe(baseUrl: string, apiKey: string, model: string) {
    void baseUrl; void apiKey; void model;
    return { status: this.reachable ? 200 : 500, receivedChunk: this.reachable };
  }
  async modelsProbe(baseUrl: string, apiKey: string, model: string) {
    void baseUrl; void apiKey; void model;
    return { status: this.reachable ? 200 : 500, maxContextTokens: this.reachable ? 128000 : undefined, multimodal: false };
  }

  abort() {}
}

class FakeSecureStorage implements FirstRunSecureStorage {
  readonly protection = 'os-protected' as const;
  stored: Record<string, string> = {};

  isAvailable() { return true; }
  encrypt(plain: string) { return Buffer.from(plain).toString('base64'); }
  decrypt(cipher: string) { return Buffer.from(cipher, 'base64').toString('utf-8'); }
}

class FakeRuntimeRebuilder implements SetupRuntimeRebuildProtocol {
  prepared: Array<{ config: SetupRuntimeBuildContext['config'] }> = [];

  async prepare(ctx: SetupRuntimeBuildContext): Promise<PreparedSetupRuntime> {
    this.prepared.push({ config: ctx.config });
    return {
      commitAndAbortPrevious: async () => {},
      discard: async () => {},
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function makeOwner(webContentsId: number, generation = 0): SetupOwner {
  return { webContentsId, processId: 1000 + webContentsId, routingId: 1, generation };
}

function makeProbeRequest(overrides?: Partial<SetupProbeRequest['input']>): SetupProbeRequest {
  return {
    version: 1 as const,
    operationId: randomUUID(),
    input: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-key-12345678',
      model: 'gpt-4o',
      ...overrides,
    },
  } as SetupProbeRequest;
}

function makeSaveRequest(probeId: string, configVersion: number): SetupSaveRequest {
  return {
    version: 1 as const,
    operationId: randomUUID(),
    probeId,
    expectedConfigVersion: configVersion,
  } as SetupSaveRequest;
}

let tmpDir: string;
let service: FirstRunSetupService;
let probeTransport: FakeProbeTransport;
let secureStorage: FakeSecureStorage;
let runtimeRebuilder: FakeRuntimeRebuilder;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-471-owner-'));
  probeTransport = new FakeProbeTransport();
  secureStorage = new FakeSecureStorage();
  runtimeRebuilder = new FakeRuntimeRebuilder();
  service = new FirstRunSetupService({
    configPath: path.join(tmpDir, 'config.json'),
    secureStorage,
    probeTransport,
    runtimeRebuilder,
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────

describe('TEST-471: Owner A probe + save', () => {
  it('owner A completes full probe→save flow successfully', async () => {
    const ownerA = makeOwner(1);
    const probeResult = await service.probe(makeProbeRequest(), { owner: ownerA });
    expect(probeResult.success).toBe(true);
    if (!probeResult.success) return;

    const saveResult = await service.save(
      makeSaveRequest(probeResult.probeId, probeResult.configVersion),
      { owner: ownerA },
    );
    expect(saveResult.success).toBe(true);
  });
});

describe('TEST-471: Owner B mismatch rejection', () => {
  it('owner B cannot use owner A probe receipt', async () => {
    const ownerA = makeOwner(1);
    const ownerB = makeOwner(2);
    // Owner A probes
    const probeResult = await service.probe(makeProbeRequest(), { owner: ownerA });
    expect(probeResult.success).toBe(true);
    if (!probeResult.success) return;

    // Owner B tries to save using owner A's probeId
    const saveResult = await service.save(
      makeSaveRequest(probeResult.probeId, probeResult.configVersion),
      { owner: ownerB },
    );
    // Must fail — owner mismatch
    expect(saveResult.success).toBe(false);
  });

  it('owner B with different generation also rejected', async () => {
    const ownerA_v1 = makeOwner(1, 0);
    const ownerA_v2 = makeOwner(1, 1); // Same webContents, different generation
    const probeResult = await service.probe(makeProbeRequest(), { owner: ownerA_v1 });
    expect(probeResult.success).toBe(true);
    if (!probeResult.success) return;

    const saveResult = await service.save(
      makeSaveRequest(probeResult.probeId, probeResult.configVersion),
      { owner: ownerA_v2 },
    );
    // Must fail — generation mismatch
    expect(saveResult.success).toBe(false);
  });
});

describe('TEST-471: Replay attack', () => {
  it('replay: same owner using same probeId twice fails', async () => {
    const owner = makeOwner(10);
    const probeResult = await service.probe(makeProbeRequest(), { owner });
    expect(probeResult.success).toBe(true);
    if (!probeResult.success) return;

    // First save — succeeds
    const save1 = await service.save(
      makeSaveRequest(probeResult.probeId, probeResult.configVersion),
      { owner },
    );
    expect(save1.success).toBe(true);

    // Replay: second save with same probeId — must fail (receipt deleted after first use)
    const save2 = await service.save(
      makeSaveRequest(probeResult.probeId, probeResult.configVersion),
      { owner },
    );
    expect(save2.success).toBe(false);
  });
});

describe('TEST-471: revokeWebContents', () => {
  it('revokeWebContents deletes all receipts for that owner', async () => {
    const owner1 = makeOwner(100);
    const owner2 = makeOwner(200);

    // Both owners probe
    const r1 = await service.probe(makeProbeRequest(), { owner: owner1 });
    const r2 = await service.probe(makeProbeRequest(), { owner: owner2 });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    if (!r1.success || !r2.success) return;

    // Revoke owner1 — their receipt should be deleted
    service.revokeWebContents(100);

    // Owner1 save should fail (receipt revoked)
    const save1 = await service.save(
      makeSaveRequest(r1.probeId, r1.configVersion),
      { owner: owner1 },
    );
    expect(save1.success).toBe(false);

    // Owner2 save should still succeed
    const save2 = await service.save(
      makeSaveRequest(r2.probeId, r2.configVersion),
      { owner: owner2 },
    );
    expect(save2.success).toBe(true);
  });
});

describe('TEST-471: Version conflict', () => {
  it('save with stale expectedConfigVersion fails', async () => {
    const owner = makeOwner(999);
    const probeResult = await service.probe(makeProbeRequest(), { owner });
    expect(probeResult.success).toBe(true);
    if (!probeResult.success) return;

    // First save succeeds (version 0 → 1)
    const save1 = await service.save(
      makeSaveRequest(probeResult.probeId, probeResult.configVersion),
      { owner },
    );
    expect(save1.success).toBe(true);

    // Second probe (new receipt, new configVersion)
    const probe2 = await service.probe(makeProbeRequest(), { owner });
    expect(probe2.success).toBe(true);
    if (!probe2.success) return;

    // Try to save with the OLD (stale) configVersion from probe1
    const save2 = await service.save(
      makeSaveRequest(probe2.probeId, probeResult.configVersion),
      { owner },
    );
    expect(save2.success).toBe(false);
  });

  it('probe→save→probe→save sequential succeeds', async () => {
    const owner = makeOwner(888);
    // Round 1
    const p1 = await service.probe(makeProbeRequest(), { owner });
    expect(p1.success).toBe(true);
    if (!p1.success) return;
    const s1 = await service.save(makeSaveRequest(p1.probeId, p1.configVersion), { owner });
    expect(s1.success).toBe(true);

    // Round 2 (updated key)
    const p2 = await service.probe(makeProbeRequest({ apiKey: 'sk-new-key-87654321' }), { owner });
    expect(p2.success).toBe(true);
    if (!p2.success) return;
    const s2 = await service.save(makeSaveRequest(p2.probeId, p2.configVersion), { owner });
    expect(s2.success).toBe(true);
  });
});
