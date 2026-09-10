import React from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { OFFICE_CAPABILITY_DEFINITIONS } from '../../engine/artifacts/prompts/OfficeCapabilityRegistry';

/**
 * METIS Office Prompt Profiles(2026-09-05 刘总要求,任务5)。
 * 挂在「成果提示词工程」之下:格式 → Profiles → Slots 三栏。
 * 能力列表由 OfficeCapabilityRegistry 动态生成;spreadsheet/pdf 无 AI 如实展示。
 */

interface CapabilitySummary { kind: string; label: string; profileCount: number; defaultProfileId: string | null; aiEnabled: boolean }
interface Profile { id: string; officeKind: string; name: string; description: string; builtin: boolean; globalPrompt?: string; slots: Record<string, string>; createdAt: number; updatedAt: number }
interface CapabilityDetail { kind: string; label: string; aiEnabled: boolean; aiNote?: string; aiActions: Array<{ slotId: string; label: string; description: string }> }

const CAPABILITY_LABELS: Record<string, string> = {
  word: 'Word', ppt: 'PPT', markdown: 'Markdown', spreadsheet: 'Spreadsheet',
  pdf: 'PDF', image: '图片', chart: '图表',
};

/** slotId → 中文能力名（注册表权威来源；用户不该看到 word.selection.rewrite 这种英文 ID）。 */
const SLOT_LABELS: Record<string, string> = Object.fromEntries(
  OFFICE_CAPABILITY_DEFINITIONS.flatMap((cap) => cap.aiActions.map((action) => [action.slotId, action.label])),
);

function slotLabel(slotId: string): string {
  return SLOT_LABELS[slotId] ?? slotId;
}

export default function SettingsOfficeProfilesSection() {
  const [capabilities, setCapabilities] = React.useState<CapabilitySummary[]>([]);
  const [activeKind, setActiveKind] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<CapabilityDetail | null>(null);
  const [profiles, setProfiles] = React.useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = React.useState<string | null>(null);
  const [draftSlot, setDraftSlot] = React.useState<{ slotId: string; label: string; content: string } | null>(null);
  const [notice, setNotice] = React.useState('');
  const [globalDraft, setGlobalDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null;
  React.useEffect(() => { setGlobalDraft(activeProfile?.globalPrompt ?? ''); }, [activeProfile?.id, activeProfile?.globalPrompt]);

  // 编辑栏常驻（刘总 2026-09）：选中 Profile 后自动选中第一个 slot，
  // 下方编辑器始终展示当前选中 part 的内容，不再点了才在底部弹。
  React.useEffect(() => {
    if (!activeProfile) { setDraftSlot(null); return; }
    const entries = Object.entries(activeProfile.slots);
    if (entries.length === 0) { setDraftSlot(null); return; }
    setDraftSlot((current) => {
      if (current && entries.some(([slotId]) => slotId === current.slotId)) return current;
      const [slotId, content] = entries[0]!;
      return { slotId, label: slotLabel(slotId), content };
    });
  }, [activeProfile]);

  const loadCapabilities = React.useCallback(async () => {
    const rows = await window.metis?.officePromptCapabilities?.();
    if (Array.isArray(rows)) {
      setCapabilities(rows);
      setActiveKind((current) => current ?? rows[0]?.kind ?? null);
    }
  }, []);


  React.useEffect(() => { void loadCapabilities(); }, [loadCapabilities]);

  React.useEffect(() => {
    if (!activeKind) return;
    let alive = true;
    void (async () => {
      const rows = await window.metis?.officePromptProfiles?.(activeKind);
      if (!alive) return;
      setProfiles(rows ?? []);
      setActiveProfileId((current) => (rows?.some((profile) => profile.id === current) ? current : rows?.[0]?.id ?? null));
    })();
    return () => { alive = false; };
  }, [activeKind]);

  const loadProfiles = async (kind: string) => {
    const rows = await window.metis?.officePromptProfiles?.(kind);
    setProfiles(rows ?? []);
    setActiveProfileId((current) => (rows?.some((profile) => profile.id === current) ? current : rows?.[0]?.id ?? null));
  };

  const createProfile = async (fromProfileId?: string) => {
    if (!activeKind || busy) return;
    setBusy(true);
    try {
      const name = window.prompt(fromProfileId ? '新 Profile 名称(副本)' : '新 Profile 名称', fromProfileId ? '副本' : '新 Profile');
      if (!name) return;
      const result = await window.metis?.officePromptCreateProfile?.({ officeKind: activeKind, name, fromProfileId });
      if (result?.ok) {
        if (activeKind) await loadProfiles(activeKind);
        await loadCapabilities();
        if (result.profile) setActiveProfileId(String((result.profile as { id: string }).id));
        setNotice('Profile 已创建。');
      }
    } finally { setBusy(false); }
  };

  const removeProfile = async (profile: Profile) => {
    if (!window.confirm(`删除 Profile「${profile.name}」?删除后可在恢复列表还原。`)) return;
    await window.metis?.officePromptDeleteProfile?.(profile.id);
    await loadProfiles(profile.officeKind);
    await loadCapabilities();
    setNotice('已删除(软删除,可恢复)。');
  };

  const restoreLatest = async () => {
    if (!activeKind) return;
    const metis = window.metis;
    if (!metis?.officePromptDeletedProfiles || !metis?.officePromptRestoreProfile) { setNotice('当前版本不支持恢复。'); return; }
    const deleted = await metis.officePromptDeletedProfiles(activeKind);
    const latest = Array.isArray(deleted) ? deleted[0] : null;
    if (!latest || typeof latest.id !== 'string') { setNotice('该格式没有可恢复的已删除 Profile。'); return; }
    const restored = await metis.officePromptRestoreProfile(latest.id);
    setNotice(restored ? `已恢复「${latest.name}」。` : '恢复未完成。');
    if (restored && activeKind) await loadProfiles(activeKind);
  };

  const setDefault = async (profile: Profile) => {
    if (!activeKind) return;
    const result = await window.metis?.officePromptSetDefault?.({ officeKind: activeKind, profileId: profile.id });
    if (result?.ok) {
      await loadCapabilities();
      setNotice(`已设为 ${CAPABILITY_LABELS[profile.officeKind] ?? profile.officeKind} 的默认 Profile。新成果默认使用;已有成果的显式绑定不受影响。`);
    }
  };

  const saveGlobal = async () => {
    const metis = window.metis;
    if (!activeProfile || !metis?.officePromptSetGlobal || busy) return;
    setBusy(true);
    try {
      const saved = await metis.officePromptSetGlobal({ profileId: activeProfile.id, content: globalDraft });
      setNotice(saved ? '全局风格已保存；后续 AI 动作即时生效。' : '保存未完成。');
      if (activeKind) await loadProfiles(activeKind);
    } catch { setNotice('保存请求未完成。'); }
    finally { setBusy(false); }
  };

  const saveSlot = async () => {
    if (!activeProfile || !draftSlot || busy) return;
    setBusy(true);
    try {
      const result = await window.metis?.officePromptSetSlot?.({ profileId: activeProfile.id, slotId: draftSlot.slotId, content: draftSlot.content });
      if (result?.ok) {
        setNotice('已保存。该 Profile 下一次执行对应动作时生效。');
        await loadProfiles(activeProfile.officeKind);
      } else {
        setNotice(`保存失败:${result?.code ?? '未知原因'}`);
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="settings-office-profiles" data-testid="settings-office-profiles">
      <h3>Metis Office Profiles</h3>
      <p className="settings-office-profiles__desc">为每种 Office 格式维护多套 AI 工作方式(Profile);成果可绑定特定 Profile,未绑定时使用格式默认。能力列表按实际支持动态生成。</p>
      <div className="settings-office-profiles__layout">
        <ul className="settings-office-profiles__kinds" aria-label="文件类型">
          {capabilities.map((capability) => (
            <li key={capability.kind}>
              <button
                type="button"
                className={capability.kind === activeKind ? 'active' : undefined}
                onClick={() => { setActiveKind(capability.kind); setDraftSlot(null); }}
                data-testid={`office-kind-${capability.kind}`}
              >
                <strong>{CAPABILITY_LABELS[capability.kind] ?? capability.kind}</strong>
                <small>{capability.aiEnabled ? `${capability.profileCount} 个 Profile` : '无 AI 动作'}</small>
              </button>
            </li>
          ))}
        </ul>
        <div className="settings-office-profiles__main">
          {activeKind && (
            <>
              <div className="settings-office-profiles__profile-bar">
                <select
                  aria-label="Profile"
                  value={activeProfileId ?? ''}
                  onChange={(event) => setActiveProfileId(event.target.value)}
                  data-testid="office-profile-select"
                >
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}{profile.builtin ? '(内置)' : ''}{capabilities.find((capability) => capability.kind === activeKind)?.defaultProfileId === profile.id ? ' · 默认' : ''}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void createProfile()}><Plus size={13} /> 新建</button>
                <button type="button" className="btn-secondary btn-sm" disabled={busy || !activeProfile} onClick={() => void createProfile(activeProfile?.id)}>复制</button>
                {activeProfile && !activeProfile.builtin && (
                  <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void window.metis?.officePromptUpdateProfile?.({ profileId: activeProfile.id, name: window.prompt('重命名 Profile', activeProfile.name) ?? activeProfile.name }).then(() => loadProfiles(activeKind))}>重命名</button>
                )}
                {activeProfile && (
                  <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void setDefault(activeProfile)} data-testid="office-profile-set-default">设为默认</button>
                )}
                {activeProfile && (
                  <button type="button" className="settings-office-profiles__danger btn-sm" disabled={busy} onClick={() => void removeProfile(activeProfile)} data-testid="office-profile-delete"><Trash2 size={13} /> 删除</button>
                )}
                <button type="button" className="btn-secondary btn-sm" disabled={busy} title="恢复最近删除的 Profile" onClick={() => void restoreLatest()}><RotateCcw size={13} /></button>
              </div>
              {activeProfile && (
                <ul className="settings-office-profiles__slots" aria-label="Prompt Slots">
                  {Object.entries(activeProfile.slots).length === 0 && <li className="settings-office-profiles__empty">该格式暂无可配置 AI 动作。</li>}
                  {Object.entries(activeProfile.slots).map(([slotId, content]) => (
                    <li key={slotId}>
                      <button
                        type="button"
                        className={draftSlot?.slotId === slotId ? 'active' : undefined}
                        onClick={() => setDraftSlot({ slotId, label: slotLabel(slotId), content })}
                        data-testid={`office-slot-${slotId}`}
                      >
                        <strong>{slotLabel(slotId)}</strong>
                        {content ? <i className="settings-office-profiles__custom-dot" title="已自定义" aria-label="已自定义" /> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {draftSlot && (
                <div className="settings-office-profiles__editor" data-testid="office-slot-editor">
                  <strong>{draftSlot.label}{activeProfile?.slots[draftSlot.slotId] ? '' : '（使用默认）'}</strong>
                  <textarea rows={10} value={draftSlot.content} onChange={(event) => setDraftSlot({ ...draftSlot, content: event.target.value })} />
                  <div className="settings-office-profiles__actions">
                    <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void saveSlot()}>保存到 Profile</button>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => setDraftSlot((current) => (current ? { ...current, content: activeProfile?.slots[current.slotId] ?? '' } : current))}>还原</button>
                  </div>
                </div>
              )}
              {notice && <p className="settings-office-profiles__notice" role="status">{notice}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
