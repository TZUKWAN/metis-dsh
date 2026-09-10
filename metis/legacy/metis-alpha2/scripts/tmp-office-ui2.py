import io

p = 'src/components/SettingsOfficeProfilesSection.tsx'
s = io.open(p, encoding='utf-8').read()

# 1. Profile 接口加 globalPrompt
old_iface = "interface Profile { id: string; officeKind: string; name: string; description: string; builtin: boolean; slots: Record<string, string>; createdAt: number; updatedAt: number }"
assert old_iface in s
s = s.replace(old_iface, "interface Profile { id: string; officeKind: string; name: string; description: string; builtin: boolean; globalPrompt?: string; slots: Record<string, string>; createdAt: number; updatedAt: number }")

# 2. 全局风格编辑器：插在 slots 列表之前（默认优先展示）
old_slots = """              {activeProfile && (
                <ul className="settings-office-profiles__slots" aria-label="Prompt Slots">"""
assert old_slots in s, 'slots anchor'
new_slots = """              {activeProfile && (
                <div className="settings-office-profiles__global" data-testid="office-global-editor">
                  <strong>全局风格与行为</strong>
                  <small style={{ display: 'block', margin: '3px 0 6px', color: 'var(--text-muted)', fontSize: 11 }}>
                    定义该 Profile 在所有 AI 动作中共同遵守的生成、修改和表达原则。
                  </small>
                  <textarea
                    rows={7}
                    value={globalDraft}
                    onChange={(event) => setGlobalDraft(event.target.value)}
                    placeholder="例如（Word）：正文以连续学术论述为主，每一段承担明确论证功能…（留空使用系统内置）"
                  />
                  <div className="settings-office-profiles__actions">
                    <button type="button" className="btn-primary btn-sm" disabled={busy || globalDraft === (activeProfile.globalPrompt ?? '')} onClick={() => void saveGlobal()}>保存全局风格</button>
                    <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setGlobalDraft(activeProfile.globalPrompt ?? '')}>放弃修改</button>
                  </div>
                </div>
              )}
              {activeProfile && (
                <ul className="settings-office-profiles__slots" aria-label="Prompt Slots">"""
s = s.replace(old_slots, new_slots)

# 3. state：globalDraft + 随 activeProfile 切换刷新 + saveGlobal
old_notice_state = "  const [notice, setNotice] = useState('');"
if old_notice_state not in s:
    import re
    m = re.search(r"const \[notice, setNotice\] = useState\([^)]*\);", s)
    old_notice_state = m.group(0)
s = s.replace(old_notice_state, old_notice_state + "\n  const [globalDraft, setGlobalDraft] = useState('');", 1)

# activeProfile 定义后同步 globalDraft
import re
m = re.search(r"const activeProfile = (memо\()?", s)
ap_anchor = "  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null;"
if ap_anchor in s:
    s = s.replace(ap_anchor, ap_anchor + "\n  useEffect(() => { setGlobalDraft(activeProfile?.globalPrompt ?? ''); }, [activeProfile?.id, activeProfile?.globalPrompt]);", 1)
else:
    # 找 activeProfile 定义行（宽松）
    m2 = re.search(r"(  const activeProfile = [^\n]+\n)", s)
    assert m2, 'activeProfile anchor'
    s = s.replace(m2.group(1), m2.group(1) + "  useEffect(() => { setGlobalDraft(activeProfile?.globalPrompt ?? ''); }, [activeProfile?.id, activeProfile?.globalPrompt]);\n", 1)

# saveGlobal 函数（挂 saveSlot 旁）
m3 = re.search(r"(  const saveSlot = async \(\) => \{)", s)
assert m3, 'saveSlot anchor'
save_global = """  const saveGlobal = async () => {
    const metis = window.metis;
    if (!activeProfile || !metis?.officePromptSetGlobal || busy) return;
    setBusy(true);
    try {
      const saved = await metis.officePromptSetGlobal({ profileId: activeProfile.id, content: globalDraft });
      setNotice(saved ? '全局风格已保存；后续 AI 动作即时生效。' : '保存未完成。');
      await reload?.();
    } catch { setNotice('保存请求未完成。'); }
    finally { setBusy(false); }
  };

"""
s = s.replace(m3.group(1), save_global + m3.group(1), 1)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('settings global editor wired')
