/** Secure extension installer — 本地包导入 / URL 安装 / MCP 地址安装。
 * 从 PersonalizationCenter 抽出的共享组件：步骤级资源获取入口复用它；
 * 安装路径始终先验证再保存，成功后由调用方绑定到当前步骤。
 * 刘总 2026-09：「描述需求由 Metis 构建」改走 McpBuilderDialog 对话窗口，
 * 此安装器只保留本地包与 URL/配置安装。 */
import { useState } from 'react';
import type { PersonalizationDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { useTranslation } from '../i18n';
import { localId } from './personalizationLib.js';

export function ExtensionInstaller({
  kind,
  definitions,
  onInstalled,
  onRefresh,
  initialMode,
}: {
  kind: 'skill' | 'mcp';
  definitions: readonly PersonalizationDefinition[];
  onInstalled: (definitionId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  /** Optional preselected install mode for step-first acquisition entries. */
  initialMode?: 'skill_package' | 'skill_url' | 'mcp_package' | 'mcp_url';
}) {
  const { locale } = useTranslation();
  const zh = locale === 'zh';
  const [mode, setMode] = useState<'skill_package' | 'skill_url' | 'mcp_package' | 'mcp_url'>(
    initialMode ?? (kind === 'skill' ? 'skill_package' : 'mcp_package'),
  );
  const [url, setUrl] = useState('');
  const [mcpName, setMcpName] = useState(zh ? '我的 MCP' : 'My MCP');
  const [expectedVersion, setExpectedVersion] = useState('');
  const [expectedDigest, setExpectedDigest] = useState('');
  const [targetDefinitionId, setTargetDefinitionId] = useState('');
  const [sourceCapabilityId, setSourceCapabilityId] = useState<string | null>(null);
  const [sourceDisplayName, setSourceDisplayName] = useState('');
  const [sourceCapabilityKind, setSourceCapabilityKind] = useState<'file' | 'folder' | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const mcpLocalId = localId(mcpName, 'my-mcp');
  const derivedMcpDefinitionId = mode === 'mcp_url'
    ? `url:mcp/${mcpLocalId}`
    : `user:mcp/${mcpLocalId}`;
  const targetCandidates = definitions.filter((definition) => {
    if (definition.kind !== kind) return false;
    if (kind === 'skill') {
      return mode === 'skill_url'
        ? definition.id.startsWith('url:skills/')
        : definition.id.startsWith('user:skills/');
    }
    return mode === 'mcp_url' ? definition.id.startsWith('url:mcp/')
      : definition.id.startsWith('user:mcp/');
  });
  const automaticTarget = targetDefinitionId
    ? null
    : mode === 'skill_url'
      ? targetCandidates.find((definition) => definition.provenance.sourceUrl === url.trim()) ?? null
      : kind === 'mcp'
        ? targetCandidates.find((definition) => definition.id === derivedMcpDefinitionId) ?? null
        : null;
  const targetDefinition = targetCandidates.find((definition) => definition.id === targetDefinitionId)
    ?? automaticTarget;
  const expectedRevision = targetDefinition?.revision ?? 0;
  const definitionId = kind === 'mcp' && targetDefinition ? targetDefinition.id : derivedMcpDefinitionId;

  const changeMode = (nextMode: typeof mode) => {
    setMode(nextMode);
    setTargetDefinitionId('');
    setStatus('');
  };

  const selectPackage = async (kind: 'file' | 'folder') => {
    setSourceCapabilityId(null);
    setSourceDisplayName('');
    setSourceCapabilityKind(null);
    const purpose = kind === 'folder'
      ? (mode === 'mcp_package' ? 'personalization-mcp-directory' : 'personalization-skill-directory')
      : 'personalization-skill-package' as const;
    try {
      const selected = await window.metis?.selectFileCapability?.(purpose);
      const expectedOperation = kind === 'folder' ? 'folder' : 'file';
      if (!selected?.success
        || selected.capability.kind !== kind
        || !selected.capability.operations.includes(expectedOperation)) {
        setStatus(kind === 'folder'
          ? (mode === 'mcp_package'
              ? (zh ? '未选择有效的 MCP 包文件夹' : 'No valid MCP package directory was selected')
              : (zh ? '未选择有效的技能文件夹' : 'No valid skill folder was selected'))
          : (zh ? '未选择有效的技能 ZIP 包' : 'No valid skill ZIP package was selected'));
        return;
      }
      setSourceCapabilityId(selected.capability.capabilityId);
      setSourceDisplayName(selected.capability.displayName);
      setSourceCapabilityKind(kind);
      setStatus('');
    } catch {
      setStatus(zh
        ? '无法打开文件选择器，请重试。'
        : 'The file picker could not be opened. Try again.');
    }
  };

  const install = async () => {
    const apply = window.metis?.applyPersonalizationExtension;
    if (!apply) {
      setStatus(zh ? '扩展安装服务不可用' : 'Extension installation service is unavailable');
      return;
    }
    const trimmedUrl = url.trim();
    const digestIsValid = expectedDigest.length === 0 || /^[a-f0-9]{64}$/u.test(expectedDigest);
    if ((mode === 'skill_url' || mode === 'mcp_url')) {
      try {
        const parsed = new URL(trimmedUrl);
        const allowedProtocol = mode === 'mcp_url' ? parsed.protocol === 'https:' : ['https:', 'http:'].includes(parsed.protocol);
        if (!allowedProtocol || parsed.username || parsed.password) throw new Error('unsupported URL');
      } catch {
        setStatus(zh ? '请输入不含凭据的有效 HTTP(S) 地址；MCP 地址必须使用 HTTPS。' : 'Enter a valid credential-free HTTP(S) URL; MCP URLs must use HTTPS.');
        return;
      }
    }
    if (!digestIsValid) {
      setStatus(zh ? 'SHA-256 必须是 64 位小写十六进制字符。' : 'SHA-256 must contain exactly 64 lowercase hexadecimal characters.');
      return;
    }
    if ((mode === 'mcp_package' || mode === 'mcp_url') && !mcpName.trim()) {
      setStatus(zh ? '请先为 MCP 填写一个名称。' : 'Give the MCP a name first.');
      return;
    }
    setBusy(true);
    setStatus('');
    const operationId = crypto.randomUUID();
    const common = { contractVersion: 1 as const, operationId, expectedRevision };
    const request = mode === 'skill_package'
      ? sourceCapabilityId ? {
          ...common,
          mode,
          sourceCapabilityId,
          expectedId: targetDefinition?.id ?? null,
        } as const : null
      : mode === 'skill_url'
        ? {
            ...common,
            mode,
            url: trimmedUrl,
            expectedArchiveSha256: expectedDigest || null,
            expectedId: targetDefinition?.id ?? null,
            expectedVersion: expectedVersion || null,
          } as const
      : mode === 'mcp_package'
            ? sourceCapabilityId ? {
                ...common,
                mode,
                definitionId,
                sourceCapabilityId,
              } as const : null
          : {
              ...common,
              mode,
              definitionId,
              manifestUrl: trimmedUrl,
              expectedManifestSha256: expectedDigest || null,
            } as const;
    if (!request) {
      setBusy(false);
      setStatus(mode === 'mcp_package'
        ? (zh ? '请先选择本地 MCP 包文件夹' : 'Choose a local MCP package directory first')
        : (zh ? '请先选择技能 ZIP 包或技能文件夹' : 'Choose a skill ZIP package or folder first'));
      return;
    }
    try {
      const result = await apply(request);
      if (!result.ok) {
        if (result.code === 'definition_rejected' && result.detailCode === 'definition_cas_failed') {
          if (mode === 'skill_package' || mode === 'mcp_package') {
            setSourceCapabilityId(null);
            setSourceDisplayName('');
            setSourceCapabilityKind(null);
            setTargetDefinitionId('');
          }
          await onRefresh();
          setStatus(mode === 'skill_package' || mode === 'mcp_package'
            ? (zh
                ? '该技能已在其他位置更新。Metis 已载入最新版本；请重新选择安装目标和技能包后重试。'
                : 'This Skill changed elsewhere. Metis loaded the latest version; select the target and skill package again to retry.')
            : (zh
                ? '配置已在其他位置更新。Metis 已载入最新版本，请检查后重试。'
                : 'This configuration changed elsewhere. Metis loaded the latest version; review it and try again.'));
          return;
        }
        setStatus(`${zh ? '安装失败' : 'Installation failed'}: ${result.code}${result.detailCode ? ` / ${result.detailCode}` : ''}`);
        return;
      }
      setStatus(zh ? '已安装并写入不可伪造的来源记录' : 'Installed with a signed, non-authoritative source record');
      await onInstalled(result.definition.id);
    } catch {
      setStatus(zh
        ? '安装未完成：无法连接主进程安装服务，可修改后重试。'
        : 'Installation did not complete: the main-process installer could not be reached. You can revise the input and retry.');
    } finally {
      setBusy(false);
    }
  };

  const modeOptions = kind === 'skill'
    ? [['skill_package', zh ? '上传技能包' : 'Upload skill package'], ['skill_url', zh ? '从 URL / GitHub 安装' : 'Install from URL / GitHub']] as const
    : [['mcp_package', zh ? '导入本地 MCP 包' : 'Import local MCP package'], ['mcp_url', zh ? '从 MCP 地址安装' : 'Install from MCP URL']] as const;

  return <section className="personalization-installer" aria-label={zh ? '安全扩展安装器' : 'Secure extension installer'}>
    <div className="personalization-installer__header">
      <div><span className="personalization-eyebrow">{kind === 'skill' ? (zh ? '技能' : 'SKILL') : 'MCP'}</span><h2>{kind === 'skill' ? (zh ? '安装技能' : 'Install skills') : (zh ? '安装 MCP' : 'Install MCP')}</h2></div>
      <span>{zh ? '所有来源先验证、再保存；安装结果不能伪造“已核验”状态。' : 'Sources are verified before persistence and can never forge a verified truth state.'}</span>
    </div>
    <label><span>{zh ? '模式' : 'Mode'}</span><select value={mode} onChange={(event) => changeMode(event.target.value as typeof mode)}>{modeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label><span>{zh ? '安装目标' : 'Installation target'}</span><select value={targetDefinition?.id ?? ''} onChange={(event) => setTargetDefinitionId(event.target.value)}><option value="">{zh ? '安装为新定义' : 'Install as a new definition'}</option>{targetCandidates.map((definition) => <option key={definition.id} value={definition.id}>{definition.name}</option>)}</select></label>
    <p className="personalization-installer__mode-help">{targetDefinition
      ? (zh ? `将更新“${targetDefinition.name}”；Metis 会自动绑定当前保存版本。` : `Updating “${targetDefinition.name}”. Metis binds the current saved version automatically.`)
      : (zh ? '将创建新定义；无需填写内部修订号。' : 'A new definition will be created; no internal revision number is required.')}</p>
    <p className="personalization-installer__mode-help">{mode === 'skill_package'
      ? (zh ? 'ZIP 适合完整技能包；文件夹适合本地开发中的文档、脚本与资源集合。' : 'ZIP is for portable packages; folders are for locally developed documents, scripts, and assets.')
      : mode === 'skill_url'
        ? (zh ? '粘贴 GitHub 或技能包直链，Metis 会下载、核验再安装。' : 'Paste a GitHub or package URL. Metis downloads, verifies, then installs it.')
        : mode === 'mcp_package'
          ? (zh ? '选择包含 manifest.json 与所有声明文件的本地 MCP 包目录。METIS 会复制、校验并静态检查后保存。' : 'Choose a local MCP package directory containing manifest.json and all declared files. METIS copies, verifies, and statically validates it before saving.')
          : (zh ? '粘贴 MCP 清单的 HTTPS 地址，核验通过后才启用。' : 'Paste an HTTPS MCP manifest URL. It is enabled only after verification.')}</p>
    {mode === 'skill_package' && <div className="personalization-package-picker">
      <button type="button" onClick={() => void selectPackage('file')}>{zh ? '选择 ZIP 技能包' : 'Choose skill ZIP package'}</button>
      <button type="button" onClick={() => void selectPackage('folder')}>{zh ? '选择技能文件夹' : 'Choose skill folder'}</button>
      <span>{sourceDisplayName
        ? `${sourceCapabilityKind === 'folder' ? (zh ? '文件夹' : 'Folder') : 'ZIP'}: ${sourceDisplayName}`
        : (zh ? '尚未选择' : 'Nothing selected')}</span>
    </div>}
    {mode === 'mcp_package' && <div className="personalization-package-picker">
      <button type="button" onClick={() => void selectPackage('folder')}>{zh ? '选择本地 MCP 包文件夹' : 'Choose local MCP package directory'}</button>
      <span>{sourceDisplayName ? `${zh ? '文件夹' : 'Directory'}: ${sourceDisplayName}` : (zh ? '尚未选择' : 'Nothing selected')}</span>
    </div>}
    {(mode === 'skill_url' || mode === 'mcp_url') && <label><span>{mode === 'skill_url' ? (zh ? '技能包 URL / GitHub 地址' : 'Skill package URL / GitHub address') : (zh ? 'MCP 清单 HTTPS 地址' : 'MCP manifest HTTPS URL')}</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." /></label>}
    {mode === 'skill_url' && <label><span>{zh ? '预期版本（可选）' : 'Expected version (optional)'}</span><input value={expectedVersion} onChange={(event) => setExpectedVersion(event.target.value)} placeholder="1.0.0" /></label>}
    {(mode === 'mcp_package' || mode === 'mcp_url') && <><label><span>{zh ? 'MCP 名称' : 'MCP name'}</span><input value={mcpName} maxLength={100} onChange={(event) => setMcpName(event.target.value)} /></label><p className="personalization-derived-id">{zh ? '安装后名称' : 'Installed as'}: <strong>{mcpName.trim() || (zh ? '未命名 MCP' : 'Unnamed MCP')}</strong></p></>}
    {(mode === 'skill_url' || mode === 'mcp_url') && <label><span>{zh ? '预期 SHA-256（可选）' : 'Expected SHA-256 (optional)'}</span><input value={expectedDigest} onChange={(event) => setExpectedDigest(event.target.value.trim().toLowerCase())} /></label>}
    <div className="personalization-actions"><button className="btn-primary" type="button" disabled={busy} onClick={() => void install()}>{busy ? (zh ? '处理中…' : 'Working…') : (zh ? '验证并安装' : 'Verify and install')}</button><span role="status" aria-live="polite">{status}</span></div>
  </section>;
}
