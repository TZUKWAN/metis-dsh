/**
 * DashboardPage project-artifact stat card: shows totals + pending count
 * for the active project, and navigates to the analysis workspace.
 *
 * @vitest-environment jsdom
 */

import { render, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMetisStore } from '../../src/store';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore';

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  }
});

describe('DashboardPage artifact stat card', () => {
  beforeEach(() => {
    useMetisStore.setState({
      papers: [],
      paperFilter: { query: '' },
      notes: [],
      experiments: [],
      collections: [],
      workflowRuns: [],
      locale: 'zh',
      theme: 'light',
      isHydrated: true,
      selectedPaperId: null,
    });
    researchWorkspaceStore.setState({ activeProjectId: 'project-1' });
    window.metis = {
      artifactListByProject: vi.fn().mockResolvedValue({
        items: [
          { id: 'a1', reviewStatus: 'draft' },
          { id: 'a2', reviewStatus: 'pending' },
          { id: 'a3', reviewStatus: 'pending' },
          { id: 'a4', reviewStatus: 'verified' },
        ],
      }),
    } as unknown as typeof window.metis;
  });

  it('renders the artifact card with total and pending counts', async () => {
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    const { container } = render(<DashboardPage />);

    await waitFor(() => {
      expect(container.textContent).toContain('项目成果');
    });
    expect(container.textContent).toContain('4（2 待审核）');
    expect(window.metis?.artifactListByProject).toHaveBeenCalledWith('project-1');
  });

  it('hides the card when no project is active', async () => {
    researchWorkspaceStore.setState({ activeProjectId: null });
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    const { container } = render(<DashboardPage />);
    await waitFor(() => {
      expect(container.textContent).toContain('仪表盘');
    });
    expect(container.textContent).not.toContain('项目成果');
  });
});
