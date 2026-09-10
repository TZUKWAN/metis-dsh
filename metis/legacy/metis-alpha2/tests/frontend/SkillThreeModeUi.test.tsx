/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import type { PersonalizationDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { useMetisStore } from '../../src/store.js';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore.js';
import PersonalizationCenter from '../../src/personalization/PersonalizationCenter.js';

let definitions: PersonalizationDefinition[];
let applyExtension: ReturnType<typeof vi.fn>;
let selectCapability: ReturnType<typeof vi.fn>;
let saveDefinition: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useMetisStore.setState({ locale: 'en' });
  researchWorkspaceStore.setState({ activeProjectId: null });
  definitions = structuredClone(buildBuiltinPersonalizationDefinitions());
  applyExtension = vi.fn().mockImplementation((request: { mode: string; id?: string; expectedId?: string }) => {
    const id = request.id ?? request.expectedId ?? 'user:skills/ui-package';
    return Promise.resolve({
      ok: true,
      mode: request.mode,
      definition: { id },
      evidence: {},
      skillInstallation: request.mode === 'skill_markdown' ? null : {},
      mcpInstallation: null,
    });
  });
  selectCapability = vi.fn().mockImplementation((purpose: string) => Promise.resolve({
    success: true,
    capability: purpose === 'personalization-skill-directory'
      ? {
          capabilityId: `fc_${'e'.repeat(32)}`,
          kind: 'folder',
          mime: 'inode/directory',
          displayName: 'ui-skill-folder',
          operations: ['folder'],
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        }
      : {
          capabilityId: `fc_${'d'.repeat(32)}`,
          kind: 'file',
          mime: 'application/zip',
          displayName: 'ui-skill.zip',
          operations: ['file'],
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
  }));
  saveDefinition = vi.fn().mockImplementation((request: { definition: PersonalizationDefinition }) => {
    definitions = [...definitions, request.definition];
    return Promise.resolve({ ok: true, code: 'saved', definition: request.definition });
  });
  Object.defineProperty(window, 'metis', {
    configurable: true,
    writable: true,
    value: {
      listPersonalization: vi.fn().mockImplementation(() => Promise.resolve({ ok: true, definitions })),
      savePersonalization: saveDefinition,
      applyPersonalizationExtension: applyExtension,
      selectFileCapability: selectCapability,
      archivePersonalization: vi.fn(),
      forkPersonalization: vi.fn(),
      listPersonalizationSecrets: vi.fn().mockResolvedValue({
        ok: true,
        contractVersion: 1,
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        revision: 0,
        secrets: [],
      }),
      capabilityVaultSources: vi.fn().mockResolvedValue({ ok: true, sources: [] }),
      capabilityVaultStats: vi.fn().mockResolvedValue({ ok: true, stats: { total: 0, skills: 0, mcps: 0, installed: 0, sources: 0 } }),
      capabilityVaultImportSource: vi.fn().mockResolvedValue({ ok: false, imported: 0, excluded: 0 }),
      capabilityVaultList: vi.fn().mockResolvedValue({ ok: true, entries: [] }),
      capabilityVaultGetDetail: vi.fn().mockResolvedValue({ ok: false }),
      capabilityVaultInstall: vi.fn().mockResolvedValue({ ok: false, code: 'install_failed' }),
      capabilityVaultUninstall: vi.fn().mockResolvedValue({ ok: false }),
    },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'metis', { configurable: true, writable: true, value: undefined });
});

async function openSkills(): Promise<void> {
  render(<PersonalizationCenter />);
  fireEvent.click(await screen.findByRole('button', { name: /Skills/ }));
  await screen.findByRole('button', { name: 'Choose skill ZIP package' });
}

describe('Skill three-mode personalization UI', () => {
  it('sends a selected ZIP only as an opaque capability, never as a local path', async () => {
    await openSkills();
    fireEvent.click(screen.getByRole('button', { name: 'Choose skill ZIP package' }));
    await waitFor(() => expect(selectCapability).toHaveBeenCalledWith('personalization-skill-package'));
    expect(await screen.findByText('ZIP: ui-skill.zip')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Verify and install' }));
    await waitFor(() => expect(applyExtension).toHaveBeenCalledTimes(1));
    const request = applyExtension.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      contractVersion: 1,
      mode: 'skill_package',
      expectedRevision: 0,
      sourceCapabilityId: `fc_${'d'.repeat(32)}`,
      expectedId: null,
    });
    expect(request).not.toHaveProperty('sourcePath');
    expect(request).not.toHaveProperty('evidenceContext');
  });

  it('selects a skill folder through its distinct purpose and still sends only the opaque capability', async () => {
    await openSkills();
    fireEvent.click(screen.getByRole('button', { name: 'Choose skill folder' }));
    await waitFor(() => expect(selectCapability).toHaveBeenCalledWith('personalization-skill-directory'));
    expect(await screen.findByText('Folder: ui-skill-folder')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Verify and install' }));
    await waitFor(() => expect(applyExtension).toHaveBeenCalledTimes(1));
    const request = applyExtension.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      contractVersion: 1,
      mode: 'skill_package',
      expectedRevision: 0,
      sourceCapabilityId: `fc_${'e'.repeat(32)}`,
      expectedId: null,
    });
    expect(request).not.toHaveProperty('sourcePath');
    expect(request).not.toHaveProperty('evidenceContext');
  });

  it('refuses a file capability returned for the directory purpose', async () => {
    selectCapability
      .mockResolvedValueOnce({
        success: true,
        capability: {
          capabilityId: `fc_${'d'.repeat(32)}`,
          kind: 'file',
          mime: 'application/zip',
          displayName: 'initial-valid.zip',
          operations: ['file'],
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      })
      .mockResolvedValueOnce({
      success: true,
      capability: {
        capabilityId: `fc_${'f'.repeat(32)}`,
        kind: 'file',
        mime: 'application/zip',
        displayName: 'wrong-kind.zip',
        operations: ['file'],
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    });
    await openSkills();
    fireEvent.click(screen.getByRole('button', { name: 'Choose skill ZIP package' }));
    expect(await screen.findByText('ZIP: initial-valid.zip')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Choose skill folder' }));
    expect(await screen.findByText('No valid skill folder was selected')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Verify and install' }));
    expect(await screen.findByText('Choose a skill ZIP package or folder first')).toBeDefined();
    expect(applyExtension).not.toHaveBeenCalled();
  });

  it('sends a GitHub installation with version and digest constraints without manual ID entry', async () => {
    await openSkills();
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'skill_url' } });
    fireEvent.change(screen.getByLabelText('Skill package URL / GitHub address'), {
      target: { value: 'https://github.com/metis-test/ui-skill' },
    });
    expect(screen.queryByLabelText('Expected skill ID (optional)')).toBeNull();
    fireEvent.change(screen.getByLabelText('Expected version (optional)'), { target: { value: '1.2.3' } });
    fireEvent.change(screen.getByLabelText('Expected SHA-256 (optional)'), { target: { value: 'A'.repeat(64) } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and install' }));
    await waitFor(() => expect(applyExtension).toHaveBeenCalledTimes(1));
    expect(applyExtension.mock.calls[0]?.[0]).toMatchObject({
      contractVersion: 1,
      mode: 'skill_url',
      url: 'https://github.com/metis-test/ui-skill',
      expectedArchiveSha256: 'a'.repeat(64),
      expectedId: null,
      expectedVersion: '1.2.3',
      expectedRevision: 0,
    });
  });

  it('creates a Markdown definition, then saves authored content through the signed extension boundary', async () => {
    await openSkills();
    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await waitFor(() => expect(saveDefinition).toHaveBeenCalledTimes(1));
    const created = saveDefinition.mock.calls[0]?.[0]?.definition as PersonalizationDefinition;
    expect(created).toMatchObject({ kind: 'skill', sourceMode: 'markdown' });
    await waitFor(() => expect(document.querySelector(`[data-definition-id="${created.id}"]`)).not.toBeNull());
    fireEvent.click(document.querySelector(`[data-definition-id="${created.id}"]`) as HTMLButtonElement);
    const markdown = await screen.findByRole('textbox', { name: 'Skill Markdown' });
    fireEvent.change(markdown, { target: { value: '# UI Markdown\n\nUI_MARKDOWN_EXACT' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new revision' }));
    await waitFor(() => expect(applyExtension).toHaveBeenCalledTimes(1));
    expect(applyExtension.mock.calls[0]?.[0]).toMatchObject({
      contractVersion: 1,
      mode: 'skill_markdown',
      id: created.id,
      expectedRevision: 1,
      markdown: '# UI Markdown\n\nUI_MARKDOWN_EXACT',
    });
  });
});
