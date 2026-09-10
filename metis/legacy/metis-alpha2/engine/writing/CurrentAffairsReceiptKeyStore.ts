/**
 * CurrentAffairsReceiptKeyStore — domain alias for the shared durable key store.
 *
 * Re-exports DurableReceiptKeyStore so that CurrentAffairs callers have a
 * domain-named import.  The underlying durability contract is provided by
 * {@link DurableReceiptKeyStore} in DurableReceiptKeyStore.ts.
 */
export {
  DurableReceiptKeyStore as CurrentAffairsReceiptKeyStore,
  type ReceiptKeyStorageCipher,
  type DurableReceiptKeyStoreDeps as ReceiptKeyStoreDeps,
  type KeyStoreResult,
} from './DurableReceiptKeyStore.js';
