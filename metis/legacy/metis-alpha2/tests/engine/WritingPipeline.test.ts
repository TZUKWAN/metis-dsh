/**
 * Tests for WritingPipeline.
 */

import { describe, it, expect } from 'vitest';
import {
  checkStage,
  calibrateStyle,
  detectMachineTaste,
  STAGE_ORDER,
  stageResultToPlain,
  styleResultToPlain,
} from '../../engine/writing/WritingPipeline.js';

describe('WritingPipeline stage checks', () => {
  it('evaluates an outline stage', () => {
    const text = `
      Research question: Can we improve accuracy?
      Contribution: We propose a new method.
      Outline: Section 1 introduces the problem, Section 2 describes methods, Section 3 reports results.
      Target venue: NeurIPS 2024.
    `;
    const result = checkStage('outline', text);

    expect(STAGE_ORDER).toContain(result.stage);
    expect(result.score).toBeGreaterThanOrEqual(0.75);
    expect(result.nextStage).toBe('introduction');
    expect(result.items.every((i) => typeof i.present === 'boolean')).toBe(true);
  });

  it('flags an incomplete methods section', () => {
    const text = 'We collected data and ran experiments.';
    const result = checkStage('methods', text);

    expect(result.score).toBeLessThan(0.7);
    expect(result.advice).toContain('missing');
  });

  it('advances polish stage when score is high', () => {
    const text = `
      We proofread the paper for grammar and style consistency.
      AI disclosure: this paper was written with assistance from a language model.
    `;
    const result = checkStage('polish', text);

    expect(result.score).toBeGreaterThanOrEqual(0.6);
    expect(result.nextStage).toBeUndefined();
  });

  it('converts stage result to plain object', () => {
    const result = checkStage('introduction', 'Background is important. However, the problem remains open. We propose X. The paper is organized as follows.');
    const plain = stageResultToPlain(result);

    expect(plain.stage).toBe('introduction');
    expect(typeof plain.score).toBe('number');
    expect(Array.isArray(plain.items)).toBe(true);
  });
});

describe('WritingPipeline style calibration', () => {
  it('detects empty hedges', () => {
    const text = 'It is important to note that the sky is blue. It should be mentioned that water is wet.';
    const issues = detectMachineTaste(text);

    expect(issues.some((i) => i.type === 'empty_hedge')).toBe(true);
  });

  it('detects repetitive openers', () => {
    const text = 'The model is fast. The model is accurate. The model is scalable. The model is reliable.';
    const issues = detectMachineTaste(text);

    expect(issues.some((i) => i.type === 'repetitive_opener')).toBe(true);
  });

  it('detects unsupported superlatives', () => {
    const text = 'Our approach is groundbreaking and achieves unprecedented results.';
    const issues = detectMachineTaste(text);

    expect(issues.some((i) => i.type === 'unsupported_superlative')).toBe(true);
  });

  // --- Round 303: expanded AI-Tell word lists and new redundant_pair check ---

  it('detects LLM filler phrases added in round 303', () => {
    const text =
      'Attention mechanisms play a crucial role in modern NLP. ' +
      'We delve into the in the realm of representation learning. ' +
      'It is widely acknowledged that transformers changed the field.';
    const issues = detectMachineTaste(text);

    const hedges = issues.filter((i) => i.type === 'empty_hedge');
    expect(hedges.length).toBeGreaterThanOrEqual(2);
    expect(hedges.some((i) => i.snippet.includes('crucial role'))).toBe(true);
    expect(hedges.some((i) => i.snippet === 'delve into')).toBe(true);
  });

  it('detects expanded superlatives (cutting-edge, game-changing)', () => {
    const text = 'Our cutting-edge method is a game-changing contribution to the literature.';
    const issues = detectMachineTaste(text);

    const sup = issues.filter((i) => i.type === 'unsupported_superlative');
    expect(sup.some((i) => i.snippet === 'cutting-edge')).toBe(true);
    expect(sup.some((i) => i.snippet === 'game-changing')).toBe(true);
  });

  it('detects redundant adjective pairs', () => {
    const text = 'We propose a novel and innovative method that is both effective and efficient.';
    const issues = detectMachineTaste(text);

    const pairs = issues.filter((i) => i.type === 'redundant_pair');
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    expect(pairs.some((i) => i.snippet === 'novel and innovative')).toBe(true);
    expect(pairs.some((i) => i.snippet === 'effective and efficient')).toBe(true);
  });

  it('emits a recommendation when a redundant pair is found', () => {
    const text = 'Our approach is novel and innovative.';
    const result = calibrateStyle(text);

    expect(result.issues.some((i) => i.type === 'redundant_pair')).toBe(true);
    expect(result.recommendations.some((r) => r.toLowerCase().includes('redundant'))).toBe(true);
  });

  it('calibrates style and returns recommendations', () => {
    const text = 'The model is groundbreaking. It is important to note that results are good. ' +
      'The model is fast. The model is accurate. The model is scalable. The model is reliable.';
    const result = calibrateStyle(text);

    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.readabilityScore).toBeGreaterThanOrEqual(0);
    expect(result.readabilityScore).toBeLessThanOrEqual(1);
  });

  it('converts style result to plain object', () => {
    const result = calibrateStyle('The sky is blue.');
    const plain = styleResultToPlain(result);

    expect(typeof plain.readabilityScore).toBe('number');
    expect(Array.isArray(plain.issues)).toBe(true);
    expect(Array.isArray(plain.recommendations)).toBe(true);
  });
});
