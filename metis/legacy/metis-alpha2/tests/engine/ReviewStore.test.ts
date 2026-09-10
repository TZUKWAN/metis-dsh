/**
 * Tests for ReviewStore — cross-session review persistence.
 * Round 305.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { saveReview, listReviews, getReviewMarkdown } from '../../engine/manifest/ReviewStore.js';
import {
  reviewSaveHandler,
  reviewListHandler,
  reviewGetHandler,
} from '../../engine/tools/builtin/academic-tools.js';

describe('ReviewStore', () => {
  let originalDataDir: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalDataDir = process.env.METIS_DATA_DIR;
    tempDir = path.join(os.tmpdir(), `metis-review-test-${Date.now()}`);
    process.env.METIS_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    if (originalDataDir !== undefined) {
      process.env.METIS_DATA_DIR = originalDataDir;
    } else {
      delete process.env.METIS_DATA_DIR;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('saves a review and returns a record with id and createdAt', async () => {
    const record = await saveReview({
      scope: 'Attention Is All You Need',
      reviewerId: 'methodology-reviewer',
      overallScore: 8,
      confidence: 4,
      summary: 'A strong paper introducing the transformer architecture.',
      strengths: ['Novel architecture', 'Strong empirical results'],
      weaknesses: ['Limited analysis of efficiency'],
      questions: ['How does it scale to very long sequences?'],
      recommendations: ['Add efficiency analysis'],
    });

    expect(record.id).toBeTruthy();
    expect(record.createdAt).toBeGreaterThan(0);
    expect(record.scope).toBe('Attention Is All You Need');
    expect(record.overallScore).toBe(8);
  });

  it('persists a markdown file and an index entry on disk', async () => {
    const record = await saveReview({ scope: 'Paper A', overallScore: 7 });

    const reviewDir = path.join(tempDir, 'reviews');
    const files = await fs.readdir(reviewDir);
    expect(files.some((f) => f.endsWith('.md') && f.includes('paper-a'))).toBe(true);
    expect(files).toContain('index.json');

    const indexRaw = await fs.readFile(path.join(reviewDir, 'index.json'), 'utf-8');
    const index = JSON.parse(indexRaw);
    expect(index.reviews).toHaveLength(1);
    expect(index.reviews[0].id).toBe(record.id);
  });

  it('lists saved reviews most recent first', async () => {
    await saveReview({ scope: 'First Paper' });
    await saveReview({ scope: 'Second Paper' });
    await saveReview({ scope: 'Third Paper' });

    const reviews = await listReviews();
    expect(reviews).toHaveLength(3);
    // unshift puts newest first
    expect(reviews[0]!.scope).toBe('Third Paper');
    expect(reviews[2]!.scope).toBe('First Paper');
  });

  it('filters by scope substring', async () => {
    await saveReview({ scope: 'Diffusion Models' });
    await saveReview({ scope: 'ResNet for Image Recognition' });
    await saveReview({ scope: 'Diffusion Theory' });

    const filtered = await listReviews({ scopeContains: 'diffusion' });
    expect(filtered).toHaveLength(2);
    expect(filtered.every((r) => r.scope.toLowerCase().includes('diffusion'))).toBe(true);
  });

  it('filters by reviewerId', async () => {
    await saveReview({ scope: 'P1', reviewerId: 'methodology' });
    await saveReview({ scope: 'P2', reviewerId: 'clarity' });
    await saveReview({ scope: 'P3', reviewerId: 'methodology' });

    const filtered = await listReviews({ reviewerId: 'methodology' });
    expect(filtered).toHaveLength(2);
    expect(filtered.every((r) => r.reviewerId === 'methodology')).toBe(true);
  });

  it('respects the limit option', async () => {
    for (let i = 0; i < 5; i++) await saveReview({ scope: `Paper ${i}` });
    expect((await listReviews({ limit: 2 })).length).toBe(2);
  });

  it('returns the markdown content via getReviewMarkdown', async () => {
    const record = await saveReview({
      scope: 'Test Paper',
      summary: 'A concise summary.',
      strengths: ['S1'],
      weaknesses: ['W1'],
    });

    const md = await getReviewMarkdown(record.id);
    expect(md).not.toBeNull();
    expect(md).toContain('Test Paper');
    expect(md).toContain('A concise summary.');
    expect(md).toContain('S1');
    expect(md).toContain('W1');
  });

  it('returns null for an unknown review id', async () => {
    expect(await getReviewMarkdown('does-not-exist-12345')).toBeNull();
  });

  it('sanitizes scope into a filesystem-safe slug', async () => {
    const record = await saveReview({ scope: 'Paper: A Strange!! Title??' });
    const reviewDir = path.join(tempDir, 'reviews');
    const files = await fs.readdir(reviewDir);
    // slug should be lowercase alphanumeric + hyphens only (before date/id suffix)
    const mdFile = files.find((f) => f.endsWith('.md'));
    expect(mdFile).toBeTruthy();
    expect(mdFile!.includes('!!')).toBe(false);
    expect(mdFile!.includes('?')).toBe(false);
    expect(record.id).toBeTruthy();
  });

  it('handles empty optional fields gracefully', async () => {
    const record = await saveReview({ scope: 'Minimal Review' });
    expect(record.id).toBeTruthy();
    expect(record.strengths).toBeUndefined();
    const md = await getReviewMarkdown(record.id);
    expect(md).toContain('Minimal Review');
  });

  // --- handler integration ---

  it('reviewSaveHandler validates required scope', async () => {
    const out = await reviewSaveHandler({}, { sessionId: 't', workspace: '.', turnIndex: 0 });
    expect(out).toContain('scope is required');
  });

  it('reviewSaveHandler persists and returns the record id', async () => {
    const out = await reviewSaveHandler(
      { scope: 'Handler Paper', overallScore: 9, strengths: ['Good'], weaknesses: ['Bad'] },
      { sessionId: 't', workspace: '.', turnIndex: 0 },
    );
    expect(out).toContain('Review Saved');
    expect(out).toContain('Handler Paper');
    expect(out).toContain('Raw JSON');

    // Verify it shows up in review_list
    const list = await reviewListHandler({}, { sessionId: 't', workspace: '.', turnIndex: 0 });
    expect(list).toContain('Handler Paper');
  });

  it('reviewListHandler reports empty when no reviews exist', async () => {
    const out = await reviewListHandler({}, { sessionId: 't', workspace: '.', turnIndex: 0 });
    expect(out).toContain('No saved reviews');
  });

  it('reviewGetHandler returns the markdown for a saved id', async () => {
    const saved = await saveReview({ scope: 'Gettable Paper', summary: 'hello world' });
    const out = await reviewGetHandler(
      { id: saved.id },
      { sessionId: 't', workspace: '.', turnIndex: 0 },
    );
    expect(out).toContain('Gettable Paper');
    expect(out).toContain('hello world');
  });

  it('reviewGetHandler reports unknown id', async () => {
    const out = await reviewGetHandler(
      { id: 'nope-9999' },
      { sessionId: 't', workspace: '.', turnIndex: 0 },
    );
    expect(out).toContain('No review found');
  });
});
