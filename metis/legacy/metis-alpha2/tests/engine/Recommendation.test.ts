/**
 * Tests for Smart Literature Recommendation Engine.
 */

import { describe, it, expect } from 'vitest';
import {
  RecommendationEngine,
  buildUserProfile,
  computeRelevance,
} from '../../engine/tools/builtin/recommendation-tools.js';
import type { PaperProfile } from '../../engine/tools/builtin/recommendation-tools.js';

// ─── Fixtures ────────────────────────────────────────────────────

function makeLibrary(): PaperProfile[] {
  return [
    {
      id: 'p1',
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      year: 2017,
      tags: ['transformer', 'attention', 'deep-learning'],
      abstract: 'We propose the Transformer architecture based on self-attention mechanisms.',
      venue: 'NeurIPS',
      rating: 5,
    },
    {
      id: 'p2',
      title: 'BERT: Pre-training of Deep Bidirectional Transformers',
      authors: ['Jacob Devlin', 'Ming-Wei Chang'],
      year: 2019,
      tags: ['bert', 'transformer', 'nlp', 'pre-training'],
      abstract: 'We introduce BERT, a bidirectional transformer for language understanding.',
      venue: 'NAACL',
      rating: 5,
    },
    {
      id: 'p3',
      title: 'GPT-3: Language Models are Few-Shot Learners',
      authors: ['Tom Brown', 'Benjamin Mann'],
      year: 2020,
      tags: ['gpt', 'language-model', 'deep-learning', 'few-shot'],
      abstract: 'We demonstrate that scaling up language models improves few-shot learning.',
      venue: 'NeurIPS',
      rating: 4,
    },
    {
      id: 'p4',
      title: 'ResNet: Deep Residual Learning for Image Recognition',
      authors: ['Kaiming He', 'Xiangyu Zhang'],
      year: 2016,
      tags: ['resnet', 'computer-vision', 'deep-learning'],
      abstract: 'We present residual learning framework for training very deep networks.',
      venue: 'CVPR',
      rating: 5,
    },
  ];
}

function makeCandidatePool(): PaperProfile[] {
  return [
    {
      id: 'c1',
      title: 'ViT: An Image is Worth 16x16 Words',
      authors: ['Alexey Dosovitskiy'],
      year: 2021,
      tags: ['transformer', 'computer-vision', 'deep-learning'],
      abstract: 'We apply the Transformer architecture to image recognition with competitive results.',
      venue: 'ICLR',
      rating: 0,
    },
    {
      id: 'c2',
      title: 'RoBERTa: A Robustly Optimized BERT Pretraining Approach',
      authors: ['Yinhan Liu'],
      year: 2019,
      tags: ['bert', 'transformer', 'nlp', 'pre-training'],
      abstract: 'We show that BERT was significantly undertrained and improve its training.',
      venue: 'arXiv',
      rating: 0,
    },
    {
      id: 'c3',
      title: 'ReAct: Synergizing Reasoning and Acting in Language Models',
      authors: ['Shunyu Yao'],
      year: 2023,
      tags: ['agent', 'reasoning', 'language-model'],
      abstract: 'We propose ReAct, a method for synergizing reasoning and acting in language models.',
      venue: 'ICLR',
      rating: 0,
    },
    {
      id: 'c4',
      title: 'T5: Exploring the Limits of Transfer Learning',
      authors: ['Colin Raffel'],
      year: 2020,
      tags: ['t5', 'transformer', 'nlp', 'transfer-learning'],
      abstract: 'We present T5, a text-to-text transfer transformer.',
      venue: 'JMLR',
      rating: 0,
    },
    {
      id: 'c5',
      title: 'LoRA: Low-Rank Adaptation of Large Language Models',
      authors: ['Edward Hu'],
      year: 2022,
      tags: ['lora', 'language-model', 'parameter-efficient', 'fine-tuning'],
      abstract: 'We propose low-rank adaptation for efficiently fine-tuning large language models.',
      venue: 'ICLR',
      rating: 0,
    },
  ];
}

// ─── Tests ───────────────────────────────────────────────────────

describe('buildUserProfile', () => {
  it('should return empty profile for empty library', () => {
    const profile = buildUserProfile([]);
    expect(profile.totalPapers).toBe(0);
    expect(profile.interests).toEqual([]);
    expect(profile.topAuthors).toEqual([]);
    expect(profile.averageRating).toBe(0);
  });

  it('should extract interests from tags and titles', () => {
    const profile = buildUserProfile(makeLibrary());
    expect(profile.interests.length).toBeGreaterThan(0);
    // 'deep-learning' appears in 3 papers, should be a top interest
    expect(profile.interests).toContain('deep-learning');
  });

  it('should compute top authors', () => {
    const profile = buildUserProfile(makeLibrary());
    expect(profile.topAuthors.length).toBeGreaterThan(0);
    // All authors appear once, so count should be 1
    expect(profile.topAuthors[0]!.count).toBeGreaterThanOrEqual(1);
  });

  it('should compute year range', () => {
    const profile = buildUserProfile(makeLibrary());
    expect(profile.yearRange.min).toBe(2016);
    expect(profile.yearRange.max).toBe(2020);
    expect(profile.yearRange.focus).toBeGreaterThan(0);
  });

  it('should compute average rating', () => {
    const profile = buildUserProfile(makeLibrary());
    expect(profile.averageRating).toBeGreaterThan(0);
    expect(profile.averageRating).toBeLessThanOrEqual(5);
  });

  it('should build tag distribution', () => {
    const profile = buildUserProfile(makeLibrary());
    expect(profile.tagDistribution.size).toBeGreaterThan(0);
    expect(profile.tagDistribution.get('deep-learning')).toBe(3); // appears in 3 papers
    expect(profile.tagDistribution.get('transformer')).toBe(2); // appears in 2 papers
  });

  it('should compute top venues', () => {
    const profile = buildUserProfile(makeLibrary());
    expect(profile.topVenues.length).toBeGreaterThan(0);
    // NeurIPS appears in 2 papers
    const neurips = profile.topVenues.find((v) => v.name === 'NeurIPS');
    expect(neurips).toBeDefined();
    expect(neurips!.count).toBe(2);
  });
});

describe('computeRelevance', () => {
  it('should return 0 score for empty profile', () => {
    const result = computeRelevance(
      { title: 'Test', authors: [], year: 2024, tags: [], abstract: '', venue: '' },
      buildUserProfile([]),
    );
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  it('should score shared tags highly', () => {
    const profile = buildUserProfile(makeLibrary());
    const candidate = {
      title: 'New Transformer Architecture',
      authors: ['New Author'],
      year: 2023,
      tags: ['transformer', 'deep-learning'],
      abstract: 'A new transformer model for NLP tasks.',
      venue: 'NeurIPS',
    };
    const result = computeRelevance(candidate, profile);
    expect(result.score).toBeGreaterThan(20);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('should score shared authors', () => {
    const profile = buildUserProfile(makeLibrary());
    const candidate = {
      title: 'New Method by Known Author',
      authors: ['Ashish Vaswani'],
      year: 2023,
      tags: ['optimization'],
      abstract: 'A new optimization method.',
      venue: 'ICML',
    };
    const result = computeRelevance(candidate, profile);
    expect(result.reasons.some((r) => r.includes('follow'))).toBe(true);
  });

  it('should score venue match', () => {
    const profile = buildUserProfile(makeLibrary());
    const candidate = {
      title: 'Another NeurIPS Paper',
      authors: ['Someone'],
      year: 2023,
      tags: [],
      abstract: 'Some abstract.',
      venue: 'NeurIPS',
    };
    const result = computeRelevance(candidate, profile);
    expect(result.reasons.some((r) => r.includes('NeurIPS'))).toBe(true);
  });

  it('should cap score at 100', () => {
    const profile = buildUserProfile(makeLibrary());
    const candidate = {
      title: 'Transformer Deep Learning Attention Model',
      authors: ['Ashish Vaswani'],
      year: 2017,
      tags: ['transformer', 'attention', 'deep-learning', 'nlp'],
      abstract: 'A transformer deep learning attention model for NLP.',
      venue: 'NeurIPS',
    };
    const result = computeRelevance(candidate, profile);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

describe('RecommendationEngine', () => {
  it('should recommend papers from a candidate pool', () => {
    const engine = new RecommendationEngine();
    const response = engine.recommendFromPool(makeCandidatePool(), {
      library: makeLibrary(),
      maxResults: 5,
    });

    expect(response.recommendations.length).toBeGreaterThan(0);
    expect(response.recommendations.length).toBeLessThanOrEqual(5);
    expect(response.profile.totalPapers).toBe(4);
    expect(response.generatedAt).toBeGreaterThan(0);
  });

  it('should sort recommendations by relevance score', () => {
    const engine = new RecommendationEngine();
    const response = engine.recommendFromPool(makeCandidatePool(), {
      library: makeLibrary(),
      maxResults: 10,
    });

    for (let i = 1; i < response.recommendations.length; i++) {
      const prev = response.recommendations[i - 1]!;
      const curr = response.recommendations[i]!;
      expect(prev.relevanceScore).toBeGreaterThanOrEqual(curr.relevanceScore);
    }
  });

  it('should respect minRelevance filter', () => {
    const engine = new RecommendationEngine();
    const response = engine.recommendFromPool(makeCandidatePool(), {
      library: makeLibrary(),
      minRelevance: 30,
    });

    for (const rec of response.recommendations) {
      expect(rec.relevanceScore).toBeGreaterThanOrEqual(30);
    }
  });

  it('should exclude papers already in library', () => {
    const library = makeLibrary();
    // Add one of the candidates to the library
    const pool = makeCandidatePool();
    const poolItem = pool[0]!;

    const engine = new RecommendationEngine();
    const response = engine.recommendFromPool(pool, {
      library: [...library, poolItem],
      maxResults: 10,
    });

    // The paper that's already in library should not appear
    const found = response.recommendations.some(
      (r) => r.title.toLowerCase() === poolItem.title.toLowerCase(),
    );
    expect(found).toBe(false);
  });

  it('should apply year range filter', () => {
    const engine = new RecommendationEngine();
    const response = engine.recommendFromPool(makeCandidatePool(), {
      library: makeLibrary(),
      yearFrom: 2021,
      yearTo: 2023,
    });

    for (const rec of response.recommendations) {
      expect(rec.year).toBeGreaterThanOrEqual(2021);
      expect(rec.year).toBeLessThanOrEqual(2023);
    }
  });

  it('should provide relevance reasons', () => {
    const engine = new RecommendationEngine();
    const response = engine.recommendFromPool(makeCandidatePool(), {
      library: makeLibrary(),
    });

    // At least some recommendations should have reasons
    const withReasons = response.recommendations.filter((r) => r.relevanceReason.length > 0);
    expect(withReasons.length).toBeGreaterThan(0);
  });

  it('should generate arXiv search strategies', () => {
    const engine = new RecommendationEngine();
    const strategies = engine.generateArxivSearchStrategies({ library: makeLibrary() });

    expect(strategies.length).toBeGreaterThan(0);
    expect(strategies.length).toBeLessThanOrEqual(6);
    for (const s of strategies) {
      expect(s.query).toBeTruthy();
      expect(s.sortBy).toBeTruthy();
    }
  });

  it('should generate Semantic Scholar strategies', () => {
    const engine = new RecommendationEngine();
    const strategies = engine.generateSemanticScholarStrategies({ library: makeLibrary() });

    expect(strategies.length).toBeGreaterThan(0);
    expect(strategies.length).toBeLessThanOrEqual(4);
  });

  it('should handle empty library for strategies', () => {
    const engine = new RecommendationEngine();
    const arxiv = engine.generateArxivSearchStrategies({ library: [] });
    const scholar = engine.generateSemanticScholarStrategies({ library: [] });

    // Should still produce some strategies (possibly with focus areas)
    expect(Array.isArray(arxiv)).toBe(true);
    expect(Array.isArray(scholar)).toBe(true);
  });

  describe('findSimilar', () => {
    it('should find similar papers by tags', () => {
      const engine = new RecommendationEngine();
      const library = makeLibrary();
      const target = library[0]!; // Attention paper

      const similar = engine.findSimilar(target, library);
      expect(similar.length).toBeGreaterThan(0);

      // BERT shares 'transformer' tag
      const bert = similar.find((s) => s.paper.id === 'p2');
      expect(bert).toBeDefined();
      expect(bert!.similarity).toBeGreaterThan(0);
    });

    it('should not include the target paper itself', () => {
      const engine = new RecommendationEngine();
      const library = makeLibrary();
      const target = library[0]!;

      const similar = engine.findSimilar(target, library);
      const hasSelf = similar.some((s) => s.paper.id === target.id);
      expect(hasSelf).toBe(false);
    });

    it('should sort by similarity descending', () => {
      const engine = new RecommendationEngine();
      const library = makeLibrary();
      const target = library[0]!;

      const similar = engine.findSimilar(target, library);
      for (let i = 1; i < similar.length; i++) {
        expect(similar[i - 1]!.similarity).toBeGreaterThanOrEqual(similar[i]!.similarity);
      }
    });

    it('should respect maxResults', () => {
      const engine = new RecommendationEngine();
      const library = makeLibrary();
      const target = library[0]!;

      const similar = engine.findSimilar(target, library, 2);
      expect(similar.length).toBeLessThanOrEqual(2);
    });

    it('should provide shared aspects', () => {
      const engine = new RecommendationEngine();
      const library = makeLibrary();
      const target = library[0]!; // Attention paper (tags: transformer, attention, deep-learning)

      const similar = engine.findSimilar(target, library);
      // Papers sharing tags should list those
      for (const result of similar) {
        if (result.similarity >= 30) {
          expect(result.sharedAspects.length).toBeGreaterThan(0);
        }
      }
    });
  });
});
