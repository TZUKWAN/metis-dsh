// @vitest-environment jsdom
/**
 * SettingsStorageSection — storage location UI tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SettingsStorageSection from '../../src/components/SettingsStorageSection';

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).metis;
});

function mockMetis(overrides: Record<string, unknown> = {}) {
  const metis = {
    storageGetLocation: vi.fn(async () => ({
      ok: true,
      dataDir: 'D:\\MetisData',
      defaultDir: 'C:\\Users\\u\\AppData\\Roaming\\Metis Research Workbench\\metis-data',
      usingDefault: false,
    })),
    storageChooseLocation: vi.fn(async () => ({ canceled: false, path: 'D:\\NewData' })),
    storageSetLocation: vi.fn(async () => ({ ok: true, restarting: true, dataDir: 'D:\\NewData' })),
    storageOpenFolder: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
  (window as unknown as { metis: unknown }).metis = metis;
  return metis;
}

describe('SettingsStorageSection', () => {
  it('renders the current location and a change button', async () => {
    mockMetis();
    render(<SettingsStorageSection />);

    await waitFor(() => {
      expect(screen.getByTestId('storage-current-path').textContent).toContain('D:\\MetisData');
    });
    expect(screen.getByTestId('storage-change-button')).toBeDefined();
    expect(screen.getByTestId('storage-open-button')).toBeDefined();
    expect(screen.getByTestId('storage-reset-button')).toBeDefined(); // not using default
    expect(screen.queryByTestId('storage-default-badge')).toBeNull();
  });

  it('shows the default badge when using the default location', async () => {
    mockMetis({
      storageGetLocation: vi.fn(async () => ({
        ok: true,
        dataDir: 'C:\\Users\\u\\AppData\\Roaming\\Metis Research Workbench\\metis-data',
        defaultDir: 'C:\\Users\\u\\AppData\\Roaming\\Metis Research Workbench\\metis-data',
        usingDefault: true,
      })),
    });
    render(<SettingsStorageSection />);

    await waitFor(() => expect(screen.getByTestId('storage-default-badge')).toBeDefined());
    expect(screen.queryByTestId('storage-reset-button')).toBeNull();
  });

  it('confirms before relocating, then shows the restarting state', async () => {
    const metis = mockMetis();
    render(<SettingsStorageSection />);

    await waitFor(() => expect(metis.storageGetLocation).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('storage-change-button'));
    await waitFor(() => expect(screen.getByTestId('storage-confirm-dialog')).toBeDefined());

    // Cancelling must not touch IPC.
    fireEvent.click(screen.getByTestId('storage-confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('storage-confirm-dialog')).toBeNull());
    expect(metis.storageSetLocation).not.toHaveBeenCalled();

    // Accepting relocates and shows the restarting notice.
    fireEvent.click(screen.getByTestId('storage-change-button'));
    await waitFor(() => expect(screen.getByTestId('storage-confirm-dialog')).toBeDefined());
    fireEvent.click(screen.getByTestId('storage-confirm-accept'));

    await waitFor(() => {
      expect(metis.storageSetLocation).toHaveBeenCalledWith('D:\\NewData');
      expect(screen.getByTestId('storage-restarting')).toBeDefined();
    });
  });

  it('surfaces a validation error without pretending success', async () => {
    mockMetis({
      storageSetLocation: vi.fn(async () => ({ ok: false, error: 'location_not_empty' })),
    });
    render(<SettingsStorageSection />);

    await waitFor(() => expect(screen.getByTestId('storage-change-button')).toBeDefined());
    fireEvent.click(screen.getByTestId('storage-change-button'));
    await waitFor(() => expect(screen.getByTestId('storage-confirm-dialog')).toBeDefined());
    fireEvent.click(screen.getByTestId('storage-confirm-accept'));

    await waitFor(() => {
      const error = screen.getByTestId('storage-error');
      expect(error.textContent).toContain('非空');
      expect(screen.queryByTestId('storage-restarting')).toBeNull();
    });
  });

  it('reset flow moves back to the default directory', async () => {
    const metis = mockMetis();
    const defaultDir = 'C:\\Users\\u\\AppData\\Roaming\\Metis Research Workbench\\metis-data';
    render(<SettingsStorageSection />);

    await waitFor(() => expect(metis.storageGetLocation).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('storage-reset-button'));
    await waitFor(() => expect(screen.getByTestId('storage-confirm-dialog')).toBeDefined());
    fireEvent.click(screen.getByTestId('storage-confirm-accept'));

    await waitFor(() => {
      expect(metis.storageSetLocation).toHaveBeenCalledWith(defaultDir);
      expect(screen.getByTestId('storage-restarting')).toBeDefined();
    });
  });
});
