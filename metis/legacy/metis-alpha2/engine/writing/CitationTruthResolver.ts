import { getPassport } from '../research/CitationPassport.js';
import {
  loadMirror as loadRetractionMirror,
  lookupDoi,
} from '../research/RetractionWatchMirror.js';
import {
  loadIndex as loadJournalIndex,
  lookupVenue,
} from '../research/JournalIntegrityMirror.js';
import {
  CitationTruthAttestationSchema,
  type CitationTruthAttestation,
} from './CitationTruth.js';

export interface CitationTruthResolutionRequest {
  sourceId: string;
  citationKeys: string[];
  identifierType: CitationTruthAttestation['identifierType'];
  identifier: string;
  locator: string;
  venue?: string;
  issn?: string;
  now?: number;
  maxPassportAgeMs?: number;
}

/**
 * Resolve a main-side citation attestation from the existing Passport,
 * triangulation snapshot, Retraction Watch mirror, journal-integrity mirrors,
 * and a concrete source locator. Missing mirrors fail closed as unknown.
 */
export async function resolveCitationTruthAttestation(
  request: CitationTruthResolutionRequest,
): Promise<CitationTruthAttestation> {
  const now = request.now ?? Date.now();
  const maxPassportAgeMs = request.maxPassportAgeMs ?? 30 * 24 * 60 * 60 * 1000;
  const isDoi = request.identifierType === 'doi';
  const passport = isDoi ? await getPassport(request.identifier) : undefined;
  const passportFresh = Boolean(
    passport
    && passport.overall === 'VERIFIED'
    && passport.lastTriangulatedAt <= now
    && now - passport.lastTriangulatedAt <= maxPassportAgeMs,
  );

  const retractionMirror = isDoi ? await loadRetractionMirror() : null;
  const retractionEntries = isDoi ? await lookupDoi(request.identifier) : undefined;
  let retraction: CitationTruthAttestation['retraction'] = 'unknown';
  if (retractionEntries?.some((entry) => entry.retractionNature.toLowerCase().includes('retract'))) {
    retraction = 'retracted';
  } else if (retractionEntries?.some((entry) => entry.retractionNature.toLowerCase().includes('concern'))) {
    retraction = 'expression_of_concern';
  } else if (retractionMirror && (!retractionEntries || retractionEntries.length === 0)) {
    retraction = 'clear';
  }

  const [doajMirror, hijackedMirror] = await Promise.all([
    loadJournalIndex('doaj_withdrawn'),
    loadJournalIndex('hijacked_journal'),
  ]);
  const integrityEntries = await lookupVenue(request.venue, request.issn);
  const journalIntegrity: CitationTruthAttestation['journalIntegrity'] = integrityEntries.length > 0
    ? 'blocked'
    : doajMirror && hijackedMirror
      ? 'trusted'
      : 'unknown';

  return CitationTruthAttestationSchema.parse({
    sourceId: request.sourceId,
    citationKeys: request.citationKeys,
    identifierType: request.identifierType,
    identifier: request.identifier,
    locator: request.locator,
    triangulation: passport?.overall ?? 'NOT_FOUND',
    passport: passportFresh ? 'verified' : passport ? 'stale' : 'missing',
    retraction,
    journalIntegrity,
    checkedAt: now,
  });
}
