import type { RuntimeShutdownCoordinator } from './RuntimeShutdownCoordinator.js';

export interface ApprovalShutdownRegistryOptions {
  timeoutMs: number;
  /** Present the approval and optionally return cleanup for renderer/native listeners. */
  present: (resolve: (approved: boolean) => void) => void | (() => void);
}

interface PendingApproval {
  settle: (approved: boolean) => boolean;
}

type RuntimeShutdownRegistration = Pick<RuntimeShutdownCoordinator, 'isDraining' | 'register'>;

/**
 * Owns renderer-backed approval promises for the application lifetime. Each
 * pending request is registered with the runtime drain, so shutdown resolves
 * it as a rejection before persistence is closed.
 */
export class ApprovalShutdownRegistry {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly runtimeShutdown: RuntimeShutdownRegistration,
    private readonly registrationPrefix: string,
  ) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  request(requestId: string, options: ApprovalShutdownRegistryOptions): Promise<boolean> {
    if (this.runtimeShutdown.isDraining() || this.pending.has(requestId)) {
      return Promise.resolve(false);
    }

    let resolveApproval!: (approved: boolean) => void;
    const approvalPromise = new Promise<boolean>((resolve) => {
      resolveApproval = resolve;
    });
    let resolveDrain!: () => void;
    const drainPromise = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    let settled = false;
    let cleanupPresentation: (() => void) | undefined;

    const settle = (approved: boolean): boolean => {
      if (settled) return false;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        cleanupPresentation?.();
      } catch {
        // Presentation cleanup is best-effort; settlement must remain fail-closed.
      }
      cleanupPresentation = undefined;
      if (this.pending.get(requestId)?.settle === settle) {
        this.pending.delete(requestId);
      }
      resolveApproval(approved);
      void approvalPromise.then(() => {
        queueMicrotask(resolveDrain);
      });
      return true;
    };

    this.pending.set(requestId, { settle });
    const timer = setTimeout(() => settle(false), Math.max(0, options.timeoutMs));
    const registered = this.runtimeShutdown.register({
      id: `${this.registrationPrefix}:${requestId}`,
      promise: drainPromise,
      abort: () => { settle(false); },
    });
    if (!registered) {
      settle(false);
      return approvalPromise;
    }

    try {
      const cleanup = options.present(settle);
      if (settled) cleanup?.();
      else cleanupPresentation = cleanup ?? undefined;
    } catch {
      settle(false);
    }
    return approvalPromise;
  }

  /** Resolve a renderer response; responses during shutdown are rejected. */
  resolve(requestId: string, approved: boolean): boolean {
    const pending = this.pending.get(requestId);
    if (this.runtimeShutdown.isDraining()) {
      pending?.settle(false);
      return false;
    }
    return pending?.settle(approved) ?? false;
  }
}

export class ScenarioApprovalRegistry extends ApprovalShutdownRegistry {
  constructor(runtimeShutdown: RuntimeShutdownRegistration) {
    super(runtimeShutdown, 'scenario-approval');
  }
}
