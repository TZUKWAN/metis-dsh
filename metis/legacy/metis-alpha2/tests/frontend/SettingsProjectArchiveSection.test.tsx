// @vitest-environment jsdom
/**
 * METIS-F10 — project archive settings section UI tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SettingsProjectArchiveSection from '../../src/components/SettingsProjectArchiveSection';

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).metis;
});

function mockMetis(overrides: Record<string, unknown> = {}) {
  const metis = {
    listProjects: vi.fn(async () => ({
      success: true,
      projects: [
        { id: 'proj-a', title: 'RAG 调研', updatedAt: 1000, archivedAt: null },
        { id: 'proj-b', title: 'Attention 综述', updatedAt: 2000, archivedAt: null },
      ],
    })),
    exportProject: vi.fn(async () => ({ ok: true, path: 'C:\\data\\exports\\proj-a-2026.mts' })),
    importProject: vi.fn(async () => ({ ok: true, projectId: 'proj-c', restored: { projectId: 'proj-c', entityCounts: {}, attachedFiles: { count: 0, bytes: 0, restoredPaths: [] } } })),
    pickProjectArchive: vi.fn(async () => ({ canceled: false, path: 'C:\\backups\\export.mts' })),
    ...overrides,
  };
  (window as unknown as { metis: unknown }).metis = metis;
  return metis;
}

describe('SettingsProjectArchiveSection', () => {
  it('lists projects and exports the selected one', async () => {
    const metis = mockMetis();
    render(<SettingsProjectArchiveSection uiMode="production" />);

    await waitFor(() => expect(metis.listProjects).toHaveBeenCalled());
    const select = screen.getByTestId('project-archive-select') as HTMLSelectElement;
    expect(select.options.length).toBe(2);
    expect(select.value).toBe('proj-a');

    fireEvent.change(select, { target: { value: 'proj-b' } });
    fireEvent.click(screen.getByTestId('project-export-button'));

    await waitFor(() => {
      expect(metis.exportProject).toHaveBeenCalledWith({ projectId: 'proj-b' });
      expect(screen.getByTestId('project-archive-status')).toBeDefined();
      expect(screen.getByText(/项目归档已导出/)).toBeDefined();
    });
    // The saved path is surfaced so the user knows where the archive lives.
    expect(screen.getByText(/proj-a-2026.mts/)).toBeDefined();
  });

  it('imports a picked archive with the overwrite toggle', async () => {
    const metis = mockMetis();
    render(<SettingsProjectArchiveSection uiMode="production" />);

    await waitFor(() => expect(metis.listProjects).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('project-overwrite-toggle'));
    fireEvent.click(screen.getByTestId('project-import-button'));

    await waitFor(() => {
      expect(metis.pickProjectArchive).toHaveBeenCalled();
      expect(metis.importProject).toHaveBeenCalledWith({
        archivePath: 'C:\\backups\\export.mts',
        overwrite: true,
      });
      expect(screen.getByText(/项目归档已导入/)).toBeDefined();
    });
  });

  it('surfaces export failures without pretending success', async () => {
    const metis = mockMetis({
      exportProject: vi.fn(async () => ({ ok: false, error: 'project_exists:proj-a' })),
    });
    render(<SettingsProjectArchiveSection uiMode="production" />);

    await waitFor(() => expect(metis.listProjects).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('project-export-button'));

    await waitFor(() => {
      const status = screen.getByTestId('project-archive-status');
      expect(status.textContent).toContain('project_exists:proj-a');
    });
    expect(screen.queryByText(/项目归档已导出/)).toBeNull();
  });

  it('shows an empty state when no projects exist', async () => {
    mockMetis({ listProjects: vi.fn(async () => ({ success: true, projects: [] })) });
    render(<SettingsProjectArchiveSection uiMode="production" />);

    await waitFor(() => {
      const select = screen.getByTestId('project-archive-select') as HTMLSelectElement;
      expect(select.options.length).toBe(1);
      expect(select.value).toBe('');
    });
    expect(screen.getByTestId('project-export-button').hasAttribute('disabled')).toBe(true);
  });
});
