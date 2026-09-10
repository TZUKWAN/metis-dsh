/**
 * SettingsProjectProviderSection — O13 项目级 provider/model 覆盖设置。
 *
 * 每个项目可以覆盖全局模型连接：选择项目 → 打开「覆盖全局模型」开关 →
 * 从全局 provider profiles 选择连接（或仅覆盖模型名 / 系统提示）。覆盖经
 * 主进程校验后存入 projects.metadata.providerOverride，goal/run 执行时按
 * 项目绑定生效；未覆盖的项目继续走全局激活 profile。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../i18n';
import type {
  ProjectProviderOverride,
  ProviderProfileSummary,
} from '../../engine/runtime/ProviderProfileContract.js';

interface ProjectOption {
  id: string;
  title: string;
}

type Notice = { kind: 'success' | 'error' | 'info'; message: string } | null;

function operationId(action: string): string {
  return `project-provider-${action}-${Date.now().toString(36)}`;
}

export default function SettingsProjectProviderSection() {
  const { locale } = useTranslation();
  const zh = locale === 'zh';

  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [profiles, setProfiles] = useState<ProviderProfileSummary[]>([]);
  const [projectId, setProjectId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [model, setModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [busy, setBusy] = useState<'idle' | 'loading' | 'saving'>('loading');
  const [notice, setNotice] = useState<Notice>(null);

  // 加载项目列表 + 全局 profile 列表。
  useEffect(() => {
    const metis = window.metis;
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      try {
        if (metis?.listProjects) {
          const response = await metis.listProjects();
          if (!cancelled && response.success) {
            setProjects(response.projects.map((p) => ({ id: p.id, title: p.title })));
          }
        }
        if (metis?.providerProfilesList) {
          const response = await metis.providerProfilesList({ contractVersion: 1, operationId: operationId('list') });
          if (!cancelled && response.ok) setProfiles(response.profiles);
        }
      } catch {
        // 列表加载失败不阻塞设置页其余部分。
      } finally {
        if (!cancelled) setBusy('idle');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 选中项目后加载其现有覆盖。
  const loadOverride = useCallback(async (id: string) => {
    const metis = window.metis;
    if (!metis?.getProjectProviderOverride || !id) return;
    setBusy('loading');
    setNotice(null);
    try {
      const response = await metis.getProjectProviderOverride(id);
      if (response.ok && response.override) {
        setEnabled(true);
        setProfileId(response.override.providerProfileId ?? '');
        setModel(response.override.model ?? '');
        setSystemPrompt(response.override.systemPrompt ?? '');
      } else {
        setEnabled(false);
        setProfileId('');
        setModel('');
        setSystemPrompt('');
      }
    } catch {
      setNotice({ kind: 'error', message: zh ? '读取项目覆盖失败。' : 'Failed to load the project override.' });
    } finally {
      setBusy('idle');
    }
  }, [zh]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );

  const save = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.setProjectProviderOverride || !projectId) return;
    setBusy('saving');
    setNotice(null);
    // 组装覆盖：空字段不写入；开关关闭时清除覆盖。
    const override: ProjectProviderOverride | null = enabled
      ? {
          ...(profileId ? { providerProfileId: profileId } : {}),
          ...(model.trim() ? { model: model.trim() } : {}),
          ...(systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
        }
      : null;
    if (enabled && !profileId && !model.trim() && !systemPrompt.trim()) {
      setNotice({ kind: 'error', message: zh ? '开启覆盖后请至少选择连接、填写模型或系统提示之一。' : 'Choose a connection, model, or system prompt before enabling the override.' });
      setBusy('idle');
      return;
    }
    try {
      const response = await metis.setProjectProviderOverride({ projectId, override });
      if (!response.ok) {
        setNotice({ kind: 'error', message: zh ? `保存失败（${response.code ?? 'unknown'}）。` : `Save failed (${response.code ?? 'unknown'}).` });
        return;
      }
      setNotice({ kind: 'success', message: enabled
        ? (zh ? '项目模型覆盖已保存，下次执行该项目任务时生效。' : 'Project model override saved. It applies the next time this project runs.')
        : (zh ? '已恢复为全局模型设置。' : 'Reverted to the global model settings.') });
    } catch {
      setNotice({ kind: 'error', message: zh ? '保存项目覆盖时发生错误。' : 'An error occurred while saving the project override.' });
    } finally {
      setBusy('idle');
    }
  }, [enabled, model, profileId, projectId, systemPrompt, zh]);

  const isBusy = busy !== 'idle';

  return (
    <section className="settings-group project-provider-override" aria-labelledby="project-provider-override-title">
      <div className="settings-section-heading">
        <div>
          <p className="settings-section-kicker">{zh ? '项目' : 'Projects'}</p>
          <h3 id="project-provider-override-title">{zh ? '项目模型覆盖' : 'Per-project model override'}</h3>
        </div>
      </div>
      <p className="settings-hint">
        {zh
          ? '默认情况下所有项目使用全局激活的模型连接。为某个项目开启覆盖后，该项目的目标/工作流执行将改用所选连接或模型。'
          : 'All projects use the globally active model connection by default. Enable an override to run a project\'s goals and workflows with a different connection or model.'}
      </p>

      <label className="settings-label">
        <span>{zh ? '项目' : 'Project'}</span>
        <select
          className="settings-input"
          value={projectId}
          disabled={isBusy}
          data-testid="project-provider-project-select"
          onChange={(event) => {
            const id = event.target.value;
            setProjectId(id);
            setEnabled(false);
            setProfileId('');
            setModel('');
            setSystemPrompt('');
            if (id) void loadOverride(id);
          }}
        >
          <option value="">{zh ? '选择项目…' : 'Select a project…'}</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.title}</option>
          ))}
        </select>
      </label>

      {selectedProject && (
        <>
          <label className="settings-toggle" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' }}>
            <input
              type="checkbox"
              checked={enabled}
              disabled={isBusy}
              data-testid="project-provider-toggle"
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>{zh ? '覆盖全局模型（仅对此项目生效）' : 'Override the global model (applies only to this project)'}</span>
          </label>

          {enabled && (
            <div className="project-provider-override__form">
              <label className="settings-label">
                <span>{zh ? '模型连接（可选）' : 'Model connection (optional)'}</span>
                <select
                  className="settings-input"
                  value={profileId}
                  disabled={isBusy}
                  data-testid="project-provider-profile-select"
                  onChange={(event) => setProfileId(event.target.value)}
                >
                  <option value="">{zh ? '沿用全局连接' : 'Keep the global connection'}</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}（{profile.model}）
                    </option>
                  ))}
                </select>
              </label>

              <label className="settings-label">
                <span>{zh ? '模型名（可选，覆盖连接默认模型）' : 'Model name (optional, overrides the connection default)'}</span>
                <input
                  className="settings-input"
                  type="text"
                  value={model}
                  disabled={isBusy}
                  data-testid="project-provider-model"
                  placeholder={zh ? '例如 deepseek-chat' : 'e.g. deepseek-chat'}
                  onChange={(event) => setModel(event.target.value)}
                />
              </label>

              <label className="settings-label">
                <span>{zh ? '项目系统提示（可选）' : 'Project system prompt (optional)'}</span>
                <textarea
                  className="settings-input"
                  value={systemPrompt}
                  disabled={isBusy}
                  rows={3}
                  data-testid="project-provider-system-prompt"
                  placeholder={zh ? '执行该项目任务时注入的系统提示…' : 'System prompt injected when this project runs…'}
                  onChange={(event) => setSystemPrompt(event.target.value)}
                />
              </label>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="btn-sm btn-secondary"
              onClick={() => void save()}
              disabled={isBusy}
              data-testid="project-provider-save"
            >
              {busy === 'saving' ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存覆盖' : 'Save override')}
            </button>
          </div>
        </>
      )}

      {notice && (
        <p className={`settings-hint settings-hint--${notice.kind}`} role="status">
          {notice.message}
        </p>
      )}
    </section>
  );
}
