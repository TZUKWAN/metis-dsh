/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WORKSPACE_AGENTS_LIMITS } from '../../engine/runtime/WorkspaceAgentsContract.js';
import ProjectMetisRulesEditor from '../../src/personalization/ProjectMetisRulesEditor.js';
import { useMetisStore } from '../../src/store.js';

let getWorkspaceAgents: ReturnType<typeof vi.fn>;
let setWorkspaceAgents: ReturnType<typeof vi.fn>;

function view(projectId: string, content: string, version: number, externalConflict = false) {
  return {
    exists: true,
    content,
    version,
    contentHash: `${projectId}-${version}`,
    projectId,
    ...(externalConflict ? { externalConflict: true } : {}),
  };
}

async function loadedTextarea(expectedValue: string): Promise<HTMLTextAreaElement> {
  const textarea = screen.getByTestId('project-metis-rules-textarea') as HTMLTextAreaElement;
  await waitFor(() => expect(textarea.value).toBe(expectedValue));
  return textarea;
}

beforeEach(() => {
  useMetisStore.setState({ locale: 'en' });
  getWorkspaceAgents = vi.fn().mockResolvedValue(view('project-a', '# Project A\n', 1));
  setWorkspaceAgents = vi.fn().mockResolvedValue({
    success: true,
    code: 'saved',
    version: 2,
    contentHash: 'saved-digest',
  });
  Object.defineProperty(window, 'metis', {
    configurable: true,
    writable: true,
    value: { getWorkspaceAgents, setWorkspaceAgents },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'metis', { configurable: true, writable: true, value: undefined });
});

describe('ProjectMetisRulesEditor', () => {
  it('clearly disables the authoritative editor when no project is active', () => {
    render(<ProjectMetisRulesEditor projectId={null} />);
    const textarea = screen.getByRole('textbox', { name: 'Current project Metis.md content' }) as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(screen.getByText('Open or create a research project first. Current project Metis.md is disabled.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save Metis.md' })).toHaveProperty('disabled', true);
    expect(getWorkspaceAgents).not.toHaveBeenCalled();
  });

  it('loads and saves through the authoritative project/version API without a path', async () => {
    getWorkspaceAgents.mockResolvedValueOnce(view('project-a', '# Disk rules\n', 4));
    render(<ProjectMetisRulesEditor projectId="project-a" />);
    const textarea = await loadedTextarea('# Disk rules\n');
    expect(textarea.maxLength).toBe(WORKSPACE_AGENTS_LIMITS.maxChars);
    fireEvent.change(textarea, { target: { value: '# Local rules\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Metis.md' }));
    await waitFor(() => expect(setWorkspaceAgents).toHaveBeenCalledWith('project-a', '# Local rules\n', 4));
    expect(setWorkspaceAgents.mock.calls[0]).toHaveLength(3);
    expect(JSON.stringify(setWorkspaceAgents.mock.calls[0])).not.toMatch(/[A-Z]:[\\/]/u);
    expect(await screen.findByText('Metis.md saved.')).toBeDefined();
  });

  it('rejects C0/C1 input before IPC and focuses the validation alert', async () => {
    render(<ProjectMetisRulesEditor projectId="project-a" />);
    const textarea = await loadedTextarea('# Project A\n');
    fireEvent.change(textarea, { target: { value: '# Rules\nforbidden\u0001control' } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('forbidden C0/C1 control characters');
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(screen.getByRole('button', { name: 'Save Metis.md' })).toHaveProperty('disabled', true);
    expect(setWorkspaceAgents).not.toHaveBeenCalled();
  });

  it('preserves a CAS-conflicted draft, rebases Keep Local Draft, and saves with the disk version', async () => {
    getWorkspaceAgents
      .mockResolvedValueOnce(view('project-a', '# Original\n', 1))
      .mockResolvedValueOnce(view('project-a', '# New disk\n', 5));
    setWorkspaceAgents
      .mockResolvedValueOnce({
        success: false,
        code: 'cas_conflict',
        currentVersion: 5,
        currentContentHash: 'disk-5',
      })
      .mockResolvedValueOnce({
        success: true,
        code: 'saved',
        version: 6,
        contentHash: 'saved-6',
      });

    render(<ProjectMetisRulesEditor projectId="project-a" />);
    const textarea = await loadedTextarea('# Original\n');
    fireEvent.change(textarea, { target: { value: '# My preserved draft\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Metis.md' }));

    const conflict = await screen.findByRole('alert');
    expect(conflict.textContent).toContain('A newer disk version exists');
    expect(textarea.value).toBe('# My preserved draft\n');
    await waitFor(() => expect(document.activeElement).toBe(conflict));

    fireEvent.click(screen.getByRole('button', { name: 'Keep Local Draft' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Metis.md' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'Save Metis.md' }));
    await waitFor(() => expect(setWorkspaceAgents).toHaveBeenCalledTimes(2));
    expect(setWorkspaceAgents.mock.calls[1]).toEqual(['project-a', '# My preserved draft\n', 5]);
  });

  it('adopts the latest disk version only after explicit conflict resolution', async () => {
    getWorkspaceAgents
      .mockResolvedValueOnce(view('project-a', '# Original\n', 1))
      .mockResolvedValueOnce(view('project-a', '# New disk\n', 5));
    setWorkspaceAgents.mockResolvedValueOnce({
      success: false,
      code: 'cas_conflict',
      currentVersion: 5,
      currentContentHash: 'disk-5',
    });

    render(<ProjectMetisRulesEditor projectId="project-a" />);
    const textarea = await loadedTextarea('# Original\n');
    fireEvent.change(textarea, { target: { value: '# Local draft\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Metis.md' }));
    await screen.findByRole('button', { name: 'Use Disk Version' });
    expect(textarea.value).toBe('# Local draft\n');
    fireEvent.click(screen.getByRole('button', { name: 'Use Disk Version' }));
    await waitFor(() => expect(textarea.value).toBe('# New disk\n'));
    expect(screen.getByRole('button', { name: 'Save Metis.md' })).toHaveProperty('disabled', true);
  });

  it('isolates dirty drafts across responsive project switches', async () => {
    getWorkspaceAgents.mockImplementation((projectId: string) => Promise.resolve(
      projectId === 'project-a'
        ? view('project-a', '# A disk\n', 1)
        : view('project-b', '# B disk\n', 3),
    ));
    const rendered = render(<ProjectMetisRulesEditor projectId="project-a" />);
    const textarea = await loadedTextarea('# A disk\n');
    fireEvent.change(textarea, { target: { value: '# A local draft\n' } });

    rendered.rerender(<ProjectMetisRulesEditor projectId="project-b" />);
    await waitFor(() => expect(textarea.value).toBe('# B disk\n'));
    fireEvent.change(textarea, { target: { value: '# B local draft\n' } });

    rendered.rerender(<ProjectMetisRulesEditor projectId="project-a" />);
    await waitFor(() => expect(textarea.value).toBe('# A local draft\n'));
    expect(getWorkspaceAgents).toHaveBeenCalledWith('project-a');
    expect(getWorkspaceAgents).toHaveBeenCalledWith('project-b');
  });

  it('does not let a late project-A save response mark an edited project-B draft as saved', async () => {
    let resolveProjectA!: (result: {
      success: true;
      code: 'saved';
      version: number;
      contentHash: string;
    }) => void;
    const projectASave = new Promise<{
      success: true;
      code: 'saved';
      version: number;
      contentHash: string;
    }>((resolve) => { resolveProjectA = resolve; });
    getWorkspaceAgents.mockImplementation((projectId: string) => Promise.resolve(
      projectId === 'project-a'
        ? view('project-a', '# A disk\n', 1)
        : view('project-b', '# B disk\n', 4),
    ));
    setWorkspaceAgents.mockImplementation((projectId: string) => projectId === 'project-a'
      ? projectASave
      : Promise.resolve({ success: true, code: 'saved', version: 5, contentHash: 'b-saved' }));

    const rendered = render(<ProjectMetisRulesEditor projectId="project-a" />);
    const textarea = await loadedTextarea('# A disk\n');
    fireEvent.change(textarea, { target: { value: '# A saved content\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Metis.md' }));
    await waitFor(() => expect(setWorkspaceAgents).toHaveBeenCalledWith('project-a', '# A saved content\n', 1));

    rendered.rerender(<ProjectMetisRulesEditor projectId="project-b" />);
    await waitFor(() => expect(textarea.value).toBe('# B disk\n'));
    fireEvent.change(textarea, { target: { value: '# B dirty draft\n' } });
    expect(screen.getByRole('button', { name: 'Save Metis.md' })).toHaveProperty('disabled', false);

    await act(async () => {
      resolveProjectA({ success: true, code: 'saved', version: 2, contentHash: 'a-saved' });
      await projectASave;
    });
    expect(textarea.value).toBe('# B dirty draft\n');
    expect(screen.queryByText('Metis.md saved.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save Metis.md' })).toHaveProperty('disabled', false);

    fireEvent.click(screen.getByRole('button', { name: 'Save Metis.md' }));
    await waitFor(() => expect(setWorkspaceAgents).toHaveBeenCalledWith('project-b', '# B dirty draft\n', 4));
  });

  it('rebases each repeated CAS conflict from the authoritative reread instead of trusting stale conflict metadata', async () => {
    getWorkspaceAgents
      .mockResolvedValueOnce(view('project-a', '# Original\n', 1))
      .mockResolvedValueOnce(view('project-a', '# Disk five\n', 5))
      .mockResolvedValueOnce(view('project-a', '# Disk seven\n', 7));
    setWorkspaceAgents
      .mockResolvedValueOnce({
        success: false,
        code: 'cas_conflict',
        currentVersion: 999,
        currentContentHash: 'untrusted-conflict-metadata',
      })
      .mockResolvedValueOnce({
        success: false,
        code: 'cas_conflict',
        currentVersion: 1000,
        currentContentHash: 'still-untrusted',
      })
      .mockResolvedValueOnce({ success: true, code: 'saved', version: 8, contentHash: 'saved-eight' });

    render(<ProjectMetisRulesEditor projectId="project-a" />);
    const textarea = await loadedTextarea('# Original\n');
    fireEvent.change(textarea, { target: { value: '# Draft surviving both conflicts\n' } });

    for (const expectedVersion of [1, 5]) {
      fireEvent.click(screen.getByRole('button', { name: 'Save Metis.md' }));
      await screen.findByRole('button', { name: 'Keep Local Draft' });
      expect(setWorkspaceAgents).toHaveBeenLastCalledWith(
        'project-a', '# Draft surviving both conflicts\n', expectedVersion,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Keep Local Draft' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save Metis.md' })).toHaveProperty('disabled', false));
    }

    fireEvent.click(screen.getByRole('button', { name: 'Save Metis.md' }));
    await waitFor(() => expect(setWorkspaceAgents).toHaveBeenLastCalledWith(
      'project-a', '# Draft surviving both conflicts\n', 7,
    ));
    expect(await screen.findByText('Metis.md saved.')).toBeDefined();
  });

  it('fails closed and focuses an alert for main-process integrity conflicts', async () => {
    getWorkspaceAgents.mockResolvedValueOnce(view('project-a', '# Canonical\n', 2, true));
    render(<ProjectMetisRulesEditor projectId="project-a" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Project-rule integrity validation failed');
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(screen.getByRole('textbox', { name: 'Current project Metis.md content' })).toHaveProperty('disabled', true);
    expect(setWorkspaceAgents).not.toHaveBeenCalled();
  });

  it('rejects a response bound to a different project', async () => {
    getWorkspaceAgents.mockResolvedValueOnce(view('project-b', '# Wrong project\n', 9));
    render(<ProjectMetisRulesEditor projectId="project-a" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('does not match the active project');
    expect(screen.getByRole('textbox', { name: 'Current project Metis.md content' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('textbox', { name: 'Current project Metis.md content' })).toHaveProperty('value', '');
  });
});
