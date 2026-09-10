/**
 * SettingsPanel — 设置中心（2026-08-23 精简版）。
 *
 * 高频设置保留在主页面；低频功能归拢到「高级设置」二级弹窗：
 *  - 数据备份、云备份(WebDAV)、核心期刊白名单、市场/集成令牌、开发者诊断
 */

import { useState, useCallback } from 'react';
import { useTranslation } from '../i18n';
import { useMetisStore, isCustomAccent, type AccentSetting, type AccentTheme, type LocaleKey, type ThemeMode } from '../store';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';
import { Settings as SettingsIcon } from 'lucide-react';
import { Select } from './ui';
import SettingsProjectArchiveSection from './SettingsProjectArchiveSection';
import SettingsStorageSection from './SettingsStorageSection';
import SettingsWeChatBotSection from './SettingsWeChatBotSection';
import SettingsImageGenerationSection from './SettingsImageGenerationSection';
import SettingsOutcomePromptsSection from './SettingsOutcomePromptsSection';
import ProviderProfilesSection from './ProviderProfilesSection';
import SettingsAdvancedDialog from './SettingsAdvancedDialog';

export interface SettingsPanelProps {
  uiMode: UIMode;
  onUIModeChange: (mode: UIMode) => void;
}

/** Accent swatch preview colors (light-mode accent values from AcademicTheme.css). */
const ACCENT_OPTIONS: Array<{ id: AccentTheme; labelKey: string; swatch: string }> = [
  { id: 'blue', labelKey: 'settings.accentBlue', swatch: '#2563EB' },
  { id: 'gold', labelKey: 'settings.accentGold', swatch: '#A16207' },
  { id: 'green', labelKey: 'settings.accentGreen', swatch: '#15803D' },
  { id: 'gray', labelKey: 'settings.accentGray', swatch: '#52525B' },
];

export default function SettingsPanel({ uiMode, onUIModeChange }: SettingsPanelProps) {
  const { t, locale, setLocale } = useTranslation();
  const theme = useMetisStore((s) => s.theme);
  const setTheme = useMetisStore((s) => s.setTheme);
  const accent = useMetisStore((s) => s.accent);
  const setAccent = useMetisStore((s) => s.setAccent);
  const diagnosticMode = uiMode === 'diagnostic';
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [issnNotice, setIssnNotice] = useState('');

  const handleIssnImport = useCallback(async () => {
    const result = await window.metis?.importIssnList?.();
    if (!result) { setIssnNotice(t('settings.issnImportUnavailable')); return; }
    setIssnNotice(result.ok
      ? t('settings.issnImportDone', { added: result.added, total: result.totalCandidates ?? 0 })
      : t('settings.issnImportFailed', { error: result.error ?? '' }));
  }, [t]);

  return (
    <div className="placeholder-page settings-page" role="region" aria-label={t('settings.pageTitle')}>
      <h2>{t('settings.pageTitle')}</h2>

      {/* Language + Appearance: one row, two compact columns */}
      <div className="settings-row">
      {/* Language */}
      <div className="settings-group">
        <h3>{t('settings.language')}</h3>
        <p>{t('settings.languageDescription')}</p>
        <label htmlFor="locale-select" className="sr-only">{t('settings.language')}</label>
        <Select
          id="locale-select"
          value={locale}
          onChange={(e) => setLocale(e.target.value as LocaleKey)}
          className="settings-input"
          style={{ width: 200 }}
        >
          <option value="en">English</option>
          <option value="zh">中文</option>
        </Select>
      </div>

      {/* Appearance */}
      <div className="settings-group">
        <h3>{t('settings.appearance')}</h3>
        <p>{t('settings.appearanceDescription')}</p>
        <label htmlFor="theme-select" className="sr-only">{t('settings.appearanceTheme')}</label>
        <Select
          id="theme-select"
          value={theme}
          onChange={(e) => setTheme(e.target.value as ThemeMode)}
          className="settings-input"
          style={{ width: 200 }}
          data-testid="appearance-theme-select"
        >
          <option value="light">{t('common.light')}</option>
          <option value="dark">{t('common.dark')}</option>
          <option value="system">{t('common.themeSystem')}</option>
        </Select>
        <div
          role="radiogroup"
          aria-label={t('settings.appearanceAccent')}
          style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}
        >
          {ACCENT_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={accent === option.id}
              title={t(option.labelKey)}
              aria-label={t(option.labelKey)}
              onClick={() => setAccent(option.id)}
              data-testid={`accent-swatch-${option.id}`}
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: option.swatch,
                border: '2px solid var(--bg-card)',
                boxShadow: accent === option.id ? 'var(--focus-ring)' : '0 0 0 1px var(--border)',
                cursor: 'pointer',
                padding: 0,
              }}
            />
          ))}
          <span aria-hidden="true" style={{ width: 1, height: 20, background: 'var(--border)' }} />
          <label
            htmlFor="accent-custom"
            title={t('settings.accentCustom')}
            style={{
              position: 'relative',
              display: 'inline-block',
              width: 24,
              height: 24,
              borderRadius: '50%',
              border: '2px solid var(--bg-card)',
              boxShadow: isCustomAccent(accent) ? 'var(--focus-ring)' : '0 0 0 1px var(--border)',
              cursor: 'pointer',
              background: 'conic-gradient(#EF4444, #F59E0B, #10B981, #3B82F6, #8B5CF6, #EC4899, #EF4444)',
              overflow: 'hidden',
              padding: 0,
            }}
          >
            <input
              id="accent-custom"
              type="color"
              value={isCustomAccent(accent) ? accent : '#2563EB'}
              onChange={(e) => setAccent(e.target.value as AccentSetting)}
              data-testid="accent-custom-picker"
              aria-label={t('settings.accentCustom')}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer', padding: 0, border: 0 }}
            />
          </label>
        </div>
      </div>
      </div>

      <ProviderProfilesSection />


      {/* Outcome image generation (dedicated provider settings + encrypted API key) */}
      <SettingsImageGenerationSection />
        <SettingsOutcomePromptsSection />

      {/* Diagnostic mode toggle */}
      <div className="settings-group">
        <h3>{t('settings.advancedTitle')}</h3>
        <p>{t('settings.advancedDescription')}</p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={diagnosticMode}
            onChange={(event) => {
              const enabled = event.target.checked;
              onUIModeChange(enabled ? 'diagnostic' : 'normal');
            }}
            data-testid="diagnostic-mode-toggle"
          />
          {t('settings.diagnosticMode')}
        </label>
      </div>

      {/* Complete project archive (METIS-F10) */}
      <SettingsProjectArchiveSection uiMode={uiMode} />

      {/* User-configurable data directory (storage location) */}
      <SettingsStorageSection />

      {/* WeChat Bot (METIS-WX-1) */}
      <SettingsWeChatBotSection />


      {/* 高级设置按钮 */}
      <div className="settings-group">
        <h3>高级设置</h3>
        <p>数据备份、云备份(WebDAV)、核心期刊白名单、市场/集成令牌、开发者诊断。</p>
        <button
          type="button"
          className="btn-sm btn-secondary"
          onClick={() => setAdvancedOpen(true)}
          data-testid="advanced-settings-button"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <SettingsIcon size={14} />
          打开高级设置
        </button>
      </div>

      {/* 高级设置二级弹窗 */}
      <SettingsAdvancedDialog
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
        uiMode={uiMode}
        issnNotice={issnNotice}
        onIssnImport={() => void handleIssnImport()}
      />
    </div>
  );
}
