/**
 * SettingsHealthSection — startup health issues + diagnostic bundle export
 * (Task 5 §16/§17 renderer surface).
 *
 * Shows ONLY the problems a user needs to act on (the main process already
 * filters healthy detail out of `issues`), plus a one-click sanitized
 * diagnostic bundle export. Placed in 设置 → 诊断 so normal users see it only
 * when something actually needs attention.
 */

import { useState, useEffect, useCallback } from 'react';

interface HealthIssue {
  id: string;
  severity: 'warning' | 'error';
  message: string;
}

interface HealthReport {
  appVersion?: string;
  issues?: HealthIssue[];
  collectedAt?: string;
  error?: string;
}

export default function SettingsHealthSection() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [exportState, setExportState] = useState<{ busy: boolean; message: string | null; ok: boolean }>({
    busy: false,
    message: null,
    ok: false,
  });

  const loadHealth = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.getHealthReport) return;
    try {
      const result = await metis.getHealthReport() as HealthReport;
      setReport(result);
    } catch (err) {
      console.warn('Failed to load health report:', err);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async loader, setState happens in .then()
    void loadHealth();
  }, [loadHealth]);

  const handleExport = async () => {
    const metis = window.metis;
    if (!metis?.exportDiagnosticBundle || exportState.busy) return;
    setExportState({ busy: true, message: null, ok: false });
    try {
      const result = await metis.exportDiagnosticBundle();
      if (result?.ok && result.path) {
        setExportState({ busy: false, message: `诊断包已导出：${result.path}`, ok: true });
      } else {
        setExportState({ busy: false, message: `导出失败：${result?.error ?? '未知错误'}`, ok: false });
      }
    } catch (err) {
      setExportState({ busy: false, message: `导出失败：${String(err)}`, ok: false });
    }
  };

  const issues = report?.issues ?? [];

  return (
    <div className="settings-group" data-testid="health-report-section">
      <h3>系统健康</h3>
      <p>仅列出需要处理的问题；未列出的子系统均正常。</p>

      {report === null && (
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>正在读取健康状态…</p>
      )}

      {report !== null && report.error && (
        <p style={{ fontSize: 13, color: 'var(--status-failed)' }}>健康报告不可用：{report.error}</p>
      )}

      {report !== null && !report.error && issues.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--status-completed)' }}>✓ 系统状态良好，无需处理。</p>
      )}

      {issues.map((issue) => (
        <div
          key={`${issue.id}-${issue.message.slice(0, 24)}`}
          data-testid={`health-issue-${issue.id}`}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
            border: `1px solid ${issue.severity === 'error' ? 'var(--status-failed)' : 'var(--border)'}`,
            borderLeft: `4px solid ${issue.severity === 'error' ? 'var(--status-failed)' : 'var(--status-running, var(--border))'}`,
            borderRadius: 6, marginBottom: 8, background: 'var(--bg-secondary)',
          }}
        >
          <span style={{ fontSize: 14, lineHeight: 1.5 }}>{issue.severity === 'error' ? '⛔' : '⚠️'}</span>
          <span style={{ fontSize: 13, lineHeight: 1.6 }}>{issue.message}</span>
        </div>
      ))}

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          className="btn-secondary"
          data-testid="export-diagnostic-bundle"
          disabled={exportState.busy}
          onClick={() => void handleExport()}
        >
          {exportState.busy ? '正在导出…' : '导出诊断信息'}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          诊断包仅含版本、健康状态与日志摘要，不含 API 密钥、聊天记录或研究数据。
        </span>
      </div>
      {exportState.message && (
        <p
          data-testid="diagnostic-bundle-result"
          style={{
            fontSize: 12, marginTop: 8,
            color: exportState.ok ? 'var(--status-completed)' : 'var(--status-failed)',
            wordBreak: 'break-all',
          }}
        >
          {exportState.message}
        </p>
      )}
    </div>
  );
}
