/**
 * ErrorBoundary component tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import ErrorBoundary from '../../src/components/ErrorBoundary';

function ThrowError({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('Test error');
  }
  return <div data-testid="child">Child content</div>;
}

function Wrapper() {
  const [shouldThrow, setShouldThrow] = useState(false);
  return (
    <ErrorBoundary onReset={() => setShouldThrow(false)}>
      <button type="button" onClick={() => setShouldThrow(true)}>Trigger error</button>
      <ThrowError shouldThrow={shouldThrow} />
    </ErrorBoundary>
  );
}

describe('ErrorBoundary', () => {
  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <div data-testid="child">Child content</div>
      </ErrorBoundary>,
    );
    expect(document.querySelector('[data-testid="child"]')).toBeTruthy();
  });

  it('renders fallback UI without raw details in normal mode', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Wrapper />);
    expect(document.querySelector('[data-testid="child"]')).toBeTruthy();

    fireEvent.click(screen.getByText('Trigger error'));
    expect(screen.getByText('出错了')).toBeDefined();
    expect(screen.getByText('重试')).toBeDefined();
    expect(screen.queryByText(/Test error/)).toBeNull();
    consoleSpy.mockRestore();
  });

  it('shows raw details only when diagnostic disclosure is enabled', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary showDetails>
        <ThrowError shouldThrow />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/Test error/)).toBeDefined();
    consoleSpy.mockRestore();
  });
});
