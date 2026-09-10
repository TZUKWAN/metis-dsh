// @vitest-environment jsdom
/**
 * METIS-OPT-3 — baseline rendering tests for previously uncovered components:
 * ApprovalModal, ApprovalQueue, ConfirmDialog, TerminalPanel.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ApprovalModal from '../../src/components/ApprovalModal';
import ApprovalQueue from '../../src/components/ApprovalQueue';
import ConfirmDialog from '../../src/components/ConfirmDialog';
import TerminalPanel from '../../src/components/TerminalPanel';

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  }
  // xterm inspects devicePixelRatio via matchMedia during term.open().
  window.matchMedia = window.matchMedia ?? (() => ({
    matches: false,
    media: '',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).metis;
});

const REQUEST = {
  requestId: 'req-1',
  action: 'read_source' as const,
  createdAt: 1000,
};

describe('ApprovalModal', () => {
  it('renders nothing when there is no pending request', () => {
    const { container } = render(
      <ApprovalModal request={null} onApprove={() => undefined} onReject={() => undefined} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders the request and approves with remember flag', () => {
    const onApprove = vi.fn();
    render(
      <ApprovalModal request={REQUEST} onApprove={onApprove} onReject={() => undefined} />,
    );
    expect(screen.getByRole('dialog')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /批准|approve/i }));
    expect(onApprove).toHaveBeenCalledWith('req-1', false);
  });

  it('rejects on Escape', () => {
    const onReject = vi.fn();
    render(
      <ApprovalModal request={REQUEST} onApprove={() => undefined} onReject={onReject} />,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onReject).toHaveBeenCalledWith('req-1', false);
  });
});

describe('ApprovalQueue', () => {
  it('loads pending approvals on mount and responds from the queue', async () => {
    const respondApproval = vi.fn(async () => ({ ok: true }));
    const onApprovalRequired = vi.fn(() => () => undefined);
    (window as unknown as { metis: unknown }).metis = {
      getPendingApprovals: vi.fn(async () => [
        { requestId: 'req-q1', action: 'run_analysis', createdAt: 2000 },
      ]),
      onApprovalRequired,
      respondApproval,
    };
    render(<ApprovalQueue />);

    // Pending request is loaded from the bridge; the queue badge shows it.
    await waitFor(() => expect(screen.getByRole('button', { name: /审批队列/i })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /审批队列/i }));
    await waitFor(() => expect(screen.getByText(/研究分析|research analysis/i)).toBeDefined());
    // The subscription hook is registered for live updates.
    expect(onApprovalRequired).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^批准$|^approve$/i }));
    expect(respondApproval).toHaveBeenCalled();
  });
});

describe('ConfirmDialog', () => {
  it('renders title/message and confirms', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="删除确认"
        message="确定要删除吗？"
        confirmLabel="确认"
        cancelLabel="取消"
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByText('删除确认')).toBeDefined();
    expect(screen.getByText('确定要删除吗？')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('cancels', () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog title="T" message="M" onConfirm={() => undefined} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /取消|cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('TerminalPanel', () => {
  it('stays collapsed when not visible (no terminal session mounted)', () => {
    const { container } = render(<TerminalPanel visible={false} onToggle={() => undefined} />);
    // The collapsed chrome stays, but no terminal element is created.
    expect(container.querySelector('.terminal-panel')).not.toBeNull();
    expect(container.querySelector('.xterm')).toBeNull();
  });

  it('renders terminal chrome and toggles', async () => {
    const onToggle = vi.fn();
    (window as unknown as { metis: unknown }).metis = {
      requestTerminalGrant: vi.fn(async () => ({ ok: false })),
    };
    render(<TerminalPanel visible onToggle={onToggle} />);
    await waitFor(() => {
      expect(screen.getByText(/终端|Terminal/i)).toBeDefined();
    });
    fireEvent.click(screen.getByRole('button', { name: /关闭|close|收起/i }));
    expect(onToggle).toHaveBeenCalled();
  });
});
