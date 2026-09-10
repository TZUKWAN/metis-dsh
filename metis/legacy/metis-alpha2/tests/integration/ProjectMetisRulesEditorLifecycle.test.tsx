/** @vitest-environment jsdom */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceAgentsManager } from '../../engine/memory/WorkspaceAgentsManager.js';
import ProjectMetisRulesEditor from '../../src/personalization/ProjectMetisRulesEditor.js';
import { useMetisStore } from '../../src/store.js';

let root: string;
let manager: WorkspaceAgentsManager;
let getWorkspaceAgents: ReturnType<typeof vi.fn>;
let setWorkspaceAgents: ReturnType<typeof vi.fn>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-authoritative-editor-'));
  manager = new WorkspaceAgentsManager(root, 'project-a');
  expect(manager.write('# Initial disk rule\n', 0)).toMatchObject({ success: true, version: 1 });
  useMetisStore.setState({ locale: 'en' });
  getWorkspaceAgents = vi.fn(async (projectId: string) => {
    if (projectId !== 'project-a') throw new Error('Unexpected project');
    return manager.read();
  });
  setWorkspaceAgents = vi.fn(async (projectId: string, content: string, expectedVersion: number) => {
    if (projectId !== 'project-a') throw new Error('Unexpected project');
    return manager.write(content, expectedVersion);
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
  fs.rmSync(root, { recursive: true, force: true });
});

describe('authoritative project Metis.md UI-to-manager lifecycle', () => {
  it('saves independent project rules, switches projects, and reloads both from disk after restart', async () => {
    const projectB = new WorkspaceAgentsManager(root, 'project-b');
    const managers = new Map<string, WorkspaceAgentsManager>([
      ['project-a', manager],
      ['project-b', projectB],
    ]);
    getWorkspaceAgents = vi.fn(async (projectId: string) => {
      const selected = managers.get(projectId);
      if (!selected) throw new Error(`Unexpected project: ${projectId}`);
      return selected.read();
    });
    setWorkspaceAgents = vi.fn(async (projectId: string, content: string, expectedVersion: number) => {
      const selected = managers.get(projectId);
      if (!selected) throw new Error(`Unexpected project: ${projectId}`);
      return selected.write(content, expectedVersion);
    });
    Object.defineProperty(window, 'metis', {
      configurable: true,
      writable: true,
      value: { getWorkspaceAgents, setWorkspaceAgents },
    });

    const mounted = render(<ProjectMetisRulesEditor projectId="project-a" />);
    let textarea = screen.getByTestId('project-metis-rules-textarea') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe('# Initial disk rule\n'));
    fireEvent.change(textarea, { target: { value: '# Project A durable rule\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Metis.md' }));
    await waitFor(() => expect(manager.read()).toMatchObject({
      content: '# Project A durable rule\n',
      version: 2,
    }));

    mounted.rerender(<ProjectMetisRulesEditor projectId="project-b" />);
    textarea = screen.getByTestId('project-metis-rules-textarea') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(''));
    fireEvent.change(textarea, { target: { value: '# Project B durable rule\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Metis.md' }));
    await waitFor(() => expect(projectB.read()).toMatchObject({
      content: '# Project B durable rule\n',
      version: 1,
    }));

    mounted.rerender(<ProjectMetisRulesEditor projectId="project-a" />);
    textarea = screen.getByTestId('project-metis-rules-textarea') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe('# Project A durable rule\n'));
    expect(screen.getByText('project-a')).toBeDefined();
    mounted.unmount();

    const restartedManagers = new Map<string, WorkspaceAgentsManager>([
      ['project-a', new WorkspaceAgentsManager(root, 'project-a')],
      ['project-b', new WorkspaceAgentsManager(root, 'project-b')],
    ]);
    Object.defineProperty(window, 'metis', {
      configurable: true,
      writable: true,
      value: {
        getWorkspaceAgents: async (projectId: string) => {
          const selected = restartedManagers.get(projectId);
          if (!selected) throw new Error(`Unexpected project: ${projectId}`);
          return selected.read();
        },
        setWorkspaceAgents: async (projectId: string, content: string, expectedVersion: number) => {
          const selected = restartedManagers.get(projectId);
          if (!selected) throw new Error(`Unexpected project: ${projectId}`);
          return selected.write(content, expectedVersion);
        },
      },
    });

    const restarted = render(<ProjectMetisRulesEditor projectId="project-a" />);
    textarea = screen.getByTestId('project-metis-rules-textarea') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe('# Project A durable rule\n'));
    restarted.rerender(<ProjectMetisRulesEditor projectId="project-b" />);
    textarea = screen.getByTestId('project-metis-rules-textarea') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe('# Project B durable rule\n'));
    expect(restartedManagers.get('project-a')?.read()).toMatchObject({
      content: '# Project A durable rule\n',
      version: 2,
    });
    expect(restartedManagers.get('project-b')?.read()).toMatchObject({
      content: '# Project B durable rule\n',
      version: 1,
    });
  });

  it('preserves a local draft across a real CAS conflict and commits only after explicit rebasing', async () => {
    render(<ProjectMetisRulesEditor projectId="project-a" />);
    const textarea = screen.getByTestId('project-metis-rules-textarea') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe('# Initial disk rule\n'));
    fireEvent.change(textarea, { target: { value: '# Local authoritative rule\n' } });

    expect(manager.write('# Concurrent disk rule\n', 1)).toMatchObject({ success: true, version: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Save Metis.md' }));
    await screen.findByRole('button', { name: 'Keep Local Draft' });

    expect(textarea.value).toBe('# Local authoritative rule\n');
    expect(manager.read()).toMatchObject({ content: '# Concurrent disk rule\n', version: 2 });
    expect(setWorkspaceAgents).toHaveBeenLastCalledWith('project-a', '# Local authoritative rule\n', 1);

    fireEvent.click(screen.getByRole('button', { name: 'Keep Local Draft' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Metis.md' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'Save Metis.md' }));

    await waitFor(() => expect(manager.read()).toMatchObject({
      content: '# Local authoritative rule\n',
      version: 3,
    }));
    expect(setWorkspaceAgents).toHaveBeenLastCalledWith('project-a', '# Local authoritative rule\n', 2);
    expect(setWorkspaceAgents.mock.calls.every((call) => call.length === 3)).toBe(true);
  });
});
