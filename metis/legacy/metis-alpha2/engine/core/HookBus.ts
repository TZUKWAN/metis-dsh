/**
 * Priority-ordered event hook bus.
 *
 * Ported from metis/events/hooks.py.
 * Supports both sync and async handlers with chain-blocking semantics.
 * Handler errors are logged but do not break the chain.
 */

export type HookHandler = (ctx: HookContext) => HookContext | void | null;
export type AsyncHookHandler = (ctx: HookContext) => Promise<HookContext | void | null>;

export interface HookContext {
  event: string;
  [key: string]: unknown;
}

/** Optional error handler for hook failures. */
export type HookErrorHandler = (event: string, handlerName: string, error: unknown) => void;

interface HookEntry {
  handler: HookHandler | AsyncHookHandler;
  priority: number;
  name: string;
  isAsync: boolean;
}

// Default error handler — logs to stderr
const defaultErrorHandler: HookErrorHandler = (event, handlerName, error) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`[HookBus] Error in handler '${handlerName}' for event '${event}': ${msg}`);
};

export class HookBus {
  private readonly hooks = new Map<string, HookEntry[]>();
  private readonly errorHandler: HookErrorHandler;

  constructor(options?: { onError?: HookErrorHandler }) {
    this.errorHandler = options?.onError ?? defaultErrorHandler;
  }

  /**
   * Register a handler for an event.
   * Lower priority number = runs first.
   */
  register(
    event: string,
    handler: HookHandler | AsyncHookHandler,
    options?: { priority?: number; name?: string },
  ): void {
    const priority = options?.priority ?? 100;
    const name = options?.name ?? (handler.name || 'anonymous');
    const isAsync = isAsyncFunction(handler);

    const entries = this.hooks.get(event) ?? [];
    entries.push({ handler, priority, name, isAsync });
    entries.sort((a, b) => a.priority - b.priority);
    this.hooks.set(event, entries);
  }

  /**
   * Emit an event synchronously.
   * If a handler returns a non-null context, it replaces the context for subsequent handlers.
   * If a handler returns null, the chain is blocked.
   */
  emit(event: string, context?: HookContext): HookContext {
    const ctx: HookContext = { event, ...context };
    const entries = this.hooks.get(event) ?? [];

    for (const entry of entries) {
      if (entry.isAsync) continue; // Skip async handlers in sync emit
      try {
        const result = (entry.handler as HookHandler)(ctx);
        if (result === null) break;
        if (result !== undefined) {
          Object.assign(ctx, result);
        }
      } catch (err) {
        this.errorHandler(event, entry.name, err);
      }
    }

    return ctx;
  }

  /**
   * Emit an event asynchronously.
   * Both sync and async handlers are invoked.
   * If a handler returns null, the chain is blocked.
   */
  async emitAsync(event: string, context?: HookContext): Promise<HookContext> {
    const ctx: HookContext = { event, ...context };
    const entries = this.hooks.get(event) ?? [];

    for (const entry of entries) {
      try {
        let result: HookContext | void | null;
        if (entry.isAsync) {
          result = await (entry.handler as AsyncHookHandler)(ctx);
        } else {
          result = (entry.handler as HookHandler)(ctx);
        }
        if (result === null) break;
        if (result !== undefined) {
          Object.assign(ctx, result);
        }
      } catch (err) {
        this.errorHandler(event, entry.name, err);
      }
    }

    return ctx;
  }

  /**
   * Remove all handlers for an event, or a specific handler by name.
   */
  unregister(event: string, handlerName?: string): void {
    if (!handlerName) {
      this.hooks.delete(event);
      return;
    }
    const entries = this.hooks.get(event);
    if (entries) {
      this.hooks.set(
        event,
        entries.filter((e) => e.name !== handlerName),
      );
    }
  }

  /** List all registered events. */
  get eventNames(): string[] {
    return [...this.hooks.keys()];
  }

  /** Get handler count for an event. */
  handlerCount(event: string): number {
    return this.hooks.get(event)?.length ?? 0;
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function isAsyncFunction(fn: unknown): boolean {
  return typeof fn === 'function' && fn.constructor?.name === 'AsyncFunction';
}
