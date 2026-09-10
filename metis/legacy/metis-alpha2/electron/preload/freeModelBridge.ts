/**
 * freeModelBridge.ts — Task 3 §5 preload domain split.
 * Mechanical extraction from electron/preload.ts; method bodies unchanged.
 */

import { ipcRenderer } from 'electron';

export const freeModelBridge = {
    // ---- 免费模型中心桥接（2026-08-23）----
    freeModelListSources: async () => ipcRenderer.invoke('freeModel:listSources') as Promise<Array<{ id: string; kind: string; name: string; baseUrl: string; enabled: boolean; hasKey: boolean }>>,

    freeModelAddSource: async (input: { name: string; baseUrl: string; apiKey?: string }) => ipcRenderer.invoke('freeModel:addSource', input) as Promise<{ ok: boolean; id?: string; code?: string }>,

    freeModelRemoveSource: async (id: string) => ipcRenderer.invoke('freeModel:removeSource', { id }) as Promise<boolean>,

    freeModelScan: async (probe: boolean) => ipcRenderer.invoke('freeModel:scan', { probe }) as Promise<{ count: number }>,

    freeModelListDiscoveries: async () => ipcRenderer.invoke('freeModel:listDiscoveries') as Promise<Array<Record<string, unknown>>>,

    freeModelListAttached: async () => ipcRenderer.invoke('freeModel:listAttached') as Promise<Array<Record<string, unknown>>>,

    freeModelAttach: async (discoveryKey: string) => ipcRenderer.invoke('freeModel:attach', { discoveryKey }) as Promise<{ ok: boolean; profileId?: string; code?: string }>,

    freeModelDetach: async (profileId: string) => ipcRenderer.invoke('freeModel:detach', { profileId }) as Promise<{ removedAttachment: boolean; deletedProfile: boolean }>,

    freeModelSetDisabled: async (profileId: string, disabled: boolean) => ipcRenderer.invoke('freeModel:setDisabled', { profileId, disabled }) as Promise<boolean>,

    freeModelDiscoverCommunity: async () => ipcRenderer.invoke('freeModel:discoverCommunity') as Promise<{ found: number; added: number; stations: Array<{ baseUrl: string; name: string; modelCount: number; latencyMs: number }> }>,

    mailboxAdd: async (input: { kind: string; label?: string; user: string; authorizationCode: string }) => ipcRenderer.invoke('mailbox:add', input) as Promise<{ ok: boolean; id?: string; code?: string }>,

    mailboxList: async () => ipcRenderer.invoke('mailbox:list') as Promise<Array<{ id: string; label: string; user: string; host: string; createdAt: number; lastCheckedAt: number | null; lastOkAt: number | null; healthy: boolean }>>,

    mailboxRemove: async (id: string) => ipcRenderer.invoke('mailbox:remove', { id }) as Promise<boolean>,

    mailboxTestFetch: async (id: string) => ipcRenderer.invoke('mailbox:testFetch', { id }) as Promise<{ ok: boolean; mails?: Array<{ from: string; subject: string; date: number; codes: string[]; links: string[] }>; error?: string }>,
    // ---- 自动注册与 OmniRoute 桥接（2026-08-24）----

    // ---- 自动注册与 OmniRoute 桥接（2026-08-24）----
    freeModelAutoRegisterBatch: async () => ipcRenderer.invoke('freeModel:autoRegisterBatch') as Promise<{ ok: boolean; progress?: { running: boolean; batchTotal: number; batchDone: number; stations: Array<Record<string, unknown>> }; code?: string }>,

    freeModelStationStates: async () => ipcRenderer.invoke('freeModel:stationStates') as Promise<Record<string, Record<string, unknown>>>,

    freeModelOmniRouteStatus: async () => ipcRenderer.invoke('freeModel:omniRouteStatus') as Promise<{ running: boolean; models: string[]; latencyMs: number | null; keyConfigured: boolean; error?: string }>,

    freeModelOmniRouteStart: async () => ipcRenderer.invoke('freeModel:omniRouteStart') as Promise<{ running: boolean; models: string[]; latencyMs: number | null; started: boolean; keyConfigured: boolean; error?: string }>,
};
