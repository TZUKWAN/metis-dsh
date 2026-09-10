/**
 * IntegrityBadge — shows a paper's citation-integrity status next to its card.
 *
 * Queries OpenAlex (is_retracted) and Crossref (update-to retraction signals)
 * asynchronously, caches results by DOI so a re-render does not refetch. The
 * fetches are renderer-safe (pure HTTP, no Node deps). Rendering never blocks
 * on the network: the badge starts as a neutral "checking" pill and resolves
 * to VERIFIED / RETRACTED / UNKNOWN once the data arrives.
 */

import { useEffect, useState } from 'react';
import { getRawWorkByDoi as getOpenAlexWork } from '@engine/research/OpenAlexClient.js';
import { getRawWorkByDoi as getCrossrefWork } from '@engine/research/CrossrefClient.js';

export type IntegrityStatus = 'checking' | 'verified' | 'retracted' | 'unknown';

interface IntegrityInfo {
  status: IntegrityStatus;
  label: string;
  color: string;
}

const STATUS_STYLE: Record<IntegrityStatus, Omit<IntegrityInfo, 'status'>> = {
  checking: { label: '...', color: 'var(--evidence-stale)' },
  verified: { label: 'VERIFIED', color: 'var(--evidence-verified)' },
  retracted: { label: 'RETRACTED', color: 'var(--evidence-refuted)' },
  unknown: { label: 'UNKNOWN', color: 'var(--text-muted)' },
};

// Module-level cache so navigating away and back does not refetch.
const cache = new Map<string, IntegrityStatus>();

async function resolveStatus(doi: string): Promise<IntegrityStatus> {
  try {
    const [openAlex, crossref] = await Promise.all([
      getOpenAlexWork(doi),
      getCrossrefWork(doi),
    ]);
    // OpenAlex carries an explicit retraction flag.
    if (openAlex?.is_retracted) return 'retracted';
    // Crossref "update-to" points at a replacement record when a work is
    // retracted or withdrawn; its type often names the action.
    const updateTo = crossref?.['update-to'];
    if (Array.isArray(updateTo) && updateTo.length > 0) {
      const label = String(updateTo[0]?.label ?? '').toLowerCase();
      if (label.includes('retract') || label.includes('withdraw') || label.includes('removal')) {
        return 'retracted';
      }
    }
    // If at least one source returned a record without a retraction signal,
    // treat the DOI as verified-present.
    if (openAlex || crossref) return 'verified';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function IntegrityBadge({ doi }: { doi: string }) {
  const [status, setStatus] = useState<IntegrityStatus>(() => cache.get(doi) ?? 'checking');

  useEffect(() => {
    // The initial state already reflects a cached value; only fetch when there
    // is nothing cached yet. The async resolve then updates state from its
    // callback (never synchronously inside the effect body).
    if (cache.has(doi)) return;
    let cancelled = false;
    void resolveStatus(doi).then((resolved) => {
      if (cancelled) return;
      cache.set(doi, resolved);
      setStatus(resolved);
    });
    return () => { cancelled = true; };
  }, [doi]);

  const style = STATUS_STYLE[status];
  return (
    <span
      className="badge integrity-badge"
      style={{ background: style.color, color: 'var(--text-on-accent)', marginLeft: 6 }}
      title={`Citation integrity: ${style.label}`}
      data-integrity-status={status}
    >
      {style.label}
    </span>
  );
}
