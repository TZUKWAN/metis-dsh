/**
 * METIS-206 — Prompt Composer tests.
 *
 * Verifies order-independence, layer precedence conflict resolution, duplicate collapse,
 * and explainability (provenance + enabled reason per fragment).
 */

import { describe, it, expect } from 'vitest';
import { composePrompt, fragmentsFromCapability, type PromptFragment } from './PromptComposer.js';
import { SEVEN_CAPABILITY_PACKS } from './packs/index.js';

function frag(key: string, layer: PromptFragment['layer'], text: string, source = 'src'): PromptFragment {
  return { key, layer, text, source, enabledReason: `enabled for ${key}` };
}

describe('METIS-206 PromptComposer — order independence', () => {
  it('produces identical output regardless of input order', () => {
    const a = [
      frag('z', 'method_rule', 'Z rule'),
      frag('a', 'core_principle', 'A principle'),
      frag('m', 'task_template', 'M task'),
    ];
    const b = [...a].reverse();
    const ra = composePrompt(a);
    const rb = composePrompt(b);
    expect(ra.text).toBe(rb.text);
    expect(ra.provenance).toEqual(rb.provenance);
  });

  it('groups by layer in the fixed precedence order', () => {
    const r = composePrompt([
      frag('r1', 'review_rule', 'review'),
      frag('c1', 'core_principle', 'core'),
      frag('m1', 'method_rule', 'method'),
    ]);
    const coreIdx = r.text.indexOf('核心原则');
    const methodIdx = r.text.indexOf('方法规则');
    const reviewIdx = r.text.indexOf('审查规则');
    expect(coreIdx).toBeLessThan(methodIdx);
    expect(methodIdx).toBeLessThan(reviewIdx);
  });
});

describe('METIS-206 PromptComposer — duplicate rule', () => {
  it('collapses same-key same-layer duplicates (keeps one)', () => {
    const r = composePrompt([
      frag('dup', 'method_rule', 'first'),
      frag('dup', 'method_rule', 'second'),
    ]);
    expect(r.outputFragmentCount).toBe(1);
    expect(r.inputFragmentCount).toBe(2);
    expect(r.text).toContain('first');
  });

  it('records no conflict for true duplicates (same layer)', () => {
    const r = composePrompt([
      frag('dup', 'method_rule', 'first'),
      frag('dup', 'method_rule', 'second'),
    ]);
    expect(r.resolvedConflicts).toHaveLength(0);
  });
});

describe('METIS-206 PromptComposer — conflict rule', () => {
  it('keeps the higher-precedence layer on same-key different-layer conflict', () => {
    const r = composePrompt([
      frag('k', 'review_rule', 'low precedence text'),
      frag('k', 'core_principle', 'high precedence text'),
    ]);
    expect(r.outputFragmentCount).toBe(1);
    expect(r.text).toContain('high precedence text');
    expect(r.text).not.toContain('low precedence text');
    // conflict recorded
    expect(r.resolvedConflicts.length).toBe(1);
    expect(r.resolvedConflicts[0]!.key).toBe('k');
  });

  it('conflict resolution is order-independent too', () => {
    const f1 = frag('k', 'review_rule', 'low');
    const f2 = frag('k', 'core_principle', 'high');
    expect(composePrompt([f1, f2]).text).toBe(composePrompt([f2, f1]).text);
  });
});

describe('METIS-206 PromptComposer — explainability', () => {
  it('every fragment in provenance has source + enabledReason + lineRange', () => {
    const r = composePrompt([
      frag('a', 'core_principle', 'A'),
      frag('b', 'method_rule', 'B'),
    ]);
    for (const p of r.provenance) {
      expect(p.source).toBeTruthy();
      expect(p.enabledReason).toBeTruthy();
      expect(p.lineRange[0]).toBeGreaterThanOrEqual(1);
      expect(p.lineRange[1]).toBeGreaterThanOrEqual(p.lineRange[0]);
    }
  });

  it('fragments from a real capability carry the capability id as source', () => {
    const cap = SEVEN_CAPABILITY_PACKS[0]!;
    const frags = fragmentsFromCapability(cap);
    const r = composePrompt(frags);
    expect(r.provenance.every((p) => p.source === cap.id)).toBe(true);
    expect(r.outputFragmentCount).toBeGreaterThan(0);
  });

  it('all seven capabilities yield explainable fragments', () => {
    for (const cap of SEVEN_CAPABILITY_PACKS) {
      const r = composePrompt(fragmentsFromCapability(cap));
      expect(r.outputFragmentCount).toBeGreaterThan(0);
      for (const p of r.provenance) {
        expect(p.enabledReason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('METIS-206 PromptComposer — robustness', () => {
  it('empty input yields empty text and empty provenance', () => {
    const r = composePrompt([]);
    expect(r.text).toBe('');
    expect(r.provenance).toHaveLength(0);
    expect(r.outputFragmentCount).toBe(0);
  });

  it('handles multi-line fragment text (lineRange spans multiple lines)', () => {
    const r = composePrompt([
      frag('ml', 'task_template', 'line one\nline two\nline three'),
    ]);
    const ml = r.provenance.find((p) => p.key === 'ml')!;
    expect(ml.lineRange[1] - ml.lineRange[0]).toBeGreaterThanOrEqual(2);
  });
});
