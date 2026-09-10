/**
 * ScenarioApprovalToast — 场景步骤审批的页内界面。
 *
 * 主进程的 approval Hook 通过 'scenario:approval:required' 推送请求；用户在
 * 当前页面直接批准/拒绝（比原生弹框更可见、可键盘操作、可自动化驱动）。
 * 120 秒无响应由主进程 fail-closed（视为拒绝）。
 */
import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, ShieldX } from 'lucide-react';
import { useTranslation } from '../i18n';

interface ApprovalRequest {
  requestId: string;
  hookId: string;
  stepId: string;
  instruction: string;
  runId: string;
}

export default function ScenarioApprovalToast() {
  const { locale } = useTranslation();
  const zh = locale === 'zh';
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const requestRef = useRef<ApprovalRequest | null>(null);

  useEffect(() => {
    const metis = window.metis;
    if (!metis?.onScenarioApprovalRequired) return;
    const dispose = metis.onScenarioApprovalRequired((payload) => {
      // 组件层再校验一次：非法推送（无 requestId）直接忽略。
      if (!payload || typeof payload.requestId !== 'string' || !payload.requestId) return;
      requestRef.current = payload;
      setRequest(payload);
    });
    return dispose;
  }, []);

  if (!request) return null;

  const respond = async (approve: boolean) => {
    const current = requestRef.current;
    if (!current || busy) return;
    setBusy(true);
    try {
      await window.metis?.respondScenarioApproval?.(current.requestId, approve);
    } finally {
      requestRef.current = null;
      setRequest(null);
      setBusy(false);
    }
  };

  return (
    <div
      className="scenario-approval-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={zh ? '场景步骤审批' : 'Scenario step approval'}
      data-testid="scenario-approval-dialog"
    >
      <div className="scenario-approval-card">
        <h3><ShieldCheck size={16} aria-hidden="true" /> {zh ? '场景步骤审批' : 'Scenario step approval'}</h3>
        <p className="scenario-approval-step">
          {zh ? `步骤「${request.stepId}」请求执行审批` : `Step "${request.stepId}" requests approval`}
        </p>
        {request.instruction && <p className="scenario-approval-instruction">{request.instruction}</p>}
        <p className="scenario-approval-note">
          {zh ? '120 秒内未响应将自动拒绝（fail-closed）。' : 'No response within 120 seconds is rejected (fail-closed).'}
        </p>
        <div className="scenario-approval-actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void respond(false)}
            data-testid="scenario-approval-reject"
          >
            <ShieldX size={13} aria-hidden="true" /> {zh ? '拒绝' : 'Reject'}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => void respond(true)}
            data-testid="scenario-approval-approve"
          >
            <ShieldCheck size={13} aria-hidden="true" /> {zh ? '批准执行' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  );
}
