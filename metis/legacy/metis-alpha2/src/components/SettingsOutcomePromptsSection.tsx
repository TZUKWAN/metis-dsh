import SettingsOfficeProfilesSection from './SettingsOfficeProfilesSection';
import React from 'react';
import { RotateCcw, Sparkles } from 'lucide-react';
import type { ArtifactPromptDefinition } from '../../engine/artifacts/prompts/ArtifactPromptRegistry.js';
// 本区（含 Office Profiles）的样式定义在 scenarioWorkbench.css 里，但该文件
// 历史上只被懒加载的 ScenarioWorkbench 引入——直接打开设置页时样式缺失、
// 整个提示词工程区退化成无样式列表（刘总 2026-09 截图问题）。
import '../personalization/scenarioWorkbench.css';

/**
 * 成果提示词工程(2026-09-05 刘总要求,任务4)。
 * 三区:左=Prompt 列表(状态标识);右=编辑器(保存/恢复默认/启停/历史);
 * Assistant(AI 修改建议,Diff 后应用)。
 */

interface PromptView {
  definition: ArtifactPromptDefinition;
  override: { promptId: string; content: string; enabled: boolean; baseVersion: number; createdAt: number; updatedAt: number } | null;
  effectiveContent: string;
  defaultUpgraded: boolean;
  status: 'default' | 'customized' | 'disabled';
}

const STATUS_LABELS: Record<string, string> = { default: 'METIS 默认', customized: '已自定义', disabled: '已停用(用默认)' };

export default function SettingsOutcomePromptsSection() {
  const [views, setViews] = React.useState<PromptView[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');
  const [dirty, setDirty] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const [assistantOpen, setAssistantOpen] = React.useState(false);
  const [assistantInstruction, setAssistantInstruction] = React.useState('');
  const [assistantSuggestion, setAssistantSuggestion] = React.useState<string | null>(null);
  const [revisions, setRevisions] = React.useState<Array<{ id: string; content: string; createdAt: number; source: string; note: string }>>([]);

  const active = views.find((view) => view.definition.id === activeId) ?? null;

  const loadViews = React.useCallback(async (selectId?: string) => {
    const rows = await window.metis?.outcomePromptList?.();
    if (!Array.isArray(rows)) return;
    setViews(rows as unknown as PromptView[]); // bridge 返回宽松形状,运行时形状由主进程 contract 保证
    setActiveId((current) => current ?? (rows[0] ? String((rows[0] as { definition: { id: string } }).definition.id) : null));
    if (selectId) setActiveId(selectId);
  }, []);

  React.useEffect(() => { void loadViews(); }, [loadViews]);

  const selectPrompt = async (promptId: string) => {
    if (dirty && !window.confirm('当前修改尚未保存,切换将丢弃。继续?')) return;
    setDirty(false);
    setAssistantSuggestion(null);
    setAssistantOpen(false);
    await loadViews(promptId);
  };

  React.useEffect(() => {
    if (active) setDraft(active.effectiveContent);
  }, [active?.definition.id, active?.effectiveContent]);

  const loadRevisions = React.useCallback(async (promptId: string) => {
    const rows = await window.metis?.outcomePromptListRevisions?.(promptId);
    setRevisions(Array.isArray(rows) ? rows : []);
  }, []);

  React.useEffect(() => { if (activeId) void loadRevisions(activeId); }, [activeId, loadRevisions]);

  const save = async () => {
    if (!active || busy) return;
    setBusy(true);
    try {
      const result = await window.metis?.outcomePromptSave?.({ promptId: active.definition.id, content: draft });
      if (result?.ok) {
        setDirty(false);
        setNotice('已保存。下一次执行对应操作时即生效。');
        await loadViews(active.definition.id);
      } else {
        setNotice(`保存失败:${result?.code ?? '未知原因'}。编辑内容已保留,可重试。`);
      }
    } finally { setBusy(false); }
  };

  const reset = async () => {
    if (!active) return;
    if (!window.confirm('恢复后将停止使用你的自定义版本(历史版本不会删除)。继续?')) return;
    const result = await window.metis?.outcomePromptReset?.(active.definition.id);
    if (result?.ok) {
      setDirty(false);
      setNotice('已恢复 METIS 默认。');
      await loadViews(active.definition.id);
    }
  };

  const toggleEnabled = async () => {
    if (!active?.override) return;
    const result = await window.metis?.outcomePromptSetEnabled?.({ promptId: active.definition.id, enabled: active.override.enabled !== true });
    if (result?.ok) await loadViews(active.definition.id);
  };

  const assist = async () => {
    if (!active || !assistantInstruction.trim()) return;
    setBusy(true);
    try {
      const result = await window.metis?.outcomePromptAssist?.({ promptId: active.definition.id, instruction: assistantInstruction.trim() });
      if (result?.ok && result.suggestion) setAssistantSuggestion(result.suggestion);
      else setNotice(`AI 建议生成失败:${result?.message ?? result?.code ?? '未知原因'}`);
    } finally { setBusy(false); }
  };

  const exportPack = () => {
    void window.metis?.outcomePromptExport?.().then((pack) => {
      if (!pack) return;
      const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'metis-artifact-prompts.json';
      anchor.click();
      URL.revokeObjectURL(url);
    });
  };

  const importPack = async (file: File) => {
    try {
      const text = await file.text();
      const result = await window.metis?.outcomePromptImport?.(JSON.parse(text));
      if (result?.ok) {
        const unknownNote = result.unknownIds && result.unknownIds.length > 0 ? `;未知提示词已跳过:${result.unknownIds.join('、')}` : '';
        setNotice(`导入成功(${result.applied?.length ?? 0} 项)${unknownNote}`);
        await loadViews(activeId ?? undefined);
      } else {
        setNotice(`导入失败:${result?.code ?? '文件格式不正确'}`);
      }
    } catch { setNotice('导入失败:文件不是有效的 JSON。'); }
  };

  return (
    <div className="settings-outcome-prompts" data-testid="settings-outcome-prompts">
      <h3>成果提示词工程</h3>
      <p className="settings-outcome-prompts__desc">自定义 METIS 在生成、修改、规划和审查各类成果时使用的 AI 工作指令。工具协议与文件保存规则不受影响,恢复默认永远可用。</p>
      <div className="settings-outcome-prompts__toolbar">
        <button type="button" className="btn-secondary btn-sm" onClick={exportPack}>导出配置</button>
        <label className="btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
          导入配置
          <input type="file" accept="application/json" style={{ display: 'none' }} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importPack(file); event.target.value = ''; }} />
        </label>
      </div>
      <div className="settings-outcome-prompts__layout">
        <ul className="settings-outcome-prompts__list" aria-label="提示词列表">
          {views.map((view) => (
            <li key={view.definition.id}>
              <button
                type="button"
                className={view.definition.id === activeId ? 'active' : undefined}
                onClick={() => void selectPrompt(view.definition.id)}
                data-testid={`outcome-prompt-${view.definition.id}`}
              >
                <strong>{view.definition.name}</strong>
                <small>{STATUS_LABELS[view.status]}{view.defaultUpgraded ? ' · 默认已更新' : ''}</small>
              </button>
            </li>
          ))}
        </ul>
        <div className="settings-outcome-prompts__editor">
          {active ? (
            <>
              <div className="settings-outcome-prompts__head">
                <strong>{active.definition.name}</strong>
                <span className="settings-outcome-prompts__status">{STATUS_LABELS[active.status]}</span>
              </div>
              <p className="settings-outcome-prompts__scope">{active.definition.description} <em>{active.definition.scopeNote}</em></p>
              <textarea
                rows={14}
                value={draft}
                onChange={(event) => { setDraft(event.target.value); setDirty(true); }}
                disabled={busy || active.override?.enabled === false}
                data-testid="outcome-prompt-editor"
              />
              <div className="settings-outcome-prompts__actions">
                <button type="button" className="btn-primary btn-sm" disabled={busy || !dirty || active.override?.enabled === false} onClick={() => void save()} data-testid="outcome-prompt-save">保存</button>
                <button type="button" className="btn-secondary btn-sm" disabled={busy || !active.override} onClick={() => void reset()} data-testid="outcome-prompt-reset"><RotateCcw size={13} /> 恢复默认</button>
                {active.override && (
                  <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void toggleEnabled()}>
                    {active.override.enabled ? '停用自定义(用默认)' : '启用自定义'}
                  </button>
                )}
                <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => { setAssistantOpen((value) => !value); setAssistantSuggestion(null); }} data-testid="outcome-prompt-assist-toggle">
                  <Sparkles size={13} /> AI 修改建议
                </button>
              </div>
              {assistantOpen && (
                <div className="settings-outcome-prompts__assistant">
                  <input
                    value={assistantInstruction}
                    placeholder="例如:重写时优先保持原有论证结构,不主动删引用。"
                    onChange={(event) => setAssistantInstruction(event.target.value)}
                    data-testid="outcome-prompt-assist-input"
                  />
                  <button type="button" className="btn-secondary btn-sm" disabled={busy || !assistantInstruction.trim()} onClick={() => void assist()}>生成建议</button>
                  {assistantSuggestion && (
                    <div className="settings-outcome-prompts__suggestion" data-testid="outcome-prompt-suggestion">
                      <strong>建议版本(与当前生效版本对比后应用):</strong>
                      <textarea rows={10} value={assistantSuggestion} onChange={(event) => setAssistantSuggestion(event.target.value)} readOnly={false} />
                      <div className="settings-outcome-prompts__actions">
                        <button type="button" className="btn-primary btn-sm" onClick={() => { setDraft(assistantSuggestion); setDirty(true); setAssistantSuggestion(null); }}>应用到编辑器</button>
                        <button type="button" className="btn-secondary btn-sm" onClick={() => setAssistantSuggestion(null)}>放弃</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {revisions.length > 0 && (
                <details className="settings-outcome-prompts__revisions">
                  <summary>历史版本({revisions.length})</summary>
                  <ul>
                    {revisions.map((revision) => (
                      <li key={revision.id}>
                        <button type="button" className="btn-secondary btn-sm" onClick={() => void window.metis?.outcomePromptRestoreRevision?.({ promptId: active.definition.id, revisionId: revision.id }).then(() => loadViews(active.definition.id))}>
                          恢复
                        </button>
                        {new Date(revision.createdAt).toLocaleString()} · {revision.source}{revision.note ? ` · ${revision.note}` : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {notice && <p className="settings-outcome-prompts__notice" role="status">{notice}</p>}
            </>
          ) : (
            <p className="settings-outcome-prompts__empty">选择左侧提示词开始自定义。</p>
          )}
        </div>
      </div>
      <SettingsOfficeProfilesSection />
    </div>
  );
}
