/**
 * McpBuilderDialog — 对话式构建 MCP（刘总 2026-09：MCP 构建与技能创造一样走对话窗口）。
 * 用自然语言描述工具需求 → Metis Builder 构建、验证并注册 MCP；
 * 选中已安装 MCP 进入时以其定义为目标做定制化优化（名称与现状预填为上下文）。
 */
import { useState } from 'react';
import { Wrench, X } from 'lucide-react';
import type { PersonalizationDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { localId } from './personalizationLib.js';

export function McpBuilderDialog({ zh, contextMcp, onClose, onInstalled }: {
  zh: boolean;
  /** 选中已安装 MCP 进入对话时传入：以其为构建目标做定制化优化。 */
  contextMcp?: PersonalizationDefinition | null;
  onClose: () => void;
  onInstalled: (definitionId: string) => void | Promise<void>;
}) {
  const [name, setName] = useState(contextMcp?.name ?? (zh ? '我的 MCP' : 'My MCP'));
  const [requirement, setRequirement] = useState(() => {
    if (!contextMcp) return '';
    return zh
      ? `基于现有 MCP「${contextMcp.name}」做定制化优化。现状：${contextMcp.description || '（无说明）'}。优化要求：`
      : `Improve the existing MCP "${contextMcp.name}". Current state: ${contextMcp.description || '(no description)'}. Requirements: `;
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const packageId = localId(name, 'my-mcp');
  const definitionId = contextMcp?.id ?? `generated:mcp/${packageId}`;
  const expectedRevision = contextMcp?.revision ?? 0;

  const build = async () => {
    const apply = window.metis?.applyPersonalizationExtension;
    if (!apply) {
      setStatus(zh ? '扩展安装服务不可用' : 'Extension installation service is unavailable');
      return;
    }
    if (!name.trim()) {
      setStatus(zh ? '请先为 MCP 填写一个名称。' : 'Give the MCP a name first.');
      return;
    }
    if (!requirement.trim()) {
      setStatus(zh ? '请先说明你需要 MCP 完成的任务。' : 'Describe what the MCP should do first.');
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const result = await apply({
        contractVersion: 1,
        operationId: crypto.randomUUID(),
        mode: 'mcp_requirements',
        definitionId,
        requirement: requirement.trim(),
        requestedPackageId: packageId,
        runProbe: true,
        expectedRevision,
      });
      if (!result.ok) {
        setStatus(`${zh ? '构建失败' : 'Build failed'}: ${result.code}${result.detailCode ? ` / ${result.detailCode}` : ''}`);
        return;
      }
      setStatus(zh ? '已构建并写入不可伪造的来源记录' : 'Built with a signed, non-authoritative source record');
      await onInstalled(result.definition.id);
      onClose();
    } catch {
      setStatus(zh
        ? '构建未完成：无法连接主进程安装服务，可修改后重试。'
        : 'Build did not complete: the main-process installer could not be reached. You can revise the input and retry.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scai-overlay" role="dialog" aria-modal="true" aria-label={zh ? '构建 MCP' : 'Build MCP'} data-testid="personalization-mcp-builder">
      <div className="scai-dialog">
        <header className="scai-dialog__head">
          <h2>{contextMcp
            ? (zh ? `构建 MCP：优化「${contextMcp.name}」` : `Build MCP: improve "${contextMcp.name}"`)
            : (zh ? '构建 MCP：描述需求，由 Metis 构建' : 'Build MCP: describe the need, Metis builds it')}</h2>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} aria-label={zh ? '关闭' : 'Close'} data-testid="personalization-mcp-builder-close"><X size={14} aria-hidden="true" /></button>
        </header>
        <div className="scai-dialog__body">
          <p className="personalization-installer__mode-help">{zh
            ? '用自然语言说明工具需求，Metis Builder 会构建、验证并注册 MCP；启动程序与参数由已验证安装记录决定，不能手工伪造。'
            : 'Describe the tool in natural language. Metis Builder constructs, validates, and registers the MCP; the executable and arguments come from the verified installation record.'}</p>
          <label><span>{zh ? 'MCP 名称' : 'MCP name'}</span><input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} data-testid="personalization-mcp-builder-name" /></label>
          <label><span>{zh ? '说明你需要 MCP 做什么' : 'Describe what the MCP must do'}</span><textarea rows={6} value={requirement} onChange={(event) => setRequirement(event.target.value)} data-testid="personalization-mcp-builder-requirement" /></label>
          <p className="personalization-derived-id">{zh ? '构建目标' : 'Build target'}: <strong>{contextMcp ? contextMcp.name : (name.trim() || (zh ? '未命名 MCP' : 'Unnamed MCP'))}</strong></p>
          <div className="personalization-actions">
            <button className="btn-primary" type="button" disabled={busy} onClick={() => void build()} data-testid="personalization-mcp-builder-submit">
              <Wrench size={13} aria-hidden="true" /> {busy ? (zh ? '构建中…' : 'Building…') : (zh ? '验证并构建' : 'Verify and build')}
            </button>
            <span role="status" aria-live="polite" data-testid="personalization-mcp-builder-status">{status}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default McpBuilderDialog;
