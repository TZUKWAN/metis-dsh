/**
 * systemBridge.ts — Task 3 §5 preload domain split.
 * Mechanical extraction from electron/preload.ts; method bodies unchanged.
 */

import { ipcRenderer } from 'electron';
import { decodeExperimentListResult } from '../../engine/runtime/ExperimentMetadataContract.js';
import { decodeProjectMemoryContent } from '../../engine/runtime/MemoryRuntimeContract.js';

export const systemBridge = {
    storageChooseLocation: async () => ipcRenderer.invoke('storage:chooseLocation') as Promise<{ canceled: boolean; path?: string }>,

    storageOpenFolder: async () => ipcRenderer.invoke('storage:openFolder') as Promise<{ ok: boolean; error?: string }>,
    // ── Research browser (embedded WebContentsView) ──

    clipboardReadText: async () =>
      ipcRenderer.invoke('clipboard:readText') as Promise<{ ok: boolean; text?: string; error?: string }>,

    clipboardWriteText: async (text: string) =>
      ipcRenderer.invoke('clipboard:writeText', text) as Promise<{ ok: boolean; error?: string }>,

    listBackups: async () => ipcRenderer.invoke('backup:list') as Promise<{ backups: Array<{ path: string; name: string }> }>,

    restoreBackup: async (backupPath: string) => ipcRenderer.invoke('backup:restore', { backupPath }) as Promise<{ ok: boolean; error?: string }>,

    flashcardList: async () => ipcRenderer.invoke('flashcard:list') as Promise<{ cards: Array<Record<string, unknown>> }>,

    flashcardSave: async (card: Record<string, unknown>) => ipcRenderer.invoke('flashcard:save', card) as Promise<{ ok: boolean }>,

    flashcardDelete: async (id: string) => ipcRenderer.invoke('flashcard:delete', id) as Promise<{ ok: boolean }>,

    // ── WeChat Bot (METIS-WX-1) ──
    wechatGetStatus: async () => ipcRenderer.invoke('wechat:getStatus') as Promise<{ ok: boolean; status?: unknown; error?: string }>,

    wechatBeginLogin: async () => ipcRenderer.invoke('wechat:beginLogin') as Promise<{ ok: boolean; qrContent?: string; error?: string }>,

    wechatPollLogin: async () => ipcRenderer.invoke('wechat:pollLogin') as Promise<{ phase: string; ok: boolean; error?: string }>,

    wechatSubmitVerifyCode: async (code: string) => ipcRenderer.invoke('wechat:submitVerifyCode', { code }) as Promise<{ ok: boolean; error?: string }>,

    wechatLogout: async () => ipcRenderer.invoke('wechat:logout') as Promise<{ ok: boolean; error?: string }>,

    wechatSendTest: async (text: string) => ipcRenderer.invoke('wechat:sendTest', { text }) as Promise<{ ok: boolean; error?: string }>,

    wechatSetProject: async (projectId: string) => ipcRenderer.invoke('wechat:setProject', { projectId }) as Promise<{ ok: boolean; error?: string }>,

    // ── Experiments metadata CRUD (GLM-102: safe DTO) ────────
    listExperiments: async () => decodeExperimentListResult(
      await ipcRenderer.invoke('experiment:list'),
    ),

    listExperimentRuns: async (experimentId: string, limit?: number) =>
      ipcRenderer.invoke('experiment:listRuns', { experimentId, limit }) as Promise<{ runs: unknown[] }>,

    getExperimentRunOutput: async (experimentId: string, runId: string) =>
      ipcRenderer.invoke('experiment:getRunOutput', { experimentId, runId }) as Promise<{ output: string; truncated: boolean }>,

    // ── Bulk Load ──────────────────────────────────────────

    // ── Memory ─────────────────────────────────────────────
    getProjectMemory: async () => decodeProjectMemoryContent(await ipcRenderer.invoke('memory:getProject')),

    // O12: white-box automatic memories (key_decision / preference / fact).
    listMemoryByCategory: async (category: string, projectId?: string) =>
      ipcRenderer.invoke('memory:listByCategory', { category, projectId }) as Promise<Array<{ key: string; value: string; category: string; updatedAt: number }>>,

    deleteMemoryByKey: async (key: string, projectId?: string) =>
      ipcRenderer.invoke('memory:deleteByKey', { key, projectId }) as Promise<{ ok: boolean; error?: string }>,

    // ── Project Metis.md (CAS-protected compatibility API) ──

    artifactListByProject: async (projectId: string) => ipcRenderer.invoke('artifact:listByProject', projectId) as Promise<{ items: Array<Record<string, unknown>> }>,

    artifactUpdateReviewStatus: async (request: { artifactId: string; toStatus: string; reason?: string }) => ipcRenderer.invoke('artifact:updateReviewStatus', request) as Promise<{ ok: boolean; error?: string }>,

    artifactListVersions: async (artifactId: string) => ipcRenderer.invoke('artifact:listVersions', artifactId) as Promise<{ versions: Array<{ version: number; createdAt: number; createdBy: string; contentPreview: string }> }>,

    artifactRestoreVersion: async (request: { artifactId: string; version: number }) => ipcRenderer.invoke('artifact:restoreVersion', request) as Promise<{ ok: boolean; version?: number; error?: string }>,
};
