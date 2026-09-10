/**
 * MethodsPanel — 方法库面板（T4 + T11）。
 *
 * 把跑通的做法存为可参数化重放的方法：列表、保存（从当前对话提炼步骤
 * 模板或手写）、参数表单、一键应用到当前项目对话（由 agent 带全部研究
 * 工具执行）。confirmEachStep 开启时只预填第一步（人机审批，T11）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import { useOverlayDialog } from '../hooks/useOverlayDialog';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import { setPendingChatIntent } from '../lib/chatIntent';
import { navigate } from '../shell/navigation';
import './MethodsPanel.css';

interface MethodView {
  id: string;
  name: string;
  description: string;
  params: Record<string, string>;
  steps: Array<{ template: string }>;
  confirmEachStep: boolean;
  sourceProjectId: string | null;
  createdAt: number;
  updatedAt: number;
  runCount: number;
  lastRunAt: number | null;
}

type Mode = 'list' | 'create' | 'params';

export default function MethodsPanel({ onClose }: { onClose: () => void }) {
  const { t, locale } = useTranslation();
  const activeProjectId = useResearchWorkspaceStore((s) => s.activeProjectId);
  const { containerRef } = useOverlayDialog({ onClose });
  const [methods, setMethods] = useState<MethodView[]>([]);
  const [mode, setMode] = useState<Mode>('list');
  const [activeMethod, setActiveMethod] = useState<MethodView | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<{ name: string; description: string; steps: string; confirmEachStep: boolean }>({
    name: '', description: '', steps: '', confirmEachStep: false,
  });

  const reload = useCallback(async () => {
    const list = await window.metis?.listMethods?.();
    if (Array.isArray(list)) setMethods(list as MethodView[]);
  }, []);

  useEffect(() => {
    let alive = true;
    void window.metis?.listMethods?.().then((list) => {
      if (alive && Array.isArray(list)) setMethods(list as MethodView[]);
    });
    return () => { alive = false; };
  }, []);

  const openParams = useCallback((method: MethodView) => {
    const initial: Record<string, string> = {};
    for (const [key, sample] of Object.entries(method.params ?? {})) initial[key] = sample ?? '';
    setParamValues(initial);
    setActiveMethod(method);
    setMode('params');
  }, []);

  const applyMethod = useCallback(async () => {
    if (!activeMethod) return;
    const metis = window.metis;
    if (!metis?.renderMethod) return;
    const rendered = await metis.renderMethod(activeMethod.id, paramValues);
    if (!rendered || rendered.length === 0) return;
    const instructions = rendered.map((item) => item.instruction);
    // 分步确认（T11）：只预填第一步，用户审完再发；否则按编号序列一次预填。
    const message = activeMethod.confirmEachStep
      ? `${instructions[0]}\n\n（来自方法「${activeMethod.name}」，本步确认后请让我继续下一步）`
      : `请按以下步骤执行（来自方法「${activeMethod.name}」）：\n${instructions.map((text, index) => `${index + 1}. ${text}`).join('\n')}`;
    setPendingChatIntent({
      message,
      projectId: activeProjectId ?? undefined,
      autoSend: false,
    });
    await metis.recordMethodRun?.({
      id: activeMethod.id,
      projectId: activeProjectId ?? null,
      params: paramValues,
      outcome: 'applied',
    });
    setNotice(t('methods.appliedNotice'));
    void reload();
    onClose();
    // 跳到项目聊天模式执行（任务4：typed navigation contract）。
    navigate({ kind: 'workspace' });
  }, [activeMethod, paramValues, activeProjectId, t, reload, onClose]);

  const createMethod = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.createMethod) return;
    const steps = draft.steps
      .split(/\n\s*\d+[.、)]\s*/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!draft.name.trim() || steps.length === 0) {
      setNotice(t('methods.createInvalid'));
      return;
    }
    const created = await metis.createMethod({
      name: draft.name.trim(),
      description: draft.description.trim(),
      steps: steps.map((template) => ({ template })),
      confirmEachStep: draft.confirmEachStep,
      sourceProjectId: activeProjectId ?? null,
    });
    if (created) {
      setNotice(t('methods.createdNotice'));
      setDraft({ name: '', description: '', steps: '', confirmEachStep: false });
      setMode('list');
      void reload();
    } else {
      setNotice(t('methods.createInvalid'));
    }
  }, [draft, activeProjectId, t, reload]);

  const deleteMethod = useCallback(async (methodId: string) => {
    await window.metis?.deleteMethod?.(methodId);
    void reload();
  }, [reload]);

  return (
    <div className="methods-panel" data-testid="methods-panel" role="dialog" aria-modal="true" aria-label={t('methods.title')} ref={containerRef}>
      <div className="methods-panel__card">
        <header className="methods-panel__header">
          <h2>{t('methods.title')}</h2>
          <button type="button" className="methods-panel__close" onClick={onClose} aria-label={t('browserOverlay.close')} data-testid="methods-close">✕</button>
        </header>

        {notice && <div className="methods-panel__notice" data-testid="methods-notice">{notice}</div>}

        {mode === 'list' && (
          <>
            <div className="methods-panel__toolbar">
              <button type="button" className="btn-primary btn-sm" onClick={() => setMode('create')} data-testid="methods-new">{t('methods.create')}</button>
              <span className="methods-panel__hint">{t('methods.hint')}</span>
            </div>
            {methods.length === 0 ? (
              <p className="methods-panel__empty" data-testid="methods-empty">{t('methods.empty')}</p>
            ) : (
              <ul className="methods-panel__list" data-testid="methods-list">
                {methods.map((method) => (
                  <li key={method.id} className="methods-panel__item" data-testid="methods-item">
                    <div className="methods-panel__item-main">
                      <button type="button" className="methods-panel__name" onClick={() => openParams(method)} data-testid="methods-run">
                        {method.name}
                      </button>
                      {method.description && <p className="methods-panel__desc">{method.description}</p>}
                      <div className="methods-panel__meta">
                        <span>{t('methods.stepCount', { count: method.steps.length })}</span>
                        {Object.keys(method.params ?? {}).length > 0 && (
                          <span>{t('methods.paramCount', { count: Object.keys(method.params).length })}</span>
                        )}
                        <span>{t('methods.runCount', { count: method.runCount })}</span>
                        {method.confirmEachStep && <span className="methods-panel__badge">{t('methods.confirmBadge')}</span>}
                        {method.lastRunAt && (
                          <span>{new Date(method.lastRunAt).toLocaleDateString(locale)}</span>
                        )}
                      </div>
                    </div>
                    <div className="methods-panel__item-actions">
                      <button type="button" className="btn-sm btn-secondary" onClick={() => void deleteMethod(method.id)} data-testid="methods-delete">{t('library.actionDelete')}</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {mode === 'create' && (
          <div className="methods-panel__form" data-testid="methods-create-form">
            <label className="library-edit__field">
              <span>{t('methods.fieldName')}</span>
              <input className="settings-input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="methods-name-input" />
            </label>
            <label className="library-edit__field">
              <span>{t('methods.fieldDescription')}</span>
              <input className="settings-input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </label>
            <label className="library-edit__field">
              <span>{t('methods.fieldSteps')}</span>
              <textarea
                className="settings-input methods-panel__steps"
                rows={6}
                placeholder={t('methods.stepsPlaceholder')}
                value={draft.steps}
                onChange={(e) => setDraft({ ...draft, steps: e.target.value })}
                data-testid="methods-steps-input"
              />
            </label>
            <label className="library-search__check">
              <input type="checkbox" checked={draft.confirmEachStep} onChange={(e) => setDraft({ ...draft, confirmEachStep: e.target.checked })} data-testid="methods-confirm-checkbox" />
              {t('methods.confirmEachStep')}
            </label>
            <div className="methods-panel__actions">
              <button type="button" className="btn-primary btn-sm" onClick={() => void createMethod()} data-testid="methods-create-submit">{t('projects.create')}</button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => setMode('list')}>{t('library.actionCancel')}</button>
            </div>
          </div>
        )}

        {mode === 'params' && activeMethod && (
          <div className="methods-panel__form" data-testid="methods-params-form">
            <h3 className="methods-panel__method-name">{activeMethod.name}</h3>
            {activeMethod.description && <p className="methods-panel__desc">{activeMethod.description}</p>}
            {Object.entries(activeMethod.params ?? {}).length === 0 ? (
              <p className="methods-panel__empty">{t('methods.noParams')}</p>
            ) : (
              Object.entries(activeMethod.params ?? {}).map(([key]) => (
                <label key={key} className="library-edit__field">
                  <span>{key}</span>
                  <input
                    className="settings-input"
                    value={paramValues[key] ?? ''}
                    onChange={(e) => setParamValues({ ...paramValues, [key]: e.target.value })}
                    data-testid={`methods-param-${key}`}
                  />
                </label>
              ))
            )}
            <ol className="methods-panel__preview">
              {activeMethod.steps.map((step, index) => (
                <li key={index}>{step.template}</li>
              ))}
            </ol>
            <div className="methods-panel__actions">
              <button type="button" className="btn-primary btn-sm" onClick={() => void applyMethod()} data-testid="methods-apply">{t('methods.apply')}</button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => setMode('list')}>{t('library.actionCancel')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
