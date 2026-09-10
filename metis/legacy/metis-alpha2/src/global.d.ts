/**
 * Renderer-side type declaration for the context-bridged metis API.
 *
 * The single authoritative type source is the preload script's export:
 *   `export type MetisAPI = typeof api;` in electron/preload.ts
 *
 * This declaration file re-exports it so that renderer code can reference
 * `window.metis` without importing Electron internals into the DOM bundle.
 */

type MetisAPI = import('../electron/preload.js').MetisAPI;

interface Window {
  metis?: MetisAPI;
}
