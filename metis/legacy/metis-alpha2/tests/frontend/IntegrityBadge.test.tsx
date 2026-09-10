/**
 * @vitest-environment jsdom
 */

import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openAlexMock = vi.fn();
const crossrefMock = vi.fn();

vi.mock('@engine/research/OpenAlexClient.js', () => ({
  getRawWorkByDoi: (doi: string) => openAlexMock(doi),
}));
vi.mock('@engine/research/CrossrefClient.js', () => ({
  getRawWorkByDoi: (doi: string) => crossrefMock(doi),
}));

import { IntegrityBadge } from '../../src/components/IntegrityBadge';

// Reset the module-level cache between tests by re-importing isolation is not
// trivial; instead drive each test through a fresh DOI so cache misses always
// trigger the mocked fetches.

describe('IntegrityBadge', () => {
  beforeEach(() => {
    openAlexMock.mockReset();
    crossrefMock.mockReset();
  });

  it('renders VERIFIED when a source returns a non-retracted record', async () => {
    openAlexMock.mockResolvedValue({ is_retracted: false });
    crossrefMock.mockResolvedValue({ 'update-to': undefined });
    const { getByText, container } = render(<IntegrityBadge doi="10.1/verified-fresh" />);
    await waitFor(() => {
      expect(getByText('VERIFIED')).toBeTruthy();
    });
    expect(container.querySelector('[data-integrity-status="verified"]')).toBeTruthy();
  });

  it('renders RETRACTED when OpenAlex flags is_retracted', async () => {
    openAlexMock.mockResolvedValue({ is_retracted: true });
    crossrefMock.mockResolvedValue(null);
    const { getByText } = render(<IntegrityBadge doi="10.1/retracted-fresh" />);
    await waitFor(() => {
      expect(getByText('RETRACTED')).toBeTruthy();
    });
  });

  it('renders RETRACTED when Crossref update-to names a withdrawal', async () => {
    openAlexMock.mockResolvedValue(null);
    crossrefMock.mockResolvedValue({ 'update-to': [{ label: 'Retraction' }] });
    const { getByText } = render(<IntegrityBadge doi="10.1/withdrawn-fresh" />);
    await waitFor(() => {
      expect(getByText('RETRACTED')).toBeTruthy();
    });
  });

  it('renders UNKNOWN when both sources are unavailable', async () => {
    openAlexMock.mockResolvedValue(null);
    crossrefMock.mockResolvedValue(null);
    const { getByText } = render(<IntegrityBadge doi="10.1/missing-fresh" />);
    await waitFor(() => {
      expect(getByText('UNKNOWN')).toBeTruthy();
    });
  });

  it('does not refetch on re-render once cached', async () => {
    openAlexMock.mockResolvedValue({ is_retracted: false });
    crossrefMock.mockResolvedValue(null);
    const { rerender, getByText } = render(<IntegrityBadge doi="10.1/cache-hit-fresh" />);
    await waitFor(() => expect(getByText('VERIFIED')).toBeTruthy());
    const callsAfterFirst = openAlexMock.mock.calls.length;
    // Re-render the same DOI; the cache should serve it without a new fetch.
    rerender(<IntegrityBadge doi="10.1/cache-hit-fresh" />);
    expect(openAlexMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('survives a fetch rejection by falling back to UNKNOWN', async () => {
    openAlexMock.mockRejectedValue(new Error('network'));
    crossrefMock.mockRejectedValue(new Error('network'));
    const { getByText } = render(<IntegrityBadge doi="10.1/error-fresh" />);
    await waitFor(() => {
      expect(getByText('UNKNOWN')).toBeTruthy();
    });
  });
});
