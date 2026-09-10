import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Brain, Cpu } from 'lucide-react';

export interface ModelThinkingSelectorProps {
  zh: boolean;
  disabled?: boolean;
  /** 带文字标题模式（2026-08-24 刘总要求）：图标旁显示「选择模型 / 思考强度」。 */
  labeled?: boolean;
  onModelChanged?: (profileId: string) => void;
}

interface ProfileSummary {
  id: string;
  name: string;
  model: string;
  isActive: boolean;
}

const THINKING_LEVELS = [
  { value: 'fast', label: '快速', short: '快' },
  { value: 'standard', label: '标准', short: '标' },
  { value: 'deep', label: '深度思考', short: '深' },
];

function bridge() {
  return typeof window !== 'undefined' ? window.metis : undefined;
}

interface ProfileListResult {
  ok?: boolean;
  revision?: number;
  profiles?: Array<{ id: string; name: string; model: string; isActive: boolean }>;
}

/**
 * 图标式选择器（2026-08-23 刘总要求）：正常只显示两个小图标（选择模型 / 思考强度），
 * 鼠标悬停显示 tooltip，点击弹出向上浮层。放在对话框下方工具行内使用。
 */
export default function ModelThinkingSelector({ zh, disabled, labeled = false, onModelChanged }: ModelThinkingSelectorProps) {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openPanel, setOpenPanel] = useState<'model' | 'thinking' | null>(null);
  const [switching, setSwitching] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState(() => {
    try { return localStorage.getItem('metis:thinking-level') || 'standard'; } catch { return 'standard'; }
  });
  const rootRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    const listFn = bridge()?.providerProfilesList as ((req: { contractVersion: number; operationId: string }) => Promise<ProfileListResult>) | undefined;
    if (!listFn) return;
    try {
      const result = await listFn({ contractVersion: 1, operationId: crypto.randomUUID() });
      if (!result.ok || !Array.isArray(result.profiles)) return;
      setProfiles(result.profiles);
      const active = result.profiles.find((p) => p.isActive);
      if (active) setActiveId(active.id);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async profile loader; setState happens after awaited IPC
    void refresh();
  }, [refresh]);

  // 点击外部收起浮层。
  useEffect(() => {
    if (!openPanel) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpenPanel(null);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [openPanel]);

  const activeProfile = profiles.find((p) => p.id === activeId);
  const activeLevel = THINKING_LEVELS.find((level) => level.value === thinkingLevel) ?? THINKING_LEVELS[1]!;

  const switchTo = async (profileId: string) => {
    setOpenPanel(null);
    if (!bridge()?.providerProfilesSwitch || profileId === activeId) return;
    setSwitching(true);
    try {
      const listed = await bridge()?.providerProfilesList?.({ contractVersion: 1, operationId: crypto.randomUUID() }) as ProfileListResult & { revision?: number };
      const revision = typeof listed?.revision === 'number' ? listed.revision : 0;
      const switchFn = bridge()?.providerProfilesSwitch;
      if (!switchFn) throw new Error('unavailable');
      await switchFn({ contractVersion: 1, operationId: crypto.randomUUID(), id: profileId, expectedRevision: revision });
      setActiveId(profileId);
      onModelChanged?.(profileId);
    } catch { /* silent */ }
    setSwitching(false);
  };

  const pickLevel = (value: string) => {
    setThinkingLevel(value);
    try { localStorage.setItem('metis:thinking-level', value); } catch { /* ignore */ }
    setOpenPanel(null);
  };

  return (
    <div className={`mts-root ${labeled ? 'mts-root--labeled' : ''}`} data-testid="model-thinking-selector" ref={rootRef}>
      <button
        type="button"
        className={`mts-icon-btn ${openPanel === 'model' ? 'mts-icon-btn--open' : ''}`}
        onClick={() => !disabled && !switching && setOpenPanel(openPanel === 'model' ? null : 'model')}
        disabled={disabled || switching}
        title={zh
          ? `选择模型：${activeProfile?.model || '默认模型'}${profiles.length === 0 ? '（未检测到可用配置）' : ''}`
          : `Model: ${activeProfile?.model || 'default'}${profiles.length === 0 ? ' (no profiles)' : ''}`}
        aria-label={zh ? '选择模型' : 'Select model'}
        aria-expanded={openPanel === 'model'}
        data-testid="mts-model-btn"
      >
        <Cpu size={15} />
        {labeled && <span className="mts-icon-label">{zh ? '选择模型' : 'Model'}</span>}
      </button>
      {openPanel === 'model' && (
        <div className="mts-dropdown" role="menu" onClick={(e) => e.stopPropagation()} data-testid="mts-model-dropdown">
          {profiles.length === 0 && <div className="mts-dropdown__empty">{zh ? '没有可切换的模型配置。' : 'No model profiles available.'}</div>}
          {profiles.map((p) => (
            <button key={p.id} type="button" role="menuitem" className={p.id === activeId ? 'mts-active' : ''} onClick={() => void switchTo(p.id)}>
              <strong>{p.model}</strong>
              <small>{p.name}</small>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className={`mts-icon-btn ${openPanel === 'thinking' ? 'mts-icon-btn--open' : ''}`}
        onClick={() => !disabled && setOpenPanel(openPanel === 'thinking' ? null : 'thinking')}
        disabled={disabled}
        title={`${zh ? '思考强度' : 'Thinking effort'}：${activeLevel.label}`}
        aria-label={zh ? '思考强度' : 'Thinking effort'}
        aria-expanded={openPanel === 'thinking'}
        data-testid="mts-thinking-btn"
      >
        <Brain size={15} />
        {labeled ? <span className="mts-icon-label">{`${zh ? '思考强度' : 'Thinking'}：${activeLevel.label}`}</span> : <span className="mts-thinking-badge">{activeLevel.short}</span>}
      </button>
      {openPanel === 'thinking' && (
        <div className="mts-dropdown mts-dropdown--thinking" role="menu" onClick={(e) => e.stopPropagation()} data-testid="mts-thinking-dropdown">
          {THINKING_LEVELS.map((level) => (
            <button key={level.value} type="button" role="menuitem" className={level.value === thinkingLevel ? 'mts-active' : ''} onClick={() => pickLevel(level.value)}>
              <strong>{level.label}</strong>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
