/**
 * Concurrency controller for LLM API calls.
 *
 * Prevents overwhelming GLM-4.7-flash and other small models
 * by limiting simultaneous provider requests. Model-specific
 * maxConcurrency is read from ProviderCapabilities.
 */

import { MAX_TIMEOUT_MS } from './Config.js';

interface QueueItem {
  fn: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  /** Detaches the cancellation listener once the item leaves the queue. */
  detach?: () => void;
}

export class RateLimiter {
  private readonly maxConcurrency: number;
  private running = 0;
  private readonly queue: QueueItem[] = [];

  constructor(maxConcurrency: number) {
    this.maxConcurrency = Math.max(1, maxConcurrency);
  }

  /** Total queued + running requests. */
  get pending(): number {
    return this.queue.length + this.running;
  }

  /** Active in-flight requests. */
  get active(): number {
    return this.running;
  }

  /**
   * Execute a function under the rate limit. If at capacity,
   * the call is queued until a slot frees up. A queued item honours
   * `signal`: aborting removes it from the queue immediately instead of
   * leaving a ghost entry that blocks later callers until the queue timer.
   */
  async execute<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      try {
        return await fn();
      } finally {
        this.running--;
        this.dequeue();
      }
    }

    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = {
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer: setTimeout(() => {
          item.detach?.();
          item.cancelled = true;
          reject(new Error(`RateLimiter: request timed out after ${MAX_TIMEOUT_MS}ms`));
        }, MAX_TIMEOUT_MS),
        cancelled: false,
      };

      if (signal) {
        const abortFromQueue = (): void => {
          const index = this.queue.indexOf(item);
          if (index >= 0) this.queue.splice(index, 1);
          clearTimeout(item.timer);
          item.cancelled = true;
          reject(signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted'));
        };
        if (signal.aborted) {
          abortFromQueue();
          return;
        }
        signal.addEventListener('abort', abortFromQueue, { once: true });
        item.detach = () => signal.removeEventListener('abort', abortFromQueue);
      }

      this.queue.push(item);
    });
  }

  /** Release one slot and run the next queued task. */
  private dequeue(): void {
    const next = this.queue.shift();
    if (!next) return;

    if (next.cancelled) {
      clearTimeout(next.timer);
      this.dequeue();
      return;
    }

    clearTimeout(next.timer);
    next.detach?.();
    this.running++;
    next.fn()
      .then((v) => next.resolve(v))
      .catch((e) => next.reject(e instanceof Error ? e : new Error(String(e))))
      .finally(() => {
        this.running--;
        this.dequeue();
      });
  }

  /** Clear all pending queue items and their timers. */
  clear(): void {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) {
        clearTimeout(item.timer);
        item.detach?.();
        item.cancelled = true;
        item.reject(new Error('RateLimiter: cleared'));
      }
    }
  }
}

/** Global registry of rate limiters keyed by model name. */
const limiters = new Map<string, RateLimiter>();

/**
 * Get or create a rate limiter for a given model.
 * Defaults to 2 concurrent calls for small models.
 */
export function getRateLimiter(
  model: string,
  maxConcurrency = 2,
): RateLimiter {
  const key = model;
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = new RateLimiter(maxConcurrency);
    limiters.set(key, limiter);
  }
  return limiter;
}

/**
 * Clear all rate limiters (useful for testing).
 */
export function clearRateLimiters(): void {
  for (const limiter of limiters.values()) {
    limiter.clear();
  }
  limiters.clear();
}
