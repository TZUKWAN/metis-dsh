/**
 * AutonomousSetupPanel — 自主科研配置中心（自主改造 C）。
 *
 * 不基于任何现有项目：用户给提示词（方向/要求）+ 项目数量，系统结合
 * 用户画像（行为习惯/背景）与独立约束，批量生成 N 个差异化选题并入队。
 * 约束（领域/方法/成果/期刊层次/语言/篇幅/自定义规则）独立持久化。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import { showToast } from '../lib/toast';
import './AutonomousSetupPanel.css';

interface ProfileView {
  defaultPrompt: string;
  defaultBatchSize: number;
  injectUserProfile: boolean;
  constraints: {
    fieldPreference: string;
    methodPreference: string;
    outputForm: string;
    journalTier: string;
    language: string;
    lengthTarget: string;
    customRules: string[];
  };
}

interface TopicPreview {
  title: string;
  researchQuestion: string;
  rationale: string;
}

export default function AutonomousSetupPanel({ onStarted }: { onStarted?: () => void }) {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(3);
  const [constraintsOpen, setConstraintsOpen] = useState(false);
  const [hardRules, setHardRules] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [topics, setTopics] = useState<TopicPreview[]>([]);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let alive = true;
    void window.metis?.getAutonomousProfile?.().then((loaded) => {
      if (!alive || !loaded) return;
      setProfile(loaded);
      setPrompt(loaded.defaultPrompt);
      setCount(loaded.defaultBatchSize);
    });
    void window.metis?.getAutonomousHardRules?.().then((rules) => {
      if (alive && Array.isArray(rules)) setHardRules(rules);
    });
    return () => { alive = false; };
  }, []);

  const saveProfile = useCallback(async (patch: Record<string, unknown>) => {
    const saved = await window.metis?.saveAutonomousProfile?.(patch);
    if (saved) {
      const loaded = await window.metis?.getAutonomousProfile?.();
      if (loaded) setProfile(loaded);
    }
  }, []);

  const generate = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.generateAutonomousBatch || !prompt.trim() || generating) return;
    setGenerating(true);
    setNotice(t('autonomousSetup.generating'));
    setTopics([]);
    const result = await metis.generateAutonomousBatch({ prompt: prompt.trim(), count });
    setGenerating(false);
    if (!result.ok) {
      setNotice(t('autonomousSetup.generateFailed', { error: result.error ?? (result.raw ?? '') }));
      showToast({ kind: 'error', text: t('autonomousSetup.generateFailedToast') });
      return;
    }
    setTopics(result.topics ?? []);
    setNotice(t('autonomousSetup.generated', { added: result.added ?? 0, total: (result.topics ?? []).length }));
    showToast({ kind: 'success', text: t('autonomousSetup.generatedToast', { count: result.added ?? 0 }) });
    onStarted?.();
  }, [prompt, count, generating, t, onStarted]);

  const updateConstraint = useCallback((key: string, value: string | boolean | number) => {
    if (!profile) return;
    void saveProfile({ constraints: { ...profile.constraints, [key]: value } });
  }, [profile, saveProfile]);

  if (!profile) return null;

  return (
    <section className="auto-setup" data-testid="auto-setup">
      <header className="auto-setup__header">
        <h2>{t('autonomousSetup.title')}</h2>
        <span className="auto-setup__subtitle">{t('autonomousSetup.subtitle')}</span>
      </header>

      <div className="auto-setup__prompt-row">
        <textarea
          className="settings-input auto-setup__prompt"
          rows={4}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t('autonomousSetup.promptPlaceholder')}
          data-testid="auto-setup-prompt"
        />
      </div>

      <div className="auto-setup__controls">
        <div className="auto-setup__count" role="radiogroup" aria-label={t('autonomousSetup.countLabel')}>
          <span className="auto-setup__count-label">{t('autonomousSetup.countLabel')}</span>
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={count === value}
              className={`auto-setup__count-btn ${count === value ? 'auto-setup__count-btn--active' : ''}`}
              onClick={() => { setCount(value); void saveProfile({ defaultBatchSize: value }); }}
              data-testid={`auto-setup-count-${value}`}
            >
              {value}
            </button>
          ))}
        </div>
        <label className="library-search__check">
          <input
            type="checkbox"
            checked={profile.injectUserProfile}
            onChange={(event) => void saveProfile({ injectUserProfile: event.target.checked })}
            data-testid="auto-setup-profile-toggle"
          />
          {t('autonomousSetup.injectProfile')}
        </label>
        <button
          type="button"
          className="btn-sm btn-secondary"
          onClick={() => setConstraintsOpen((value) => !value)}
          data-testid="auto-setup-constraints-toggle"
        >
          {t('autonomousSetup.constraintsButton')}
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={!prompt.trim() || generating}
          onClick={() => void generate()}
          data-testid="auto-setup-generate"
        >
          {generating ? t('common.testing') : t('autonomousSetup.generate', { count })}
        </button>
      </div>

      {notice && <div role="status" className="auto-setup__notice" data-testid="auto-setup-notice">{notice}</div>}

      {topics.length > 0 && (
        <ul className="auto-setup__topics" data-testid="auto-setup-topics">
          {topics.map((topic, index) => (
            <li key={index} className="auto-setup__topic" data-testid="auto-setup-topic">
              <div className="auto-setup__topic-head">
                <span className="auto-setup__topic-index">{index + 1}</span>
                <span className="auto-setup__topic-title">{topic.title}</span>
              </div>
              <p className="auto-setup__topic-question">{topic.researchQuestion}</p>
              {topic.rationale && <p className="auto-setup__topic-rationale">{topic.rationale}</p>}
            </li>
          ))}
        </ul>
      )}

      {constraintsOpen && (
        <div className="auto-setup__constraints" data-testid="auto-setup-constraints">
          <div className="auto-setup__constraint-row">
            <label>{t('autonomousSetup.field')}
              <input className="settings-input" value={profile.constraints.fieldPreference} onChange={(e) => updateConstraint('fieldPreference', e.target.value)} data-testid="auto-setup-field" />
            </label>
            <label>{t('autonomousSetup.method')}
              <select className="settings-input" value={profile.constraints.methodPreference} onChange={(e) => updateConstraint('methodPreference', e.target.value)} data-testid="auto-setup-method">
                <option value="any">{t('autonomousSetup.anyMethod')}</option>
                <option value="quantitative">{t('autonomousSetup.quant')}</option>
                <option value="qualitative">{t('autonomousSetup.qual')}</option>
                <option value="mixed">{t('autonomousSetup.mixed')}</option>
              </select>
            </label>
            <label>{t('autonomousSetup.outputForm')}
              <select className="settings-input" value={profile.constraints.outputForm} onChange={(e) => updateConstraint('outputForm', e.target.value)} data-testid="auto-setup-output">
                <option value="journal_article">{t('autonomousSetup.journalArticle')}</option>
                <option value="report">{t('autonomousSetup.report')}</option>
                <option value="any">{t('autonomousSetup.anyOutput')}</option>
              </select>
            </label>
            <label>{t('autonomousSetup.journalTier')}
              <select className="settings-input" value={profile.constraints.journalTier} onChange={(e) => updateConstraint('journalTier', e.target.value)} data-testid="auto-setup-tier">
                <option value="core">{t('autonomousSetup.coreJournals')}</option>
                <option value="general">{t('autonomousSetup.generalJournals')}</option>
                <option value="any">{t('autonomousSetup.anyTier')}</option>
              </select>
            </label>
            <label>{t('autonomousSetup.language')}
              <select className="settings-input" value={profile.constraints.language} onChange={(e) => updateConstraint('language', e.target.value)} data-testid="auto-setup-language">
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
            </label>
            <label>{t('autonomousSetup.length')}
              <input className="settings-input" value={profile.constraints.lengthTarget} onChange={(e) => updateConstraint('lengthTarget', e.target.value)} data-testid="auto-setup-length" />
            </label>
          </div>
          <label className="auto-setup__rules-label">{t('autonomousSetup.customRules')}</label>
          <textarea
            className="settings-input auto-setup__rules"
            rows={3}
            value={profile.constraints.customRules.join('\n')}
            onChange={(event) => void saveProfile({ constraints: { ...profile.constraints, customRules: event.target.value.split('\n').filter((line) => line.trim()) } })}
            placeholder={t('autonomousSetup.rulesPlaceholder')}
            data-testid="auto-setup-rules"
          />
          {hardRules.length > 0 && (
            <details className="auto-setup__hard-rules">
              <summary>{t('autonomousSetup.hardRules')}</summary>
              <ul>
                {hardRules.map((rule, index) => (
                  <li key={index}>{rule}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
