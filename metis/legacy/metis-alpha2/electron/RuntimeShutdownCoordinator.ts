export interface ShutdownRegistration {
  id: string;
  promise: Promise<unknown>;
  abort: () => void;
}

export type RuntimeShutdownRegistrationOwner = Pick<RuntimeShutdownCoordinator, 'register'>;

/**
 * Registers a run after its active state has been published, rolling that state
 * back when shutdown has already started. The executor must be started only
 * after this function returns a non-null unregister callback.
 */
export function registerRuntimeRunOrRollback(
  runtimeShutdown: RuntimeShutdownRegistrationOwner,
  registration: ShutdownRegistration,
  rollback: () => void,
): (() => void) | null {
  const unregister = runtimeShutdown.register(registration);
  if (unregister) return unregister;

  try {
    registration.abort();
  } catch {
    // Registration rejection must still clean the owner state.
  }
  try {
    rollback();
  } catch {
    // Rollback is best-effort and must not allow the rejected run to start.
  }
  return null;
}

export interface ShutdownDrainResult {
  timedOut: boolean;
  pending: string[];
}

export type RuntimeShutdownRegistration = Pick<RuntimeShutdownCoordinator, 'isDraining' | 'register'>;

export interface TrackedEphemeralOperationAccepted {
  admitted: true;
  signal: AbortSignal;
  completion: Promise<void>;
  cleanup: () => void;
}

export interface TrackedEphemeralOperationRejected<TRejection> {
  admitted: false;
  rejection: TRejection;
}

export type TrackedEphemeralOperation<TRejection> =
  | TrackedEphemeralOperationAccepted
  | TrackedEphemeralOperationRejected<TRejection>;

/**
 * Admit one short-lived operation into the process-wide shutdown lifecycle.
 * The caller owns execution and must call cleanup in a finally block after the
 * operation settles. This keeps the helper generic while making the operation
 * signal, drain completion, admission rejection, and unregister path explicit.
 */
export function trackEphemeralOperation<TRejection>(
  runtimeShutdown: RuntimeShutdownRegistration,
  options: { id: string; rejection: TRejection },
): TrackedEphemeralOperation<TRejection> {
  if (runtimeShutdown.isDraining()) return { admitted: false, rejection: options.rejection };

  const controller = new AbortController();
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
  const unregister = runtimeShutdown.register({
    id: options.id,
    promise: completion,
    abort: () => controller.abort(),
  });

  if (!unregister) {
    controller.abort();
    resolveCompletion();
    return { admitted: false, rejection: options.rejection };
  }

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    resolveCompletion();
    unregister();
  };

  return { admitted: true, signal: controller.signal, completion, cleanup };
}

/**
 * Coordinates cooperative application shutdown. Registration is deliberately
 * small: owners keep their domain-specific state, while this class guarantees
 * that shutdown aborts every registered run before waiting for it to unwind.
 */
export class RuntimeShutdownCoordinator {
  private draining = false;
  private closed = false;
  private readonly registrations = new Map<string, ShutdownRegistration>();

  isDraining(): boolean {
    return this.draining || this.closed;
  }

  register(registration: ShutdownRegistration): (() => void) | null {
    if (this.isDraining() || this.registrations.has(registration.id)) return null;
    this.registrations.set(registration.id, registration);
    const unregister = () => {
      if (this.registrations.get(registration.id) === registration) {
        this.registrations.delete(registration.id);
      }
    };
    void registration.promise.finally(unregister).catch(() => undefined);
    return unregister;
  }

  beginDrain(): boolean {
    if (this.closed) return false;
    if (this.draining) return false;
    this.draining = true;
    for (const registration of this.registrations.values()) {
      try {
        registration.abort();
      } catch {
        // Shutdown continues; the promise is still awaited below.
      }
    }
    return true;
  }

  async drain(timeoutMs = 10_000): Promise<ShutdownDrainResult> {
    this.beginDrain();
    const entries = [...this.registrations.values()];
    if (entries.length === 0) {
      this.closed = true;
      return { timedOut: false, pending: [] };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    await Promise.race([
      Promise.allSettled(entries.map((entry) => entry.promise)),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, Math.max(0, timeoutMs));
      }),
    ]);
    if (timer) clearTimeout(timer);

    const pending = [...this.registrations.keys()];
    this.closed = true;
    return { timedOut, pending };
  }
}
