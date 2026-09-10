import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';
import type {
  ApprovalRequestView,
  ApprovalAction,
} from '../../engine/runtime/ApprovalRuntimeContract';

function requestKey(request: ApprovalRequestView): string {
  return request.requestId ?? `approval-${request.createdAt}`;
}

function actionLabelKey(action: ApprovalAction): string {
  switch (action) {
    case 'read_source': return 'approval.actionReadSource';
    case 'write_research_data': return 'approval.actionWriteResearchData';
    case 'access_external_source': return 'approval.actionAccessExternalSource';
    case 'run_analysis': return 'approval.actionRunAnalysis';
    case 'perform_research_action': return 'approval.actionResearch';
  }
}

export interface ApprovalQueueProps {
  uiMode?: UIMode;
}

export default function ApprovalQueue({ uiMode = 'normal' }: ApprovalQueueProps) {
  const { t } = useTranslation();
  const [requests, setRequests] = useState<ApprovalRequestView[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    const metis = window.metis;
    if (!metis) return;

    const mergeRequests = (
      existing: ApprovalRequestView[],
      incoming: ApprovalRequestView[],
    ): ApprovalRequestView[] => {
      const map = new Map(existing.map((request) => [requestKey(request), request]));
      for (const request of incoming) {
        const key = requestKey(request);
        if (!map.has(key)) map.set(key, request);
      }
      return [...map.values()].sort((a, b) => a.createdAt - b.createdAt);
    };

    void metis.getPendingApprovals().then((pending) => {
      if (pending.length > 0) setRequests((current) => mergeRequests(current, pending));
    }).catch(() => undefined);

    if (!metis.onApprovalRequired) return;
    return metis.onApprovalRequired((request) => {
      setRequests((current) => mergeRequests(current, [request]));
    });
  }, []);

  // P1-12：原生嵌入视图（协同页第三方 AI / 内嵌浏览器）是 WebContentsView，
  // 永远绘制在渲染层 DOM 之上。审批队列浮窗打开时必须先隐藏它们，否则浮窗
  // 会被盖住；关闭时按 App.tsx ApprovalToastGate 的同一模式通知各页恢复。
  useEffect(() => {
    if (!isOpen) return;
    const metis = window.metis;
    void metis?.collabHide?.();
    void metis?.browserHide?.();
    return () => {
      // 仅当没有其他全局模态接管屏幕时才恢复嵌入视图。
      if (document.querySelector('[aria-modal="true"]') === null) {
        window.dispatchEvent(new CustomEvent('metis:restore-embedded-views'));
      }
    };
  }, [isOpen]);

  const handleRespond = async (targetKey: string, approved: boolean) => {
    const metis = window.metis;
    if (!metis?.respondApproval) return;
    const request = requests.find((r) => requestKey(r) === targetKey);
    if (!request) return;
    const result = await metis.respondApproval(request.requestId ?? targetKey, approved);
    if (result.success) {
      setRequests((current) => current.filter((r) => requestKey(r) !== targetKey));
      setExpandedId((current) => (current === targetKey ? null : current));
    }
  };

  const handleRespondAll = async (approved: boolean) => {
    const metis = window.metis;
    if (!metis?.respondApproval) return;
    const results = await Promise.all(
      requests.map((request) => metis.respondApproval(request.requestId, approved)),
    );
    const completed = new Set(
      requests.filter((_request, index) => results[index]?.success).map((request) => request.requestId),
    );
    setRequests((current) => current.filter((request) => !completed.has(request.requestId)));
    setExpandedId(null);
  };

  if (requests.length === 0 && !isOpen) return null;

  const canShowTechnicalDetails = uiMode === 'diagnostic';

  return (
    <>
      <button
        className="approval-queue-toggle"
        onClick={() => setIsOpen((open) => !open)}
        aria-label={t('approval.queueToggle')}
        aria-expanded={isOpen}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        {requests.length > 0 && <span className="approval-queue-badge">{requests.length}</span>}
      </button>

      {isOpen && (
        <section className="approval-queue-panel" aria-label={t('approval.queueTitle')}>
          <div className="approval-queue-header">
            <h3>{t('approval.queueTitle')}</h3>
            <button className="approval-queue-close" onClick={() => setIsOpen(false)} aria-label={t('common.close')}>
              ×
            </button>
          </div>

          {requests.length === 0 ? (
            <div className="approval-queue-empty">{t('approval.noPending')}</div>
          ) : (
            <>
              <div className="approval-queue-actions">
                <button className="btn-primary btn-sm" onClick={() => { void handleRespondAll(true); }}>
                  {t('approval.approveAll')}
                </button>
                <button className="btn-secondary btn-sm" onClick={() => { void handleRespondAll(false); }}>
                  {t('approval.rejectAll')}
                </button>
              </div>
              <ul className="approval-queue-list">
                {requests.map((request) => {
                  const key = requestKey(request);
                  const isExpanded = expandedId === key;
                  return (
                    <li key={key} className="approval-queue-item">
                      <div className="approval-queue-item-header">
                        <span className="approval-queue-tool">{t(actionLabelKey(request.action))}</span>
                        <span className="approval-queue-reason">{t('approval.safeSummary')}</span>
                      </div>
                      {canShowTechnicalDetails && (
                        <div className="approval-queue-disclosure">
                          <button
                            className="approval-queue-disclosure-toggle"
                            onClick={() => setExpandedId(isExpanded ? null : key)}
                            aria-expanded={isExpanded}
                          >
                            {t('approval.expandDetails')}
                          </button>
                        </div>
                      )}
                      {isExpanded && (
                        <div className="approval-queue-technical-details">
                          <div>
                            <strong>{t('approval.technicalAction')}:</strong> {request.action}
                          </div>
                          <div>
                            <strong>requestId:</strong> {request.requestId}
                          </div>
                          <div>
                            <strong>createdAt:</strong> {new Date(request.createdAt).toISOString()}
                          </div>
                        </div>
                      )}
                      <div className="approval-queue-item-actions">
                        <button className="btn-secondary btn-sm" onClick={() => { void handleRespond(key, false); }}>
                          {t('approval.reject')}
                        </button>
                        <button className="btn-primary btn-sm" onClick={() => { void handleRespond(key, true); }}>
                          {t('approval.approve')}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      )}
    </>
  );
}
