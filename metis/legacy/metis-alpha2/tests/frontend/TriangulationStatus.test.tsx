/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const triangulateMock = vi.fn();

vi.mock('@engine/research/CitationTriangulator.js', () => ({
  triangulateDoi: (doi: string) => triangulateMock(doi),
}));

import { TriangulationStatus } from '../../src/components/TriangulationStatus';

describe('TriangulationStatus', () => {
  beforeEach(() => {
    triangulateMock.mockReset();
  });

  it('shows a verify button and reveals the status after triangulation', async () => {
    triangulateMock.mockResolvedValue({ overall: 'VERIFIED', existsIn: ['crossref', 'openalex'], missingIn: [], titleConsensus: 'full', yearConsensus: 'full', authorConsensus: 'full', doi: '10.1/x', normalizedDoi: '10.1/x', records: [], warnings: [] });
    const { getByText, container } = render(<TriangulationStatus doi="10.1/x" />);
    expect(getByText(/Verify across sources|跨源验证/)).toBeTruthy();
    fireEvent.click(getByText(/Verify across sources|跨源验证/));
    await waitFor(() => {
      expect(container.querySelector('[data-triangulation="VERIFIED"]')).toBeTruthy();
    });
  });

  it('shows INCONSISTENT when sources disagree', async () => {
    triangulateMock.mockResolvedValue({ overall: 'INCONSISTENT', existsIn: ['crossref'], missingIn: [], titleConsensus: 'none', yearConsensus: 'none', authorConsensus: 'none', doi: '10.1/y', normalizedDoi: '10.1/y', records: [], warnings: [] });
    const { getByText, container } = render(<TriangulationStatus doi="10.1/y" />);
    fireEvent.click(getByText(/Verify across sources|跨源验证/));
    await waitFor(() => {
      expect(container.querySelector('[data-triangulation="INCONSISTENT"]')).toBeTruthy();
    });
  });

  it('shows an error badge and a retry action when triangulation fails', async () => {
    triangulateMock.mockRejectedValue(new Error('network'));
    const { getByText, container } = render(<TriangulationStatus doi="10.1/z" />);
    fireEvent.click(getByText(/Verify across sources|跨源验证/));
    await waitFor(() => {
      expect(container.querySelector('[data-triangulation]')).toBeFalsy();
      expect(getByText(/Verification failed|验证失败/)).toBeTruthy();
    });
  });
});
