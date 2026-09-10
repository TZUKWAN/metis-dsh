/**
 * Frontend test setup: explicit DOM cleanup between tests.
 *
 * @testing-library/react's auto-cleanup relies on vitest injecting a global
 * afterEach (test.globals). Under the vitest workspace the global is not
 * injected reliably, so we register cleanup explicitly — without it, rendered
 * components accumulate across tests and queries match stale DOM.
 */
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});


/**
 * Node >=25 exposes an experimental Web Storage global whose localStorage
 * lacks clear/removeItem and shadows jsdom's full implementation. When that
 * is detected, replace the global with jsdom's own localStorage so browser
 * tests behave identically across Node versions.
 */
const jsdomStorage = (globalThis as { window?: Window }).window?.localStorage;
if (
  jsdomStorage
  && typeof jsdomStorage.clear === 'function'
  && globalThis.localStorage
  && typeof (globalThis.localStorage as Storage).clear !== 'function'
) {
  Object.defineProperty(globalThis, 'localStorage', { value: jsdomStorage, configurable: true });
}
