/**
 * Unpaywall open-access PDF resolver (O3).
 *
 * Unpaywall indexes 60M+ open-access articles across 50k+ journals and is the
 * most reliable legal source for finding a downloadable PDF — it sidesteps
 * most publisher anti-leech measures because it links to the *open* copy.
 *
 * Docs: https://unpaywall.org/products/api
 * Endpoint: https://api.unpaywall.org/v2/{doi}?email=...
 *
 * An email is required by Unpaywall's usage policy; it is a contact address
 * for rate-limit/abuse contact, not an auth credential.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const UNPAYWALL_BASE = 'https://api.unpaywall.org/v2';

export interface UnpaywallPdfLocation {
  url: string;
  /** 'gold' | 'hybrid' | 'bronze' | 'green' | 'closed' per Unpaywall schema. */
  oaStatus: string;
  /** Whether the location is flagged as the publisher-hosted version. */
  version: string | null;
  /** True when Unpaywall reports the URL as host-type 'repository'. */
  repository: boolean;
}

export interface UnpaywallResult {
  doi: string;
  bestPdfUrl: string | null;
  locations: UnpaywallPdfLocation[];
  isOA: boolean;
  oaStatus: string;
}

interface UnpaywallResponse {
  doi?: string;
  is_oa?: boolean;
  oa_status?: string;
  best_oa_location?: UnpaywallRawLocation | null;
  oa_locations?: UnpaywallRawLocation[] | null;
}

interface UnpaywallRawLocation {
  url_for_pdf?: string | null;
  url?: string | null;
  host_type?: string;
  version?: string | null;
  oa?: boolean;
  license?: string | null;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

function toLocation(raw: UnpaywallRawLocation): UnpaywallPdfLocation | null {
  const url = raw.url_for_pdf ?? raw.url;
  if (!url) return null;
  return {
    url,
    oaStatus: raw.host_type ?? 'unknown',
    version: raw.version ?? null,
    repository: raw.host_type === 'repository',
  };
}

/**
 * Resolve open-access PDF candidates for a DOI.
 * Returns null when the DOI is unknown to Unpaywall or no OA copy exists.
 */
export async function resolvePdf(
  doi: string,
  email: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<UnpaywallResult | null> {
  const cleanDoi = doi.trim().replace(/^https?:\/\/doi\.org\//i, '').replace(/^doi:\s*/i, '');
  if (!cleanDoi || !/^10\./.test(cleanDoi)) return null;
  const contact = email.trim() || 'metis@localhost';
  const url = `${UNPAYWALL_BASE}/${encodeURIComponent(cleanDoi)}?email=${encodeURIComponent(contact)}`;

  try {
    const response = await fetchWithTimeout(url, timeoutMs);
    if (!response.ok) return null;
    const data = (await response.json()) as UnpaywallResponse;
    if (!data || typeof data !== 'object') return null;

    const rawLocations = Array.isArray(data.oa_locations) ? data.oa_locations : [];
    const locations: UnpaywallPdfLocation[] = [];
    for (const raw of rawLocations) {
      const loc = toLocation(raw);
      if (loc) locations.push(loc);
    }

    const bestRaw = data.best_oa_location ?? null;
    const best = bestRaw ? toLocation(bestRaw) : null;

    return {
      doi: data.doi ?? cleanDoi,
      bestPdfUrl: best?.url ?? locations[0]?.url ?? null,
      locations,
      isOA: data.is_oa === true,
      oaStatus: data.oa_status ?? (data.is_oa ? 'oa' : 'closed'),
    };
  } catch {
    return null;
  }
}

/**
 * Build an ordered candidate URL list for a paper, combining the existing
 * pdfUrl with Unpaywall and arXiv sources. De-duplicated, PDFs first.
 */
export async function collectPdfCandidates(params: {
  doi?: string;
  arxivId?: string;
  pdfUrl?: string;
  email?: string;
  timeoutMs?: number;
}): Promise<string[]> {
  const { doi, arxivId, pdfUrl, email = 'metis@localhost', timeoutMs } = params;
  const candidates: string[] = [];
  const seen = new Set<string>();

  const push = (url: string | undefined | null) => {
    if (!url) return;
    const cleaned = url.trim();
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      candidates.push(cleaned);
    }
  };

  // 1. Unpaywall best OA location (most reliable legal source).
  if (doi && /^10\./.test(doi.trim())) {
    try {
      const result = await resolvePdf(doi, email, timeoutMs);
      if (result?.bestPdfUrl) push(result.bestPdfUrl);
      for (const loc of result?.locations ?? []) push(loc.url);
    } catch {
      // Non-fatal: fall through to other sources.
    }
  }

  // 2. arXiv canonical PDF URL.
  if (arxivId) {
    const id = arxivId.trim();
    if (id) push(`https://arxiv.org/pdf/${id}.pdf`);
  }

  // 3. Whatever the metadata already resolved (Semantic Scholar openAccessPdf etc).
  push(pdfUrl);

  return candidates;
}
