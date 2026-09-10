/**
 * Central IPC registration ledger (Task 3: Host / IPC lifecycle robustness).
 *
 * Every migrated domain registrar receives one `DomainIpcRegistrar` bound to a
 * single owner name. The registry keeps a process-wide ledger of
 * channel → owner so that:
 *  - duplicate registrations fail loudly in dev/test instead of stacking
 *    silent Electron listeners (one channel, one owner);
 *  - every registration returns a real disposer (removeHandler + ledger);
 *  - `snapshot()` yields the channel/owner table asserted by tests and the
 *    final report.
 *
 * Electron's `ipcMain` is injected as a structural interface so the registry
 * is unit-testable without Electron.
 */

import type { IpcMainInvokeEvent } from 'electron';

/** Structural surface of Electron's ipcMain actually used here. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
  listenerCount(channel: string): number;
}

export type IpcChannelListener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

export interface IpcRegistryOptions {
  /**
   * The live Electron `ipcMain` (or a structural test double). Required —
   * importing electron implicitly would break under both ESM and CJS builds.
   */
  ipcMain: IpcMainLike;
  /** Fail loudly on duplicate/foreign registration (dev & test). */
  strict?: boolean;
  /** Bookkeeping hook used by tests to observe unregister timing. */
  onRegister?: (entry: IpcLedgerEntry) => void;
  onUnregister?: (entry: IpcLedgerEntry) => void;
}

export interface IpcLedgerEntry {
  channel: string;
  owner: string;
  registeredAt: number;
}

export interface IpcRegistrationConflict {
  channel: string;
  owner: string;
  reason: 'duplicate_in_ledger' | 'existing_electron_listener' | 'channel_prefix_mismatch';
}

export class IpcRegistrationError extends Error {
  constructor(message: string, readonly conflict: IpcRegistrationConflict) {
    super(message);
    this.name = 'IpcRegistrationError';
  }
}

export interface IpcSnapshotEntry {
  channel: string;
  owner: string;
}

export interface IpcRegistrySnapshot {
  entries: IpcSnapshotEntry[];
  conflicts: IpcRegistrationConflict[];
}

export interface DomainHandleOptions {
  /** Overrides the registrar owner for this one channel. */
  owner?: string;
}

/** Per-domain registration surface; one domain registrar owns its prefixes. */
export class DomainIpcRegistrar {
  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly registry: IpcRegistry,
    readonly owner: string,
    private readonly channelPrefixes: readonly string[],
  ) {}

  /**
   * Registers `ipcMain.handle(channel, listener)` under this owner and returns
   * a disposer that removes the handler and updates the ledger. In strict mode
   * a channel may only ever be registered once process-wide.
   */
  handle(
    channel: string,
    listener: IpcChannelListener,
    options: DomainHandleOptions = {},
  ): () => void {
    const dispose = this.registry.register(channel, listener, {
      owner: options.owner ?? this.owner,
      allowedPrefixes: this.channelPrefixes,
    });
    this.disposers.push(dispose);
    return dispose;
  }

  /** Removes every channel this registrar registered. Idempotent. */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  get registrationCount(): number {
    return this.disposers.length;
  }

  get ownerName(): string {
    return this.owner;
  }
}

export class IpcRegistry {
  private readonly ledger = new Map<string, IpcLedgerEntry>();
  private readonly conflicts: IpcRegistrationConflict[] = [];
  private readonly ipcMain: IpcMainLike;

  constructor(private readonly options: IpcRegistryOptions) {
    this.ipcMain = options.ipcMain;
  }

  get strict(): boolean {
    return this.options.strict ?? false;
  }

  domain(owner: string, channelPrefixes: readonly string[] = []): DomainIpcRegistrar {
    return new DomainIpcRegistrar(this, owner, channelPrefixes);
  }

  /** @internal registration path used by {@link DomainIpcRegistrar}. */
  register(
    channel: string,
    listener: IpcChannelListener,
    binding: { owner: string; allowedPrefixes: readonly string[] },
  ): () => void {
    const conflict = this.detectConflict(channel, binding);
    if (conflict) {
      this.conflicts.push(conflict);
      if (this.strict) {
        throw new IpcRegistrationError(
          `IPC registration rejected: "${channel}" (${conflict.reason}, incumbent owner: ${this.ledger.get(channel)?.owner ?? 'electron'}) claimed by "${binding.owner}"`,
          conflict,
        );
      }
    }

    this.ipcMain.handle(channel, listener);
    const entry: IpcLedgerEntry = {
      channel,
      owner: binding.owner,
      registeredAt: Date.now(),
    };
    this.ledger.set(channel, entry);
    this.options.onRegister?.(entry);

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      // Only remove if we still own the live Electron listener — a prior
      // removeHandler (e.g. from a non-registry path) would make this a no-op
      // that must not resurrect or delete someone else's registration.
      if (this.ledger.get(channel) === entry) {
        this.ledger.delete(channel);
        this.options.onUnregister?.(entry);
        try {
          this.ipcMain.removeHandler(channel);
        } catch {
          // removeHandler on an already-removed channel is harmless.
        }
      }
    };
  }

  isRegistered(channel: string): boolean {
    return this.ledger.has(channel);
  }

  ownerOf(channel: string): string | null {
    return this.ledger.get(channel)?.owner ?? null;
  }

  channelsByOwner(owner: string): string[] {
    return [...this.ledger.values()].filter((entry) => entry.owner === owner).map((e) => e.channel);
  }

  snapshot(): IpcRegistrySnapshot {
    return {
      entries: [...this.ledger.values()]
        .map(({ channel, owner }) => ({ channel, owner }))
        .sort((a, b) => (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0)),
      conflicts: [...this.conflicts],
    };
  }

  disposeAll(): void {
    for (const entry of [...this.ledger.values()]) {
      this.ledger.delete(entry.channel);
      this.options.onUnregister?.(entry);
      try {
        this.ipcMain.removeHandler(entry.channel);
      } catch {
        // Best-effort teardown.
      }
    }
  }

  private detectConflict(
    channel: string,
    binding: { owner: string; allowedPrefixes: readonly string[] },
  ): IpcRegistrationConflict | null {
    if (binding.allowedPrefixes.length > 0 && !binding.allowedPrefixes.some((p) => channel.startsWith(p))) {
      return { channel, owner: binding.owner, reason: 'channel_prefix_mismatch' };
    }
    if (this.ledger.has(channel)) {
      return { channel, owner: binding.owner, reason: 'duplicate_in_ledger' };
    }
    if (this.ipcMain.listenerCount(channel) > 0) {
      // Registered outside the registry (legacy direct ipcMain.handle path).
      return { channel, owner: binding.owner, reason: 'existing_electron_listener' };
    }
    return null;
  }
}
