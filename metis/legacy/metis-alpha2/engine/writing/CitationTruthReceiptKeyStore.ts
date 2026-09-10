/**
 * CitationTruthReceiptKeyStore — domain alias for the shared durable key store.
 *
 * Re-exports DurableReceiptKeyStore so that CitationTruth callers have a
 * domain-named import.  The underlying durability contract is provided by
 * {@link DurableReceiptKeyStore} in DurableReceiptKeyStore.ts.
 */
export {
  DurableReceiptKeyStore as CitationTruthReceiptKeyStore,
  type ReceiptKeyStorageCipher,
  type DurableReceiptKeyStoreDeps as CitationTruthKeyStoreDeps,
  type KeyStoreResult,
} from './DurableReceiptKeyStore.js';
