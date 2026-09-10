/**
 * Lightweight telemetry — tracks operation counts, latencies, and error rates.
 * No external dependencies; writes to a simple in-memory store with optional persistence.
 */

export interface TelemetryEvent {
  type: string;
  name: string;
  durationMs: number;
  success: boolean;
  error?: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

export class Telemetry {
  private readonly events: TelemetryEvent[] = [];
  private readonly maxEvents: number;

  constructor(maxEvents = 10_000) {
    this.maxEvents = maxEvents;
  }

  /** Record a completed operation. */
  record(event: Omit<TelemetryEvent, 'timestamp'>): void {
    this.events.push({ ...event, timestamp: Date.now() });
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  /** Time an async operation and record the result. */
  async track<T>(
    type: string,
    name: string,
    fn: () => Promise<T>,
    metadata: Record<string, unknown> = {},
  ): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      this.record({
        type,
        name,
        durationMs: Math.round(performance.now() - start),
        success: true,
        metadata,
      });
      return result;
    } catch (err) {
      this.record({
        type,
        name,
        durationMs: Math.round(performance.now() - start),
        success: false,
        error: err instanceof Error ? err.message : String(err),
        metadata,
      });
      throw err;
    }
  }

  /** Get all events, optionally filtered by type. */
  getEvents(type?: string): TelemetryEvent[] {
    if (type) return this.events.filter((e) => e.type === type);
    return [...this.events];
  }

  /** Compute aggregate statistics for a given event type. */
  getStats(type: string): { count: number; successRate: number; avgDurationMs: number; p50Ms: number; p99Ms: number } {
    const filtered = this.events.filter((e) => e.type === type);
    const count = filtered.length;
    if (count === 0) return { count: 0, successRate: 0, avgDurationMs: 0, p50Ms: 0, p99Ms: 0 };

    const successes = filtered.filter((e) => e.success).length;
    const durations = filtered.map((e) => e.durationMs).sort((a, b) => a - b);

    return {
      count,
      successRate: successes / count,
      avgDurationMs: Math.round(durations.reduce((s, d) => s + d, 0) / count),
      p50Ms: durations[Math.floor(count * 0.5)] ?? 0,
      p99Ms: durations[Math.floor(count * 0.99)] ?? 0,
    };
  }

  /** Clear all events. */
  clear(): void {
    this.events.length = 0;
  }

  get size(): number {
    return this.events.length;
  }
}

/** Global telemetry singleton. */
export const telemetry = new Telemetry();
