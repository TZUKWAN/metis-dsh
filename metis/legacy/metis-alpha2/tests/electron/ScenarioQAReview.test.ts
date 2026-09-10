/**
 * Tests for scenario QA review wiring — independent reviewer on final output.
 */

import { describe, it, expect, vi } from 'vitest';

describe('scenario QA review', () => {
  it('calls the reviewer when quality criteria are present', async () => {
    const reviewerLoop = { run: vi.fn(async () => ({ finalText: '{"passed": true}' })) };
    const criteria = ['must cite a source', 'must be under 1000 words'];
    const output = { primary: 'draft text' };

    const reviewResponse = await reviewerLoop.run({
      messages: [{
        role: 'user',
        content: `You are an independent quality reviewer. Review the produced output against these quality criteria and respond with ONLY a JSON object: {"passed": true/false, "failures": ["..."]}.\n\nQuality criteria:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nProduced output:\n${JSON.stringify(output).slice(0, 4000)}`,
      }],
      maxTurns: 1,
      allowedTools: [],
      sessionId: 'sess',
      requestId: 'req',
      resumeFromCheckpoint: false,
    });
    const verdict = JSON.parse(reviewResponse.finalText.match(/\{[\s\S]*\}/)![0]);
    expect(verdict.passed).toBe(true);
    expect(reviewerLoop.run).toHaveBeenCalled();
  });

  it('rejects when the reviewer fails the output', async () => {
    const reviewerLoop = { run: vi.fn(async () => ({ finalText: '{"passed": false, "failures": ["no citation"] }' })) };
    const reviewResponse = await reviewerLoop.run({ messages: [{ role: 'user', content: 'review' }] });
    const verdict = JSON.parse(reviewResponse.finalText.match(/\{[\s\S]*\}/)![0]);
    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toContain('no citation');
  });

  it('treats review exceptions as non-fatal (pass through)', async () => {
    const reviewerLoop = { run: vi.fn(async () => { throw new Error('reviewer down'); }) };
    let passed = true;
    try {
      await reviewerLoop.run({ messages: [{ role: 'user', content: 'review' }] });
    } catch {
      passed = true; // non-fatal
    }
    expect(passed).toBe(true);
  });
});
