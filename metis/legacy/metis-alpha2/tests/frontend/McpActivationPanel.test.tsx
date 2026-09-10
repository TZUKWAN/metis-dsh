/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { McpActivationIpcRequest } from '../../engine/runtime/McpActivationContract.js';
import type { McpDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { useMetisStore } from '../../src/store.js';
import McpActivationPanel, {
  type McpActivationPanelDependencies,
} from '../../src/personalization/McpActivationPanel.js';

const INSTALLATION_ID = 'mcp_0123456789abcdef0123456789abcdef';
const OPERATION_ID = '00000000-0000-4000-8000-000000000321';
const PACKAGE_DIGEST = 'a'.repeat(64);
const MANIFEST_DIGEST = 'b'.repeat(64);
const SOURCE_URL = 'https://packages.example.org/private/manifest.json?token=URL_SECRET_123';

function pendingDefinition(overrides: Partial<McpDefinition> = {}): McpDefinition {
  return {
    contractVersion: 1,
    id: 'url:mcp/panel-fixture',
    kind: 'mcp',
    name: 'C:\\private\\SECRET_PACKAGE_NAME',
    description: 'ENV_SECRET_123 must never be rendered',
    enabled: false,
    tags: ['url', 'pending-probe'],
    revision: 4,
    provenance: {
      origin: 'url',
      author: 'External package',
      version: '1.0.0',
      license: null,
      sourceUrl: SOURCE_URL,
      sourceRevision: INSTALLATION_ID,
      installedDigest: PACKAGE_DIGEST,
      parentId: null,
      parentVersion: null,
      locallyModified: false,
      createdAt: 100,
      updatedAt: 100,
    },
    sourceMode: 'url',
    transport: 'stdio',
    command: 'metis-managed-mcp',
    args: [INSTALLATION_ID],
    environment: {},
    sourceUrl: SOURCE_URL,
    exposedTools: [],
    workingDirectoryToken: INSTALLATION_ID,
    ...overrides,
  } as McpDefinition;
}

function successResponse(
  request: McpActivationIpcRequest,
  tools: readonly string[] = ['bounded_echo', 'lookup_record'],
) {
  const definition = pendingDefinition({
    enabled: true,
    revision: request.expectedRevision + 1,
    tags: ['url', 'probe-verified'],
    exposedTools: [...tools],
    provenance: {
      ...pendingDefinition().provenance,
      updatedAt: 200,
    },
  });
  return {
    ok: true as const,
    contractVersion: 1 as const,
    operationId: request.operationId,
    definition,
    installation: {
      installationId: request.installationId,
      packageId: 'panel-fixture',
      packageVersion: '1.0.0',
      manifestSha256: MANIFEST_DIGEST,
      packageSha256: PACKAGE_DIGEST,
      state: 'enabled' as const,
      enabled: true,
      installedAt: 100,
      verifiedAt: 120,
      probedAt: 180,
      exposedTools: [...tools],
      failureCode: null,
    },
    evidence: {
      envelopeVersion: 1 as const,
      envelopeId: `evidence_${'c'.repeat(32)}`,
      sessionId: 'activation-session',
      projectId: 'activation-project',
      operationId: request.operationId,
      runManifestDigest: 'd'.repeat(64),
      sourceDefinitionId: request.definitionId,
      sourceDefinitionRevision: request.expectedRevision + 1,
      sourceKind: 'mcp' as const,
      observedAt: 200,
      sourceUrl: SOURCE_URL,
      locator: null,
      payload: { kind: 'json' as const, canonicalJson: '{}' },
      payloadDigest: 'e'.repeat(64),
      truth: {
        state: 'unverified' as const,
        authority: 'metis_automatic_truth_layer' as const,
        reviewStatus: 'pending' as const,
        correctionState: 'unknown' as const,
        claimEligible: false as const,
        publishEligible: false as const,
      },
      signature: 'f'.repeat(64),
    },
  };
}

let activateMcp: ReturnType<typeof vi.fn>;
let dependencies: McpActivationPanelDependencies;

beforeEach(() => {
  useMetisStore.setState({ locale: 'zh' });
  activateMcp = vi.fn().mockImplementation((request: McpActivationIpcRequest) => Promise.resolve(successResponse(request)));
  dependencies = {
    createOperationId: () => OPERATION_ID,
    activateMcp,
  };
});

afterEach(cleanup);

describe('McpActivationPanel eligibility and IPC boundary', () => {
  it('renders only for an activation-ready disabled URL MCP', () => {
    const { rerender } = render(<McpActivationPanel definition={pendingDefinition()} dependencies={dependencies} />);
    expect(screen.getByRole('button', { name: '验证并激活' })).toBeDefined();

    rerender(<McpActivationPanel definition={pendingDefinition({ enabled: true })} dependencies={dependencies} />);
    expect(screen.queryByRole('region', { name: 'URL MCP 激活' })).toBeNull();

    const generated = pendingDefinition({
      id: 'generated:mcp/panel-fixture',
      sourceMode: 'generated',
      sourceUrl: null,
      provenance: {
        ...pendingDefinition().provenance,
        origin: 'generated',
        sourceUrl: null,
      },
    });
    rerender(<McpActivationPanel definition={generated} dependencies={dependencies} />);
    expect(activateMcp).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'URL MCP 激活' })).toBeNull();
  });

  it('sends exactly one strict owner-blind request per click and shows no confirmation dialog', async () => {
    render(<McpActivationPanel definition={pendingDefinition()} dependencies={dependencies} />);
    fireEvent.click(screen.getByRole('button', { name: '验证并激活' }));
    await waitFor(() => expect(activateMcp).toHaveBeenCalledTimes(1));
    const request = activateMcp.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).toEqual({
      contractVersion: 1,
      operationId: OPERATION_ID,
      definitionId: 'url:mcp/panel-fixture',
      installationId: INSTALLATION_ID,
      expectedRevision: 4,
    });
    expect(Object.keys(request).sort()).toEqual([
      'contractVersion', 'definitionId', 'expectedRevision', 'installationId', 'operationId',
    ]);
    expect(request).not.toHaveProperty('owner');
    expect(request).not.toHaveProperty('evidenceContext');
    expect(request).not.toHaveProperty('sampleCall');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('locks concurrent clicks before React rerenders', async () => {
    let resolveActivation!: (value: unknown) => void;
    activateMcp.mockImplementationOnce(() => new Promise((resolve) => { resolveActivation = resolve; }));
    render(<McpActivationPanel definition={pendingDefinition()} dependencies={dependencies} />);
    const button = screen.getByRole('button', { name: '验证并激活' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(activateMcp).toHaveBeenCalledTimes(1);
    const request = activateMcp.mock.calls[0]![0] as McpActivationIpcRequest;
    resolveActivation(successResponse(request));
    expect(await screen.findByText('激活成功')).toBeDefined();
  });

  it('discards a stale response and unlocks the newly supplied revision', async () => {
    let resolveOld!: (value: unknown) => void;
    activateMcp
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce((request: McpActivationIpcRequest) => Promise.resolve(successResponse(request)));
    const { rerender } = render(<McpActivationPanel definition={pendingDefinition()} dependencies={dependencies} />);
    fireEvent.click(screen.getByRole('button', { name: '验证并激活' }));
    const oldRequest = activateMcp.mock.calls[0]![0] as McpActivationIpcRequest;

    rerender(<McpActivationPanel definition={pendingDefinition({ revision: 5 })} dependencies={dependencies} />);
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    resolveOld(successResponse(oldRequest));
    await waitFor(() => expect((screen.getByRole('button', { name: '验证并激活' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText('激活成功')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '验证并激活' }));
    await waitFor(() => expect(activateMcp).toHaveBeenCalledTimes(2));
    expect(activateMcp.mock.calls[1]![0]).toMatchObject({ expectedRevision: 5 });
  });
});

describe('McpActivationPanel fail-closed result rendering', () => {
  it('shows a bounded tool count and summary without rendering source, command, path, or secret fields', async () => {
    const tools = ['tool_one', 'tool_two', 'tool_three', 'tool_four', 'tool_five', 'tool_six', 'tool_seven'];
    activateMcp.mockImplementationOnce((request: McpActivationIpcRequest) => Promise.resolve(successResponse(request, tools)));
    const onActivated = vi.fn();
    render(<McpActivationPanel definition={pendingDefinition()} dependencies={dependencies} onActivated={onActivated} />);
    fireEvent.click(screen.getByRole('button', { name: '验证并激活' }));

    expect(await screen.findByText('已验证并激活 7 个工具。')).toBeDefined();
    expect(screen.getByRole('list', { name: '已激活工具摘要' }).children).toHaveLength(5);
    expect(screen.getByText('另有 2 个工具。')).toBeDefined();
    expect(screen.queryByRole('button', { name: '验证并激活' })).toBeNull();
    expect(onActivated).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, revision: 5 }));
    expect(document.body.textContent).not.toMatch(/URL_SECRET_123|ENV_SECRET_123|SECRET_PACKAGE_NAME|metis-managed-mcp|packages\.example\.org|[A-Za-z]:\\/iu);
  });

  it('uses one fixed error for thrown details, malformed responses, and response-binding attacks', async () => {
    activateMcp.mockRejectedValueOnce(new Error('probe_failed at C:\\private\\TOKEN_SECRET.txt'));
    render(<McpActivationPanel definition={pendingDefinition()} dependencies={dependencies} />);
    fireEvent.click(screen.getByRole('button', { name: '验证并激活' }));
    expect((await screen.findByRole('alert')).textContent).toBe('激活失败。MCP 保持禁用状态。（invalid_response）');
    expect(document.body.textContent).not.toMatch(/probe_failed|private|TOKEN_SECRET/iu);

    cleanup();
    activateMcp.mockResolvedValueOnce({ ok: true, truth: { state: 'verified' }, secret: 'REFLECT_SECRET' });
    render(<McpActivationPanel definition={pendingDefinition()} dependencies={dependencies} />);
    fireEvent.click(screen.getByRole('button', { name: '验证并激活' }));
    expect((await screen.findByRole('alert')).textContent).toBe('激活失败。MCP 保持禁用状态。（invalid_response）');
    expect(document.body.textContent).not.toContain('REFLECT_SECRET');

    cleanup();
    activateMcp.mockImplementationOnce((request: McpActivationIpcRequest) => {
      const response = successResponse(request);
      return Promise.resolve({
        ...response,
        definition: {
          ...response.definition,
          command: 'powershell.exe',
          environment: { PROBE_TOKEN: { secret: false, value: 'INJECTED_ENV_SECRET' } },
        },
      });
    });
    render(<McpActivationPanel definition={pendingDefinition()} dependencies={dependencies} />);
    fireEvent.click(screen.getByRole('button', { name: '验证并激活' }));
    expect((await screen.findByRole('alert')).textContent).toBe('激活失败。MCP 保持禁用状态。（invalid_response）');
    expect(document.body.textContent).not.toMatch(/powershell|INJECTED_ENV_SECRET/iu);

    cleanup();
    activateMcp.mockImplementationOnce((request: McpActivationIpcRequest) => {
      const response = successResponse({ ...request, operationId: '00000000-0000-4000-8000-000000000999' });
      return Promise.resolve(response);
    });
    render(<McpActivationPanel definition={pendingDefinition()} dependencies={dependencies} />);
    fireEvent.click(screen.getByRole('button', { name: '验证并激活' }));
    expect((await screen.findByRole('alert')).textContent).toBe('激活失败。MCP 保持禁用状态。（invalid_response）');
    expect(screen.queryByText('激活成功')).toBeNull();
  });

  it('rejects an invalid renderer operation id without crossing the dependency boundary', async () => {
    dependencies = { ...dependencies, createOperationId: () => 'not-a-uuid' };
    render(<McpActivationPanel definition={pendingDefinition()} dependencies={dependencies} />);
    fireEvent.click(screen.getByRole('button', { name: '验证并激活' }));
    const invalidOperationAlert = await screen.findByRole('alert');
    expect(invalidOperationAlert.textContent).toBe('激活失败。MCP 保持禁用状态。（invalid_request）');
    expect(document.activeElement).toBe(invalidOperationAlert);
    expect(activateMcp).not.toHaveBeenCalled();
  });

  it('switches every visible and accessible label to English while retaining the failure code', async () => {
    useMetisStore.setState({ locale: 'en' });
    activateMcp.mockImplementationOnce((request: McpActivationIpcRequest) => Promise.resolve({
      ok: false,
      contractVersion: 1,
      operationId: request.operationId,
      code: 'probe_failed',
      compensated: true,
      recoveryPending: false,
    }));
    render(<McpActivationPanel definition={pendingDefinition()} dependencies={dependencies} />);
    expect(screen.getByRole('region', { name: 'MCP activation' })).toBeDefined();
    expect(screen.getByText('Verify MCP')).toBeDefined();
    const action = screen.getByRole('button', { name: 'Verify and activate' });
    fireEvent.click(action);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Activation failed. The MCP remains disabled. (probe_failed)');
    expect(document.activeElement).toBe(alert);
    expect(document.body.textContent).not.toContain('验证 MCP');

    cleanup();
    render(<McpActivationPanel definition={pendingDefinition()} dependencies={dependencies} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verify and activate' }));
    expect(await screen.findByText('Activation succeeded')).toBeDefined();
    expect(screen.getByText('Verified and activated 2 tools.')).toBeDefined();
    expect(screen.getByRole('list', { name: 'Activated tool summary' })).toBeDefined();
  });

  it('keeps responsive, keyboard, reduced-motion, and forced-colors safeguards scoped', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/personalization/McpActivationPanel.css'), 'utf8');
    expect(css).toContain('.mcp-activation-panel__action:focus-visible');
    expect(css).toContain('@media (max-width: 640px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media (forced-colors: active)');
  });
});
