import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpActivationRequestSchema } from '../../engine/runtime/McpActivationContract.js';

const MAIN_SOURCE = fs.readFileSync(path.resolve('electron/main.ts'), 'utf8');
const EXTENSION_SOURCE = fs.readFileSync(path.resolve('electron/PersonalizationExtensionService.ts'), 'utf8');

function handlerSource(channel: string, nextChannel: string): string {
  const start = MAIN_SOURCE.indexOf(`ipcMain.handle('${channel}'`);
  const end = MAIN_SOURCE.indexOf(`ipcMain.handle('${nextChannel}'`, start + 1);
  if (start < 0 || end < 0) throw new Error(`IPC handler ${channel} is unavailable`);
  return MAIN_SOURCE.slice(start, end);
}

describe('generated MCP transaction production wiring', () => {
  it('prepares without enabling, journals activation, and only then returns the enabled result', () => {
    const handler = handlerSource('personalization:extension:apply', 'personalization:mcp:activate');
    const prepare = handler.indexOf('personalizationExtensions.prepareGeneratedMcp(request)');
    const activate = handler.indexOf('personalizationGeneratedMcpActivation.activate({');
    const genericApply = handler.indexOf('personalizationExtensions.apply(request');
    expect(prepare).toBeGreaterThan(0);
    expect(activate).toBeGreaterThan(prepare);
    expect(genericApply).toBeGreaterThan(activate);
    expect(handler).toContain("request.mode === 'mcp_requirements' && request.runProbe");
    expect(handler).toContain('evidenceContext: { ...request.evidenceContext, owner }');
  });

  it('recovers both inner activation and outer generated intent journals before exposing the service', () => {
    const activationConstruction = MAIN_SOURCE.indexOf('new PersonalizationMcpActivationService(mcpRoot');
    const innerRecovery = MAIN_SOURCE.indexOf('await activation.recoverPending()', activationConstruction);
    const generatedConstruction = MAIN_SOURCE.indexOf('new GeneratedMcpActivationCoordinator(mcpRoot', innerRecovery);
    const outerRecovery = MAIN_SOURCE.indexOf('await generatedActivation.recoverPending()', generatedConstruction);
    const extensionConstruction = MAIN_SOURCE.indexOf('new PersonalizationExtensionService({', outerRecovery);
    expect(activationConstruction).toBeGreaterThan(0);
    expect(innerRecovery).toBeGreaterThan(activationConstruction);
    expect(generatedConstruction).toBeGreaterThan(innerRecovery);
    expect(outerRecovery).toBeGreaterThan(generatedConstruction);
    expect(extensionConstruction).toBeGreaterThan(outerRecovery);
  });

  it('forbids the old direct probe-and-enable path and accepts generated activation identities', () => {
    expect(EXTENSION_SOURCE).toContain("'generated_activation_transaction_required'");
    expect(McpActivationRequestSchema.safeParse({
      contractVersion: 1,
      definitionId: 'generated:mcp/transaction-wiring',
      installationId: `mcp_${'a'.repeat(32)}`,
      expectedRevision: 1,
      evidenceContext: {
        sessionId: 'session-generated',
        projectId: 'project-generated',
        operationId: '00000000-0000-4000-8000-000000000345',
        runManifestDigest: 'b'.repeat(64),
        observedAt: 1,
        owner: { webContentsId: 1, processId: 1, routingId: 0, generation: 0 },
      },
    }).success).toBe(true);
  });
});
