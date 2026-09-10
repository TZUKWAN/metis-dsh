/**
 * Project claim manifest — persistent handoff file for cross-session research.
 *
 * Stores claims, their evidence status, and gap reasons so a new chat session
 * can resume a long-running research project. Inspired by academic skill
 * manifests (e.g. WenyuChiou/ai-research-skills) and ARS v3.8 Material Passport.
 *
 * The manifest is stored as JSON in the Metis data directory under
 * `manifest/claims.json`. It is intentionally simple: a richer YAML schema can
 * be added later.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

export type ClaimStatus = 'proposed' | 'verified' | 'single_index' | 'mismatch' | 'contradicted' | 'unverifiable' | 'gap';

export interface ClaimManifestEntry {
  id: string;
  claim: string;
  source?: string;
  doi?: string;
  arxivId?: string;
  pdfUrl?: string;
  status: ClaimStatus;
  evidenceArtifacts?: string[];
  gapReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ClaimManifest {
  version: number;
  projectName?: string;
  researchQuestion?: string;
  updatedAt: number;
  claims: ClaimManifestEntry[];
}

const MANIFEST_VERSION = 1;

function getDataDir(): string {
  // In Electron main, main.ts should set METIS_DATA_DIR before any engine call.
  if (process.env.METIS_DATA_DIR) return process.env.METIS_DATA_DIR;
  // Node / test fallback: use a directory under the project root or temp.
  try {
    const cwd = process.cwd();
    return path.join(cwd, '.metis-data');
  } catch {
    return path.join(os.tmpdir(), 'metis-data');
  }
}

function getManifestDir(): string {
  return path.join(getDataDir(), 'manifest');
}

function getManifestPath(): string {
  return path.join(getManifestDir(), 'claims.json');
}

export async function ensureManifestDir(): Promise<void> {
  await fs.mkdir(getManifestDir(), { recursive: true });
}

function emptyManifest(): ClaimManifest {
  return {
    version: MANIFEST_VERSION,
    updatedAt: Date.now(),
    claims: [],
  };
}

/**
 * Load the claim manifest from disk.
 *
 * Returns an empty manifest if the file does not exist or is malformed.
 */
export async function loadManifest(): Promise<ClaimManifest> {
  try {
    await ensureManifestDir();
    const raw = await fs.readFile(getManifestPath(), 'utf-8');
    const parsed = JSON.parse(raw) as ClaimManifest;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.claims)) {
      return emptyManifest();
    }
    return { ...emptyManifest(), ...parsed, claims: parsed.claims };
  } catch {
    return emptyManifest();
  }
}

async function saveManifest(manifest: ClaimManifest): Promise<void> {
  await ensureManifestDir();
  manifest.updatedAt = Date.now();
  await fs.writeFile(getManifestPath(), JSON.stringify(manifest, null, 2), 'utf-8');
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Add a new claim to the manifest.
 */
export async function addClaim(entry: Omit<ClaimManifestEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<ClaimManifestEntry> {
  const manifest = await loadManifest();
  const now = Date.now();
  const newEntry: ClaimManifestEntry = {
    ...entry,
    id: generateId(),
    createdAt: now,
    updatedAt: now,
  };
  manifest.claims.push(newEntry);
  await saveManifest(manifest);
  return newEntry;
}

/**
 * Update an existing claim's status and optional fields.
 */
export async function updateClaim(
  id: string,
  updates: Partial<Omit<ClaimManifestEntry, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<ClaimManifestEntry | null> {
  const manifest = await loadManifest();
  const idx = manifest.claims.findIndex((c) => c.id === id);
  if (idx === -1) return null;

  manifest.claims[idx] = {
    ...manifest.claims[idx]!,
    ...updates,
    updatedAt: Date.now(),
  };
  await saveManifest(manifest);
  return manifest.claims[idx]!;
}

/**
 * List all claims, optionally filtered by status.
 */
export async function listClaims(filter?: { status?: ClaimStatus }): Promise<ClaimManifestEntry[]> {
  const manifest = await loadManifest();
  if (!filter?.status) return manifest.claims;
  return manifest.claims.filter((c) => c.status === filter.status);
}

/**
 * Find a claim by id, exact text, or identifier (doi / arxivId / pdfUrl).
 */
export async function findClaim(options: {
  id?: string;
  claim?: string;
  doi?: string;
  arxivId?: string;
  pdfUrl?: string;
}): Promise<ClaimManifestEntry | null> {
  const manifest = await loadManifest();

  if (options.id) {
    return manifest.claims.find((c) => c.id === options.id) ?? null;
  }

  const normalize = (s?: string) => (s ?? '').trim().toLowerCase();
  const doi = normalize(options.doi);
  const arxivId = normalize(options.arxivId);
  const pdfUrl = normalize(options.pdfUrl);
  const claimText = normalize(options.claim);

  return (
    manifest.claims.find((c) => {
      if (doi && normalize(c.doi) === doi) return true;
      if (arxivId && normalize(c.arxivId) === arxivId) return true;
      if (pdfUrl && normalize(c.pdfUrl) === pdfUrl) return true;
      if (claimText && normalize(c.claim) === claimText) return true;
      return false;
    }) ?? null
  );
}

/**
 * Delete a claim by ID.
 */
export async function deleteClaim(id: string): Promise<boolean> {
  const manifest = await loadManifest();
  const initialLength = manifest.claims.length;
  manifest.claims = manifest.claims.filter((c) => c.id !== id);
  if (manifest.claims.length === initialLength) return false;
  await saveManifest(manifest);
  return true;
}

/**
 * Update project-level metadata.
 */
export async function updateProjectMeta(updates: { projectName?: string; researchQuestion?: string }): Promise<void> {
  const manifest = await loadManifest();
  if (updates.projectName !== undefined) manifest.projectName = updates.projectName;
  if (updates.researchQuestion !== undefined) manifest.researchQuestion = updates.researchQuestion;
  await saveManifest(manifest);
}

/**
 * Convert a claim entry to a plain object for tool output.
 */
export function claimToPlain(entry: ClaimManifestEntry): Record<string, unknown> {
  return {
    id: entry.id,
    claim: entry.claim,
    source: entry.source,
    doi: entry.doi,
    arxivId: entry.arxivId,
    pdfUrl: entry.pdfUrl,
    status: entry.status,
    evidenceArtifacts: entry.evidenceArtifacts,
    gapReason: entry.gapReason,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/**
 * Convert the whole manifest to a plain object for tool output.
 */
export function manifestToPlain(manifest: ClaimManifest): Record<string, unknown> {
  return {
    version: manifest.version,
    projectName: manifest.projectName,
    researchQuestion: manifest.researchQuestion,
    updatedAt: manifest.updatedAt,
    claimCount: manifest.claims.length,
    claims: manifest.claims.map(claimToPlain),
  };
}
