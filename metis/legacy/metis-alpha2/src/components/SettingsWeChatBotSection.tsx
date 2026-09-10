/**
 * SettingsWeChatBotSection — 微信 Bot（METIS-WX-1）。
 *
 * 扫码绑定微信 → 微信里直接与 Metis 对话
 * （/项目 /模型 /状态 /新建 /继续 /停止 /帮助）→ 完成摘要回发。
 * 协议：腾讯官方 iLink Bot API。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from '../i18n';

export type WeChatPhase =
  | 'unbound'
  | 'login_pending'
  | 'login_scaned'
  | 'need_verifycode'
  | 'bound'
  | 'error';

interface WeChatStatusView {
  phase: WeChatPhase;
  botId: string;
  userId: string;
  activeProjectId: string;
  activeSessionId: string;
  boundAt: number;
  busy: boolean;
  lastError: string;
  lastInboundAt: string;
  qrContent: string;
  menuWaiting: boolean;
  recentLog: Array<{ at: string; direction: 'in' | 'out'; text: string }>;
}

interface ProjectSummary {
  id: string;
  title: string;
}

export default function SettingsWeChatBotSection() {
  const { t, locale } = useTranslation();
  const zh = locale === 'zh';
  const [status, setStatus] = useState<WeChatStatusView | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [testText, setTestText] = useState('');
  const mounted = useRef(true);

  const refreshStatus = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.wechatGetStatus) return;
    try {
      const result = await metis.wechatGetStatus();
      if (result.ok && result.status) {
        setStatus(result.status as WeChatStatusView);
      }
    } catch {
      /* settings must not break */
    }
  }, []);

  // Poll login state while a QR login is in progress (same cadence as ZCode's QR poll).
  const pollLogin = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.wechatPollLogin) return;
    try {
      await metis.wechatPollLogin();
      await refreshStatus();
    } catch { /* transient */ }
  }, [refreshStatus]);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void (async () => {
      const metis = window.metis;
      if (!metis?.wechatGetStatus) return;
      try {
        const result = await metis.wechatGetStatus();
        if (!cancelled && result.ok && result.status) {
          setStatus(result.status as WeChatStatusView);
        }
      } catch { /* settings must not break */ }
    })();
    void (async () => {
      const metis = window.metis;
      if (!metis?.listProjects) return;
      try {
        const result = await metis.listProjects();
        if (!cancelled && result.success) setProjects(result.projects);
      } catch { /* ignore */ }
    })();
    const timer = window.setInterval(() => {
      if (!mounted.current) return;
      void refreshStatus();
      // While a QR login is pending, advance the login state machine.
      if (status?.phase === 'login_pending' || status?.phase === 'login_scaned' || status?.phase === 'need_verifycode') {
        void pollLogin();
      }
    }, 3000);
    return () => {
      cancelled = true;
      mounted.current = false;
      if (timer) window.clearInterval(timer);
    };
  }, [refreshStatus, pollLogin, status?.phase]);

  const handleBeginLogin = async () => {
    const metis = window.metis;
    if (!metis?.wechatBeginLogin) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await metis.wechatBeginLogin();
      if (result.ok) {
        await refreshStatus();
      } else {
        setNotice({ type: 'error', message: result.error ?? t('settings.wechatLoginFailed') });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitVerifyCode = async () => {
    const metis = window.metis;
    if (!metis?.wechatSubmitVerifyCode || !verifyCode.trim()) return;
    await metis.wechatSubmitVerifyCode(verifyCode.trim());
    setVerifyCode('');
    await pollLogin();
  };

  const handleLogout = async () => {
    const metis = window.metis;
    if (!metis?.wechatLogout) return;
    await metis.wechatLogout();
    setNotice({ type: 'success', message: t('settings.wechatLogoutDone') });
    await refreshStatus();
  };

  const handleSendTest = async () => {
    const metis = window.metis;
    if (!metis?.wechatSendTest || !testText.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await metis.wechatSendTest(testText.trim());
      setNotice(result.ok
        ? { type: 'success', message: t('settings.wechatTestSent') }
        : { type: 'error', message: result.error ?? t('settings.wechatTestFailed') });
    } finally {
      setBusy(false);
    }
  };

  const handleSetProject = async (projectId: string) => {
    const metis = window.metis;
    if (!metis?.wechatSetProject) return;
    await metis.wechatSetProject(projectId);
    await refreshStatus();
  };

  const phase = status?.phase ?? 'unbound';
  const isBound = phase === 'bound';

  return (
    <div className="settings-group" data-testid="wechat-bot-section">
      <h3>{t('settings.wechatBot')}</h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
        {t('settings.wechatBotDescription')}
      </p>

      {!isBound && (
        <div data-testid="wechat-login-area">
          {phase === 'unbound' || phase === 'error' ? (
            <div>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void handleBeginLogin()}
                disabled={busy}
                data-testid="wechat-begin-login"
              >
                {t('settings.wechatBind')}
              </button>
              {phase === 'error' && status?.lastError && (
                <div role="alert" style={{ marginTop: 8, color: 'var(--status-failed)', fontSize: 13 }}>
                  {status.lastError}
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {/* White canvas stays literal so the QR code always scans. */}
              <div style={{ background: '#fff', padding: 8, borderRadius: 'var(--radius, 4px)' }}>
                {status?.qrContent ? (
                  <QRCodeSVG value={status.qrContent} size={180} data-testid="wechat-qr" />
                ) : (
                  <div style={{ width: 180, height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                    {t('common.loading')}
                  </div>
                )}
              </div>
              <div style={{ maxWidth: 260 }}>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {phase === 'login_scaned' && t('settings.wechatScaned')}
                  {phase === 'need_verifycode' && t('settings.wechatNeedVerifyCode')}
                  {phase === 'login_pending' && t('settings.wechatScanHint')}
                </div>
                {phase === 'need_verifycode' && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                    <input
                      className="settings-input"
                      value={verifyCode}
                      onChange={(e) => setVerifyCode(e.target.value)}
                      placeholder={t('settings.wechatVerifyCodePlaceholder')}
                      style={{ width: 120 }}
                      data-testid="wechat-verify-code"
                    />
                    <button type="button" className="btn-secondary" onClick={() => void handleSubmitVerifyCode()} data-testid="wechat-verify-submit">
                      {t('common.confirm')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {isBound && (
        <div data-testid="wechat-bound-area">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span
              data-testid="wechat-bound-badge"
              style={{
                padding: '3px 10px', borderRadius: 'var(--radius, 4px)', fontSize: 12,
                background: status?.busy ? 'var(--bg-secondary)' : 'var(--status-completed-bg)',
                color: status?.busy ? 'var(--text-secondary)' : 'var(--status-completed)',
              }}
            >
              {status?.busy ? t('settings.wechatWorking') : t('settings.wechatConnected')}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {t('settings.wechatBoundUser')}: {status?.userId || status?.botId || '-'}
            </span>
            <button type="button" className="btn-secondary" onClick={() => void handleLogout()} data-testid="wechat-logout">
              {t('settings.wechatUnbind')}
            </button>
          </div>

          <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('settings.projectSelect')}</label>
            <select
              className="settings-input"
              value={status?.activeProjectId ?? ''}
              onChange={(e) => void handleSetProject(e.target.value)}
              style={{ maxWidth: 260 }}
              data-testid="wechat-project-select"
            >
              <option value="">{t('settings.wechatNoProject')}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.title || project.id}</option>
              ))}
            </select>
          </div>

          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="settings-input"
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
              placeholder={t('settings.wechatTestPlaceholder')}
              style={{ width: 260 }}
              data-testid="wechat-test-input"
            />
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void handleSendTest()}
              disabled={busy || !testText.trim()}
              data-testid="wechat-test-send"
            >
              {t('settings.wechatTestSend')}
            </button>
          </div>

          {status && status.recentLog.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{t('settings.wechatActivity')}</div>
              <div
                data-testid="wechat-log"
                style={{
                  fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-secondary)',
                  borderRadius: 'var(--radius, 4px)', padding: '8px 10px', maxHeight: 140, overflowY: 'auto',
                  lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                }}
              >
                {status.recentLog.map((entry, index) => (
                  <div key={index}>
                    <span style={{ color: entry.direction === 'in' ? 'var(--status-completed)' : 'var(--text-muted)', fontWeight: 600 }}>
                      {entry.direction === 'in' ? (zh ? '收' : 'IN') : (zh ? '发' : 'OUT')}
                    </span>{' '}
                    {entry.text}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {notice && (
        <div
          role={notice.type === 'error' ? 'alert' : 'status'}
          data-testid="wechat-notice"
          style={{
            marginTop: 10, fontSize: 13, padding: '8px 10px', borderRadius: 'var(--radius, 4px)',
            color: notice.type === 'error' ? 'var(--status-failed)' : 'var(--status-completed)',
            background: 'var(--bg-secondary)',
          }}
        >
          {notice.message}
        </div>
      )}
    </div>
  );
}
