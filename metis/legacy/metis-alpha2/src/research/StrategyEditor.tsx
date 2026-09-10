/**
 * StrategyEditor — compose user-defined research workflow strategies and paper
 * structure templates. Nothing is hard-coded: the researcher picks the phases
 * (research actions) and their order, and defines the paper's section layout
 * for the writing action.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '../i18n';
import type { ResearchStrategy, PaperStructureTemplate, StrategyActionKind } from '../../engine/runtime/ResearchStrategyContract';
import { STRATEGY_ACTIONS } from '../../engine/runtime/ResearchStrategyContract';

type Notice = { kind: 'success' | 'error'; message: string } | null;

interface EditablePhase {
  action: StrategyActionKind;
  name: string;
  prompt?: string;
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const ACTION_LABELS: Record<StrategyActionKind, string> = {
  question_formulation: '研究问题界定',
  literature_review: '文献综述',
  source_discovery: '资料发现',
  screening: '文献筛选',
  conceptual_analysis: '概念与理论分析',
  source_criticism: '史料批判',
  research_design: '研究设计',
  data_collection: '资料与数据获取',
  coding: '质性编码',
  data_preparation: '数据准备',
  statistics: '定量分析',
  triangulation: '三角互证与稳健性检验',
  argumentation: '论证构建',
  writing: '论文写作',
  analysis: '文本分析',
  synthesis: '综合归纳',
  quality_audit: '研究质量审计',
};

export default function StrategyEditor() {
  const { t, locale } = useTranslation();
  const zh = locale === 'zh';

  // ── Strategies ─────────────────────────────────────────────
  const [strategies, setStrategies] = useState<ResearchStrategy[]>([]);
  const [selectedStrategyId, setSelectedStrategyId] = useState('');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [phases, setPhases] = useState<EditablePhase[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  // ── Paper structures ───────────────────────────────────────
  const [structures, setStructures] = useState<PaperStructureTemplate[]>([]);
  const [structureName, setStructureName] = useState('');
  const [sections, setSections] = useState<Array<{ id: string; title: string; instruction?: string }>>([]);

  const loadAll = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.strategyList) return;
    const [strategyResult, structureResult] = await Promise.all([
      metis.strategyList(),
      metis.structureList(),
    ]);
    if (!mounted.current) return;
    if (strategyResult.ok && Array.isArray(strategyResult.strategies)) {
      const list = strategyResult.strategies as unknown as ResearchStrategy[];
      // Deferred: the effect body must stay free of synchronous setState.
      await Promise.resolve();
      if (!mounted.current) return;
      setStrategies(list);
      setSelectedStrategyId((current) => (
        list.some((s) => s.id === current) ? current : (list.find((s) => s.isDefault)?.id ?? (list[0]?.id ?? ''))
      ));
    }
    if (structureResult.ok && Array.isArray(structureResult.templates)) {
      setStructures(structureResult.templates as unknown as PaperStructureTemplate[]);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async loader; setState happens after awaited IPC
    void loadAll();
    return () => { mounted.current = false; };
  }, [loadAll]);

  const selected = strategies.find((s) => s.id === selectedStrategyId) ?? null;

  const startEdit = useCallback((strategy: ResearchStrategy | null) => {
    setEditing(true);
    setNotice(null);
    if (strategy) {
      setName(strategy.name);
      setDescription(strategy.description ?? '');
      setPhases(strategy.phases.map((p) => ({ action: p.action, name: p.name, prompt: p.prompt })));
    } else {
      setName('');
      setDescription('');
      setPhases([{ action: 'literature_review', name: '文献综述' }]);
    }
  }, []);

  const saveStrategy = useCallback(async () => {
    if (!name.trim() || phases.length === 0) return;
    setBusy(true);
    setNotice(null);
    const now = Date.now();
    const strategy: ResearchStrategy = {
      id: selected?.id ?? makeId('strategy'),
      name: name.trim(),
      description: description.trim() || undefined,
      phases: phases.map((p) => ({ action: p.action, name: p.name.trim() || ACTION_LABELS[p.action], ...(p.prompt?.trim() ? { prompt: p.prompt.trim() } : {}) })),
      createdAt: selected?.createdAt ?? now,
      updatedAt: now,
      isDefault: selected?.isDefault ?? false,
    };
    try {
      const result = await window.metis?.strategySave?.(strategy as unknown as Record<string, unknown>);
      if (!result?.ok) {
        setNotice({ kind: 'error', message: result?.error ?? (zh ? '保存失败' : 'Save failed') });
        return;
      }
      setEditing(false);
      setNotice({ kind: 'success', message: zh ? '策略已保存' : 'Strategy saved' });
      await loadAll();
      setSelectedStrategyId(strategy.id);
    } finally {
      setBusy(false);
    }
  }, [name, description, phases, selected, zh, loadAll]);

  const deleteStrategy = useCallback(async (id: string) => {
    const result = await window.metis?.strategyDelete?.(id);
    if (result?.ok) await loadAll();
  }, [loadAll]);

  const setDefault = useCallback(async (id: string) => {
    const result = await window.metis?.strategySetDefault?.(id);
    if (result?.ok) await loadAll();
  }, [loadAll]);

  // ── Structure editing ──────────────────────────────────────
  const [structureEditing, setStructureEditing] = useState(false);
  const [editingStructureId, setEditingStructureId] = useState('');

  const startStructureEdit = useCallback((template: PaperStructureTemplate | null) => {
    setStructureEditing(true);
    setEditingStructureId(template?.id ?? '');
    setStructureName(template?.name ?? '');
    setSections(template?.sections.map((s) => ({ id: s.id, title: s.title, instruction: s.instruction })) ?? [{ id: makeId('sec'), title: '', instruction: '' }]);
  }, []);

  const saveStructure = useCallback(async () => {
    if (!structureName.trim() || sections.filter((s) => s.title.trim()).length === 0) return;
    setBusy(true);
    const now = Date.now();
    const template: PaperStructureTemplate = {
      id: editingStructureId || makeId('structure'),
      name: structureName.trim(),
      sections: sections.filter((s) => s.title.trim()).map((s) => ({
        id: s.id,
        title: s.title.trim(),
        ...(s.instruction?.trim() ? { instruction: s.instruction.trim() } : {}),
      })),
      createdAt: structures.find((x) => x.id === editingStructureId)?.createdAt ?? now,
      updatedAt: now,
      isDefault: structures.find((x) => x.id === editingStructureId)?.isDefault ?? false,
    };
    try {
      const result = await window.metis?.structureSave?.(template as unknown as Record<string, unknown>);
      if (!result?.ok) {
        setNotice({ kind: 'error', message: result?.error ?? (zh ? '保存失败' : 'Save failed') });
        return;
      }
      setStructureEditing(false);
      setNotice({ kind: 'success', message: zh ? '论文结构已保存' : 'Paper structure saved' });
      await loadAll();
    } finally {
      setBusy(false);
    }
  }, [structureName, sections, editingStructureId, structures, zh, loadAll]);

  const deleteStructure = useCallback(async (id: string) => {
    const result = await window.metis?.structureDelete?.(id);
    if (result?.ok) await loadAll();
  }, [loadAll]);

  return (
    <div className="settings-group" data-testid="strategy-editor">
      <h3>{zh ? '自主科研工作流策略' : 'Autonomous research workflow strategies'}</h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
        {zh
          ? '按你的研究方法编排阶段序列（文献综述、质性编码、定量分析、论证构建、论文写作等），自主科研将严格按此流程推进，而不是固定范式。'
          : 'Compose the phase sequence for your own methodology (literature review, coding, statistics, argumentation, writing, …). The autonomous run follows your workflow, not a fixed paradigm.'}
      </p>

      {strategies.length === 0 && !editing && (
        <button className="btn-primary btn-sm" onClick={() => startEdit(null)} data-testid="strategy-new">
          {zh ? '新建策略' : 'New strategy'}
        </button>
      )}

      {strategies.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {strategies.map((strategy) => (
            <div key={strategy.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
              border: '1px solid var(--border)', borderRadius: 'var(--radius, 4px)',
              background: strategy.id === selectedStrategyId ? 'var(--bg-hover)' : 'transparent',
            }}>
              <button
                type="button"
                className="btn-sm"
                data-testid={`strategy-select-${strategy.id}`}
                onClick={() => setSelectedStrategyId(strategy.id)}
                style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <div style={{ fontWeight: 600 }}>{strategy.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {strategy.phases.map((p) => p.name).join(' → ')}
                </div>
              </button>
              {strategy.isDefault && (
                <span className="settings-hint" style={{ fontSize: 11 }}>{zh ? '默认' : 'Default'}</span>
              )}
              <button type="button" className="btn-sm btn-secondary" onClick={() => void setDefault(strategy.id)} disabled={strategy.isDefault}>
                {zh ? '设默认' : 'Set default'}
              </button>
              <button type="button" className="btn-sm btn-secondary" onClick={() => startEdit(strategy)}>
                {zh ? '编辑' : 'Edit'}
              </button>
              <button type="button" className="btn-sm" onClick={() => void deleteStrategy(strategy.id)} style={{ color: 'var(--status-failed)' }}>
                {zh ? '删除' : 'Delete'}
              </button>
            </div>
          ))}
          <button className="btn-secondary btn-sm" onClick={() => startEdit(null)} data-testid="strategy-new">
            {zh ? '新建策略' : 'New strategy'}
          </button>
        </div>
      )}

      {editing && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius, 4px)', padding: 14, marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <input
              className="settings-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={zh ? '策略名称' : 'Strategy name'}
              aria-label={zh ? '策略名称' : 'Strategy name'}
              style={{ flex: 1, minWidth: 180 }}
              data-testid="strategy-name"
            />
            <input
              className="settings-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={zh ? '策略说明（可选）' : 'Description (optional)'}
              aria-label={zh ? '策略说明' : 'Strategy description'}
              style={{ flex: 2, minWidth: 220 }}
              data-testid="strategy-description"
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {phases.map((phase, index) => (
              <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 18 }}>{index + 1}.</span>
                <select
                  className="settings-input"
                  value={phase.action}
                  onChange={(e) => {
                    const action = e.target.value as StrategyActionKind;
                    setPhases((prev) => prev.map((p, i) => i === index ? { ...p, action } : p));
                  }}
                  aria-label={zh ? `阶段 ${index + 1} 动作` : `Phase ${index + 1} action`}
                  style={{ width: 150 }}
                  data-testid={`strategy-phase-action-${index}`}
                >
                  {STRATEGY_ACTIONS.map((action) => (
                    <option key={action} value={action}>{ACTION_LABELS[action]}</option>
                  ))}
                </select>
                <input
                  className="settings-input"
                  value={phase.name}
                  onChange={(e) => setPhases((prev) => prev.map((p, i) => i === index ? { ...p, name: e.target.value } : p))}
                  placeholder={zh ? '阶段名称' : 'Phase name'}
                  aria-label={zh ? `阶段 ${index + 1} 名称` : `Phase ${index + 1} name`}
                  style={{ flex: 1, minWidth: 140 }}
                  data-testid={`strategy-phase-name-${index}`}
                />
                <button
                  type="button"
                  className="btn-sm"
                  onClick={() => setPhases((prev) => prev.filter((_, i) => i !== index))}
                  style={{ color: 'var(--status-failed)' }}
                >
                  {zh ? '移除' : 'Remove'}
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button
                type="button"
                className="btn-sm btn-secondary"
                onClick={() => setPhases((prev) => [...prev, { action: 'analysis', name: zh ? '文本分析' : 'Analysis' }])}
                data-testid="strategy-add-phase"
              >
                + {zh ? '添加阶段' : 'Add phase'}
              </button>
              <button type="button" className="btn-sm btn-secondary" onClick={() => setPhases((prev) => [...prev.slice(0, prev.length - 1)])} disabled={phases.length <= 1}>
                {zh ? '上移最后阶段' : 'Truncate last'}
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="button" className="btn-primary btn-sm" onClick={() => void saveStrategy()} disabled={busy || !name.trim() || phases.length === 0} data-testid="strategy-save">
              {busy ? t('common.saving') : zh ? '保存策略' : 'Save strategy'}
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => setEditing(false)}>{zh ? '取消' : 'Cancel'}</button>
          </div>
        </div>
      )}

      {/* ── Paper structure templates ─────────────────────────── */}
      <h3 style={{ marginTop: 20 }}>{zh ? '论文结构模板' : 'Paper structure templates'}</h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
        {zh
          ? '定义论文写作动作的章节结构（可完全自定义）。写作动作会严格按此结构逐节产出。'
          : 'Define the section structure the writing action must follow. It is fully customizable and never hard-coded.'}
      </p>

      {structures.length === 0 && !structureEditing && (
        <button className="btn-primary btn-sm" onClick={() => startStructureEdit(null)} data-testid="structure-new">
          {zh ? '新建结构' : 'New structure'}
        </button>
      )}

      {structures.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {structures.map((template) => (
            <div key={template.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
              border: '1px solid var(--border)', borderRadius: 'var(--radius, 4px)',
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{template.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {template.sections.map((s) => s.title).join(' · ')}
                </div>
              </div>
              <button type="button" className="btn-sm btn-secondary" onClick={() => startStructureEdit(template)}>{zh ? '编辑' : 'Edit'}</button>
              <button type="button" className="btn-sm" onClick={() => void deleteStructure(template.id)} style={{ color: 'var(--status-failed)' }}>{zh ? '删除' : 'Delete'}</button>
            </div>
          ))}
          <button className="btn-secondary btn-sm" onClick={() => startStructureEdit(null)} data-testid="structure-new">{zh ? '新建结构' : 'New structure'}</button>
        </div>
      )}

      {structureEditing && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius, 4px)', padding: 14 }}>
          <input
            className="settings-input"
            value={structureName}
            onChange={(e) => setStructureName(e.target.value)}
            placeholder={zh ? '结构名称（如：期刊论文结构）' : 'Structure name'}
            aria-label={zh ? '结构名称' : 'Structure name'}
            style={{ marginBottom: 10, width: '100%' }}
            data-testid="structure-name"
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sections.map((section, index) => (
              <div key={section.id} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', width: 18 }}>{index + 1}.</span>
                <input
                  className="settings-input"
                  value={section.title}
                  onChange={(e) => setSections((prev) => prev.map((s, i) => i === index ? { ...s, title: e.target.value } : s))}
                  placeholder={zh ? '章节标题' : 'Section title'}
                  aria-label={zh ? `章节 ${index + 1} 标题` : `Section ${index + 1} title`}
                  style={{ flex: 1, minWidth: 140 }}
                  data-testid={`structure-section-title-${index}`}
                />
                <input
                  className="settings-input"
                  value={section.instruction ?? ''}
                  onChange={(e) => setSections((prev) => prev.map((s, i) => i === index ? { ...s, instruction: e.target.value } : s))}
                  placeholder={zh ? '写作要求（可选）' : 'Writing instruction (optional)'}
                  aria-label={zh ? `章节 ${index + 1} 写作要求` : `Section ${index + 1} writing instruction`}
                  style={{ flex: 2, minWidth: 180 }}
                  data-testid={`structure-section-instruction-${index}`}
                />
                <button
                  type="button"
                  className="btn-sm"
                  onClick={() => setSections((prev) => prev.filter((_, i) => i !== index))}
                  style={{ color: 'var(--status-failed)' }}
                >
                  {zh ? '移除' : 'Remove'}
                </button>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="btn-sm btn-secondary"
              onClick={() => setSections((prev) => [...prev, { id: makeId('sec'), title: '', instruction: '' }])}
              data-testid="structure-add-section"
            >
              + {zh ? '添加章节' : 'Add section'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="button" className="btn-primary btn-sm" onClick={() => void saveStructure()} disabled={busy || !structureName.trim()} data-testid="structure-save">
              {zh ? '保存结构' : 'Save structure'}
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => setStructureEditing(false)}>{zh ? '取消' : 'Cancel'}</button>
          </div>
        </div>
      )}

      {notice && (
        <div
          role={notice.kind === 'error' ? 'alert' : 'status'}
          style={{ marginTop: 10, fontSize: 13, color: notice.kind === 'error' ? 'var(--status-failed)' : 'var(--status-completed)' }}
        >
          {notice.message}
        </div>
      )}
    </div>
  );
}
