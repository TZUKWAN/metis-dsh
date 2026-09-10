/** Main-process adapter for owner-bound experiment script execution. */
import { app, dialog, BrowserWindow, webContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { ExperimentScriptService } from './ExperimentScriptService.js';
import {
  ExperimentAttachmentRepository,
  reconcileExperimentManagedRoot,
} from '../engine/persistence/ExperimentAttachmentRepository.js';
import type { ExecutionOwnerIdentity } from './ExecutionCapabilityRegistry.js';
import type {
  AttachmentAccessBinding,
  ExperimentExecutionGrantResult,
  ExperimentRunResult,
  ExperimentScriptAttachResult,
} from '../engine/runtime/ExperimentRuntimeContract.js';

export interface ExperimentScriptAdapter {
  service: ExperimentScriptService;
  repository: ExperimentAttachmentRepository;
  ipc: {
    attachScript(owner: ExecutionOwnerIdentity, input: unknown): Promise<ExperimentScriptAttachResult>;
    requestRunGrant(owner: ExecutionOwnerIdentity, input: unknown): Promise<ExperimentExecutionGrantResult>;
    run(owner: ExecutionOwnerIdentity, input: unknown): Promise<ExperimentRunResult>;
    cancel(owner: ExecutionOwnerIdentity, input: unknown): boolean;
  };
  resolveBinding(owner: ExecutionOwnerIdentity): AttachmentAccessBinding;
  dispose(): void;
}

export interface ExperimentScriptAdapterOptions {
  db: Database.Database;
  /** Read-only packaged resource root. Python is available only below this root. */
  resourcesPath: string;
  /** Non-empty 32+ byte process secret; never persisted. */
  processSecret: string;
}

function resolveOwnerWindow(owner: ExecutionOwnerIdentity): BrowserWindow | null {
  const contents = webContents.fromId(owner.webContentsId);
  if (!contents) return null;
  const window = BrowserWindow.fromWebContents(contents);
  if (!window || window.isDestroyed()) return null;
  if (
    contents.mainFrame.processId !== owner.mainFrameProcessId
    || contents.mainFrame.routingId !== owner.mainFrameRoutingId
  ) return null;
  return window;
}

export function createExperimentScriptAdapter(
  options: ExperimentScriptAdapterOptions,
): ExperimentScriptAdapter {
  if (options.processSecret.length < 32) {
    throw new TypeError('ExperimentScriptAdapter requires a non-empty 32+ byte process secret');
  }
  if (!path.isAbsolute(options.resourcesPath)) {
    throw new TypeError('ExperimentScriptAdapter requires an absolute resources path');
  }

  const userData = app.getPath('userData');
  const managedRoot = path.resolve(userData, 'experiment-scripts', 'managed');
  const logRoot = path.resolve(userData, 'experiment-scripts', 'logs');
  fs.mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(logRoot, { recursive: true, mode: 0o700 });

  const repository = new ExperimentAttachmentRepository(options.db);
  repository.initialize(options.processSecret);
  reconcileExperimentManagedRoot(managedRoot, repository.listReferencedManagedPaths());

  async function selectScript(
    _experimentId: string,
    owner: ExecutionOwnerIdentity,
  ): Promise<string | null> {
    const window = resolveOwnerWindow(owner);
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      title: 'Select experiment script',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [
        { name: 'Python', extensions: ['py'] },
        { name: 'Node.js', extensions: ['js', 'mjs', 'cjs'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  }

  const resolveBinding = (owner: ExecutionOwnerIdentity): AttachmentAccessBinding => (
    repository.createAccessBinding(owner)
  );
  const service = new ExperimentScriptService({
    managedRoot,
    logRoot,
    runtimeRoot: path.resolve(options.resourcesPath, 'experiment-runtime'),
    trustedNodeExecutable: process.execPath,
    selectScriptPath: selectScript,
    persistence: repository,
    resolveBinding,
  });

  return {
    service,
    repository,
    resolveBinding,
    ipc: {
      attachScript(owner, input) {
        return service.attach(input, owner);
      },
      requestRunGrant(owner, input) {
        return service.requestRunGrant(input, owner);
      },
      run(owner, input) {
        return service.run(input, owner);
      },
      cancel(owner, input) {
        return service.cancel(input, owner);
      },
    },
    dispose() {
      service.dispose();
    },
  };
}
