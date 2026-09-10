// @vitest-environment jsdom
/**
 * ProjectTasksPanel — project-bound tasks in the research workspace.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProjectTasksPanel from '../../src/research/ProjectTasksPanel';

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).metis;
});

function mockMetis(overrides: Record<string, unknown> = {}) {
  const metis = {
    listGoals: vi.fn(async () => ({
      success: true,
      goals: [
        { goalId: 'goal-proj', label: '项目任务 A', status: 'running', createdAt: 1, projectId: 'proj-1' },
        { goalId: 'goal-proj2', label: '项目任务 B', status: 'draft', createdAt: 2, projectId: 'proj-1' },
        { goalId: 'goal-other', label: '别的项目任务', status: 'ready', createdAt: 3, projectId: 'proj-2' },
        { goalId: 'goal-global', label: '全局任务', status: 'ready', createdAt: 4 },
      ],
    })),
    createGoal: vi.fn(async () => ({ success: true, goalId: 'goal-new', status: 'draft' })),
    updateGoalStatus: vi.fn(async () => ({ ok: true })),
    onGoalChanged: vi.fn(() => () => {}),
    ...overrides,
  };
  (window as unknown as { metis: unknown }).metis = metis;
  return metis;
}

describe('ProjectTasksPanel', () => {
  it('shows only the tasks of the current project', async () => {
    mockMetis();
    render(<ProjectTasksPanel projectId="proj-1" />);
    await waitFor(() => {
      expect(screen.getByText('项目任务 A')).toBeDefined();
      expect(screen.getByText('项目任务 B')).toBeDefined();
      expect(screen.queryByText('别的项目任务')).toBeNull();
      expect(screen.queryByText('全局任务')).toBeNull();
    });
  });

  it('creates a task bound to the project', async () => {
    const metis = mockMetis();
    render(<ProjectTasksPanel projectId="proj-1" />);
    await waitFor(() => expect(metis.listGoals).toHaveBeenCalled());

    const input = screen.getByTestId('project-tasks-input');
    fireEvent.change(input, { target: { value: '新任务' } });
    fireEvent.click(screen.getByTestId('project-tasks-create'));

    await waitFor(() => {
      expect(metis.createGoal).toHaveBeenCalledWith('新任务', undefined, 'proj-1');
    });
  });

  it('updates a task status through the goal engine', async () => {
    const metis = mockMetis();
    render(<ProjectTasksPanel projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('项目任务 A')).toBeDefined());

    fireEvent.click(screen.getAllByTestId('project-tasks-completed')[0]);
    await waitFor(() => {
      expect(metis.updateGoalStatus).toHaveBeenCalledWith({ goalId: 'goal-proj', status: 'completed' });
    });
  });

  it('shows an empty state when the project has no tasks', async () => {
    mockMetis({ listGoals: vi.fn(async () => ({ success: true, goals: [] })) });
    render(<ProjectTasksPanel projectId="proj-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('project-tasks-empty')).toBeDefined();
    });
  });
});
