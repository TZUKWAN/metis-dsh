/**
 * TriangulationStatus — cross-source verification of a paper's DOI.
 *
 * Runs engine/research/CitationTriangulator.triangulateDoi (Crossref +
 * OpenAlex + Semantic Scholar) on demand, caches results per DOI, and shows
 * VERIFIED / INCONSISTENT / NOT_FOUND / PARTIAL. Triangulation is slow (three
 * network calls), so it is triggered by a button, never during render.
 */

import { useCallback, useState } from 'react';
import { useTranslation } from '../i18n';
import { triangulateDoi } from '@engine/research/CitationTriangulator.js';

type TriangulationOverall = 'VERIFIED' | 'INCONSISTENT' | 'NOT_FOUND' | 'PARTIAL';

interface TriangulationState {
  status: 'idle' | 'running' | 'done' | 'error';
  overall?: TriangulationOverall;
  sources?: string[];
  error?: string;
}

const STATUS_COLOR: Record<TriangulationOverall, string> = {
  VERIFIED: 'var(--evidence-verified)',
  INCONSISTENT: 'var(--evidence-pending)',
  NOT_FOUND: 'var(--evidence-refuted)',
  PARTIAL: 'var(--text-muted)',
};

// Module-level cache: re-checking the same DOI is free.
const cache = new Map<string, TriangulationOverall>();

export function TriangulationStatus({ doi }: { doi: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<TriangulationState>(() => {
    const cached = cache.get(doi);
    return cached ? { status: 'done', overall: cached } : { status: 'idle' };
  });

  const runTriangulation = useCallback(async () => {
    setState({ status: 'running' });
    try {
      const result = await triangulateDoi(doi);
      cache.set(doi, result.overall);
      setState({
        status: 'done',
        overall: result.overall,
        sources: result.existsIn,
      });
    } catch (err) {
      setState({ status: 'error', error: err instanceof Error ? err.message : 'triangulation failed' });
    }
  }, [doi]);

  return (
    <div className="triangulation-status">
      {state.status === 'idle' && (
        <button className="btn-sm btn-secondary" onClick={() => void runTriangulation()}>
          {t('papers.triangulate')}
        </button>
      )}
      {state.status === 'running' && (
        <span className="badge" style={{ background: 'var(--evidence-stale)', color: 'var(--text-on-accent)' }}>
          {t('papers.triangulating')}
        </span>
      )}
      {state.status === 'done' && state.overall && (
        <>
          <span
            className="badge"
            style={{ background: STATUS_COLOR[state.overall], color: 'var(--text-on-accent)' }}
            title={state.sources?.join(', ')}
            data-triangulation={state.overall}
          >
            {state.overall}
          </span>
          <button className="btn-sm btn-secondary" onClick={() => void runTriangulation()}>
            {t('papers.triangulateRefresh')}
          </button>
        </>
      )}
      {state.status === 'error' && (
        <>
          <span className="badge" style={{ background: 'var(--text-muted)', color: 'var(--text-on-accent)' }}>
            {t('papers.triangulateError')}
          </span>
          <button className="btn-sm btn-secondary" onClick={() => void runTriangulation()}>
            {t('papers.triangulateRetry')}
          </button>
        </>
      )}
    </div>
  );
}
