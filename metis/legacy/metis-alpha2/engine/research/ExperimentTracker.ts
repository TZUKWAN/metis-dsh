/**
 * Experiment Tracker — tracks ML/science experiments with parameters, metrics, and status.
 */

export interface Experiment {
  id: string;
  name: string;
  description: string;
  status: 'planned' | 'running' | 'completed' | 'failed' | 'cancelled';
  parameters: Record<string, unknown>;
  metrics: Record<string, number>;
  tags: string[];
  notes: string;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export class ExperimentTracker {
  private readonly experiments = new Map<string, Experiment>();

  /** Create a new experiment. */
  create(exp: Omit<Experiment, 'createdAt' | 'updatedAt' | 'startedAt' | 'completedAt'>): Experiment {
    const now = Date.now();
    const entry: Experiment = { ...exp, createdAt: now, updatedAt: now, startedAt: null, completedAt: null };
    this.experiments.set(exp.id, entry);
    return entry;
  }

  /** Get an experiment by ID. */
  get(id: string): Experiment | undefined {
    return this.experiments.get(id);
  }

  /** Update experiment fields. */
  update(id: string, updates: Partial<Pick<Experiment, 'name' | 'description' | 'parameters' | 'metrics' | 'tags' | 'notes'>>): Experiment | undefined {
    const exp = this.experiments.get(id);
    if (!exp) return undefined;
    Object.assign(exp, updates, { updatedAt: Date.now() });
    return exp;
  }

  /** Mark experiment as running. */
  start(id: string): boolean {
    const exp = this.experiments.get(id);
    if (!exp) return false;
    exp.status = 'running';
    exp.startedAt = Date.now();
    exp.updatedAt = Date.now();
    return true;
  }

  /** Mark experiment as completed with final metrics. */
  complete(id: string, finalMetrics?: Record<string, number>): boolean {
    const exp = this.experiments.get(id);
    if (!exp) return false;
    exp.status = 'completed';
    exp.completedAt = Date.now();
    exp.updatedAt = Date.now();
    if (finalMetrics) Object.assign(exp.metrics, finalMetrics);
    return true;
  }

  /** Mark experiment as failed. */
  fail(id: string, reason?: string): boolean {
    const exp = this.experiments.get(id);
    if (!exp) return false;
    exp.status = 'failed';
    exp.completedAt = Date.now();
    exp.updatedAt = Date.now();
    if (reason) exp.notes += `\nFailed: ${reason}`;
    return true;
  }

  /** Compare experiments by a specific metric. */
  compare(metricKey: string, experimentIds: string[]): Array<{ id: string; name: string; value: number | undefined }> {
    return experimentIds.map((id) => {
      const exp = this.experiments.get(id);
      return { id, name: exp?.name ?? '', value: exp?.metrics[metricKey] };
    }).sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  }

  /** Filter experiments by status or tags. */
  filter(options: { status?: Experiment['status']; tags?: string[] }): Experiment[] {
    let results = [...this.experiments.values()];
    if (options.status) results = results.filter((e) => e.status === options.status);
    if (options.tags && options.tags.length > 0) {
      results = results.filter((e) => options.tags!.some((t) => e.tags.includes(t)));
    }
    return results;
  }

  /** Delete an experiment. */
  delete(id: string): boolean {
    return this.experiments.delete(id);
  }

  list(): Experiment[] {
    return [...this.experiments.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get count(): number { return this.experiments.size; }
}
