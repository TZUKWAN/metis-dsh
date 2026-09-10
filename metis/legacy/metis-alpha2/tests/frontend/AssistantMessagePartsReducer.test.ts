import { describe, expect, it } from 'vitest';
import {
  assistantToolPartFromLegacy,
  createAssistantMessageParts,
  normalizeAssistantEvent,
  reduceAssistantMessagePartsBatch,
} from '../../src/lib/assistantMessagePartsReducer';

describe('assistant message parts reducer', () => {
  it('normalizes run lifecycle and tool phases into one container', () => {
    const state = reduceAssistantMessagePartsBatch([
      { kind: 'run', phase: 'created', eventId: 'run-created', sequence: 1 },
      { kind: 'run', phase: 'started', eventId: 'run-started', sequence: 2 },
      { kind: 'tool', phase: 'created', toolCallId: 'tool-1', name: 'search', eventId: 'tool-created', sequence: 3 },
      { kind: 'tool', phase: 'args', toolCallId: 'tool-1', name: 'search', arguments: '{"q":"x"}', eventId: 'tool-args', sequence: 4 },
      { kind: 'tool', phase: 'result', toolCallId: 'tool-1', name: 'search', result: 'ok', status: 'completed', eventId: 'tool-result', sequence: 5 },
      { kind: 'tool', phase: 'error', toolCallId: 'tool-2', name: 'open', error: 'failed', status: 'error', eventId: 'tool-error', sequence: 6 },
      { kind: 'run', phase: 'completed', eventId: 'run-completed', sequence: 7 },
      { kind: 'run', phase: 'interrupted', eventId: 'run-interrupted', sequence: 8 },
      { kind: 'tool', phase: 'replay', toolCallId: 'tool-1', name: 'search', result: 'replayed', eventId: 'tool-replay', sequence: 9 },
    ]);
    expect(state.tools).toHaveLength(2);
    expect(state.tools[0]).toMatchObject({
      toolCallId: 'tool-1', arguments: '{"q":"x"}', result: 'replayed', replayed: true, status: 'completed',
    });
    expect(state.tools[1]).toMatchObject({ toolCallId: 'tool-2', error: 'failed', status: 'error' });
    expect(state.run.phases).toEqual(['created', 'started', 'completed', 'interrupted']);
    expect(state.run.status).toBe('interrupted');
  });

  it('deduplicates eventId, sequence, and identical replay delivery', () => {
    const first = {
      kind: 'tool' as const, phase: 'args' as const, toolCallId: 'tool-1', name: 'search',
      arguments: '{}', eventId: 'same', sequence: 1,
    };
    const state = reduceAssistantMessagePartsBatch([
      first,
      first,
      { ...first, eventId: 'different' },
      { ...first, eventId: undefined, sequence: undefined },
    ]);
    expect(state.tools).toHaveLength(1);
    expect(state.seenEventIds).toEqual(['same']);
    expect(state.seenSequences).toEqual([1]);
  });

  it('normalizes existing presentation events without changing their public shape', () => {
    const event = {
      type: 'tool_result' as const, toolCallId: 'tool-1', toolName: 'search', status: 'completed' as const,
      timestamp: 10, sources: [], eventId: 'evt-1', sequence: 2,
    };
    const state = reduceAssistantMessagePartsBatch([normalizeAssistantEvent(event)], createAssistantMessageParts());
    expect(state.tools[0]).toMatchObject({ toolCallId: 'tool-1', name: 'search', status: 'completed' });
    expect(state.seenEventIds).toEqual(['evt-1']);
  });

  it('keeps failed detail as error and protects newer result/source fields from late replay', () => {
    const state = reduceAssistantMessagePartsBatch([
      normalizeAssistantEvent({
        type: 'tool_result', toolCallId: 'tool-1', toolName: 'search', status: 'completed', timestamp: 20,
        detail: 'new result', sources: [{ label: 'new source', url: 'https://example.com/new' }], sequence: 20,
      }),
      normalizeAssistantEvent({
        type: 'tool_result', toolCallId: 'tool-1', toolName: 'search', status: 'failed', timestamp: 10,
        detail: 'old error', sources: [{ label: 'old source', url: 'https://example.com/old' }], sequence: 10,
      }),
      normalizeAssistantEvent({
        type: 'tool_result', toolCallId: 'tool-2', toolName: 'open', status: 'failed', timestamp: 30,
        detail: 'permission denied', sources: [], sequence: 30,
      }),
    ]);
    expect(state.tools[0]).toMatchObject({ result: 'new result', status: 'completed', sources: [{ label: 'new source' }] });
    expect(state.tools[0]?.error).toBeUndefined();
    expect(state.tools[1]).toMatchObject({ error: 'permission denied', status: 'error' });
    expect(state.tools[1]?.result).toBeUndefined();
  });

  it('adapts legacy tool calls without dropping args, result, error, or sources', () => {
    expect(assistantToolPartFromLegacy({
      toolCallId: 'legacy-1', name: 'lookup', arguments: '{"q":"x"}', result: 'found',
      error: 'warning', status: 'error', sources: [{ label: 'source' }],
    })).toEqual({
      toolCallId: 'legacy-1', name: 'lookup', arguments: '{"q":"x"}', result: 'found',
      error: 'warning', status: 'error', sources: [{ label: 'source' }],
    });
  });

  it('merges tool args, result, error, and sources across out-of-order deliveries', () => {
    const state = reduceAssistantMessagePartsBatch([
      {
        kind: 'tool', phase: 'result', toolCallId: 'tool-ordered', name: 'lookup',
        result: 'new result', status: 'completed', sources: [{ label: 'new source' }], sequence: 20,
      },
      {
        kind: 'tool', phase: 'args', toolCallId: 'tool-ordered', name: 'lookup',
        arguments: '{"q":"real"}', sequence: 10,
      },
      {
        kind: 'tool', phase: 'error', toolCallId: 'tool-ordered', name: 'lookup',
        error: 'late old error', status: 'error', sources: [{ label: 'old source' }], sequence: 5,
      },
    ]);
    expect(state.tools[0]).toMatchObject({
      arguments: '{"q":"real"}', result: 'new result', sources: [{ label: 'new source' }], status: 'completed',
    });
    expect(state.tools[0]?.error).toBeUndefined();
  });

  it('does not reopen a terminal run when a late running lifecycle arrives', () => {
    const state = reduceAssistantMessagePartsBatch([
      { kind: 'run', phase: 'completed', sequence: 10, eventId: 'completed' },
      { kind: 'run', phase: 'started', sequence: 9, eventId: 'late-start' },
      { kind: 'run', phase: 'started', eventId: 'late-unsequenced-start' },
    ]);
    expect(state.run.status).toBe('completed');
    expect(state.run.events.filter((event) => event.type === 'lifecycle')).toHaveLength(1);
  });
});
