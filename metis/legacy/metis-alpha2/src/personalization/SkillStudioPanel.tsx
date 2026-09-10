import React from 'react';
import { Sparkles, X } from 'lucide-react';
import type { PersonalizationDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';

/**
 * Skill Studio 对话弹窗（2026-09-05 刘总要求任务 7；2026-09 重构为「创造技能」对话入口）。
 * 用户粘贴经验/工作描述 → AI 萃取为结构化 SKILL（Decision Rules 为核心）
 * → 沙箱快速验证 → 以 SKILL.md 产出交由上层保存进 Personalization 技能库
 * （进入库 ≠ 注册给普通 Agent，遵守任务 7 零可见）。
 * 传入 contextSkill 时把该技能内容作为对话上下文，做定制化优化。
 */

export interface SkillStudioDraft {
  name: string;
  systemPrompt: string;
}

export function SkillStudioDialog({ zh, onSave, onClose, contextSkill }: {
  zh: boolean;
  onSave: (draft: SkillStudioDraft) => Promise<void>;
  onClose: () => void;
  /** 选中已安装技能进入对话时传入：其内容作为优化上下文。 */
  contextSkill?: PersonalizationDefinition | null;
}) {
  const [experience, setExperience] = React.useState(() => {
    if (!contextSkill) return '';
    const markdown = contextSkill.kind === 'skill' ? contextSkill.markdown : '';
    return zh
      ? `[优化现有技能「${contextSkill.name}」]\n说明：${contextSkill.description || '（无）'}\n\n现有技能内容：\n${markdown.slice(0, 12000)}`
      : `[Improve existing skill "${contextSkill.name}"]\nDescription: ${contextSkill.description || '(none)'}\n\nCurrent skill content:\n${markdown.slice(0, 12000)}`;
  });
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const [skill, setSkill] = React.useState<{ name?: string; purpose?: string; whenToUse?: string; whenNotToUse?: string; steps?: string[]; decisionRules?: Array<{ when: string; then: string; doNot?: string }>; evidenceRequirements?: string; qualityCriteria?: string[] } | null>(null);
  const [testMessage, setTestMessage] = React.useState('');
  const [testAnswer, setTestAnswer] = React.useState<string | null>(null);

  const generate = async () => {
    if (!experience.trim() || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await window.metis?.skillStudioGenerate?.({ experience: experience.trim(), source: 'from_experience' });
      if (result?.ok && result.skill) {
        setSkill(result.skill as typeof skill);
        setNotice(zh ? 'AI 已萃取结构化技能。请核对判断规则后保存。' : 'Structured skill extracted. Review the decision rules and save.');
      } else {
        setNotice(result?.message ?? result?.code ?? (zh ? '生成未完成,可重试。' : 'Generation did not finish.'));
      }
    } catch {
      setNotice(zh ? '生成请求未完成,可重试。' : 'Generation request failed; retry.');
    } finally { setBusy(false); }
  };

  const renderSkillMarkdown = (): string => {
    if (!skill) return '';
    const lines: string[] = [`# Skill: ${skill.name ?? ''}`, '', `## 用途\n${skill.purpose ?? ''}`, '', `## 激活条件\n何时使用: ${skill.whenToUse ?? ''}${skill.whenNotToUse ? `\n何时不使用: ${skill.whenNotToUse}` : ''}`];
    if (skill.steps && skill.steps.length > 0) {
      lines.push(`## 方法步骤\n${skill.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`);
    }
    if (skill.decisionRules && skill.decisionRules.length > 0) {
      lines.push(`## 判断规则 (Decision Rules)\n${skill.decisionRules.map((rule, index) => `${index + 1}. IF: ${rule.when}\n   THEN: ${rule.then}${rule.doNot ? `\n   DO NOT: ${rule.doNot}` : ''}`).join('\n')}`);
    }
    if (skill.evidenceRequirements) lines.push(`## 证据要求\n${skill.evidenceRequirements}`);
    if (skill.qualityCriteria && skill.qualityCriteria.length > 0) {
      lines.push(`## 完成标准\n${skill.qualityCriteria.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
    }
    return lines.join('\n');
  };

  const runTest = async () => {
    if (!skill || !testMessage.trim() || busy) return;
    setBusy(true);
    try {
      const result = await window.metis?.skillStudioTestRun?.({ systemPrompt: renderSkillMarkdown(), allowedTools: ['web_search', 'web_fetch'], message: testMessage.trim() });
      setTestAnswer(result?.answer ?? (zh ? '测试未完成,可重试。' : 'Test did not finish.'));
    } finally { setBusy(false); }
  };

  const save = async () => {
    if (!skill) return;
    await onSave({ name: skill.name ?? (zh ? '技能工坊技能' : 'Skill Studio skill'), systemPrompt: renderSkillMarkdown() });
    setNotice(zh ? '已保存到技能库(进入库≠注册给普通 Agent;可被场景编排选用)。' : 'Saved to the skill library.');
    setSkill(null);
    setExperience('');
  };

  return (
    <div className="scai-overlay" data-testid="skill-studio-panel" role="dialog" aria-modal="true" aria-label={zh ? '技能工坊' : 'Skill Studio'}>
      <div className="scai-dialog">
        <header className="scai-dialog__head">
          <h2>{contextSkill
            ? (zh ? `技能工坊：优化「${contextSkill.name}」` : `Skill Studio: improve "${contextSkill.name}"`)
            : (zh ? '技能工坊：把经验变成技能' : 'Skill Studio: turn experience into skills')}</h2>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} aria-label={zh ? '关闭' : 'Close'} data-testid="skill-studio-close"><X size={14} aria-hidden="true" /></button>
        </header>
        <div className="scai-dialog__body">
          <div className="skill-studio__body">
            {contextSkill && <p className="skill-studio__notice">{zh ? '已把该技能现有内容填入下方，可补充要求后由 AI 重新萃取。' : 'The current skill content is prefilled below; add your requirements and let AI re-extract.'}</p>}
            <textarea
              rows={5}
              value={experience}
              placeholder={zh ? '描述你的经验/方法/一次工作过程。例如:我做 CSSCI 论文选题时,一般先判断现实矛盾,再看现有研究回答到哪一步……' : 'Describe your research experience or a recent working session.'}
              onChange={(event) => setExperience(event.target.value)}
              data-testid="skill-studio-experience"
            />
            <div className="skill-studio__sources">
              <button type="button" className="btn-primary btn-sm" disabled={busy || !experience.trim()} onClick={() => void generate()} data-testid="skill-studio-generate">
                <Sparkles size={13} aria-hidden="true" /> {zh ? 'AI 萃取为结构化技能' : 'Extract structured skill'}
              </button>
              {/* from_files(2026-09-05 补全):读取本地文本文件作为经验材料 */}
              <label className="btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
                {zh ? '从文件导入' : 'From files'}
                <input
                  type="file"
                  accept=".md,.markdown,.txt,.json"
                  style={{ display: 'none' }}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    try {
                      const text = await file.text();
                      setExperience((current) => (current ? `${current}

[来自文件 ${file.name}]
${text.slice(0, 18000)}` : `[来自文件 ${file.name}]
${text.slice(0, 18000)}`));
                    } catch { setNotice(zh ? '文件读取失败。' : 'Failed to read file.'); }
                    event.target.value = '';
                  }}
                  data-testid="skill-studio-file-input"
                />
              </label>
              {/* from_session(2026-09-05 补全):粘贴会话历史作为经验材料 */}
              <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={async () => {
                try {
                  const sessions = await window.metis?.listSessions?.();
                  const first = Array.isArray(sessions) ? sessions[0] : undefined;
                  if (!first?.id || !window.metis?.getMessages) { setNotice(zh ? '没有可读取的会话。' : 'No session to read.'); return; }
                  const history = await window.metis.getMessages(first.id);
                  const NL = String.fromCharCode(10);
                  const texts = (Array.isArray(history) ? history : [])
                    .map((message) => message as { role?: string; content?: string })
                    .filter((message) => message.role === 'user' || message.role === 'assistant')
                    .map((message) => `${message.role}: ${message.content ?? ''}`)
                    .join(NL);
                  if (!texts) { setNotice(zh ? '该会话没有可提取的消息。' : 'No messages to extract.'); return; }
                  setExperience((current) => (current ? `${current}${NL}${NL}[来自会话]${NL}${texts.slice(0, 18000)}` : `[来自会话]${NL}${texts.slice(0, 18000)}`));
                  setNotice(zh ? '已读取最近会话内容作为经验材料。' : 'Session history appended.');
                } catch { setNotice(zh ? '会话读取失败。' : 'Failed to read session.'); }
              }} data-testid="skill-studio-from-session">
                {zh ? '从最近会话导入' : 'From session'}
              </button>
            </div>
            {skill && (
              <div className="skill-studio__result" data-testid="skill-studio-result">
                <strong>{skill.name}</strong>
                {skill.purpose && <p>{skill.purpose}</p>}
                {skill.decisionRules && skill.decisionRules.length > 0 && (
                  <div>
                    <strong>{zh ? '判断规则' : 'Decision rules'}</strong>
                    <ul>{skill.decisionRules.map((rule, index) => <li key={index}>IF {rule.when} → THEN {rule.then}{rule.doNot ? ` / DO NOT: ${rule.doNot}` : ''}</li>)}</ul>
                  </div>
                )}
                <label className="skill-studio__test-label">{zh ? '测试运行(沙箱)' : 'Test run (sandbox)'}
                  <input value={testMessage} placeholder={zh ? '给一个真实案例' : 'Give a real case'} onChange={(event) => setTestMessage(event.target.value)} data-testid="skill-studio-test-input" />
                </label>
                <button type="button" className="btn-secondary btn-sm" disabled={busy || !testMessage.trim()} onClick={() => void runTest()} data-testid="skill-studio-test-run">{zh ? '测试技能' : 'Test skill'}</button>
                {testAnswer && <pre className="skill-studio__test-answer">{testAnswer}</pre>}
                <button type="button" className="btn-primary btn-sm" onClick={() => void save()} data-testid="skill-studio-save">{zh ? '保存到技能库' : 'Save to library'}</button>
              </div>
            )}
            {notice && <p className="skill-studio__notice" role="status">{notice}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
