import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NetworkDisplayNameSchema } from '../../engine/runtime/NetworkCapabilityContract.js';

describe('NetworkCapabilityContract control-character boundary', () => {
  it('rejects C0 and C1 control characters', () => {
    expect(NetworkDisplayNameSchema.safeParse('paper\u0000.pdf').success).toBe(false);
    expect(NetworkDisplayNameSchema.safeParse('paper\u0085.pdf').success).toBe(false);
  });

  it('documents the one-line lint exception immediately above the security regex', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', '..', 'engine', 'runtime', 'NetworkCapabilityContract.ts'),
      'utf8',
    );
    expect(source).toMatch(
      /eslint-disable-next-line no-control-regex -- control characters are exactly what this boundary rejects\r?\nconst UNSAFE_CONTROL_CHARACTERS/u,
    );
  });
});
