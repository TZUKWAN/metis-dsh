/**
 * AutonomousRuntimeContract — live event decode contracts, including the
 * pause/resume state machine events added with the real pause/resume work.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTONOMOUS_CONTRACT_VERSION,
  AutonomousControlRequestSchema,
  AutonomousControlResponseSchema,
  AutonomousStartResponseSchema,
  AutonomousLiveEventSchema,
  decodeAutonomousControlRequest,
  decodeAutonomousLiveEvent,
} from '../../engine/runtime/AutonomousRuntimeContract.js';

function base(sessionId: string, sequence: number) {
  return { version: AUTONOMOUS_CONTRACT_VERSION, sessionId, sequence };
}

describe('AutonomousRuntimeContract pause/resume events', () => {
  it('returns the automatically created project context with the session', () => {
    expect(AutonomousStartResponseSchema.parse({
      ok: true,
      sessionId: 'session-1',
      projectId: 'project-auto-1',
    })).toEqual({ ok: true, sessionId: 'session-1', projectId: 'project-auto-1' });
  });

  it('decodes an automatically selected method summary and an honest failure event', () => {
    const started = {
      ...base('sess-method', 0),
      type: 'engine-started',
      goal: '研究档案中的制度变迁',
      plan: [{ phase: 'source_criticism', name: '史料批判' }],
      method: {
        family: 'historical',
        name: '历史研究',
        rationale: '目标关注历时变化并依赖档案材料。',
        confidence: 0.9,
        selectedBy: 'automatic_provider',
      },
    };
    const failed = {
      ...base('sess-method', 4),
      type: 'engine-failed',
      reason: '资料发现连续失败，已保留检查点。',
      completedPhases: 2,
      recoverable: true,
    };

    expect(decodeAutonomousLiveEvent(started)?.type).toBe('engine-started');
    expect(decodeAutonomousLiveEvent(failed)?.type).toBe('engine-failed');
  });

  it('decodes engine-paused and engine-resumed live events', () => {
    const paused = {
      ...base('sess-1', 5),
      type: 'engine-paused',
      reason: 'user_pause',
    };
    const resumed = {
      ...base('sess-1', 6),
      type: 'engine-resumed',
      completedPhases: 2,
    };
    expect(AutonomousLiveEventSchema.parse(paused)).toEqual(paused);
    expect(AutonomousLiveEventSchema.parse(resumed)).toEqual(resumed);
    expect(decodeAutonomousLiveEvent(paused)?.type).toBe('engine-paused');
    expect(decodeAutonomousLiveEvent(resumed)?.type).toBe('engine-resumed');
  });

  it('drops malformed pause/resume payloads (tamper resistance)', () => {
    expect(decodeAutonomousLiveEvent({ ...base('sess-1', 5), type: 'engine-paused' })).toBeUndefined();
    expect(decodeAutonomousLiveEvent({ ...base('sess-1', 5), type: 'engine-paused', reason: 'ctrl\u0000char' })).toBeUndefined();
    expect(decodeAutonomousLiveEvent({ ...base('sess-1', 6), type: 'engine-resumed', completedPhases: -1 })).toBeUndefined();
    expect(decodeAutonomousLiveEvent({ ...base('sess-1', 6), type: 'engine-resumed', completedPhases: 2, secret: 'x' })).toBeUndefined();
    expect(decodeAutonomousLiveEvent({ ...base('sess-1', 6), type: 'engine-fabricated', reason: 'x' })).toBeUndefined();
  });

  it('decodes pause/resume control requests and responses', () => {
    const pause = { version: AUTONOMOUS_CONTRACT_VERSION, sessionId: 'sess-1', action: 'pause' as const };
    const resume = { version: AUTONOMOUS_CONTRACT_VERSION, sessionId: 'sess-1', action: 'resume' as const, reason: 'user_resume' };
    expect(decodeAutonomousControlRequest(pause)).toEqual(pause);
    expect(decodeAutonomousControlRequest(resume)).toEqual(resume);
    expect(decodeAutonomousControlRequest({ ...resume, action: 'forged' })).toBeUndefined();
    expect(AutonomousControlRequestSchema.parse(pause)).toEqual(pause);

    expect(AutonomousControlResponseSchema.parse({ ok: true, code: 'applied' })).toEqual({ ok: true, code: 'applied' });
    expect(AutonomousControlResponseSchema.parse({ ok: false, code: 'not_found' })).toEqual({ ok: false, code: 'not_found' });
    expect(AutonomousControlResponseSchema.safeParse({ ok: false, code: 'fabricated_code' }).success).toBe(false);
  });
});
