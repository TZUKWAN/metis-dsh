/**
 * SearchInput component tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import SearchInput from '../../src/components/SearchInput';

function ControlledSearchInput() {
  const [value, setValue] = useState('');
  return <SearchInput value={value} onChange={setValue} placeholder="Search" className="search-input" />;
}

describe('SearchInput', () => {
  it('renders an input and shows a clear button only when there is a value', () => {
    const { rerender } = render(<SearchInput value="" onChange={vi.fn()} placeholder="Search" />);
    expect(document.querySelector('input')).toBeTruthy();
    expect(document.querySelector('button[aria-label="Clear search"]')).toBeNull();

    rerender(<SearchInput value="query" onChange={vi.fn()} placeholder="Search" />);
    expect(document.querySelector('button[aria-label="Clear search"]')).toBeTruthy();
  });

  it('calls onChange with an empty string and focuses input when clear is clicked', () => {
    const handleChange = vi.fn();
    render(<SearchInput value="query" onChange={handleChange} placeholder="Search" />);
    const input = document.querySelector('input') as HTMLInputElement;
    const clear = document.querySelector('button[aria-label="Clear search"]') as HTMLButtonElement;

    fireEvent.click(clear);
    expect(handleChange).toHaveBeenCalledWith('');
    expect(document.activeElement).toBe(input);
  });

  it('clears the controlled value and keeps focus when clear is clicked', async () => {
    render(<ControlledSearchInput />);
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'test' } });
    expect(input.value).toBe('test');

    const clear = document.querySelector('button[aria-label="Clear search"]') as HTMLButtonElement;
    fireEvent.click(clear);

    await waitFor(() => {
      expect(input.value).toBe('');
    });
    expect(document.activeElement).toBe(input);
  });

  it('focuses the input when / is pressed outside of inputs', () => {
    render(<ControlledSearchInput />);
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.keyDown(window, { key: '/' });
    expect(document.activeElement).toBe(input);
  });
});
