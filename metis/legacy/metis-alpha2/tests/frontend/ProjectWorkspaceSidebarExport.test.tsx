/**
 * ProjectWorkspaceSidebar — the sidebar export button writes the active
 * project to a single .mts archive and reports the resulting path.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore';

function seedWorkspace() {
  researchWorkspaceStore.setState({
    projects: [{ id: 'proj-1', title: '导出测试项目', lifecycle: 'active' }] as never,
    activeProjectId: 'proj-1',
    snapshot: {
      project: { id: 'proj-1', title: '导出测试项目' },
      sources: [],
      evidence: [],
      noteCodes: [],
      claims: [],
      artifacts: [],
      runs: [],
      decisions: [],
      checkpoints: [],
    } as never,
    activeSection: 'project',
    loading: { projects: false, snapshot: false, mutation: false } as never,
    error: null,
  });
}

describe('ProjectWorkspaceSidebar export', () => {
  beforeEach(() => {
    seedWorkspace();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    delete (window as unknown as { metis?: unknown }).metis;
  });

  it('exports the active project and reports the archive path', async () => {
    const exportProject = vi.fn().mockResolvedValue({
      ok: true,
      path: 'C:\\exports\\proj-1-2026.mts',
    });
    window.metis = { exportProject } as unknown as typeof window.metis;

    const { default: ProjectWorkspaceSidebar } = await import('../../src/research/ProjectWorkspaceSidebar');
    render(<ProjectWorkspaceSidebar />);

    const button = await screen.findByTestId('sidebar-export-project');
    fireEvent.click(button);

    await waitFor(() => {
      expect(exportProject).toHaveBeenCalledWith({ projectId: 'proj-1' });
    });
    expect(await screen.findByText(/已导出：C:\\exports\\proj-1-2026\.mts/)).toBeDefined();
  });

  it('surfaces an export failure', async () => {
    window.metis = {
      exportProject: vi.fn().mockResolvedValue({ ok: false, error: 'project_not_found' }),
    } as unknown as typeof window.metis;

    const { default: ProjectWorkspaceSidebar } = await import('../../src/research/ProjectWorkspaceSidebar');
    render(<ProjectWorkspaceSidebar />);

    fireEvent.click(await screen.findByTestId('sidebar-export-project'));

    expect(await screen.findByText(/导出项目失败：project_not_found/)).toBeDefined();
  });
});
