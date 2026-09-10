/**
 * Tests for AutoUpdaterService — background update lifecycle with a fake
 * electron-updater, so no real network/installer is involved.
 */

import { describe, it, expect, vi } from 'vitest';
import { AutoUpdaterService, type AutoUpdaterLike } from '../../electron/AutoUpdaterService.js';

function fakeUpdater() {
  const handlers = new Map<string, Array<(...args: never[]) => void>>();
  return {
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(listener);
      handlers.set(event, list);
      return undefined;
    }),
    emit(event: string, ...args: never[]) {
      (handlers.get(event) ?? []).forEach((fn) => fn(...args));
    },
    checkForUpdatesAndNotify: vi.fn(async () => {}),
    downloadUpdate: vi.fn(async () => {}),
    quitAndInstall: vi.fn(),
    handlers,
  } as unknown as AutoUpdaterLike & { emit(event: string, ...args: never[]): void; handlers: Map<string, Array<(...args: never[]) => void>> };
}

describe('AutoUpdaterService', () => {
  it('initializes listeners and checks for updates', () => {
    const updater = fakeUpdater();
    const service = new AutoUpdaterService(() => updater);
    const events: string[] = [];
    service.on('event', (e: { type: string }) => events.push(e.type));
    service.init();
    expect(updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
    expect(updater.on).toHaveBeenCalled();
  });

  it('forwards update-available to the event stream', () => {
    const updater = fakeUpdater();
    const service = new AutoUpdaterService(() => updater);
    const events: Array<{ type: string; version?: string }> = [];
    service.on('event', (e: { type: string; version?: string }) => events.push(e));
    service.init();
    updater.emit('update-available', { version: '0.2.0' } as never);
    // Legacy (no-options) construction resolves to the alpha channel, which is
    // now disclosed on availability events.
    expect(events).toContainEqual({ type: 'available', version: '0.2.0', channel: 'alpha' });
  });

  it('downloads once and only once, then quits-and-installs', async () => {
    const updater = fakeUpdater();
    const service = new AutoUpdaterService(() => updater);
    service.init();
    updater.emit('update-downloaded', { version: '0.2.0' } as never);
    await service.download();
    await service.download();
    expect(updater.downloadUpdate).not.toHaveBeenCalled(); // already downloaded
    service.quitAndInstall();
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('downloads when not yet downloaded', async () => {
    const updater = fakeUpdater();
    const service = new AutoUpdaterService(() => updater);
    service.init();
    await service.download();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('emits an error when the updater factory throws', () => {
    const service = new AutoUpdaterService(() => { throw new Error('no updater'); });
    const errors: string[] = [];
    service.on('event', (e: { type: string; message?: string }) => {
      if (e.type === 'error') errors.push(e.message ?? '');
    });
    service.init();
    expect(errors).toContain('electron-updater unavailable');
  });
});
