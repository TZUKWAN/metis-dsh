/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExperimentsPage from '../../src/pages/ExperimentsPage';
import { useMetisStore, type ExperimentItem } from '../../src/store';

const RUNNING_EXPERIMENT: ExperimentItem = {
  id: 'exp-running',
  name: 'Running experiment',
  description: '',
  status: 'running',
  parameters: {},
  metrics: {},
  tags: [],
  notes: '',
  linkedPaperIds: [],
  scriptAttachment: {
    attachmentId: `esa_${'a'.repeat(32)}`,
    displayName: 'run.js',
    runtime: 'node',
    sizeBytes: 10,
    attachedAt: 1,
  },
  scriptRuntimeStatus: 'running',
  createdAt: 1,
};

describe('ExperimentsPage GLM-102 execution controls', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'metis');
    useMetisStore.setState({ experiments: [] });
  });

  it('calls the real cancel API while running and does not fake a Zustand final state', async () => {
    const cancelExperiment = vi.fn(async () => true);
    Object.defineProperty(window, 'metis', {
      configurable: true,
      value: { cancelExperiment },
    });
    useMetisStore.setState({ experiments: [RUNNING_EXPERIMENT] });
    render(<ExperimentsPage />);

    const cancel = screen.getByRole('button', { name: /取消/u }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    await waitFor(() => expect(cancelExperiment).toHaveBeenCalledWith('exp-running'));
    expect(useMetisStore.getState().experiments[0]?.status).toBe('running');
    expect(useMetisStore.getState().experiments[0]?.scriptRuntimeStatus).toBe('running');
    expect(cancel.disabled).toBe(true);
  });
});
