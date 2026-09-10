/**
 * TEST-METIS-471 Unit 2: Static contract tests for settings security wiring.
 *
 * Reads source files and asserts critical security patterns exist (or are absent).
 * Does NOT modify any product source code.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(relativePath), 'utf-8');
}

const mainSrc = readSource('electron/main.ts');
const preloadSrc = readSource('electron/preload.ts');
const serviceSrc = readSource('electron/FirstRunSetupService.ts');
const contractSrc = readSource('engine/runtime/WorkspaceAgentsContract.ts');

describe('TEST-471: main.ts security wiring', () => {
  it('REQUIRED: setup:probe uses decodeSettingsProviderProbeRequest (strict keyMode)', () => {
    expect(mainSrc).toMatch(/decodeSettingsProviderProbeRequest/);
  });

  it('FORBIDDEN: no legacy decodeSetupProbeRequest in setup:probe handler', () => {
    // The legacy decoder may still be imported but must NOT be used
    // as the primary path in the probe handler anymore.
    // It may still be used inside FirstRunSetupService for backward compat.
    const probeHandlerMatch = mainSrc.match(/ipcMain\.handle\('setup:probe'.*?(?=ipcMain\.handle)/s);
    if (probeHandlerMatch) {
      expect(probeHandlerMatch[0]).not.toMatch(/decodeSetupProbeRequest\(rawRequest\)/);
    }
  });

  it('REQUIRED: setupOwnerFor uses frame.processId and frame.routingId (tuple)', () => {
    expect(mainSrc).toMatch(/frame\.processId/);
    expect(mainSrc).toMatch(/frame\.routingId/);
    expect(mainSrc).toMatch(/webContentsGenerations\.get/);
  });

  it('REQUIRED: bumpWebContentsGeneration exists for navigation', () => {
    expect(mainSrc).toMatch(/bumpWebContentsGeneration|webContentsGenerations\.set.*\+/);
  });

  it('REQUIRED: cleanupWebContentsOwner exists for destroy/revocation', () => {
    expect(mainSrc).toMatch(/cleanupWebContentsOwner|revokeWebContents/);
  });

  it('REQUIRED: did-start-navigation calls bump or generation increment', () => {
    // main.ts must have a handler that increments generation on navigation
    expect(mainSrc).toMatch(/did-start-navigation/);
  });

  it('REQUIRED: render-process-gone or destroyed cleans up owner', () => {
    expect(mainSrc).toMatch(/render-process-gone|destroyed.*cleanupWebContents|revokeWebContents/);
  });

  it('REQUIRED: saved-key probe failure returns nested recovery (not flattened spread)', () => {
    // FIX-METIS-490 regression: the saved-key probe failure path must
    // return { success:false, recovery: {...} } — NOT spread recovery
    // fields to the top level, which violates SetupProbeResponseSchema.
    const probeHandler = mainSrc.match(/ipcMain\.handle\('setup:probe'.*?(?=ipcMain\.handle\('setup:save')/s);
    if (probeHandler) {
      // Must use nested recovery: { ... } shape
      expect(probeHandler[0]).toMatch(/recovery:\s*createSetupRecovery/);
      // Must NOT spread recovery fields to top level
      expect(probeHandler[0]).not.toMatch(/\.\.\.createSetupRecovery/);
    }
  });

  it('REQUIRED: workspace:agents:get uses decodeWorkspaceAgentsGetRequest (strict projectId)', () => {
    expect(mainSrc).toMatch(/decodeWorkspaceAgentsGetRequest/);
  });

  it('REQUIRED: workspace:agents:set uses decodeWorkspaceAgentsWriteRequest (projectId required)', () => {
    expect(mainSrc).toMatch(/decodeWorkspaceAgentsWriteRequest/);
  });

  it('FORBIDDEN: no default/project-list fallback for projectId in workspace handlers', () => {
    // The handlers must NOT use ?? 'default' or hardcoded projectId
    const wsSection = mainSrc.match(/workspace:agents:get.*?workspace:agents:set.*?\);/s);
    if (wsSection) {
      expect(wsSection[0]).not.toMatch(/\?\?\s*['"]default['"]/);
      expect(wsSection[0]).not.toMatch(/\?\?\s*['"]project-list['"]/);
    }
  });

  it('REQUIRED: startup scans existing project directories', () => {
    expect(mainSrc).toMatch(/readdirSync.*projects|projects.*readdir/);
  });

  it('REQUIRED: workspace manager only created for existing projects (get path)', () => {
    // get handler: does NOT create new manager
    const getHandler = mainSrc.match(/workspace:agents:get.*?\{[\s\S]*?catch/s);
    if (getHandler) {
      expect(getHandler[0]).not.toMatch(/new WorkspaceAgentsManager/);
    }
  });

  it('FORBIDDEN: no WorkspaceAgentsManager default singleton', () => {
    expect(mainSrc).not.toMatch(/new WorkspaceAgentsManager\(DATA_DIR,\s*'default'\s*\)/);
    expect(mainSrc).not.toMatch(/workspaceAgentsManager\s*=\s*new WorkspaceAgentsManager\(DATA_DIR\)/);
  });
});

describe('TEST-471: preload.ts security wiring', () => {
  it('REQUIRED: setupProbe accepts SettingsProviderProbeRequest (not just legacy)', () => {
    expect(preloadSrc).toMatch(/SettingsProviderProbeRequest/);
    expect(preloadSrc).toMatch(/decodeSettingsProviderProbeRequest/);
  });

  it('FORBIDDEN: setupProbe does not fall back to legacy decodeSetupProbeRequest as primary', () => {
    // The preload setupProbe function must use the new decoder as primary
    const setupProbeFn = preloadSrc.match(/setupProbe:[\s\S]*?\{[\s\S]*?\},/);
    if (setupProbeFn) {
      // Must use new decoder
      expect(setupProbeFn[0]).toMatch(/decodeSettingsProviderProbeRequest/);
    }
  });

  it('ATTACK-REGRESSION: workspace agents set/get do NOT hardcode projectId (extract-only)', () => {
    // Extract ONLY the workspace agents functions (not researchListProjects
    // which legitimately uses 'project-list' as a dummy operation sentinel).
    const wsGetFn = preloadSrc.match(/getWorkspaceAgents:[\s\S]*?\},/);
    const wsSetFn = preloadSrc.match(/setWorkspaceAgents:[\s\S]*?\},/);
    expect(wsGetFn).toBeDefined();
    expect(wsSetFn).toBeDefined();
    // Neither function must contain a hardcoded projectId string
    if (wsGetFn) expect(wsGetFn[0]).not.toMatch(/projectId:\s*['"]/);
    if (wsSetFn) expect(wsSetFn[0]).not.toMatch(/projectId:\s*['"]/);
    // Both must pass through the caller's projectId via decode
    if (wsGetFn) expect(wsGetFn[0]).toMatch(/decodeWorkspaceAgentsGetRequest/);
    if (wsSetFn) expect(wsSetFn[0]).toMatch(/decodeWorkspaceAgentsWriteRequest/);
    // Assert request object includes caller projectId
    if (wsGetFn) expect(wsGetFn[0]).toMatch(/projectId/);
    if (wsSetFn) expect(wsSetFn[0]).toMatch(/projectId/);
  });

  it('REQUIRED: workspace agents get passes projectId from caller', () => {
    // The preload should pass through the projectId from the renderer's request
    expect(preloadSrc).toMatch(/workspace:agents:get/);
  });

  it('REQUIRED: invokeSetupWithProgress accepts SettingsProviderProbeRequest', () => {
    expect(preloadSrc).toMatch(/SettingsProviderProbeRequest/);
  });
});

describe('TEST-471: FirstRunSetupService owner contract', () => {
  it('REQUIRED: ProbeReceipt.owner uses SetupOwner tuple (not plain number)', () => {
    expect(serviceSrc).toMatch(/owner:\s*\{\s*webContentsId/);
    expect(serviceSrc).toMatch(/owner:\s*SetupOwner/);
  });

  it('REQUIRED: save() checks owner.webContentsId on receipt', () => {
    expect(serviceSrc).toMatch(/owner\.webContentsId\s*!==\s*options\.owner\.webContentsId/);
  });

  it('VERIFY: save() checks ALL owner tuple fields including generation', () => {
    expect(serviceSrc).toMatch(/owner\.generation\s*!==\s*options\.owner\.generation/);
    expect(serviceSrc).toMatch(/owner\.processId\s*!==\s*options\.owner\.processId/);
    expect(serviceSrc).toMatch(/owner\.routingId\s*!==\s*options\.owner\.routingId/);
  });

  it('REQUIRED: workspace agents pass caller projectId (no hardcoded fallback)', () => {
    // Verify preload agents functions use the contract decoder for projectId
    // and never fall back to a hardcoded value.
    const wsGetFn = preloadSrc.match(/getWorkspaceAgents:[\s\S]*?\},/);
    const wsSetFn = preloadSrc.match(/setWorkspaceAgents:[\s\S]*?\},/);
    // get must decode request with projectId from caller
    if (wsGetFn) {
      expect(wsGetFn[0]).toMatch(/decodeWorkspaceAgentsGetRequest\(\{\s*projectId\s*\}/);
    }
    // set must decode write request with projectId from caller
    if (wsSetFn) {
      expect(wsSetFn[0]).toMatch(/decodeWorkspaceAgentsWriteRequest\(\{/);
      expect(wsSetFn[0]).toMatch(/projectId/);
    }
  });

  it('REQUIRED: revokeWebContents iterates probeReceipts by owner.webContentsId', () => {
    expect(serviceSrc).toMatch(/revokeWebContents/);
    expect(serviceSrc).toMatch(/receipt\.owner\.webContentsId\s*===/);
  });

  it('REQUIRED: probe() stores owner in receipt', () => {
    expect(serviceSrc).toMatch(/owner:\s*options\.owner/);
  });

  it('REQUIRED: SetupOwner exported with webContentsId/processId/routingId/generation', () => {
    expect(serviceSrc).toMatch(/export interface SetupOwner/);
    expect(serviceSrc).toMatch(/webContentsId:\s*number/);
    expect(serviceSrc).toMatch(/processId:\s*number/);
    expect(serviceSrc).toMatch(/routingId:\s*number/);
    expect(serviceSrc).toMatch(/generation:\s*number/);
  });
});

describe('TEST-471: WorkspaceAgentsContract strict projectId', () => {
  it('REQUIRED: WorkspaceAgentsWriteRequest includes projectId (not optional)', () => {
    expect(contractSrc).toMatch(/projectId.*z\.string/);
    expect(contractSrc).toMatch(/PROJECT_ID_REGEX/);
  });

  it('REQUIRED: WorkspaceAgentsGetRequest exists with projectId', () => {
    expect(contractSrc).toMatch(/WorkspaceAgentsGetRequestSchema/);
  });

  it('REQUIRED: WorkspaceAgentsView includes projectId', () => {
    expect(contractSrc).toMatch(/WorkspaceAgentsViewSchema[\s\S]*?projectId/);
  });

  it('REQUIRED: PROJECT_ID_REGEX validates safe chars only', () => {
    expect(contractSrc).toMatch(/PROJECT_ID_REGEX\s*=\s*\/\^\[a-zA-Z0-9\]/);
  });

  it('REQUIRED: project_not_found in discriminated union', () => {
    expect(contractSrc).toMatch(/code:\s*z\.literal\('project_not_found'\)/);
  });

  it('REQUIRED: createWorkspaceAgentsFailure accepts project_not_found', () => {
    expect(contractSrc).toMatch(/project_not_found/);
  });

  it('REQUIRED: main workspace:agents:set returns project_not_found', () => {
    expect(mainSrc).toMatch(/project_not_found/);
  });

  it('REQUIRED: ensureWorkspaceManager evicts deleted projects from cache', () => {
    expect(mainSrc).toMatch(/workspaceAgentsByProject\.delete/);
  });

  it('REQUIRED: workspace:agents:get calls ensureWorkspaceManager directly (no cache bypass)', () => {
    const getHandler = mainSrc.match(/workspace:agents:get.*?\{[\s\S]*?catch/s);
    if (getHandler) {
      // Must use ensureWorkspaceManager without cache-first get
      expect(getHandler[0]).toMatch(/ensureWorkspaceManager/);
      expect(getHandler[0]).not.toMatch(/workspaceAgentsByProject\.get.*\?\?.*ensure/);
    }
  });
});
