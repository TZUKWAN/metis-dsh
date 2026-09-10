/**
 * topicBridge.ts — Task 3 §5 preload domain split.
 * Mechanical extraction from electron/preload.ts; method bodies unchanged.
 */

import { ipcRenderer } from 'electron';

export const topicBridge = {
    // ---- 选题 Topic(2026-09-04 刘总要求:选题一级功能)----
    topicCreateSession: async (rawRequest: { title?: string; initialIntent?: string; sourceProjectId?: string | null; discipline?: string; constraints?: Record<string, unknown>; category?: string | null }) => (
      ipcRenderer.invoke('topic:sessions:create', rawRequest) as Promise<{ ok: boolean; code?: string; session?: unknown }>
    ),

    topicListSessions: async () => (
      ipcRenderer.invoke('topic:sessions:list') as Promise<Array<Record<string, unknown>>>
    ),

    topicGetSession: async (sessionId: string) => (
      ipcRenderer.invoke('topic:sessions:get', { sessionId }) as Promise<{ session: Record<string, unknown>; candidates: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> } | null>
    ),

    topicUpdateSession: async (rawRequest: { sessionId: string; patch: Record<string, unknown> }) => (
      ipcRenderer.invoke('topic:sessions:update', rawRequest) as Promise<Record<string, unknown> | null>
    ),

    topicDeleteSession: async (sessionId: string) => (
      ipcRenderer.invoke('topic:sessions:delete', { sessionId }) as Promise<boolean>
    ),

    topicUpdateCandidate: async (rawRequest: { sessionId: string; candidateId: string; patch: Record<string, unknown> }) => (
      ipcRenderer.invoke('topic:candidates:update', rawRequest) as Promise<Record<string, unknown> | null>
    ),

    topicSelectCandidate: async (rawRequest: { sessionId: string; candidateId: string }) => (
      ipcRenderer.invoke('topic:select', rawRequest) as Promise<{ ok: boolean; code?: string; session?: unknown; candidate?: unknown; brief?: unknown }>
    ),

    topicMarkConverted: async (rawRequest: { candidateId: string; projectId?: string; scenarioId?: string }) => (
      ipcRenderer.invoke('topic:markConverted', rawRequest) as Promise<Record<string, unknown> | null>
    ),

    topicGetBrief: async (sessionId: string) => (
      ipcRenderer.invoke('topic:brief', { sessionId }) as Promise<Record<string, unknown> | null>
    ),
};
