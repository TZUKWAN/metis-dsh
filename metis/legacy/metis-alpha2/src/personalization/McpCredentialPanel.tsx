/**
 * McpCredentialPanel — 单个 MCP 条目的凭据录入区。
 *
 * 刘总反馈（2026-10）：MCP 页原来只有一个全局「MCP 凭据」入口，装多个 MCP 时
 * 不知道凭据是给谁用的；改为每个 MCP 条目上单独录入：
 * - 定义里 environment 声明了 secret 项的，按声明逐字段渲染（名称即凭据库键名，
 *   与清单里 ${secret:NAME} 约定一致）；
 * - 未声明的给一个自由键值对输入。
 * 保存仍走同一套主进程加密凭据库（write-only，值不回显），加密存储机制本身不变。
 * 凭据库状态由 mcpCredentialVault 的 usePersonalizationSecrets 统一加载后传入。
 */
import { useState } from 'react';
import type { McpDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { useTranslation } from '../i18n';
import {
  declaredMcpSecrets,
  type PersonalizationSecretVaultHandle,
  type SecretMutationResult,
} from './mcpCredentialVault.js';
import './McpCredentialPanel.css';

export default function McpCredentialPanel({
  definition,
  vault,
  testId,
}: {
  definition: McpDefinition;
  vault: PersonalizationSecretVaultHandle;
  testId: string;
}) {
  const { locale } = useTranslation();
  const zh = locale === 'zh';
  const declared = declaredMcpSecrets(definition);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [freeName, setFreeName] = useState('');
  const [freeValue, setFreeValue] = useState('');
  const [status, setStatus] = useState('');

  const mutationStatus = (result: SecretMutationResult, name: string): boolean => {
    if (result.ok) return true;
    setStatus(result.transport
      ? (zh ? '保存未完成，凭据值仍保留在输入框中，可直接重试。' : 'Save did not complete. The credential value remains in the field so you can retry.')
      : `${zh ? '操作失败' : 'Operation failed'}: ${result.code} (${name})`);
    return false;
  };

  const saveField = async (name: string) => {
    const value = drafts[name] ?? '';
    if (!value) return;
    if (mutationStatus(await vault.save(name, value), name)) {
      setDrafts((current) => ({ ...current, [name]: '' }));
      setStatus(zh ? `凭据 ${name} 已加密保存；值不会回显` : `Credential ${name} saved encrypted; values are never displayed`);
    }
  };

  const removeField = async (name: string) => {
    if (mutationStatus(await vault.remove(name), name)) {
      setStatus(zh ? `凭据 ${name} 已删除` : `Credential ${name} removed`);
    }
  };

  const saveFree = async () => {
    const name = freeName.trim();
    if (!name || !freeValue) return;
    if (mutationStatus(await vault.save(name, freeValue), name)) {
      setFreeName('');
      setFreeValue('');
      setStatus(zh ? `凭据 ${name} 已加密保存；值不会回显` : `Credential ${name} saved encrypted; values are never displayed`);
    }
  };

  return (
    <div className="mcp-credential-panel" data-testid={testId}>
      {!vault.available && <p className="mcp-credential-panel__status" role="status">{zh ? '加密凭据库不可用' : 'Encrypted credential vault is unavailable'}</p>}
      {declared.map((name) => {
        const configured = vault.secretNames.has(name);
        return (
          <div className="mcp-credential-panel__row" key={name}>
            <div className="mcp-credential-panel__row-head">
              <strong>{name}</strong>
              <span className={configured ? 'mcp-credential-panel__state mcp-credential-panel__state--ok' : 'mcp-credential-panel__state mcp-credential-panel__state--missing'}>
                {configured ? (zh ? '已配置' : 'Configured') : (zh ? '未配置' : 'Not configured')}
              </span>
            </div>
            <div className="mcp-credential-panel__row-inputs">
              <input
                type="password"
                value={drafts[name] ?? ''}
                onChange={(event) => setDrafts((current) => ({ ...current, [name]: event.target.value }))}
                placeholder={zh ? '输入凭据值（加密保存，不回显）' : 'Credential value (saved encrypted, never echoed)'}
                autoComplete="new-password"
                data-testid={`${testId}-input-${name}`}
              />
              <button type="button" disabled={vault.busy || !(drafts[name] ?? '')} onClick={() => void saveField(name)} data-testid={`${testId}-save-${name}`}>
                {zh ? '加密保存' : 'Save encrypted'}
              </button>
              {configured && (
                <button type="button" disabled={vault.busy} onClick={() => void removeField(name)} data-testid={`${testId}-remove-${name}`}>
                  {zh ? '删除' : 'Remove'}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {declared.length === 0 && (
        <div className="mcp-credential-panel__row">
          <p className="mcp-credential-panel__hint">{zh ? '该 MCP 未声明凭据需求；如运行时需要，可自由添加键值对。' : 'This MCP declares no credential requirements; add free-form key/value pairs if needed.'}</p>
          <div className="mcp-credential-panel__row-inputs">
            <input
              value={freeName}
              onChange={(event) => setFreeName(event.target.value.toUpperCase())}
              placeholder="ZOTERO_API_KEY"
              autoComplete="off"
              spellCheck={false}
              data-testid={`${testId}-free-name`}
            />
            <input
              type="password"
              value={freeValue}
              onChange={(event) => setFreeValue(event.target.value)}
              autoComplete="new-password"
              data-testid={`${testId}-free-value`}
            />
            <button type="button" disabled={vault.busy || !freeName.trim() || !freeValue} onClick={() => void saveFree()} data-testid={`${testId}-free-save`}>
              {zh ? '加密保存' : 'Save encrypted'}
            </button>
          </div>
        </div>
      )}
      {status && <p className="mcp-credential-panel__status" role="status" aria-live="polite">{status}</p>}
    </div>
  );
}
