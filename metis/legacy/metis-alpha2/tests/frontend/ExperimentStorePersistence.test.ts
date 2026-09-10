/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMetisStore, type ExperimentItem } from '../../src/store';

const EXPERIMENT: ExperimentItem = {
  id: 'exp-store',
  name: 'Stored experiment',
  description: '',
  status: 'planned',
  parameters: { alpha: '1' },
  metrics: { score: 0.5 },
  tags: [],
  notes: '',
  linkedPaperIds: [],
  starred: true,
  createdAt: 1,
};

describe('experiment Zustand persistence gate', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'metis');
    useMetisStore.setState({ experiments: [] });
  });

  it('mutates local state only after a successful database result', async () => {
    const saveExperiment = vi.fn()
      .mockResolvedValueOnce({ success: false, code: 'experiment_metadata_unavailable' })
      .mockResolvedValueOnce({ success: true, code: 'saved' });
    Object.defineProperty(window, 'metis', {
      configurable: true,
      value: { saveExperiment },
    });
    await useMetisStore.getState().addExperiment(EXPERIMENT);
    expect(useMetisStore.getState().experiments).toEqual([]);
    await useMetisStore.getState().addExperiment(EXPERIMENT);
    expect(useMetisStore.getState().experiments).toEqual([EXPERIMENT]);
    expect(saveExperiment).toHaveBeenLastCalledWith(expect.objectContaining({
      parameters: { alpha: '1' },
      metrics: { score: 0.5 },
      starred: true,
    }));
  });

  it('retains an experiment when delete persistence fails', async () => {
    const deleteExperiment = vi.fn(async () => ({
      success: false,
      code: 'experiment_metadata_unavailable',
    }));
    Object.defineProperty(window, 'metis', {
      configurable: true,
      value: { deleteExperiment },
    });
    useMetisStore.setState({ experiments: [EXPERIMENT] });
    await useMetisStore.getState().removeExperiment(EXPERIMENT.id);
    expect(useMetisStore.getState().experiments).toEqual([EXPERIMENT]);
  });
});
