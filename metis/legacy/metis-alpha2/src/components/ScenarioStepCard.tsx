/**
 * ScenarioStepCard — 场景工作流步骤卡（2026-09-01 刘总方案）。
 *
 * 聊天里的每一步不再是干巴巴的「完成✓」，而是一张可交互卡片：
 *   思路 / 结果 / 下一步（模型按 step_brief 契约汇报，剥离自产物正文）
 *   [✍ 指导重做] [⏭ 跳过] —— 落库成功后自动补发「继续」恢复运行。
 *
 * 渲染路径：消息中的 ```metis-step-card 围栏块由 SafeMarkdown 的 codeComponent
 * 拦截进入本组件（ChatPage 接线）；JSON 解析失败时降级为普通代码块展示。
 */
import { useState } from 'react';

export interface ScenarioStepCardData {
  v: number;
  runId: string;
  sessionId: string;
  stepId: string;
  stepName: string;
  iteration: number;
  status: 'completed' | 'final';
  brief: { approach: string; result: string; next: string } | null;
  artifactName: string;
  chars: number;
  scenarioId: string;
}

export function parseScenarioStepCard(code: string): ScenarioStepCardData | null {
  try {
    const value = JSON.parse(code) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const card = value as Partial<ScenarioStepCardData>;
    if (card.v !== 1 || typeof card.stepId !== 'string' || typeof card.sessionId !== 'string') return null;
    if (card.status !== 'completed' && card.status !== 'final') return null;
    return card as ScenarioStepCardData;
  } catch {
    return null;
  }
}

export function ScenarioStepCard({ card }: { card: ScenarioStepCardData }) {
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState<'redo' | 'skip' | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const control = async (action: 'redo' | 'skip') => {
    if (busy) return;
    setBusy(action);
    setNotice(null);
    try {
      const result = await window.metis?.scenarioStepControl?.({
        sessionId: card.sessionId,
        stepId: card.stepId,
        action,
        ...(action === 'redo' ? { guidance } : {}),
      });
      if (!result) {
        setNotice({ ok: false, text: '当前版本不支持步骤控制' });
      } else if (result.ok) {
        setNotice({ ok: true, text: result.message });
        setGuidanceOpen(false);
        setGuidance('');
        window.dispatchEvent(new CustomEvent('metis:scenario-continue', { detail: { sessionId: card.sessionId } }));
      } else {
        setNotice({ ok: false, text: result.message || `操作失败（${result.code}）` });
      }
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : '操作失败' });
    } finally {
      setBusy(null);
    }
  };

  const isFinal = card.status === 'final';
  return (
    <div className="scenario-step-card" data-testid="scenario-step-card" data-step-id={card.stepId}>
      <div className="scenario-step-card__head">
        <span className={`scenario-step-card__badge ${isFinal ? 'is-final' : ''}`}>
          {isFinal ? '最终成果' : `第 ${card.iteration} 轮`}
        </span>
        <strong className="scenario-step-card__name">{card.stepName}</strong>
        <span className="scenario-step-card__status">已完成 ✓</span>
      </div>
      {card.brief && (
        <dl className="scenario-step-card__brief">
          <div><dt>思路</dt><dd>{card.brief.approach}</dd></div>
          <div><dt>结果</dt><dd>{card.brief.result}</dd></div>
          <div><dt>下一步</dt><dd>{card.brief.next}</dd></div>
        </dl>
      )}
      <div className="scenario-step-card__artifact">
        产出：<code>{card.artifactName}</code>
        <span className="scenario-step-card__chars">约 {card.chars.toLocaleString('en-US')} 字符 · 右侧「生成物」面板可看全文</span>
      </div>
      <div className="scenario-step-card__actions">
        {guidanceOpen ? (
          <div className="scenario-step-card__guidance">
            <textarea
              value={guidance}
              onChange={(event) => setGuidance(event.target.value)}
              placeholder="写下您对这一步的要求，例如：把定量研究也纳入，重点看近5年文献…"
              rows={3}
              autoFocus
            />
            <div className="scenario-step-card__guidance-actions">
              <button type="button" disabled={busy !== null} onClick={() => void control('redo')}>
                {busy === 'redo' ? '提交中…' : '按指导重做'}
              </button>
              <button type="button" className="secondary" onClick={() => { setGuidanceOpen(false); setGuidance(''); }}>取消</button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" disabled={busy !== null} onClick={() => setGuidanceOpen(true)}>引导</button>
            <button type="button" disabled={busy !== null} onClick={() => void control('skip')}>
              {busy === 'skip' ? '处理中…' : '跳过'}
            </button>
          </>
        )}
      </div>
      {notice && (
        <div className={`scenario-step-card__notice ${notice.ok ? 'is-ok' : 'is-error'}`} role="status">{notice.text}</div>
      )}
    </div>
  );
}
