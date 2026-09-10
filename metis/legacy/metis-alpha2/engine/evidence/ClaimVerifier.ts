/**
 * Claim verifier — check whether a user-provided claim is supported by the
 * text of a cited paper.
 *
 * v2 adds an optional LLM semantic judge on top of the original keyword-level
 * passage ranking. When a BaseProvider is supplied, the top passages are sent
 * to the model for a support / contradiction / insufficient-evidence verdict.
 * The keyword verdict is always retained as a deterministic fallback.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BaseProvider } from '../providers/BaseProvider.js';
import type { ChatMessage } from '../core/types.js';
import { resolveDoi } from '../research/DoiResolver.js';
import { resolveArxiv } from '../research/ArxivResolver.js';
import { getWorkByDoi as getOpenAlexWorkByDoi } from '../research/OpenAlexClient.js';
import { getPdfReader } from '../research/PdfReader.js';
import { downloadFile } from '../research/PdfDownloader.js';

export type ClaimVerdict =
  | 'SUPPORTED'
  | 'LIKELY_SUPPORTED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'CONTRADICTED'
  | 'NO_TEXT_AVAILABLE'
  | 'ERROR';

export interface ScoredPassage {
  text: string;
  score: number;
  page?: number;
}

export interface SemanticJudgment {
  verdict: ClaimVerdict;
  confidence: number;
  reasoning: string;
  passageIndices: number[];
}

export interface ClaimVerificationResult {
  claim: string;
  identifier: string;
  identifierType: 'doi' | 'arxiv' | 'unknown';
  metadata: Record<string, unknown>;
  pdfUrl?: string;
  pdfDownloaded: boolean;
  topPassages: ScoredPassage[];
  /** Final verdict. If an LLM judgment is available it takes precedence. */
  verdict: ClaimVerdict;
  /** Keyword-only verdict, preserved as a deterministic baseline. */
  keywordVerdict: ClaimVerdict;
  reasoning: string;
  /** LLM semantic judgment, present only when a provider was supplied. */
  semantic?: SemanticJudgment;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'can', 'need', 'dare', 'ought',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'as',
  'and', 'or', 'but', 'so', 'yet', 'that', 'which', 'who', 'whom',
  'this', 'these', 'those', 'it', 'its', 'their', 'they', 'we', 'our',
  'us', 'i', 'me', 'my', 'you', 'your', 'he', 'she', 'him', 'her',
  'than', 'then', 'also', 'only', 'even', 'just', 'not', 'no', 'nor',
]);

function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  return normalized
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function extractSentences(text: string): string[] {
  // Split on sentence terminators, keeping some punctuation.
  const raw = text.split(/(?<=[.!?])\s+/);
  return raw.map((s) => s.trim()).filter((s) => s.length > 20);
}

function scoreSentence(sentence: string, claimTokens: string[]): number {
  const sentenceTokens = new Set(tokenize(sentence));
  if (sentenceTokens.size === 0 || claimTokens.length === 0) return 0;

  let matches = 0;
  for (const token of claimTokens) {
    if (sentenceTokens.has(token)) matches++;
  }
  const coverage = matches / claimTokens.length;

  // Bonus for exact claim token phrase windows (two consecutive tokens).
  let phraseMatches = 0;
  for (let i = 0; i < claimTokens.length - 1; i++) {
    const phrase = `${claimTokens[i]} ${claimTokens[i + 1]}`;
    if (sentence.toLowerCase().includes(phrase)) phraseMatches++;
  }
  const phraseBonus = claimTokens.length > 1 ? phraseMatches / (claimTokens.length - 1) : 0;

  return Math.min(1, coverage * 0.7 + phraseBonus * 0.3);
}

function looksContradictory(sentence: string, claimTokens: string[]): boolean {
  const lower = sentence.toLowerCase();
  const negationWords = ['not', 'no', 'never', 'neither', 'nor', 'unable', 'failed', 'contrary', 'contradict'];
  const hasNegation = negationWords.some((w) => lower.includes(w));
  const claimCoverage = claimTokens.filter((t) => lower.includes(t)).length / Math.max(1, claimTokens.length);
  return hasNegation && claimCoverage > 0.4;
}

/**
 * Find the most relevant passages in a body of text for a given claim.
 *
 * Exported for unit testing.
 */
export function findRelevantPassages(claim: string, text: string, topK = 5): ScoredPassage[] {
  const claimTokens = tokenize(claim);
  if (claimTokens.length === 0) return [];

  const passages = extractSentences(text).map((sentence) => ({
    text: sentence,
    score: scoreSentence(sentence, claimTokens),
  }));

  passages.sort((a, b) => b.score - a.score);
  return passages.slice(0, topK);
}

function decideVerdict(topPassages: ScoredPassage[], claimTokens: string[]): ClaimVerdict {
  if (topPassages.length === 0) return 'NO_TEXT_AVAILABLE';
  const best = topPassages[0]!;

  if (topPassages.some((p) => looksContradictory(p.text, claimTokens))) {
    return 'CONTRADICTED';
  }
  if (best.score >= 0.7) return 'SUPPORTED';
  if (best.score >= 0.4) return 'LIKELY_SUPPORTED';
  return 'INSUFFICIENT_EVIDENCE';
}

function reasoningForVerdict(verdict: ClaimVerdict, bestScore: number, identifier: string): string {
  switch (verdict) {
    case 'SUPPORTED':
      return `High keyword overlap (score ${bestScore.toFixed(2)}) found in ${identifier}; the claim appears to be directly supported by the source text.`;
    case 'LIKELY_SUPPORTED':
      return `Moderate keyword overlap (score ${bestScore.toFixed(2)}) found in ${identifier}; the claim is likely supported, but a human should confirm interpretation.`;
    case 'INSUFFICIENT_EVIDENCE':
      return `Low keyword overlap (best score ${bestScore.toFixed(2)}) in ${identifier}; the source text does not clearly support the claim.`;
    case 'CONTRADICTED':
      return `A relevant passage in ${identifier} contains negation or contradictory language around the claim keywords.`;
    case 'NO_TEXT_AVAILABLE':
      return `Could not extract usable text for ${identifier}.`;
    case 'ERROR':
      return `An error occurred while verifying the claim against ${identifier}.`;
  }
}

function normalizeIdentifier(input: string): { type: 'doi' | 'arxiv' | 'unknown'; value: string } {
  const trimmed = input.trim();
  if (/^10\.\d{4,}\//i.test(trimmed) || /^https?:\/\/doi\.org\//i.test(trimmed)) {
    return { type: 'doi', value: trimmed };
  }
  if (/^arxiv:/i.test(trimmed) || /arxiv\.org\/abs\//i.test(trimmed) || /^\d{4}\.\d{4,}/i.test(trimmed)) {
    return { type: 'arxiv', value: trimmed };
  }
  return { type: 'unknown', value: trimmed };
}

async function resolveIdentifier(
  identifier: string,
  type: 'doi' | 'arxiv' | 'unknown',
): Promise<{ metadata: Record<string, unknown>; pdfUrl?: string; arxivId?: string } | null> {
  if (type === 'doi') {
    const metadata = await resolveDoi(identifier);
    if (!metadata) return null;

    // Try to get a better PDF URL from OpenAlex as fallback.
    let openAlexPdfUrl: string | undefined;
    try {
      const openAlex = await getOpenAlexWorkByDoi(identifier);
      openAlexPdfUrl = openAlex?.pdfUrl;
    } catch {
      openAlexPdfUrl = undefined;
    }

    return {
      metadata: {
        doi: metadata.doi,
        title: metadata.title,
        authors: metadata.authors,
        year: metadata.year,
        venue: metadata.venue,
      },
      pdfUrl: metadata.pdfUrl || openAlexPdfUrl,
      arxivId: metadata.arxivId,
    };
  }

  if (type === 'arxiv') {
    const metadata = await resolveArxiv(identifier);
    if (!metadata) return null;
    return {
      metadata: {
        arxivId: metadata.arxivId,
        title: metadata.title,
        authors: metadata.authors,
        year: metadata.year,
        doi: metadata.doi,
      },
      pdfUrl: metadata.pdfUrl,
      arxivId: metadata.arxivId,
    };
  }

  return null;
}

async function downloadPdfToTemp(pdfUrl: string): Promise<string | null> {
  const ext = path.extname(new URL(pdfUrl).pathname) || '.pdf';
  const tmpFile = path.join(os.tmpdir(), `metis-claim-${Date.now()}${ext}`);
  try {
    await downloadFile(pdfUrl, tmpFile);
    return tmpFile;
  } catch {
    return null;
  }
}

async function extractTextFromPdf(filePath: string): Promise<string> {
  const reader = getPdfReader();
  const result = await reader.readFile(filePath, { includeMetadata: false, includeOutline: false });
  return result.pages.map((p) => p.text).join('\n');
}

function buildJudgmentPrompt(claim: string, passages: ScoredPassage[]): string {
  const passageBlock = passages
    .map((p, idx) => `[${idx + 1}] ${p.text}`)
    .join('\n\n');

  return `You are a rigorous scientific claim verifier. A user has made a claim about a cited paper, and I have extracted the most relevant passages from the paper text.

Claim: "${claim}"

Relevant passages:
${passageBlock}

Instructions:
- Determine whether the passages SUPPORT, CONTRADICT, or provide INSUFFICIENT EVIDENCE for the claim.
- Use LIKELY_SUPPORTED only when the evidence is encouraging but indirect or hedged.
- Be conservative: do not infer support that is not present in the passages.
- Output ONLY a JSON object (no markdown, no prose):
{
  "verdict": "SUPPORTED" | "LIKELY_SUPPORTED" | "INSUFFICIENT_EVIDENCE" | "CONTRADICTED",
  "confidence": <number between 0 and 1>,
  "reasoning": "<1-3 sentence explanation citing specific passages>",
  "supportingPassageIndices": [<1-based indices of passages used>]
}`;
}

function parseJsonBlock(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();

  // Direct JSON parse first.
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // ignore
  }

  // Extract the first JSON object from surrounding prose/markdown.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeVerdict(value: unknown): ClaimVerdict | null {
  const valid: ClaimVerdict[] = [
    'SUPPORTED',
    'LIKELY_SUPPORTED',
    'INSUFFICIENT_EVIDENCE',
    'CONTRADICTED',
  ];
  const str = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '_');
  return valid.find((v) => v === str) ?? null;
}

/**
 * Ask an LLM provider to judge whether the provided passages support,
 * contradict, or are insufficient for the claim.
 */
export async function judgeClaimSemantically(
  provider: BaseProvider,
  claim: string,
  passages: ScoredPassage[],
): Promise<SemanticJudgment | null> {
  if (!provider || passages.length === 0) return null;

  try {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a rigorous scientific claim verifier. Respond with a single JSON object containing verdict, confidence, reasoning, and supportingPassageIndices.',
      },
      { role: 'user', content: buildJudgmentPrompt(claim, passages) },
    ];

    const response = await provider.complete(messages, undefined, {
      temperature: 0,
      max_tokens: 1024,
    });

    const parsed = parseJsonBlock(response.content ?? '');
    if (!parsed) return null;

    const verdict = normalizeVerdict(parsed.verdict);
    if (!verdict) return null;

    const confidence =
      typeof parsed.confidence === 'number'
        ? Math.min(1, Math.max(0, parsed.confidence))
        : 0.7;

    const passageIndices = Array.isArray(parsed.supportingPassageIndices)
      ? parsed.supportingPassageIndices.filter((n: unknown): n is number => typeof n === 'number')
      : [];

    return {
      verdict,
      confidence,
      reasoning: String(parsed.reasoning ?? ''),
      passageIndices,
    };
  } catch {
    return null;
  }
}

export interface VerifyClaimOptions {
  claim: string;
  doi?: string;
  arxivId?: string;
  pdfUrl?: string;
  topK?: number;
  /** Optional LLM provider for semantic claim judgment. */
  provider?: BaseProvider;
}

/**
 * Verify a claim against the text of a cited work.
 *
 * If a DOI or arXiv ID is provided, the function resolves metadata and
 * attempts to locate an open-access PDF. If `pdfUrl` is provided, it is
 * used directly. The PDF is downloaded to a temporary file, text is
 * extracted, and the most relevant sentences are scored. When a provider
 * is supplied, the top passages are also sent to the LLM for a semantic
 * support / contradiction judgment.
 */
export async function verifyClaim(options: VerifyClaimOptions): Promise<ClaimVerificationResult> {
  const { claim, doi, arxivId, pdfUrl: explicitPdfUrl, topK = 5, provider } = options;

  const identifierInput = doi || arxivId || explicitPdfUrl || 'unknown';
  const normalized = normalizeIdentifier(identifierInput);

  if (normalized.type === 'unknown' && !explicitPdfUrl) {
    return {
      claim,
      identifier: identifierInput,
      identifierType: 'unknown',
      metadata: {},
      pdfDownloaded: false,
      topPassages: [],
      verdict: 'ERROR',
      keywordVerdict: 'ERROR',
      reasoning: 'No usable identifier (DOI / arXiv ID / PDF URL) was provided.',
    };
  }

  const resolved = await resolveIdentifier(identifierInput, normalized.type);
  if (!resolved) {
    return {
      claim,
      identifier: identifierInput,
      identifierType: normalized.type,
      metadata: {},
      pdfDownloaded: false,
      topPassages: [],
      verdict: 'ERROR',
      keywordVerdict: 'ERROR',
      reasoning: `Could not resolve identifier ${identifierInput}.`,
    };
  }

  const pdfUrl = explicitPdfUrl || resolved.pdfUrl;
  if (!pdfUrl) {
    return {
      claim,
      identifier: identifierInput,
      identifierType: normalized.type,
      metadata: resolved.metadata,
      pdfDownloaded: false,
      topPassages: [],
      verdict: 'NO_TEXT_AVAILABLE',
      keywordVerdict: 'NO_TEXT_AVAILABLE',
      reasoning: 'No open-access PDF URL is available for this identifier.',
    };
  }

  const tmpFile = await downloadPdfToTemp(pdfUrl);
  if (!tmpFile) {
    return {
      claim,
      identifier: identifierInput,
      identifierType: normalized.type,
      metadata: resolved.metadata,
      pdfUrl,
      pdfDownloaded: false,
      topPassages: [],
      verdict: 'NO_TEXT_AVAILABLE',
      keywordVerdict: 'NO_TEXT_AVAILABLE',
      reasoning: 'Failed to download the PDF from the available URL.',
    };
  }

  try {
    const text = await extractTextFromPdf(tmpFile);
    const claimTokens = tokenize(claim);
    const topPassages = findRelevantPassages(claim, text, topK);
    const keywordVerdict = decideVerdict(topPassages, claimTokens);

    const semantic = provider
      ? (await judgeClaimSemantically(provider, claim, topPassages)) ?? undefined
      : undefined;
    const verdict = semantic?.verdict ?? keywordVerdict;
    const reasoning = semantic
      ? `[LLM judgment, confidence ${(semantic.confidence * 100).toFixed(0)}%] ${semantic.reasoning}`
      : reasoningForVerdict(keywordVerdict, topPassages[0]?.score ?? 0, identifierInput);

    return {
      claim,
      identifier: identifierInput,
      identifierType: normalized.type,
      metadata: resolved.metadata,
      pdfUrl,
      pdfDownloaded: true,
      topPassages,
      verdict,
      keywordVerdict,
      reasoning,
      semantic,
    };
  } catch (err) {
    return {
      claim,
      identifier: identifierInput,
      identifierType: normalized.type,
      metadata: resolved.metadata,
      pdfUrl,
      pdfDownloaded: true,
      topPassages: [],
      verdict: 'ERROR',
      keywordVerdict: 'ERROR',
      reasoning: `Error reading PDF: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    // Best-effort cleanup.
    await fs.unlink(tmpFile).catch(() => {});
  }
}
