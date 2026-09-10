import { useState } from 'react';
import { type ScenarioStepCardData } from '../components/ScenarioStepCard';

export interface StepCardActionsProps {
  card: ScenarioStepCardData;
  /** 提出意见/修改这步：交由宿主（ChatPage）打开 Composer Target Context。 */
  onComment: (card: ScenarioStepCardData, mode: 'comment' | 'modify') => void;
  onNotice?: (text: string) => void;
}

/**
 * Step 三操作版卡片（T3 二期）：提出意见 / 修改这步 / 重做 / ···(跳过)。
 * 语义区分（文档三十四节）：
 *  - 提出意见：Composer Target Context，纯对话，不改 Step；
 *  - 修改这步：redo 分支（guidance=基于当前结果修改），旧 Revision 保留；
 *  - 重做：从输入重执行，下游自动重置（既有 applyStepControl 机制）。
 */
export function ScenarioStepCardWithActions({ card, onComment, onNotice }: StepCardActionsProps) {
  const [guidanceOpen, setGuidanceOpen] = useState<'redo' | 'modify' | null>(null);
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const control = async (action: 'redo' | 'skip', guidanceOverride?: string) => {
    if (busy) return;
    setBusy(action);
    setNotice(null);
    try {
      const result = await window.metis?.scenarioStepControl?.({
        sessionId: card.sessionId,
        stepId: card.stepId,
        action,
        ...(action === 'redo' ? { guidance: guidanceOverride ?? guidance } : {}),
      });
      if (!result) {
        setNotice({ ok: false, text: '当前版本不支持步骤控制' });
      } else if (result.ok) {
        setNotice({ ok: true, text: result.message });
        setGuidanceOpen(null);
        setGuidance('');
        onNotice?.(result.message);
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
        <span className="scenario-step-card__chars">约 {card.chars.toLocaleString('en-US')} 字符 · 右侧面板可看全文</span>
      </div>
      <div className="scenario-step-card__actions">
        {guidanceOpen ? (
          <div className="scenario-step-card__guidance">
            <textarea
              value={guidance}
              onChange={(event) => setGuidance(event.target.value)}
              placeholder={guidanceOpen === 'modify'
                ? '要怎么修改这一步的结果？例如：把理论框架重新整理为劳动过程理论→工作场所学习→职业分层…'
                : '重做指导（可选），例如：重新检索，把 CSSCI 与英文文献分开分析…'}
              rows={3}
              autoFocus
            />
            <div className="scenario-step-card__guidance-actions">
              <button type="button" disabled={busy !== null} onClick={() => void control('redo')}>
                {busy === 'redo' ? (guidanceOpen === 'modify' ? '生成新版本…' : '重做中…') : guidanceOpen === 'modify' ? '生成新版本' : '确认重做'}
              </button>
              <button type="button" className="secondary" onClick={() => { setGuidanceOpen(null); setGuidance(''); }}>取消</button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" disabled={busy !== null} onClick={() => onComment(card, 'comment')}>提出意见</button>
            <button type="button" disabled={busy !== null} onClick={() => onComment(card, 'modify')}>修改这步</button>
            <button type="button" disabled={busy !== null} onClick={() => setGuidanceOpen('redo')}>重做</button>
            <span style={{ position: 'relative' }}>
              <button type="button" disabled={busy !== null} onClick={() => setMoreOpen((open) => !open)} aria-label="更多操作">···</button>
              {moreOpen && (
                <span style={{ position: 'absolute', top: '100%', left: 0, zIndex: 30, display: 'flex', flexDirection: 'column', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: 'var(--shadow-2)', minWidth: 120 }}>
                  <button type="button" disabled={busy !== null} onClick={() => { setMoreOpen(false); void control('skip'); }} style={{ textAlign: 'left' }}>
                    {busy === 'skip' ? '处理中…' : '跳过此步'}
                  </button>
                </span>
              )}
            </span>
          </>
        )}
      </div>
      {notice && (
        <div className={`scenario-step-card__notice ${notice.ok ? 'is-ok' : 'is-error'}`} role="status">{notice.text}</div>
      )}
    </div>
  );
}
