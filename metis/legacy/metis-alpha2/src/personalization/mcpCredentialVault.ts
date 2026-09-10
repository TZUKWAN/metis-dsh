/**
 * mcpCredentialVault — 加密凭据库的共享 hook 与 MCP 凭据声明工具函数。
 *
 * 刘总反馈（2026-10）：MCP 凭据改为按条目录入；凭据库元数据（仅名称与时间，不含值）
 * 由该 hook 统一加载一份，供全局面板、条目上的「凭据未配置」标记与条目内录入区共用，
 * 避免重复 IPC。加密存储机制本身不变（write-only，界面只持有 ${secret:NAME} 引用）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { McpDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';

type SecretMetadata = { name: string; createdAt: number; updatedAt: number };

export type SecretMutationResult = { ok: true } | { ok: false; code: string; transport: boolean };

export interface PersonalizationSecretVaultHandle {
  /** 凭据库 API 是否可用（window.metis 缺失时为 false）。 */
  readonly available: boolean;
  readonly busy: boolean;
  /** '' | 'unavailable' | 'ipc' | 凭据库返回的失败 code。 */
  readonly loadError: string;
  readonly secrets: readonly SecretMetadata[];
  readonly secretNames: ReadonlySet<string>;
  refresh(): Promise<void>;
  save(name: string, value: string): Promise<SecretMutationResult>;
  remove(name: string): Promise<SecretMutationResult>;
}

/** 共享一份凭据库元数据；active 为 true 时（MCP 标签页打开）才加载。 */
export function usePersonalizationSecrets(active: boolean): PersonalizationSecretVaultHandle {
  const [revision, setRevision] = useState(0);
  const [secrets, setSecrets] = useState<readonly SecretMetadata[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [available, setAvailable] = useState(true);

  const refresh = useCallback(async () => {
    const list = window.metis?.listPersonalizationSecrets;
    if (!list) {
      setAvailable(false);
      setLoadError('unavailable');
      return;
    }
    try {
      const response = await list({ contractVersion: 1, operationId: crypto.randomUUID() });
      if (!response.ok) {
        setLoadError(response.code);
        return;
      }
      setRevision(response.revision);
      setSecrets(response.secrets);
      setLoadError('');
    } catch {
      setLoadError('ipc');
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void refresh(); });
    return () => { cancelled = true; };
  }, [active, refresh]);

  const mutate = useCallback(async (
    action: 'set' | 'remove',
    name: string,
    value?: string,
  ): Promise<SecretMutationResult> => {
    const api = action === 'set' ? window.metis?.setPersonalizationSecret : window.metis?.removePersonalizationSecret;
    if (!api) return { ok: false, code: 'unavailable', transport: true };
    setBusy(true);
    try {
      const request = {
        contractVersion: 1 as const,
        operationId: crypto.randomUUID(),
        expectedRevision: revision,
        name,
        ...(action === 'set' ? { value: value ?? '' } : {}),
      };
      const response = await api(request as never);
      if (!response.ok) {
        if (response.code === 'revision_conflict') await refresh();
        return { ok: false, code: response.code, transport: false };
      }
      setRevision(response.revision);
      await refresh();
      return { ok: true };
    } catch {
      return { ok: false, code: 'ipc', transport: true };
    } finally {
      setBusy(false);
    }
  }, [revision, refresh]);

  const save = useCallback((name: string, value: string) => mutate('set', name, value), [mutate]);
  const remove = useCallback((name: string) => mutate('remove', name), [mutate]);

  return {
    available,
    busy,
    loadError,
    secrets,
    secretNames: new Set(secrets.map((secret) => secret.name)),
    refresh,
    save,
    remove,
  };
}

/** MCP 声明的凭据字段：environment 中 secret: true 的键（值恒为 null，运行时由主进程从凭据库解析）。 */
export function declaredMcpSecrets(definition: McpDefinition): string[] {
  return Object.entries(definition.environment)
    .filter(([, entry]) => entry.secret)
    .map(([name]) => name)
    .sort();
}

/** 已启用但凭据库中缺失的声明字段；未启用的 MCP 运行时不加载，不标记。 */
export function missingMcpSecrets(definition: McpDefinition, secretNames: ReadonlySet<string>): string[] {
  if (!definition.enabled) return [];
  return declaredMcpSecrets(definition).filter((name) => !secretNames.has(name));
}
