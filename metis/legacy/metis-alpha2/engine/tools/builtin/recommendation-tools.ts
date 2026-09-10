/**
 * Smart Literature Recommendation Engine — recommends papers based on user library.
 *
 * Analyzes the user's existing paper library (tags, topics, authors, venues)
 * to generate relevance-based recommendations. Can be used standalone with
 * heuristic scoring or integrated with arXiv/Semantic Scholar APIs.
 *
 * Key concepts:
 *   - UserProfile: Extracted research interests from the paper library
 *   - Recommendation: A scored paper suggestion with relevance explanation
 *   - RecommendationSource: Where the recommendation comes from (arXiv, Semantic Scholar, local)
 */

// ─── Types ────────────────────────────────────────────────────────

export interface PaperProfile {
  id: string;
  title: string;
  authors: string[];
  year: number;
  tags: string[];
  abstract: string;
  venue: string;
  rating: number;
}

export interface UserProfile {
  /** Research interest keywords extracted from tags and titles. */
  interests: string[];
  /** Frequently cited authors. */
  topAuthors: Array<{ name: string; count: number }>;
  /** Preferred venues. */
  topVenues: Array<{ name: string; count: number }>;
  /** Tag frequency distribution. */
  tagDistribution: Map<string, number>;
  /** Year range of interest. */
  yearRange: { min: number; max: number; focus: number };
  /** Average rating tendency. */
  averageRating: number;
  /** Total papers analyzed. */
  totalPapers: number;
}

export interface Recommendation {
  title: string;
  authors: string[];
  year: number;
  abstract: string;
  venue: string;
  tags: string[];
  relevanceScore: number;     // 0-100
  relevanceReason: string;    // Why this paper is recommended
  source: RecommendationSource;
  url?: string;
  doi?: string;
  arxivId?: string;
}

export type RecommendationSource = 'local' | 'arxiv' | 'semantic_scholar' | 'crossref';

export interface RecommendationRequest {
  /** Papers currently in the user's library. */
  library: PaperProfile[];
  /** Maximum recommendations to return. */
  maxResults?: number;
  /** Minimum relevance score (0-100). */
  minRelevance?: number;
  /** Focus areas (overrides auto-detected interests). */
  focusAreas?: string[];
  /** Exclude papers already in library (by title similarity). */
  excludeTitles?: string[];
  /** Year range filter. */
  yearFrom?: number;
  yearTo?: number;
}

export interface RecommendationResponse {
  recommendations: Recommendation[];
  profile: UserProfile;
  generatedAt: number;
  source: RecommendationSource;
}

// ─── User Profile Builder ────────────────────────────────────────

export function buildUserProfile(library: PaperProfile[]): UserProfile {
  if (library.length === 0) {
    return {
      interests: [],
      topAuthors: [],
      topVenues: [],
      tagDistribution: new Map(),
      yearRange: { min: 0, max: 0, focus: 0 },
      averageRating: 0,
      totalPapers: 0,
    };
  }

  // Interest keywords from tags + titles
  const interestCounts = new Map<string, number>();
  for (const paper of library) {
    for (const tag of paper.tags) {
      interestCounts.set(tag, (interestCounts.get(tag) ?? 0) + 1);
    }
    // Extract keywords from title (simple: split on common words)
    const titleWords = extractKeywords(paper.title);
    for (const word of titleWords) {
      interestCounts.set(word, (interestCounts.get(word) ?? 0) + 0.5);
    }
  }

  const interests = [...interestCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([kw]) => kw);

  // Top authors
  const authorCounts = new Map<string, number>();
  for (const paper of library) {
    for (const author of paper.authors) {
      const normalizedName = author.trim().toLowerCase();
      authorCounts.set(normalizedName, (authorCounts.get(normalizedName) ?? 0) + 1);
    }
  }

  const topAuthors = [...authorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  // Top venues
  const venueCounts = new Map<string, number>();
  for (const paper of library) {
    if (paper.venue) {
      venueCounts.set(paper.venue, (venueCounts.get(paper.venue) ?? 0) + 1);
    }
  }

  const topVenues = [...venueCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  // Tag distribution
  const tagDistribution = new Map<string, number>();
  for (const paper of library) {
    for (const tag of paper.tags) {
      tagDistribution.set(tag, (tagDistribution.get(tag) ?? 0) + 1);
    }
  }

  // Year range
  const years = library.map((p) => p.year).filter((y) => y > 0);
  const minY = years.length > 0 ? Math.min(...years) : 0;
  const maxY = years.length > 0 ? Math.max(...years) : 0;
  // Focus year = mode (most common year)
  const yearCounts = new Map<number, number>();
  for (const y of years) yearCounts.set(y, (yearCounts.get(y) ?? 0) + 1);
  const focusYear = yearCounts.size > 0
    ? [...yearCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0]
    : 0;

  const averageRating = library.reduce((sum, p) => sum + p.rating, 0) / library.length;

  return {
    interests,
    topAuthors,
    topVenues,
    tagDistribution,
    yearRange: { min: minY, max: maxY, focus: focusYear },
    averageRating,
    totalPapers: library.length,
  };
}

// ─── Relevance Scoring ───────────────────────────────────────────

/**
 * Compute relevance score (0-100) of a candidate paper against a user profile.
 * Considers: tag overlap, author overlap, keyword overlap, year proximity, venue match.
 */
export function computeRelevance(
  candidate: { title: string; authors: string[]; year: number; tags: string[]; abstract: string; venue: string },
  profile: UserProfile,
): { score: number; reasons: string[] } {
  if (profile.totalPapers === 0) return { score: 0, reasons: [] };

  let score = 0;
  const reasons: string[] = [];
  const candidateTags = candidate.tags.map((t) => t.toLowerCase());
  const candidateTitleWords = new Set(extractKeywords(candidate.title));
  const candidateAbstractWords = new Set(extractKeywords(candidate.abstract));

  // 1. Tag overlap (max 30 points)
  let tagScore = 0;
  for (const tag of candidateTags) {
    const profileCount = profile.tagDistribution.get(tag) ?? 0;
    if (profileCount > 0) {
      tagScore += Math.min(10, profileCount * 2);
      if (!reasons.includes(`Shared interest: ${tag}`)) {
        reasons.push(`Shared interest: ${tag}`);
      }
    }
  }
  score += Math.min(30, tagScore);

  // 2. Author overlap (max 20 points)
  const normalizedCandidateAuthors = candidate.authors.map((a) => a.trim().toLowerCase());
  const profileAuthors = new Set(profile.topAuthors.map((a) => a.name));
  const sharedAuthors = normalizedCandidateAuthors.filter((a) => profileAuthors.has(a));
  if (sharedAuthors.length > 0) {
    score += Math.min(20, sharedAuthors.length * 10);
    reasons.push(`Author you follow: ${sharedAuthors[0]}${sharedAuthors.length > 1 ? ` +${sharedAuthors.length - 1} more` : ''}`);
  }

  // 3. Keyword overlap with interests (max 25 points)
  let keywordScore = 0;
  for (const interest of profile.interests) {
    const interestLower = interest.toLowerCase();
    if (candidateTitleWords.has(interestLower) || candidateAbstractWords.has(interestLower)) {
      keywordScore += 5;
      if (reasons.length < 5) {
        reasons.push(`Matches your research topic: ${interest}`);
      }
    }
  }
  score += Math.min(25, keywordScore);

  // 4. Year proximity (max 10 points)
  if (profile.yearRange.focus > 0 && candidate.year > 0) {
    const yearDiff = Math.abs(candidate.year - profile.yearRange.focus);
    if (yearDiff <= 1) {
      score += 10;
    } else if (yearDiff <= 3) {
      score += 7;
    } else if (yearDiff <= 5) {
      score += 4;
    }
  }

  // 5. Venue match (max 10 points)
  const profileVenues = new Set(profile.topVenues.map((v) => v.name.toLowerCase()));
  if (candidate.venue && profileVenues.has(candidate.venue.toLowerCase())) {
    score += 10;
    reasons.push(`Published in ${candidate.venue} (a venue you read)`);
  }

  // 6. Title/abstract keyword density bonus (max 5 points)
  const abstractLower = candidate.abstract.toLowerCase();
  let densityBonus = 0;
  for (const interest of profile.interests.slice(0, 5)) {
    const regex = new RegExp(interest.toLowerCase(), 'gi');
    const matches = abstractLower.match(regex);
    if (matches && matches.length >= 2) {
      densityBonus += 1;
    }
  }
  score += Math.min(5, densityBonus);

  return { score: Math.min(100, score), reasons: reasons.slice(0, 5) };
}

// ─── Recommendation Engine ───────────────────────────────────────

export class RecommendationEngine {
  /**
   * Generate recommendations from a local candidate pool.
   * Useful when you have a pre-fetched set of papers (e.g., from arXiv search results).
   */
  recommendFromPool(
    candidates: PaperProfile[],
    request: RecommendationRequest,
  ): RecommendationResponse {
    const profile = buildUserProfile(request.library);
    const maxResults = request.maxResults ?? 10;
    const minRelevance = request.minRelevance ?? 20;
    const excludeTitles = new Set(
      (request.excludeTitles ?? request.library.map((p) => p.title.toLowerCase().trim())),
    );

    // Score each candidate
    const scored: Array<{ candidate: PaperProfile; score: number; reasons: string[] }> = [];

    for (const candidate of candidates) {
      // Skip papers already in library (by title similarity)
      const normalizedTitle = candidate.title.toLowerCase().trim();
      let isDuplicate = false;
      for (const excluded of excludeTitles) {
        if (normalizedTitle === excluded || titleSimilarity(normalizedTitle, excluded) > 0.85) {
          isDuplicate = true;
          break;
        }
      }
      if (isDuplicate) continue;

      // Year filter
      if (request.yearFrom && candidate.year < request.yearFrom) continue;
      if (request.yearTo && candidate.year > request.yearTo) continue;

      const { score, reasons } = computeRelevance(candidate, profile);
      if (score >= minRelevance) {
        scored.push({ candidate, score, reasons });
      }
    }

    // Sort by relevance score descending
    scored.sort((a, b) => b.score - a.score);

    const recommendations: Recommendation[] = scored.slice(0, maxResults).map((item) => ({
      title: item.candidate.title,
      authors: item.candidate.authors,
      year: item.candidate.year,
      abstract: item.candidate.abstract,
      venue: item.candidate.venue,
      tags: item.candidate.tags,
      relevanceScore: item.score,
      relevanceReason: item.reasons.join('; '),
      source: 'local' as const,
      id: item.candidate.id,
    }));

    return {
      recommendations,
      profile,
      generatedAt: Date.now(),
      source: 'local',
    };
  }

  /**
   * Generate arXiv-style recommendations based on user profile.
   * Returns search queries and strategies for arXiv API integration.
   */
  generateArxivSearchStrategies(request: RecommendationRequest): Array<{ query: string; category?: string; sortBy: string }> {
    const profile = buildUserProfile(request.library);
    const strategies: Array<{ query: string; category?: string; sortBy: string }> = [];

    // Strategy 1: Top interest keywords combined
    if (profile.interests.length > 0) {
      const topInterests = profile.interests.slice(0, 3).join(' AND ');
      strategies.push({
        query: topInterests,
        sortBy: 'submittedDate',
      });
    }

    // Strategy 2: Follow top authors
    for (const author of profile.topAuthors.slice(0, 3)) {
      strategies.push({
        query: `au:${author.name}`,
        sortBy: 'submittedDate',
      });
    }

    // Strategy 3: Interest + recent
    if (profile.interests.length >= 2) {
      strategies.push({
        query: profile.interests.slice(0, 2).join(' OR '),
        sortBy: 'relevance',
      });
    }

    // Strategy 4: Focus areas override
    if (request.focusAreas && request.focusAreas.length > 0) {
      strategies.push({
        query: request.focusAreas.join(' AND '),
        sortBy: 'relevance',
      });
    }

    return strategies.slice(0, 6);
  }

  /**
   * Generate Semantic Scholar search strategies based on user profile.
   * Returns query parameters for Semantic Scholar API integration.
   */
  generateSemanticScholarStrategies(request: RecommendationRequest): Array<{ query: string; year?: string; fieldsOfStudy?: string[] }> {
    const profile = buildUserProfile(request.library);
    const strategies: Array<{ query: string; year?: string; fieldsOfStudy?: string[] }> = [];

    // Top interests as search queries
    if (profile.interests.length > 0) {
      strategies.push({
        query: profile.interests.slice(0, 3).join(' '),
        year: profile.yearRange.focus > 0 ? `${profile.yearRange.focus}-${profile.yearRange.focus + 2}` : undefined,
      });
    }

    // Author-based recommendations
    for (const author of profile.topAuthors.slice(0, 2)) {
      strategies.push({
        query: author.name,
      });
    }

    return strategies.slice(0, 4);
  }

  /**
   * Find papers in library similar to a given paper.
   * Useful for "find similar" functionality.
   */
  findSimilar(
    targetPaper: PaperProfile,
    library: PaperProfile[],
    maxResults?: number,
  ): Array<{ paper: PaperProfile; similarity: number; sharedAspects: string[] }> {
    const results: Array<{ paper: PaperProfile; similarity: number; sharedAspects: string[] }> = [];

    for (const paper of library) {
      if (paper.id === targetPaper.id) continue;

      const aspects: string[] = [];
      let similarity = 0;

      // Tag overlap (0-40 points)
      const sharedTags = targetPaper.tags.filter((t) => paper.tags.includes(t));
      if (sharedTags.length > 0) {
        similarity += Math.min(40, sharedTags.length * 10);
        aspects.push(`Shared tags: ${sharedTags.join(', ')}`);
      }

      // Author overlap (0-30 points)
      const sharedAuthors = targetPaper.authors.filter((a) =>
        paper.authors.some((pa) => pa.toLowerCase() === a.toLowerCase()),
      );
      if (sharedAuthors.length > 0) {
        similarity += Math.min(30, sharedAuthors.length * 15);
        aspects.push(`Shared authors: ${sharedAuthors.join(', ')}`);
      }

      // Year proximity (0-15 points)
      const yearDiff = Math.abs(targetPaper.year - paper.year);
      if (yearDiff <= 1) similarity += 15;
      else if (yearDiff <= 3) similarity += 10;
      else if (yearDiff <= 5) similarity += 5;

      // Title keyword overlap (0-15 points)
      const targetKeywords = new Set(extractKeywords(targetPaper.title));
      const paperKeywords = new Set(extractKeywords(paper.title));
      const sharedKeywords = [...targetKeywords].filter((k) => paperKeywords.has(k));
      if (sharedKeywords.length > 0) {
        similarity += Math.min(15, sharedKeywords.length * 5);
        aspects.push(`Related topic: ${sharedKeywords.slice(0, 3).join(', ')}`);
      }

      if (similarity > 0) {
        results.push({ paper, similarity, sharedAspects: aspects });
      }
    }

    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, maxResults ?? 5);
  }
}

// ─── Helper Functions ────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'can', 'shall', 'not', 'no', 'nor',
  'this', 'that', 'these', 'those', 'it', 'its', 'we', 'our', 'they',
  'their', 'them', 'he', 'she', 'him', 'her', 'his', 'which', 'what',
  'how', 'when', 'where', 'who', 'whom', 'why', 'all', 'each', 'every',
  'both', 'few', 'more', 'most', 'other', 'some', 'such', 'than', 'too',
  'very', 'just', 'about', 'above', 'after', 'before', 'between', 'into',
  'through', 'during', 'using', 'based', 'via', 'new', 'also', 'via',
]);

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Simple title similarity using Jaccard similarity on words.
 */
function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/).filter((w) => w.length >= 3));
  const wordsB = new Set(b.split(/\s+/).filter((w) => w.length >= 3));
  if (wordsA.size === 0 && wordsB.size === 0) return 0;

  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}
