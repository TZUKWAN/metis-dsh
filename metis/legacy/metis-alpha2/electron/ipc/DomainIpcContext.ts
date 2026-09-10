/**
 * Dependency-injection surface handed to every domain IPC registrar
 * (Task 3 §4). Registrars must receive everything that used to be module
 * state in `main.ts` through this context, so they stay import-cycle free
 * from `main.ts` and unit-testable without Electron.
 *
 * The interface grows per migrated domain; keep entries grouped by domain.
 */

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { AgentLoop } from '../../engine/core/AgentLoop.js';
import type { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import type { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import type { OpenAICompatProvider } from '../../engine/providers/OpenAICompatProvider.js';
import type { FreeModelService } from '../FreeModelService.js';
import type { TopicService } from '../TopicService.js';
import type { RuntimeShutdownCoordinator } from '../RuntimeShutdownCoordinator.js';
import type { BrowserService } from '../BrowserService.js';
import type { CollabService } from '../CollabService.js';
import type { WeChatBotService } from '../WeChatBotService.js';
import type { ProviderProfileStore } from '../ProviderProfileStore.js';
import type { ExperimentScriptAdapter } from '../ExperimentScriptAdapter.js';
import type { FileCapabilityRegistry } from '../FileCapabilityRegistry.js';
import type { IpcRegistry } from './IpcRegistry.js';

export interface DomainIpcContext {
  /** Process-wide registration ledger (duplicate gate + disposers). */
  registry: IpcRegistry;
  /** Throws unless the invoking sender is the authorized main frame. */
  requireRendererMainFrame(event: IpcMainInvokeEvent): BrowserWindow;
  /** Cooperative shutdown coordinator (admission for long operations). */
  runtimeShutdown: RuntimeShutdownCoordinator;

  // ── AI runtime ────────────────────────────────────────────
  /** Live agent loop, or null before the provider runtime is ready. */
  agentLoop(): AgentLoop | null;
  provider(): OpenAICompatProvider | null;

  // ── Persistence ───────────────────────────────────────────
  store(): PersistenceStore | null;
  researchRepository(): ResearchRepository | null;
  providerProfileStore(): ProviderProfileStore | null;

  // ── Topic domain ──────────────────────────────────────────
  ensureTopicService(): TopicService;

  // ── Free-model domain ─────────────────────────────────────
  freeModelService(): FreeModelService | null;

  // ── Experiment domain ─────────────────────────────────────
  experimentScriptAdapter(): ExperimentScriptAdapter | null;

  // ── Artifact / capability domain ──────────────────────────
  /** Process-wide registry; created at module load, never reassigned. */
  fileCapabilities(): FileCapabilityRegistry;

  // ── Host environment ──────────────────────────────────────
  /** Resolved data directory (lazy: it binds after module init). */
  dataDir(): string;
  /** Electron userData directory (storage-location pointer files). */
  userDataDir(): string;
  /** Default data directory (before user relocation). */
  defaultDataDir(): string;

  // ── Backup domain ─────────────────────────────────────────
  backupService(): import('../BackupService.js').BackupService | null;

  // ── WeChat bot domain ─────────────────────────────────────
  ensureWeChatBot(): WeChatBotService | null;

  // ── Collab domain ─────────────────────────────────────────
  browserService(): BrowserService | null;
  collabService(): CollabService | null;
  ensureCollabService(): CollabService | null;
}
