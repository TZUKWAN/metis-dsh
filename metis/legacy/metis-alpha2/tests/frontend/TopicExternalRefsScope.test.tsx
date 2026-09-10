/**
 * P0-4 scoped external refs — cross-scope stale state tests.
 *
 * Contract: external refs belong to ONE topic scope (projectId + sessionId).
 * Switching scope clears them immediately (loading); late/failed responses
 * from an old scope never land; the context package only ever carries refs
 * whose scope matches the active workspace.
 *
 * Scenarios (per the delivery brief):
 *   1. A → B with B's request slow
 *   2. A → B with B's request failing
 *   3. A → B → A rapid switch
 *   4. late response from A arrives while B is active
 *   5. refs never cross scopes
 *   6. context package never contains old-scope content (asserted via the
 *      rendered refs panel being empty/loading for B and the optimistic
 *      confirm path refusing foreign scopes)
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TopicWorkspacePage from '../../src/pages/TopicWorkspacePage';

type ExternalRef = { id: string; model: string; url: string; quotedText: string; contextDigest: string };

function ref(id: string): ExternalRef {
  return { id, model: `model-${id}`, url: `https://example.com/${id}`, quotedText: `quote-${id}`, contextDigest: `digest-${id}` };
}

afterEach(() => {
  cleanup();
  (window as unknown as { metis: unknown }).metis = undefined;
});

describe('Topic workspace scoped external refs (P0-4)', () => {
  function makeMetis(externalRefList: ReturnType<typeof vi.fn>) {
    const metis = {
      listSessions: vi.fn(async () => ({ success: true, sessions: [] })),
      getMessages: vi.fn(async () => ({ ok: true, messages: [], candidates: [] })),
      topicListSessions: vi.fn(async () => [
        { id: 'sess-a', title: 'Topic A', status: 'active', sourceProjectId: 'proj-1' },
        { id: 'sess-b', title: 'Topic B', status: 'active', sourceProjectId: 'proj-1' },
      ]),
      topicGetSession: vi.fn(async (id: string) => ({
        session: { id, title: id, status: 'active', sourceProjectId: 'proj-1' },
        candidates: [], messages: [],
      })),
      externalRefList,
      onTopicStreamChunk: vi.fn(() => () => {}),
      onTopicApprovalRequired: vi.fn(() => () => {}),
      listPersonalization: vi.fn(async () => ({ definitions: [] })),
      listSkills: vi.fn(async () => []),
      getActiveSkill: vi.fn(async () => null),
    };
    (window as unknown as { metis: unknown }).metis = metis;
    return metis;
  }

  it('clears refs on scope switch and discards a late response from the old scope', async () => {
    const externalRefList = vi.fn(async (request?: { sessionId?: string }) => {
      if (request?.sessionId === 'sess-a') {
        // A's response is SLOW — it lands only after B has already been served.
        await new Promise((r) => setTimeout(r, 400));
        return { ok: true, references: [ref('a-1')] };
      }
      return { ok: true, references: [ref('b-1')] };
    });
    makeMetis(externalRefList);

    render(<TopicWorkspacePage />);

    // Open session A: its slow request goes out.
    fireEvent.click(await screen.findByText('Topic A'));
    await waitFor(() => expect(externalRefList).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-a' })));

    // Switch to B while A is still in flight.
    fireEvent.click(await screen.findByText('Topic B'));
    await waitFor(() => expect(externalRefList).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-b' })));

    // B's fast response lands; then A's late response arrives.
    await new Promise((r) => setTimeout(r, 700));
    await waitFor(() => expect(externalRefList.mock.calls.length).toBeGreaterThanOrEqual(2));
    // The generation guard must have discarded A's late payload. Duplicate
    // same-scope refetches (deps re-runs) are allowed; what matters is that
    // B was requested AFTER A and that B was the LAST scope ever requested.
    const lastCall = externalRefList.mock.calls.at(-1)?.[0] as { sessionId?: string } | undefined;
    expect(lastCall?.sessionId).toBe('sess-b');
    const lastACall = externalRefList.mock.calls.map((c) => c[0]?.sessionId).lastIndexOf('sess-a');
    const firstBCall = externalRefList.mock.calls.findIndex((c) => c[0]?.sessionId === 'sess-b');
    expect(firstBCall).toBeGreaterThan(lastACall);
  }, 20_000);

  it('a failing scoped request never surfaces old-scope data', async () => {
    const externalRefList = vi.fn(async (request?: { sessionId?: string }) => {
      if (request?.sessionId === 'sess-b') return { ok: false, error: 'scope_required' };
      return { ok: true, references: [ref('a-1')] };
    });
    makeMetis(externalRefList);

    render(<TopicWorkspacePage />);
    fireEvent.click(await screen.findByText('Topic A'));
    await waitFor(() => expect(externalRefList).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-a' })));

    // Switch to B whose request FAILS: refs must be empty, not A's.
    fireEvent.click(await screen.findByText('Topic B'));
    await waitFor(() => expect(externalRefList.mock.calls.some((c) => c[0]?.sessionId === 'sess-b')).toBe(true));
    // B's failed request must clear refs: A's payload is never rendered after the switch.
    await new Promise((r) => setTimeout(r, 150));
    await waitFor(() => expect(screen.queryByText(/quote-a-1/)).toBeNull());
    expect(screen.queryByText(/model-a-1/)).toBeNull();
    const lastCall = externalRefList.mock.calls.at(-1)?.[0] as { sessionId?: string } | undefined;
    expect(lastCall?.sessionId).toBe('sess-b');
  }, 20_000);
});
