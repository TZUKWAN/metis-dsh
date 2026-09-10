/**
 * Experiment domain IPC registrar — Task 3 §4.
 * Migrated verbatim from `electron/main.ts` setupIPC(); channels, decode
 * contracts and recovery shapes unchanged (GLM-102 safe-DTO discipline kept).
 */

import fs from 'node:fs';
import {
  decodeExperimentDelete,
  decodeExperimentList,
  decodeExperimentListResult,
  decodeExperimentMutationResult,
  decodeExperimentSave,
} from '../../engine/runtime/ExperimentMetadataContract.js';
import {
  decodeExperimentRunRequest,
  decodeExperimentRunResult,
} from '../../engine/runtime/ExperimentRuntimeContract.js';
import type { DomainIpcContext } from './DomainIpcContext.js';
import { executionOwnerFor } from './sharedGuards.js';

export function registerExperimentIpc(ctx: DomainIpcContext): () => void {
  const { requireRendererMainFrame, store } = ctx;
  const experimentScriptAdapter = () => ctx.experimentScriptAdapter();
  const dom = ctx.registry.domain('experiment', ['experiment:']);

  // ── Experiments metadata CRUD (GLM-102: safe DTO, no path leak) ──
  dom.handle('experiment:list', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!store()) return decodeExperimentListResult(undefined);
      return decodeExperimentListResult({
        success: true,
        experiments: decodeExperimentList(store()!.getExperimentMetadata()),
      });
    } catch {
      return decodeExperimentListResult(undefined);
    }
  });
  dom.handle('experiment:save', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const req = decodeExperimentSave(raw);
      if (!req) return decodeExperimentMutationResult({
        success: false,
        code: 'experiment_metadata_invalid',
      });
      if (!store()) return decodeExperimentMutationResult(undefined);
      store()!.saveExperimentMetadata(req);
      return decodeExperimentMutationResult({ success: true, code: 'saved' });
    } catch {
      return decodeExperimentMutationResult(undefined);
    }
  });
  dom.handle('experiment:delete', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const id = decodeExperimentDelete(raw);
      if (!id) return decodeExperimentMutationResult({
        success: false,
        code: 'experiment_metadata_invalid',
      });
      if (!store()) return decodeExperimentMutationResult(undefined);
      store()!.deleteExperimentMetadata(id);
      return decodeExperimentMutationResult({ success: true, code: 'deleted' });
    } catch {
      return decodeExperimentMutationResult(undefined);
    }
  });

  // ── Experiments secure execution (GLM-102: service-backed IPC) ──
  dom.handle('experiment:attachScript', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      if (!experimentScriptAdapter()) return { status: 'rejected', code: 'experiment_script_unavailable' };
      return experimentScriptAdapter()!.ipc.attachScript(owner, rawRequest);
    } catch {
      return { status: 'rejected', code: 'experiment_script_unavailable' };
    }
  });

  dom.handle('experiment:requestRunGrant', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      if (!experimentScriptAdapter()) return { status: 'rejected', code: 'experiment_grant_unavailable' };
      return experimentScriptAdapter()!.ipc.requestRunGrant(owner, rawRequest);
    } catch {
      return { status: 'rejected', code: 'experiment_grant_unavailable' };
    }
  });

  dom.handle('experiment:run', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      if (!experimentScriptAdapter()) return { status: 'rejected', exitCode: null, metrics: {} };
      const request = decodeExperimentRunRequest(rawRequest);
      if (!request) return { status: 'rejected', exitCode: null, metrics: {} };
      const result = decodeExperimentRunResult(
        await experimentScriptAdapter()!.ipc.run(owner, request),
      );
      if (store() && !['rejected', 'runtime_unavailable'].includes(result.status)) {
        const status = result.status === 'completed'
          ? 'completed'
          : result.status === 'cancelled'
            ? 'cancelled'
            : 'failed';
        store()!.updateExperimentRunState(request.experimentId, status, result.metrics);
      }
      return result;
    } catch {
      return { status: 'rejected', exitCode: null, metrics: {} };
    }
  });

  dom.handle('experiment:cancel', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      if (!experimentScriptAdapter()) return false;
      return experimentScriptAdapter()!.ipc.cancel(owner, rawRequest);
    } catch {
      return false;
    }
  });

  // ── Experiment run history + output ──────────────────────
  dom.handle('experiment:listRuns', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { experimentId?: string; limit?: number };
      if (!experimentScriptAdapter()) return { runs: [] };
      const runs = experimentScriptAdapter()!.repository.getRunsForExperiment(
        String(request?.experimentId ?? ''),
        typeof request?.limit === 'number' ? request.limit : 50,
      );
      return {
        runs: runs.map((r) => ({
          runId: r.runId, experimentId: r.experimentId, status: r.status,
          exitCode: r.exitCode, metrics: r.metrics, startedAt: r.startedAt,
          finishedAt: r.finishedAt, hasOutput: Boolean(r.stdoutLogPath),
        })),
      };
    } catch {
      return { runs: [] };
    }
  });

  dom.handle('experiment:getRunOutput', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { experimentId?: string; runId?: string };
      if (!experimentScriptAdapter()) return { output: '', truncated: false };
      const runs = experimentScriptAdapter()!.repository.getRunsForExperiment(String(request?.experimentId ?? ''), 200);
      const run = runs.find((r) => r.runId === request?.runId);
      if (!run?.stdoutLogPath) return { output: '', truncated: false };
      const MAX_BYTES = 16 * 1024;
      const stat = fs.statSync(run.stdoutLogPath);
      const startOffset = Math.max(0, stat.size - MAX_BYTES);
      const fd = fs.openSync(run.stdoutLogPath, 'r');
      const buf = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
      fs.readSync(fd, buf, 0, buf.length, startOffset);
      fs.closeSync(fd);
      let text = buf.toString('utf8');
      text = text.replace(/[A-Z]:\\[^\s\n]+/gi, '[path]').replace(/\/home\/[^\s\n]+/g, '[path]');
      return { output: text, truncated: stat.size > MAX_BYTES };
    } catch {
      return { output: '', truncated: false };
    }
  });

  return () => dom.dispose();
}
