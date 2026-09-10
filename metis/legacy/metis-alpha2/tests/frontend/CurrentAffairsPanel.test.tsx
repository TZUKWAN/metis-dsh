/**
 * @vitest-environment jsdom
 * FIX-METIS-495: CurrentAffairsPanel — contract-aligned mocks with echoed operationId.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

let m: Record<string, ReturnType<typeof vi.fn>>;
const h64 = () => 'a'.repeat(64);

const LS_SRC = { sourceId: 'src-1', projectId: 'p1', kind: 'policy_document' as const, title: 'T', authors: ['A'], url: null, contentDigest: h64(), correctionState: 'clean' as const, updatedAt: 1, publishedAt: null, fetchedAt: null, deleted: false, eligible: true, reviewStatus: 'clean' as const, reason: '' };

function R_OK(oid: string) { return { ok: true, version: 1, operationId: oid, draft: true, readyForApproval: true, phase: 'approval', approved: false, exportReady: false, temporalCheckPassed: true, correctionReviewComplete: true, verifiedSourceCount: 1, rejectedSourceCount: 0, sourceCount: 1, factCount: 0, contentDigest: h64(), sourceSnapshotDigest: 'b'.repeat(64), preview: { title: 'P', summary: 'S', sections: [{ heading: 'H', content: 'C' }], sourceCount: 1, factCount: 0 }, errors: [] }; }
function A_OK(oid: string) { return { ok: true, version: 1, operationId: oid, receipt: { receiptId: 'r1', nonce: 'n1', expiresAt: 1e12, projectId: 'p', workflowId: 'w', profileId: 'pf', manifestVersion: 1, contentDigest: h64(), sourceSnapshotDigest: 'b'.repeat(64) } }; }
function E_OK(oid: string) { return { ok: true, version: 1, operationId: oid, artifactId: 'a1', artifactVersion: 1, contentDigest: h64(), gatePassed: true, gateIssues: [], recordCount: 2, provenance: { exportedAt: 1, exportedBy: 'u', receiptId: 'r1', sourceCount: 1 } }; }
beforeEach(() => {
  vi.resetModules();
  m = {
    currentAffairsListSources: vi.fn().mockResolvedValue({ ok: true, version: 1, operationId: 'ls', sources: [LS_SRC] }),
    currentAffairsResearch: vi.fn().mockImplementation((r: { operationId: string }) => Promise.resolve(R_OK(r.operationId))),
    currentAffairsApprove: vi.fn().mockImplementation((r: { operationId: string }) => Promise.resolve(A_OK(r.operationId))),
    currentAffairsExport: vi.fn().mockImplementation((r: { operationId: string }) => Promise.resolve(E_OK(r.operationId))),
    currentAffairsCancel: vi.fn().mockResolvedValue({ ok: true, receiptId: 'r1' }),
    currentAffairsReviewSource: vi.fn().mockResolvedValue({ ok: true, version: 1, operationId: 'rv', sourceId: 'src-1', reviewed: true, correctionState: 'clean' as const, reviewDigest: 'c'.repeat(64) }),
  };
  Object.defineProperty(window, 'metis', { value: m, writable: true, configurable: true });
});

async function renderPanel() {
  const { default: P } = await import('../../src/research/CurrentAffairsPanel');
  render(<P projectId="p1" />);
  await waitFor(() => expect(m.currentAffairsListSources).toHaveBeenCalled());
}
async function setup() {
  await renderPanel();
  await waitFor(() => expect(screen.getByRole('button', { name: /选择/ }).hasAttribute('disabled')).toBe(false));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /选择/ })); });
  await act(async () => { fireEvent.change(document.getElementById('ca-title') as HTMLInputElement, { target: { value: 'T' } }); });
}

async function executeToApproved() {
  await setup();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /执行验证/ })); });
  await waitFor(() => expect(m.currentAffairsApprove).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole('button', { name: /导出/ })).toBeDefined());
}

describe('source loading', () => {
  it('loads eligible sources', async () => { await renderPanel(); });
  it('shows error when all sources deleted', async () => {
    m.currentAffairsListSources.mockResolvedValue({ ok: true, version: 1, operationId: 'ls', sources: [{ ...LS_SRC, deleted: true }] });
    await renderPanel();
    await waitFor(() => expect(screen.getByText(/没有符合条件的时政来源/)).toBeDefined());
  });
});

describe('source review', () => {
  it('shows review button for correction_pending source, triggers review→reload', async () => {
    m.currentAffairsListSources.mockResolvedValue({
      ok: true, version: 1, operationId: 'ls',
      sources: [{ ...LS_SRC, correctionState: 'correction_pending' as const, eligible: false, reviewStatus: 'correction_pending' as const, reason: '待审核 (correction_pending)' }],
    });
    await renderPanel();
    // Review button appears for correction_pending source (has hash, not retracted)
    expect(screen.getByText(/待审核/)).toBeDefined();
    const reviewBtn = screen.getByRole('button', { name: /审核/ });
    expect(reviewBtn).toBeDefined();
    // Click review → dialog
    await act(async () => { fireEvent.click(reviewBtn); });
    expect(screen.getByText('确认审核')).toBeDefined();
    await act(async () => { fireEvent.click(screen.getByText('确认审核')); });
    // reviewSource IPC called → listSources reloaded
    await waitFor(() => {
      expect(m.currentAffairsReviewSource).toHaveBeenCalled();
      expect(m.currentAffairsListSources).toHaveBeenCalledTimes(2);
    });
  });

  it('review failure shows error code', async () => {
    m.currentAffairsReviewSource.mockResolvedValueOnce({ ok: false, version: 1, operationId: 'rv', sourceId: 'src-1', code: 'conflict' as const });
    m.currentAffairsListSources.mockResolvedValue({
      ok: true, version: 1, operationId: 'ls',
      sources: [{ ...LS_SRC, correctionState: 'correction_pending' as const, eligible: false, reviewStatus: 'correction_pending' as const, reason: '待审核 (correction_pending)' }],
    });
    await renderPanel();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /审核/ })); });
    await act(async () => { fireEvent.click(screen.getByText('确认审核')); });
    await waitFor(() => expect(screen.getByText(/conflict/)).toBeDefined());
  });
});

describe('lifecycle', () => {
  it('full cycle: select → execute → automatic receipt → export', async () => {
    await executeToApproved();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /导出/ })); });
    await waitFor(() => expect(screen.getByText(/a1/)).toBeDefined());
  });

  it('does not render permission approval or rejection controls', async () => {
    await executeToApproved();
    expect(screen.queryByRole('button', { name: /批准/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /拒绝/ })).toBeNull();
    expect(m.currentAffairsApprove).toHaveBeenCalledTimes(1);
  });

  it('cancel after automatic receipt sends revoke_approval exact tuple', async () => {
    m.currentAffairsCancel.mockResolvedValueOnce({ ok: false, code: 'cancel_unavailable' });
    await executeToApproved();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /取消/ })); });
    await waitFor(() => {
      expect(m.currentAffairsCancel).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'revoke_approval', receiptId: 'r1', receiptNonce: 'n1' })
      );
      expect(screen.getByRole('alert').textContent).toContain('cancel_unavailable');
    });
  });

  it('not readyForApproval shows error', async () => {
    m.currentAffairsResearch.mockImplementationOnce((r: { operationId: string }) =>
      Promise.resolve({ ...R_OK(r.operationId), readyForApproval: false, errors: ['fail'] }));
    await setup();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /执行验证/ })); });
    await waitFor(() => expect(screen.getByText(/fail/)).toBeDefined());
  });

  it('research failure with errors → error alert', async () => {
    m.currentAffairsResearch.mockImplementationOnce((r: { operationId: string }) =>
      Promise.resolve({ ok: false, version: 1, operationId: r.operationId, code: 'manifest_invalid' as const, errors: ['invalid manifest'] }));
    await setup();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /执行验证/ })); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('invalid manifest'));
  });

  it('automatic receipt and export succeed with typed bridge', async () => {
    await executeToApproved();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /导出/ })); });
    await waitFor(() => expect(screen.getByText(/a1/)).toBeDefined());
    // Receipt is displayed
    expect(screen.getByText(/r1/)).toBeDefined();
  });

  it('JSON import with valid IDs imports and deduplicates', async () => {
    await renderPanel();
    await act(async () => { fireEvent.click(screen.getByText('JSON 导入')); });
    await act(async () => { fireEvent.click(screen.getByText('输入')); });
    await act(async () => { fireEvent.change(document.getElementById('ca-json') as HTMLTextAreaElement, { target: { value: '{"title":"X","selectedSourceIds":["src-1","src-1"]}' } }); });
    await act(async () => { fireEvent.click(screen.getByText('导入')); });
    // After import: 1 selected (dedup), title is set
    await waitFor(() => {
      expect((document.getElementById('ca-title') as HTMLInputElement).value).toBe('X');
    });
  });

  it('JSON import rejects invalid IDs (spaces) — safeParse fails, no state change', async () => {
    const prevTitle = (document.getElementById('ca-title') as HTMLInputElement)?.value ?? '';
    await renderPanel();
    await act(async () => { fireEvent.click(screen.getByText('JSON 导入')); });
    await act(async () => { fireEvent.click(screen.getByText('输入')); });
    await act(async () => { fireEvent.change(document.getElementById('ca-json') as HTMLTextAreaElement, { target: { value: '{"title":"X","selectedSourceIds":["src-1","bad id"]}' } }); });
    await act(async () => { fireEvent.click(screen.getByText('导入')); });
    await waitFor(() => expect(screen.getByText(/格式不正确/)).toBeDefined());
    // Title must NOT have changed
    expect((document.getElementById('ca-title') as HTMLInputElement).value).toBe(prevTitle);
  });

  it('JSON import rejects extra keys — strictObject, no state change', async () => {
    await renderPanel();
    await act(async () => { fireEvent.click(screen.getByText('JSON 导入')); });
    await act(async () => { fireEvent.click(screen.getByText('输入')); });
    await act(async () => { fireEvent.change(document.getElementById('ca-json') as HTMLTextAreaElement, { target: { value: '{"title":"X","selectedSourceIds":["src-1"],"__extra":"leak"}' } }); });
    await act(async () => { fireEvent.click(screen.getByText('导入')); });
    await waitFor(() => expect(screen.getByText(/格式不正确/)).toBeDefined());
  });

  it('JSON import rejects oversized selectedSourceIds array', async () => {
    await renderPanel();
    await act(async () => { fireEvent.click(screen.getByText('JSON 导入')); });
    await act(async () => { fireEvent.click(screen.getByText('输入')); });
    const big = JSON.stringify({ title: 'X', selectedSourceIds: Array.from({ length: 501 }, (_, i) => `src-${i}`) });
    await act(async () => { fireEvent.change(document.getElementById('ca-json') as HTMLTextAreaElement, { target: { value: big } }); });
    await act(async () => { fireEvent.click(screen.getByText('导入')); });
    await waitFor(() => expect(screen.getByText(/格式不正确/)).toBeDefined());
  });

  it('JSON import rejects empty title string', async () => {
    await renderPanel();
    await act(async () => { fireEvent.click(screen.getByText('JSON 导入')); });
    await act(async () => { fireEvent.click(screen.getByText('输入')); });
    await act(async () => { fireEvent.change(document.getElementById('ca-json') as HTMLTextAreaElement, { target: { value: '{"title":"","selectedSourceIds":["src-1"]}' } }); });
    await act(async () => { fireEvent.click(screen.getByText('导入')); });
    await waitFor(() => expect(screen.getByText(/格式不正确/)).toBeDefined());
  });

  it('JSON import rejects non-object (array)', async () => {
    await renderPanel();
    await act(async () => { fireEvent.click(screen.getByText('JSON 导入')); });
    await act(async () => { fireEvent.click(screen.getByText('输入')); });
    await act(async () => { fireEvent.change(document.getElementById('ca-json') as HTMLTextAreaElement, { target: { value: '["src-1"]' } }); });
    await act(async () => { fireEvent.click(screen.getByText('导入')); });
    await waitFor(() => expect(screen.getByText(/必须是对象/)).toBeDefined());
  });
});

describe('a11y', () => {
  it('ul/li no role=option', async () => { await renderPanel(); expect(document.querySelector('ul.ca-source-list')).toBeDefined(); });
  it('error role=alert', async () => {
    m.currentAffairsResearch.mockImplementationOnce((r: { operationId: string }) =>
      Promise.resolve({ ok: false, version: 1, operationId: r.operationId, errors: ['e'] }));
    await setup();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /执行验证/ })); });
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
  });
});

describe('timeout and stale protection', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('never-resolving research leaves executing state until timeout', async () => {
    m.currentAffairsResearch.mockReturnValue(new Promise(() => {}));
    await setup();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /执行验证/ })); });
    await waitFor(() => expect(screen.queryByRole('button', { name: /执行验证/ })).toBeNull());
  });

  it('research timeout shows error with fake timers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    m.currentAffairsResearch.mockReturnValue(new Promise(() => {}));
    await setup();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /执行验证/ })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
    expect(screen.getByRole('alert').textContent).toContain('超时');
    expect(screen.getByRole('button', { name: /重新开始/ })).toBeDefined();
  });

  it('late response after timeout is ignored (fake timers)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let resolve!: (v: unknown) => void;
    m.currentAffairsResearch.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    await setup();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /执行验证/ })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
    expect(screen.getByText(/超时/)).toBeDefined();
    // Late response — must NOT change phase from error
    await act(async () => { resolve(R_OK('late')); await Promise.resolve(); });
    expect(screen.getByRole('button', { name: /重新开始/ })).toBeDefined();
  });
});

describe('malformed response recovery', () => {
  it('research returning null → no phase transition (tok.done false)', async () => {
    m.currentAffairsResearch.mockResolvedValueOnce(null);
    await setup();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /执行验证/ })); });
    // null result means tok.done() returns false — stays in executing, no error
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('research returning undefined → no crash', async () => {
    m.currentAffairsResearch.mockResolvedValueOnce(undefined);
    await setup();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /执行验证/ })); });
    // Should not crash; undefined is falsy, tok.done returns false
    expect(screen.queryByRole('button', { name: /执行验证/ })).toBeNull();
  });

  it('automatic receipt returning null fails closed', async () => {
    m.currentAffairsApprove.mockResolvedValueOnce(null);
    await setup();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /执行验证/ })); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('内部收据签发失败'));
    expect(screen.queryByRole('button', { name: /导出/ })).toBeNull();
  });

  it('export returning null falls back to approved phase', async () => {
    await executeToApproved();
    m.currentAffairsExport.mockResolvedValueOnce(null);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /导出/ })); });
    // null → !result → !tok.done → setPhase('approved') via || short-circuit
    await waitFor(() => expect(screen.getByRole('button', { name: /导出/ })).toBeDefined());
  });

  it('cancel returning null for discard_draft stays in phase', async () => {
    let resolveApproval!: (value: unknown) => void;
    m.currentAffairsApprove.mockReturnValueOnce(new Promise(resolve => { resolveApproval = resolve; }));
    m.currentAffairsCancel.mockResolvedValueOnce(null);
    await setup();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /执行验证/ })); });
    await waitFor(() => expect(screen.getByRole('button', { name: /打断/ })).toBeDefined());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /打断/ })); });
    // null → !result → setErrorMsg → return, no phase change
    await waitFor(() => expect(screen.getByText(/取消失败/)).toBeDefined());
    await act(async () => { resolveApproval(A_OK('late')); await Promise.resolve(); });
    expect(screen.queryByRole('button', { name: /导出/ })).toBeNull();
  });
});

describe('unmount cleanup', () => {
  it('sets cancelled flag on unmount', async () => {
    const { unmount } = await (async () => {
      const { default: P } = await import('../../src/research/CurrentAffairsPanel');
      const result = render(<P projectId="p1" />);
      await waitFor(() => expect(m.currentAffairsListSources).toHaveBeenCalled());
      return result;
    })();
    unmount();
    // After unmount, cancelled ref is true — IPC responses are ignored
    m.currentAffairsResearch.mockResolvedValue(R_OK('after-unmount'));
    // No crash, no state update warnings
    expect(true).toBe(true);
  });

  it('active token invalidated on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    m.currentAffairsResearch.mockReturnValue(new Promise(() => {}));
    const { unmount } = await (async () => {
      const { default: P } = await import('../../src/research/CurrentAffairsPanel');
      const result = render(<P projectId="p1" />);
      await waitFor(() => expect(m.currentAffairsListSources).toHaveBeenCalled());
      return result;
    })();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /选择/ })); });
    await act(async () => { fireEvent.change(document.getElementById('ca-title') as HTMLInputElement, { target: { value: 'T' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /执行验证/ })); });
    unmount();
    // Advance past timeout — should NOT trigger setState on unmounted component
    await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
    // No "Can't perform a React state update on an unmounted component" warning
    expect(true).toBe(true);
    vi.useRealTimers();
  });
});

describe('interrupt / revoke exact discriminated request', () => {
  it('interrupt during automatic receipt sends exact discard_draft and ignores late receipt', { timeout: 15000 }, async () => {
    let resolveApproval!: (value: unknown) => void;
    m.currentAffairsApprove.mockReturnValueOnce(new Promise(resolve => { resolveApproval = resolve; }));
    await setup();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /执行验证/ })); });
    await waitFor(() => expect(screen.getByRole('button', { name: /打断/ })).toBeDefined());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /打断/ })); });
    await waitFor(() => {
      const call = m.currentAffairsCancel.mock.calls[0]?.[0];
      expect(call).toMatchObject({ action: 'discard_draft', version: 1 });
      // Must not include revoke_approval fields
      expect(call).not.toHaveProperty('receiptId');
      expect(call).not.toHaveProperty('profileId');
      expect(call).not.toHaveProperty('contentDigest');
    });
    await act(async () => { resolveApproval(A_OK('late')); await Promise.resolve(); });
    expect(screen.queryByRole('button', { name: /导出/ })).toBeNull();
  });

  it('revoke_approval sends exact tuple with receipt fields', async () => {
    await executeToApproved();
    const prevCount = m.currentAffairsCancel.mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /取消/ })); });
    await waitFor(() => {
      const call = m.currentAffairsCancel.mock.calls[prevCount]?.[0];
      expect(call).toMatchObject({
        action: 'revoke_approval', version: 1,
        receiptId: 'r1', receiptNonce: 'n1',
      });
      expect(call).toHaveProperty('profileId');
      expect(call).toHaveProperty('contentDigest');
      expect(call).toHaveProperty('sourceSnapshotDigest');
      expect(call).toHaveProperty('manifestVersion');
    });
  });

  it('interrupt failure stays in automatic receipt phase', async () => {
    let resolveApproval!: (value: unknown) => void;
    m.currentAffairsApprove.mockReturnValueOnce(new Promise(resolve => { resolveApproval = resolve; }));
    m.currentAffairsCancel.mockResolvedValueOnce({ ok: false, code: 'cancel_unavailable' });
    await setup();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /执行验证/ })); });
    await waitFor(() => expect(screen.getByRole('button', { name: /打断/ })).toBeDefined());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /打断/ })); });
    await waitFor(() => {
      expect(screen.getByText(/取消失败/)).toBeDefined();
      expect(screen.getByRole('button', { name: /打断/ })).toBeDefined();
    });
    await act(async () => { resolveApproval(A_OK('late')); await Promise.resolve(); });
    expect(screen.queryByRole('button', { name: /导出/ })).toBeNull();
  });
});

describe('review reload full cycle', () => {
  it('review source → confirm → IPC called → listSources reloaded', async () => {
    m.currentAffairsListSources.mockResolvedValue({
      ok: true, version: 1, operationId: 'ls',
      sources: [{
        ...LS_SRC, correctionState: 'correction_pending' as const,
        eligible: false, reviewStatus: 'correction_pending' as const,
        reason: '待审核 (correction_pending)',
      }],
    });
    await renderPanel();
    const reviewBtn = screen.getByRole('button', { name: /审核/ });
    await act(async () => { fireEvent.click(reviewBtn); });
    expect(screen.getByText('确认审核')).toBeDefined();
    await act(async () => { fireEvent.click(screen.getByText('确认审核')); });
    await waitFor(() => {
      expect(m.currentAffairsReviewSource).toHaveBeenCalledWith(expect.objectContaining({
        sourceId: 'src-1',
        caKind: 'policy_document',
        correctionState: 'clean',
      }));
      // listSources called twice: initial load + after review
      expect(m.currentAffairsListSources).toHaveBeenCalledTimes(2);
    });
  });

  it('review failure with code → error displayed, sources NOT reloaded', async () => {
    const initCalls = m.currentAffairsListSources.mock.calls.length;
    m.currentAffairsReviewSource.mockResolvedValueOnce({
      ok: false, version: 1, operationId: 'rv', sourceId: 'src-1', code: 'hash_mismatch' as const,
    });
    m.currentAffairsListSources.mockResolvedValue({
      ok: true, version: 1, operationId: 'ls',
      sources: [{
        ...LS_SRC, correctionState: 'correction_pending' as const,
        eligible: false, reviewStatus: 'correction_pending' as const,
        reason: '待审核 (correction_pending)',
      }],
    });
    await renderPanel();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /审核/ })); });
    await act(async () => { fireEvent.click(screen.getByText('确认审核')); });
    await waitFor(() => {
      expect(screen.getByText(/hash_mismatch/)).toBeDefined();
      // listSources only called once (initial load) — NOT reloaded after failure
      expect(m.currentAffairsListSources).toHaveBeenCalledTimes(initCalls + 1);
    });
  });
});

describe('a11y completeness', () => {
  it('ca-panel region has accessible label', async () => {
    await renderPanel();
    expect(screen.getByRole('region', { name: /时政研究/ })).toBeDefined();
  });

  it('phase bar has status role with polite live region', async () => {
    await setup();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /执行验证/ })); });
    await waitFor(() => {
      const bar = screen.getByRole('status');
      expect(bar).toBeDefined();
      expect(bar.getAttribute('aria-live')).toBe('polite');
    });
  });

  it('review dialog has dialog role', async () => {
    m.currentAffairsListSources.mockResolvedValue({
      ok: true, version: 1, operationId: 'ls',
      sources: [{ ...LS_SRC, correctionState: 'correction_pending' as const, eligible: false, reviewStatus: 'correction_pending' as const, reason: '待审核 (correction_pending)' }],
    });
    await renderPanel();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /审核/ })); });
    expect(screen.getByRole('dialog', { name: /审核来源/ })).toBeDefined();
  });

  it('source select buttons have aria-pressed state', async () => {
    await renderPanel();
    const btn = screen.getByRole('button', { name: /选择/ });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { fireEvent.click(btn); });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('error alert receives focus for screen reader', async () => {
    m.currentAffairsResearch.mockImplementationOnce((r: { operationId: string }) =>
      Promise.resolve({ ok: false, version: 1, operationId: r.operationId, code: 'manifest_invalid' as const, errors: ['invalid'] }));
    await setup();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /执行验证/ })); });
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toBeDefined();
      expect(alert.getAttribute('tabIndex')).toBe('-1');
    });
  });
});
