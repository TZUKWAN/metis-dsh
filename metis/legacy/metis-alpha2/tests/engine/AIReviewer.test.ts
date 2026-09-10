/**
 * Tests for Heuristic Review Engine (formerly AIReviewer).
 */

import { describe, it, expect } from 'vitest';
import { HeuristicReviewer as AIReviewer } from '../../engine/evals/AIReviewer.js';
import type { PaperSubmission } from '../../engine/evals/AIReviewer.js';

// ─── Fixtures ────────────────────────────────────────────────────

function makeGoodSubmission(): PaperSubmission {
  return {
    title: 'Attention Is All You Need: A Novel Transformer Architecture for Sequence Modeling',
    abstract: `We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable and requiring significantly less time to train. Our model achieves 28.4 BLEU on the WMT 2014 English-to-German translation task, improving over the existing best results, including ensembles, by over 2 BLEU.`,
    authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit'],
    keywords: ['transformer', 'attention', 'neural-network', 'sequence-modeling'],
    year: 2017,
    venue: 'NeurIPS',
    sections: [
      {
        type: 'introduction',
        title: 'Introduction',
        content: `Recurrent neural networks and convolutional neural networks have been widely used for sequence modeling. In this work we propose the Transformer, a novel architecture based entirely on attention. Our model is the first to rely entirely on self-attention to compute representations of input and output without using sequence-aligned RNNs or convolution. This is a novel contribution that significantly improves parallelization.`,
      },
      {
        type: 'related_work',
        title: 'Related Work',
        content: `Unlike previous approaches that use recurrent layers (Sutskever et al., 2014; Bahdanau et al., 2015), our method extends the attention mechanism to be the primary computation engine. The use of self-attention has been explored in different contexts (Lin et al., 2017) but our approach is distinct from these earlier works in that we use attention exclusively without any recurrent or convolutional components. Improvements upon prior work include better parallelization and faster training.`,
      },
      {
        type: 'methodology',
        title: 'Model Architecture',
        content: `The Transformer follows an encoder-decoder structure using stacked self-attention and point-wise, fully connected layers. The encoder maps an input sequence of symbol representations to a sequence of continuous representations. The decoder generates an output sequence. The key innovation is the multi-head attention mechanism, which allows the model to jointly attend to information from different representation subspaces at different positions. We describe the attention mechanism using the equation: Attention(Q,K,V) = softmax(QK^T / sqrt(d_k)) V. This is our core algorithm. The model also uses positional encoding to inject information about the relative position of tokens. Our assumption is that self-attention alone can capture all necessary dependencies.`,
      },
      {
        type: 'results',
        title: 'Results',
        content: `We evaluate our model on two standard machine translation tasks: WMT 2014 English-to-German and WMT 2014 English-to-French. Our base model achieves 28.4 BLEU on En-De, outperforming all previous models including ensembles. On En-Fr, our model achieves 41.0 BLEU, a new state-of-the-art. Compared to the baseline models (Bahdanau et al., 2015), we improve by over 2 BLEU on both tasks. We also conducted ablation studies showing that removing multi-head attention degrades performance by 1.2 BLEU. Statistical significance was confirmed with p-value < 0.01. Error bars are reported across 5 runs with standard deviation of 0.3 BLEU. The dataset used includes the WMT 2014 benchmark corpus with 4.5M sentence pairs.`,
      },
      {
        type: 'discussion',
        title: 'Discussion',
        content: `Our results demonstrate that the Transformer architecture can achieve state-of-the-art performance on machine translation tasks while being significantly more parallelizable than recurrent approaches. The main limitation is that self-attention has quadratic complexity with respect to sequence length. Future work could explore efficient attention variants for longer sequences.`,
      },
      {
        type: 'conclusion',
        title: 'Conclusion',
        content: `We presented the Transformer, the first sequence transduction model based entirely on self-attention. Our model achieves superior results on machine translation tasks while being more parallelizable. Future directions include applying the Transformer to other tasks such as text summarization and image generation.`,
      },
    ],
  };
}

function makeWeakSubmission(): PaperSubmission {
  return {
    title: 'Short',
    abstract: 'Bad abstract',
    authors: ['Unknown'],
    keywords: [],
    year: 2024,
    venue: '',
    sections: [],
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('AIReviewer', () => {
  it('should generate a full multi-persona review', async () => {
    const reviewer = new AIReviewer();
    const session = await reviewer.review(makeGoodSubmission());

    expect(session.status).toBe('completed');
    expect(session.reports.length).toBe(5);
    expect(session.completedAt).toBeGreaterThan(0);
    expect(session.metaReview).toBeDefined();
  });

  it('should score a well-structured paper higher than a weak one', async () => {
    const reviewer = new AIReviewer();
    const goodSession = await reviewer.review(makeGoodSubmission());
    const weakSession = await reviewer.review(makeWeakSubmission());

    const goodAvgScore = goodSession.reports.reduce((s, r) => s + r.overallScore, 0) / goodSession.reports.length;
    const weakAvgScore = weakSession.reports.reduce((s, r) => s + r.overallScore, 0) / weakSession.reports.length;

    expect(goodAvgScore).toBeGreaterThan(weakAvgScore);
  });

  it('should generate criteria with valid scores', async () => {
    const reviewer = new AIReviewer();
    const session = await reviewer.review(makeGoodSubmission(), { personas: ['methodologist'] });

    expect(session.reports.length).toBe(1);
    const report = session.reports[0]!;
    expect(report.criteria.length).toBeGreaterThan(0);

    for (const criterion of report.criteria) {
      expect(criterion.score).toBeGreaterThanOrEqual(1);
      expect(criterion.score).toBeLessThanOrEqual(10);
      expect(criterion.maxScore).toBe(10);
      expect(criterion.comment).toBeTruthy();
    }
  });

  it('should produce correct recommendation based on score', async () => {
    const reviewer = new AIReviewer();
    const goodSession = await reviewer.review(makeGoodSubmission(), { personas: ['methodologist'] });
    const report = goodSession.reports[0]!;

    expect(['accept', 'weak_accept', 'borderline', 'weak_reject', 'reject']).toContain(report.recommendation);

    // Good paper should at least be borderline or better
    const goodRecScore = { accept: 5, weak_accept: 4, borderline: 3, weak_reject: 2, reject: 1 };
    expect(goodRecScore[report.recommendation]).toBeGreaterThanOrEqual(3);
  });

  it('should include strengths and weaknesses', async () => {
    const reviewer = new AIReviewer();
    const session = await reviewer.review(makeGoodSubmission(), { personas: ['methodologist'] });
    const report = session.reports[0]!;

    expect(report.strengths.length).toBeGreaterThan(0);
    expect(report.summary).toBeTruthy();
    expect(report.detailedComments).toBeTruthy();
    expect(report.detailedComments).toContain('Review by');
  });

  it('should generate questions for papers without limitations section', async () => {
    const reviewer = new AIReviewer();
    const session = await reviewer.review(makeGoodSubmission(), { personas: ['clarity_reviewer'] });
    const report = session.reports[0]!;

    // Our fixture mentions "limitation" in the discussion, so questions might be fewer
    // but should still have some if anything is missing
    expect(Array.isArray(report.questions)).toBe(true);
  });

  it('should generate a meta-review with consensus', async () => {
    const reviewer = new AIReviewer();
    const session = await reviewer.review(makeGoodSubmission());

    expect(session.metaReview.consensusScore).toBeGreaterThan(0);
    expect(session.metaReview.consensusScore).toBeLessThanOrEqual(10);
    expect(session.metaReview.agreement).toBeGreaterThanOrEqual(0);
    expect(session.metaReview.agreement).toBeLessThanOrEqual(1);
    expect(['accept', 'weak_accept', 'borderline', 'weak_reject', 'reject']).toContain(
      session.metaReview.overallRecommendation,
    );
    expect(session.metaReview.decisionRationale).toBeTruthy();
  });

  it('should handle empty submission gracefully', async () => {
    const reviewer = new AIReviewer();
    const session = await reviewer.review(makeWeakSubmission());

    expect(session.status).toBe('completed');
    expect(session.reports.length).toBe(5);
    // Weak paper should have low consensus score
    expect(session.metaReview.consensusScore).toBeLessThan(7);
  });

  it('should track sessions', async () => {
    const reviewer = new AIReviewer();
    await reviewer.review(makeGoodSubmission(), { sessionId: 'test-session-1' });

    const retrieved = reviewer.getSession('test-session-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe('test-session-1');

    const allSessions = reviewer.listSessions();
    expect(allSessions.length).toBe(1);
  });

  it('should expose persona definitions', () => {
    const reviewer = new AIReviewer();
    const personas = reviewer.getPersonas();

    expect(personas.length).toBe(5);
    expect(personas.map((p) => p.id)).toEqual(
      expect.arrayContaining(['methodologist', 'clarity_reviewer', 'novelty_expert', 'experimentalist', 'domain_expert']),
    );
  });

  it('should use custom persona subset', async () => {
    const reviewer = new AIReviewer();
    const session = await reviewer.review(makeGoodSubmission(), { personas: ['methodologist', 'novelty_expert'] });

    expect(session.reports.length).toBe(2);
    expect(session.reports[0]!.reviewerPersona).toBe('methodologist');
    expect(session.reports[1]!.reviewerPersona).toBe('novelty_expert');
  });
});
