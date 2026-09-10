import { describe, expect, it } from 'vitest';
import {
  AgentControlRequestSchema,
  AgentControlResponseSchema,
  decodeAgentControlResponse,
} from '../../engine/runtime/LiveSteeringContract.js';

describe('live steering renderer contract', () => {
  it('accepts strict instruction and interrupt requests', () => {
    expect(AgentControlRequestSchema.safeParse({
      contractVersion: 1,
      operationId: 'steer-1',
      sessionId: 'session-1',
      action: 'instruction',
      content: 'Use a qualitative comparison instead.',
    }).success).toBe(true);
    expect(AgentControlRequestSchema.safeParse({
      contractVersion: 1,
      operationId: 'interrupt-1',
      sessionId: 'session-1',
      action: 'interrupt',
      reason: 'User stopped the run',
    }).success).toBe(true);
  });

  it('rejects cross-variant fields, control characters and extras', () => {
    expect(AgentControlRequestSchema.safeParse({
      contractVersion: 1,
      operationId: 'steer-1',
      sessionId: 'session-1',
      action: 'instruction',
      content: 'Continue',
      reason: 'smuggled',
    }).success).toBe(false);
    expect(AgentControlRequestSchema.safeParse({
      contractVersion: 1,
      operationId: 'steer-1',
      sessionId: 'session-1',
      action: 'instruction',
      content: 'bad\u0000instruction',
    }).success).toBe(false);
  });

  it('requires a complete strict response and fails closed on malformed input', () => {
    const valid = {
      ok: true,
      contractVersion: 1,
      operationId: 'steer-1',
      action: 'instruction',
      sequence: 1,
    } as const;
    expect(AgentControlResponseSchema.safeParse(valid).success).toBe(true);
    expect(decodeAgentControlResponse({ ...valid, secret: 'must-not-cross' }, 'steer-1')).toEqual({
      ok: false,
      contractVersion: 1,
      operationId: 'steer-1',
      code: 'queue_unavailable',
    });
  });
});
