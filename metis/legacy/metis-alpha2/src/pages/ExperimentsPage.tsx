import { useState, useEffect, useRef, useCallback } from 'react';
import SearchInput from '../components/SearchInput';
import ConfirmDialog from '../components/ConfirmDialog';
import { useMetisStore } from '../store';
import type { ExperimentItem } from '../store';
import { useTranslation } from '../i18n';
import {
  decodeExperimentExecutionGrantResult,
  decodeExperimentRunResult,
  decodeExperimentScriptAttachResult,
  type ExperimentRunStatus,
  type ExperimentRuntimeStatus,
  type ExperimentScriptFailureCode,
} from '../../engine/runtime/ExperimentRuntimeContract';

const STATUS_CSS_VARS: Record<ExperimentItem['status'], string> = {
  planned: 'var(--text-secondary)',
  running: 'var(--status-running)',
  completed: 'var(--status-completed)',
  failed: 'var(--status-failed)',
  cancelled: 'var(--text-muted)',
};

type ExperimentApiMethod =
  | 'attachExperimentScript'
  | 'requestExperimentRunGrant'
  | 'runExperiment'
  | 'cancelExperiment';

const RUNTIME_STATUS_COPY: Record<'en' | 'zh', Record<ExperimentRuntimeStatus, string>> = {
  en: {
    not_attached: 'No script attached',
    attaching: 'Importing script…',
    ready: 'Ready',
    requesting_grant: 'Requesting execution authorization…',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    timed_out: 'Timed out',
    cancelled: 'Cancelled',
    rejected: 'Rejected',
    runtime_unavailable: 'Controlled runtime unavailable',
  },
  zh: {
    not_attached: '尚未附加脚本',
    attaching: '正在导入脚本…',
    ready: '已就绪',
    requesting_grant: '正在请求执行授权…',
    running: '正在运行',
    completed: '运行完成',
    failed: '运行失败',
    timed_out: '运行超时',
    cancelled: '已取消',
    rejected: '已拒绝',
    runtime_unavailable: '受控运行时不可用',
  },
};

const RUNTIME_FAILURE_COPY: Record<'en' | 'zh', Record<ExperimentScriptFailureCode, string>> = {
  en: {
    experiment_script_unavailable: 'Script selection is unavailable.',
    experiment_script_type_unsupported: 'Use a Python or Node.js script (.py, .js, .mjs, or .cjs).',
    experiment_script_too_large: 'The script exceeds the 4 MiB safety limit.',
    experiment_script_not_text: 'The script must be valid UTF-8 text without unsafe control characters.',
    experiment_script_copy_failed: 'The script could not be copied into managed storage.',
    experiment_script_not_attached: 'Attach a script before requesting a run.',
    experiment_runtime_unavailable: 'A controlled runtime is not available.',
    experiment_grant_unavailable: 'Execution authorization is unavailable.',
    experiment_run_rejected: 'The run request was rejected.',
    experiment_run_timeout: 'The experiment exceeded its execution time limit.',
    experiment_run_failed: 'The experiment failed. Detailed output remains in protected desktop logs.',
    experiment_result_unavailable: 'A safe experiment result is unavailable.',
  },
  zh: {
    experiment_script_unavailable: '当前无法选择脚本。',
    experiment_script_type_unsupported: '仅支持 Python 或 Node.js 脚本（.py、.js、.mjs、.cjs）。',
    experiment_script_too_large: '脚本超过 4 MiB 安全上限。',
    experiment_script_not_text: '脚本必须是有效 UTF-8 文本，且不能包含不安全控制字符。',
    experiment_script_copy_failed: '脚本无法复制到受管存储。',
    experiment_script_not_attached: '请先附加脚本，再请求运行。',
    experiment_runtime_unavailable: '受控运行时不可用。',
    experiment_grant_unavailable: '当前无法取得执行授权。',
    experiment_run_rejected: '运行请求已被拒绝。',
    experiment_run_timeout: '实验运行超过时间限制。',
    experiment_run_failed: '实验运行失败；详细输出仅保留在桌面端受保护日志中。',
    experiment_result_unavailable: '当前无法取得安全的实验结果。',
  },
};

function isScriptRuntimeBusy(status: ExperimentRuntimeStatus | undefined): boolean {
  return status === 'attaching' || status === 'requesting_grant' || status === 'running';
}

function runtimeStatusForFailure(code: ExperimentScriptFailureCode): ExperimentRuntimeStatus {
  if (code === 'experiment_runtime_unavailable') return 'runtime_unavailable';
  if (code === 'experiment_run_timeout') return 'timed_out';
  if (code === 'experiment_run_failed' || code === 'experiment_result_unavailable') return 'failed';
  return 'rejected';
}

function issueForRunStatus(status: ExperimentRunStatus): ExperimentScriptFailureCode | undefined {
  if (status === 'failed') return 'experiment_run_failed';
  if (status === 'timed_out') return 'experiment_run_timeout';
  if (status === 'rejected') return 'experiment_run_rejected';
  if (status === 'runtime_unavailable') return 'experiment_runtime_unavailable';
  return undefined;
}

async function callExperimentApi(
  methodName: ExperimentApiMethod,
  ...args: unknown[]
): Promise<unknown> {
  if (typeof window === 'undefined') return undefined;
  const api = window.metis;
  if (!api) return undefined;
  const method = Reflect.get(api, methodName);
  if (typeof method !== 'function') return undefined;
  return Promise.resolve(Reflect.apply(method, api, args));
}

function formatScriptSize(sizeBytes: number): string {
  if (sizeBytes < 1_024) return `${sizeBytes} B`;
  return `${(sizeBytes / 1_024).toFixed(sizeBytes < 10_240 ? 1 : 0)} KiB`;
}

function MetricBar({ value, max = 1 }: { value: number; max?: number }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const green = 'var(--status-completed)';
  const yellow = 'var(--accent-warm)';
  const blue = 'var(--chart-1)';
  const fillColor = pct > 80 ? green : pct > 50 ? yellow : blue;
  return (
    <div className="metric-bar">
      <div className="metric-fill" style={{ width: `${pct}%`, background: fillColor }} />
      <span className="metric-value">{typeof value === 'number' ? value.toFixed(3) : value}</span>
    </div>
  );
}

function downloadTextFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function experimentsToCsv(experiments: ExperimentItem[]): string {
  const headers = ['id', 'name', 'description', 'status', 'tags', 'parameters', 'metrics', 'linkedPaperIds', 'notes', 'createdAt'];
  const rows = experiments.map((e) => [
    e.id,
    `"${e.name.replace(/"/g, '""')}"`,
    `"${e.description.replace(/"/g, '""')}"`,
    e.status,
    `"${e.tags.join(', ')}"`,
    `"${JSON.stringify(e.parameters).replace(/"/g, '""')}"`,
    `"${JSON.stringify(e.metrics).replace(/"/g, '""')}"`,
    `"${e.linkedPaperIds.join(', ')}"`,
    `"${e.notes.replace(/"/g, '""')}"`,
    new Date(e.createdAt).toISOString(),
  ]);
  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
}

export default function ExperimentsPage() {
  const { experiments, addExperiment, removeExperiment, updateExperimentStatus, updateExperiment, setExperimentRuntimeState, toggleExperimentStar, papers, experimentSearchQuery, setExperimentSearchQuery } = useMetisStore();
  const { t, locale } = useTranslation();
  const [showForm, setShowForm] = useState(false);
  const [deletingExperimentId, setDeletingExperimentId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [compareKey, setCompareKey] = useState('');
  const [tagInputs, setTagInputs] = useState<Record<string, string>>({});
  const [metricInputs, setMetricInputs] = useState<Record<string, { key: string; value: string }>>({});
  const [paramInputs, setParamInputs] = useState<Record<string, { key: string; value: string }>>({});
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [starredOnly, setStarredOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const bulkSelectAllRef = useRef<HTMLInputElement>(null);
  const query = experimentSearchQuery;
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'name' | 'metric'>('newest');
  const [sortMetricKey, setSortMetricKey] = useState<string>('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [scriptActionIds, setScriptActionIds] = useState<Set<string>>(() => new Set());
  const [cancelRequestIds, setCancelRequestIds] = useState<Set<string>>(() => new Set());
  const isExperimentActionBlocked = (experiment: ExperimentItem | undefined): boolean => (
    experiment === undefined
    || isScriptRuntimeBusy(experiment.scriptRuntimeStatus)
    || scriptActionIds.has(experiment.id)
  );

  const openForm = useCallback(() => {
    setShowForm(true);
    window.setTimeout(() => {
      nameInputRef.current?.focus();
    }, 50);
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'n' && (e.ctrlKey || e.metaKey)) {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return;
        }
        e.preventDefault();
        openForm();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openForm]);

  const allMetricKeys = [...new Set(experiments.flatMap((e) => Object.keys(e.metrics)))];
  const allTags = [...new Set(experiments.flatMap((e) => e.tags))].sort();

  const filteredExperiments = experiments.filter((exp) => {
    if (statusFilter && exp.status !== statusFilter) return false;
    if (tagFilter && !exp.tags.includes(tagFilter)) return false;
    if (starredOnly && !exp.starred) return false;
    if (query) {
      const q = query.toLowerCase();
      const text = `${exp.name} ${exp.description} ${exp.notes}`.toLowerCase();
      if (!text.includes(q)) return false;
    }
    return true;
  });

  const sortedFilteredExperiments = [...filteredExperiments].sort((a, b) => {
    if (sortBy === 'newest') return b.createdAt - a.createdAt;
    if (sortBy === 'oldest') return a.createdAt - b.createdAt;
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    if (sortBy === 'metric' && sortMetricKey) {
      return (b.metrics[sortMetricKey] ?? -Infinity) - (a.metrics[sortMetricKey] ?? -Infinity);
    }
    return 0;
  });
  if (compareKey && !allMetricKeys.includes(compareKey)) allMetricKeys.push(compareKey);

  // ─── Bulk selection helpers ─────────────────────────────────────
  const isAllSelected = sortedFilteredExperiments.length > 0 && sortedFilteredExperiments.every((e) => selectedIds.has(e.id));
  const someSelected = sortedFilteredExperiments.some((e) => selectedIds.has(e.id));

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (isAllSelected) {
        sortedFilteredExperiments.forEach((e) => next.delete(e.id));
      } else {
        sortedFilteredExperiments.forEach((e) => next.add(e.id));
      }
      return next;
    });
  };

  const bulkSetStatus = (status: ExperimentItem['status']) => {
    selectedIds.forEach((id) => {
      const experiment = experiments.find((candidate) => candidate.id === id);
      if (!isExperimentActionBlocked(experiment)) {
        void updateExperimentStatus(id, status);
      }
    });
    setSelectedIds(new Set());
  };

  const confirmBulkDelete = async () => {
    for (const id of selectedIds) {
      const experiment = experiments.find((candidate) => candidate.id === id);
      if (!isExperimentActionBlocked(experiment)) {
        await removeExperiment(id);
      }
    }
    setSelectedIds(new Set());
    setShowBulkDeleteConfirm(false);
  };

  useEffect(() => {
    if (bulkSelectAllRef.current) {
      bulkSelectAllRef.current.indeterminate = someSelected && !isAllSelected;
    }
  }, [someSelected, isAllSelected]);

  const handleCreate = async () => {
    if (!name.trim()) return;
    const id = `exp_${Date.now()}`;
    await addExperiment({ id, name, description: desc, status: 'planned', parameters: {}, metrics: {}, tags: [], notes: '', linkedPaperIds: [], scriptRuntimeStatus: 'not_attached', createdAt: Date.now() });
    setName(''); setDesc(''); setShowForm(false);
  };

  const handleTogglePaperLink = (expId: string, paperId: string) => {
    const exp = experiments.find((e) => e.id === expId);
    if (!exp) return;
    const has = exp.linkedPaperIds.includes(paperId);
    void updateExperiment(exp.id, {
      linkedPaperIds: has
        ? exp.linkedPaperIds.filter((id) => id !== paperId)
        : [...exp.linkedPaperIds, paperId],
    });
  };

  const handleAddTags = (expId: string) => {
    const exp = experiments.find((e) => e.id === expId);
    if (!exp) return;
    const raw = tagInputs[expId] ?? '';
    const newTags = raw.split(',').map((t) => t.trim()).filter(Boolean);
    if (newTags.length === 0) return;
    void updateExperiment(expId, { tags: [...new Set([...exp.tags, ...newTags])] });
    setTagInputs((prev) => ({ ...prev, [expId]: '' }));
  };

  const handleRemoveTag = (expId: string, tag: string) => {
    const exp = experiments.find((e) => e.id === expId);
    if (!exp) return;
    void updateExperiment(expId, { tags: exp.tags.filter((t) => t !== tag) });
  };

  const handleAddMetric = (expId: string) => {
    const exp = experiments.find((e) => e.id === expId);
    if (!exp) return;
    const input = metricInputs[expId] ?? { key: '', value: '' };
    const key = input.key.trim();
    const value = parseFloat(input.value);
    if (!key || Number.isNaN(value)) return;
    void updateExperiment(expId, { metrics: { ...exp.metrics, [key]: value } });
    setMetricInputs((prev) => ({ ...prev, [expId]: { key: '', value: '' } }));
  };

  const handleRemoveMetric = (expId: string, key: string) => {
    const exp = experiments.find((e) => e.id === expId);
    if (!exp) return;
    const rest = Object.fromEntries(Object.entries(exp.metrics).filter(([k]) => k !== key));
    void updateExperiment(expId, { metrics: rest });
  };

  const handleAddParameter = (expId: string) => {
    const exp = experiments.find((e) => e.id === expId);
    if (!exp) return;
    const input = paramInputs[expId] ?? { key: '', value: '' };
    const key = input.key.trim();
    const value = input.value.trim();
    if (!key) return;
    void updateExperiment(expId, { parameters: { ...exp.parameters, [key]: value } });
    setParamInputs((prev) => ({ ...prev, [expId]: { key: '', value: '' } }));
  };

  const handleRemoveParameter = (expId: string, key: string) => {
    const exp = experiments.find((e) => e.id === expId);
    if (!exp) return;
    const rest = Object.fromEntries(Object.entries(exp.parameters).filter(([k]) => k !== key));
    void updateExperiment(expId, { parameters: rest });
  };

  const handleDuplicate = async (expId: string) => {
    const exp = experiments.find((e) => e.id === expId);
    if (!exp || isExperimentActionBlocked(exp)) return;
    const id = `exp_${Date.now()}`;
    await addExperiment({
      id,
      name: `${exp.name} (${t('common.duplicate')})`,
      description: exp.description,
      status: 'planned',
      parameters: { ...exp.parameters },
      metrics: { ...exp.metrics },
      tags: [...exp.tags],
      notes: exp.notes,
      linkedPaperIds: [...exp.linkedPaperIds],
      scriptRuntimeStatus: 'not_attached',
      starred: exp.starred,
      createdAt: Date.now(),
    });
  };

  const handleSelectScript = async (expId: string) => {
    const experiment = experiments.find((candidate) => candidate.id === expId);
    if (!experiment || isExperimentActionBlocked(experiment)) return;
    setScriptActionIds((previous) => new Set(previous).add(expId));
    const previousStatus = experiment.scriptAttachment ? 'ready' : 'not_attached';
    setExperimentRuntimeState(expId, {
      scriptRuntimeStatus: 'attaching',
      scriptRuntimeIssue: undefined,
    });
    try {
      const result = decodeExperimentScriptAttachResult(
        await callExperimentApi('attachExperimentScript', expId),
      );
      if (result.status === 'cancelled') {
        setExperimentRuntimeState(expId, { scriptRuntimeStatus: previousStatus });
        return;
      }
      if (result.status === 'rejected') {
        setExperimentRuntimeState(expId, {
          scriptRuntimeStatus: runtimeStatusForFailure(result.code),
          scriptRuntimeIssue: result.code,
        });
        return;
      }
      setExperimentRuntimeState(expId, {
        scriptAttachment: result.attachment,
        scriptRuntimeStatus: 'ready',
        scriptRuntimeIssue: undefined,
      });
    } catch {
      setExperimentRuntimeState(expId, {
        scriptRuntimeStatus: 'failed',
        scriptRuntimeIssue: 'experiment_result_unavailable',
      });
    } finally {
      setScriptActionIds((previous) => {
        const next = new Set(previous);
        next.delete(expId);
        return next;
      });
    }
  };

  const handleRunScript = async (expId: string) => {
    const experiment = experiments.find((candidate) => candidate.id === expId);
    if (
      !experiment?.scriptAttachment
      || isExperimentActionBlocked(experiment)
    ) {
      return;
    }
    setScriptActionIds((previous) => new Set(previous).add(expId));
    setCancelRequestIds((previous) => {
      const next = new Set(previous);
      next.delete(expId);
      return next;
    });
    setSelectedIds((previous) => {
      if (!previous.has(expId)) return previous;
      const next = new Set(previous);
      next.delete(expId);
      return next;
    });
    setExperimentRuntimeState(expId, {
      scriptRuntimeStatus: 'requesting_grant',
      scriptRuntimeIssue: undefined,
    });
    try {
      const grantResult = decodeExperimentExecutionGrantResult(
        await callExperimentApi('requestExperimentRunGrant', expId),
      );
      if (grantResult.status === 'rejected') {
        setExperimentRuntimeState(expId, {
          scriptRuntimeStatus: runtimeStatusForFailure(grantResult.code),
          scriptRuntimeIssue: grantResult.code,
        });
        return;
      }

      setExperimentRuntimeState(expId, {
        status: 'running',
        scriptRuntimeStatus: 'running',
        scriptRuntimeIssue: undefined,
      });
      const runResult = decodeExperimentRunResult(
        await callExperimentApi('runExperiment', {
          experimentId: expId,
          grant: grantResult.grant,
        }),
      );
      const experimentStatus: ExperimentItem['status'] = runResult.status === 'completed'
        ? 'completed'
        : runResult.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
      const latestMetrics = useMetisStore.getState().experiments
        .find((candidate) => candidate.id === expId)?.metrics ?? experiment.metrics;
      setExperimentRuntimeState(expId, {
        status: experimentStatus,
        metrics: { ...latestMetrics, ...runResult.metrics },
        scriptRuntimeStatus: runResult.status,
        scriptRuntimeIssue: issueForRunStatus(runResult.status),
      });
    } catch {
      setExperimentRuntimeState(expId, {
        status: 'failed',
        scriptRuntimeStatus: 'failed',
        scriptRuntimeIssue: 'experiment_result_unavailable',
      });
    } finally {
      setScriptActionIds((previous) => {
        const next = new Set(previous);
        next.delete(expId);
        return next;
      });
      setCancelRequestIds((previous) => {
        const next = new Set(previous);
        next.delete(expId);
        return next;
      });
    }
  };

  const handleCancelScript = async (expId: string) => {
    const experiment = useMetisStore.getState().experiments
      .find((candidate) => candidate.id === expId);
    if (experiment?.scriptRuntimeStatus !== 'running' || cancelRequestIds.has(expId)) return;
    setCancelRequestIds((previous) => new Set(previous).add(expId));
    try {
      const accepted = await callExperimentApi('cancelExperiment', expId);
      if (accepted !== true) {
        setExperimentRuntimeState(expId, { scriptRuntimeIssue: 'experiment_run_rejected' });
        setCancelRequestIds((previous) => {
          const next = new Set(previous);
          next.delete(expId);
          return next;
        });
      }
    } catch {
      setExperimentRuntimeState(expId, { scriptRuntimeIssue: 'experiment_result_unavailable' });
      setCancelRequestIds((previous) => {
        const next = new Set(previous);
        next.delete(expId);
        return next;
      });
    }
  };

  const handleExportCsv = () => {
    const csv = experimentsToCsv(filteredExperiments);
    downloadTextFile(csv, `experiments-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  return (
    <div className="experiments-page">
      <div className="exp-header">
        <h2>{t('experiments.pageTitle')}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-secondary" onClick={handleExportCsv}>{t('experiments.exportCsv')}</button>
          <button className="btn-primary" onClick={openForm}>{t('experiments.newExperiment')}</button>
        </div>
      </div>

      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t('experiments.modalTitle')}</h3>
            <label>{t('experiments.modalName')}
              <input type="text" value={name} ref={nameInputRef} onChange={(e) => setName(e.target.value)} placeholder={t('experiments.modalNamePlaceholder')} className="settings-input" />
            </label>
            <label>{t('experiments.modalDescription')}
              <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t('experiments.modalDescPlaceholder')} rows={3} style={{ width: '100%', marginTop: 4, padding: 8 }} />
            </label>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowForm(false)}>{t('common.cancel')}</button>
              <button className="btn-primary" onClick={handleCreate}>{t('common.create')}</button>
            </div>
          </div>
        </div>
      )}

      <div className="exp-filters" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <SearchInput
          className="search-input"
          placeholder={t('experiments.searchPlaceholder')}
          value={query}
          onChange={setExperimentSearchQuery}
          style={{ flex: 1, minWidth: 160 }}
        />
        <div className="result-count" style={{ marginBottom: 0 }} aria-live="polite" aria-atomic="true">{t('experiments.resultCount', { count: sortedFilteredExperiments.length })}</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          {t('experiments.filterByStatus')}
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="detail-select">
            <option value="">{t('experiments.allStatuses')}</option>
            <option value="planned">planned</option>
            <option value="running">running</option>
            <option value="completed">completed</option>
            <option value="failed">failed</option>
            <option value="cancelled">cancelled</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          {t('experiments.filterByTag')}
          <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} className="detail-select">
            <option value="">{t('experiments.allTags')}</option>
            {allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          {t('experiments.sortBy')}
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} className="detail-select">
            <option value="newest">{t('experiments.sortNewest')}</option>
            <option value="oldest">{t('experiments.sortOldest')}</option>
            <option value="name">{t('experiments.sortName')}</option>
            <option value="metric">{t('experiments.sortMetric')}</option>
          </select>
        </label>
        <button
          type="button"
          className={`btn-sm ${starredOnly ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setStarredOnly((v) => !v)}
          aria-pressed={starredOnly}
        >
          {t('experiments.filterStarredOnly')}
        </button>
        {sortBy === 'metric' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            {t('experiments.compareByMetric')}
            <select value={sortMetricKey} onChange={(e) => setSortMetricKey(e.target.value)} className="detail-select">
              <option value="">{t('experiments.selectMetric')}</option>
              {allMetricKeys.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
        )}
      </div>

      {allMetricKeys.length > 0 && (
        <div className="compare-bar">
          <label>{t('experiments.compareByMetric')}</label>
          <select value={compareKey} onChange={(e) => setCompareKey(e.target.value)}>
            <option value="">{t('experiments.selectMetric')}</option>
            {allMetricKeys.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
      )}

      <div className="exp-bulk-bar">
        <label className="bulk-select-label">
          <input
            ref={bulkSelectAllRef}
            type="checkbox"
            checked={isAllSelected}
            onChange={toggleSelectAll}
            aria-label={t('experiments.selectAll')}
          />
          <span>{selectedIds.size > 0 ? t('experiments.selectedCount', { count: selectedIds.size }) : t('experiments.selectAll')}</span>
        </label>
        {selectedIds.size > 0 && (
          <div className="bulk-actions">
            <select
              value=""
              onChange={(e) => { const status = e.target.value as ExperimentItem['status']; if (status) bulkSetStatus(status); e.target.value = ''; }}
              className="detail-select"
              aria-label={t('experiments.bulkSetStatus')}
            >
              <option value="">{t('experiments.bulkSetStatus')}</option>
              <option value="planned">planned</option>
              <option value="running">running</option>
              <option value="completed">completed</option>
              <option value="failed">failed</option>
              <option value="cancelled">cancelled</option>
            </select>
            <button type="button" className="btn-sm" onClick={() => setShowBulkDeleteConfirm(true)}>{t('experiments.bulkDelete')}</button>
          </div>
        )}
      </div>

      <div className="exp-grid">
        {sortedFilteredExperiments.map((exp) => (
          <div key={exp.id} className={`exp-card status-${exp.status} ${selectedIds.has(exp.id) ? 'batch-selected' : ''}`}>
            <div className="exp-card-header">
              <input
                type="checkbox"
                checked={selectedIds.has(exp.id)}
                onChange={() => { if (!isExperimentActionBlocked(exp)) toggleSelect(exp.id); }}
                aria-label={exp.name}
                disabled={isExperimentActionBlocked(exp)}
              />
              <h3>{exp.name}</h3>
              <button
                className={`btn-sm ${exp.starred ? 'btn-primary' : 'btn-secondary'}`}
                title={exp.starred ? t('common.unstar') : t('common.star')}
                onClick={() => { void toggleExperimentStar(exp.id); }}
                aria-pressed={exp.starred}
              >
                {exp.starred ? '★' : '☆'}
              </button>
              <span className="exp-status-badge" style={{ background: STATUS_CSS_VARS[exp.status] }}>{exp.status}</span>
            </div>
            <p className="exp-desc">{exp.description || t('experiments.noDescription')}</p>
            <div className="exp-tags" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
              {exp.tags.map((tag) => (
                <span key={tag} className="tag inline-flex-center">
                  <button
                    type="button"
                    className="tag"
                    onClick={() => { setExperimentSearchQuery(''); setTagFilter(tag); }}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                  >
                    {tag}
                  </button>
                  <button
                    className="tag-remove"
                    onClick={() => handleRemoveTag(exp.id, tag)}
                    title={t('common.delete')}
                  >×</button>
                </span>
              ))}
              <div className="inline-flex-center" style={{ gap: 4 }}>
                <input
                  type="text"
                  value={tagInputs[exp.id] ?? ''}
                  onChange={(e) => setTagInputs((prev) => ({ ...prev, [exp.id]: e.target.value }))}
                  placeholder={t('experiments.editTagsPlaceholder')}
                  className="settings-input"
                  style={{ width: 120, fontSize: 12 }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddTags(exp.id); }}
                />
                <button className="btn-sm btn-primary" onClick={() => handleAddTags(exp.id)}>{t('experiments.addTag')}</button>
              </div>
            </div>
            <div className="exp-notes" style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>{t('experiments.notes')}</div>
              <textarea
                value={exp.notes}
                onChange={(e) => { void updateExperiment(exp.id, { notes: e.target.value }); }}
                placeholder={t('experiments.notes')}
                rows={3}
                className="settings-input"
                style={{ width: '100%', fontSize: 13, resize: 'vertical' }}
              />
            </div>
            <div className="exp-parameters" style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>{t('experiments.parameters')}</div>
              {Object.keys(exp.parameters).length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{t('experiments.noParameters')}</div>
              )}
              {Object.entries(exp.parameters).map(([k, v]) => (
                <div key={k} className="exp-parameter" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 4 }}>
                  <span style={{ flex: 1, fontWeight: 500 }}>{k}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{v}</span>
                  <button className="tag-remove" onClick={() => handleRemoveParameter(exp.id, k)} title={t('common.delete')}>×</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
                <input
                  type="text"
                  value={paramInputs[exp.id]?.key ?? ''}
                  onChange={(e) => setParamInputs((prev) => ({ ...prev, [exp.id]: { ...(prev[exp.id] ?? { key: '', value: '' }), key: e.target.value } }))}
                  placeholder={t('experiments.parameterName')}
                  className="settings-input"
                  style={{ flex: 1, fontSize: 12 }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddParameter(exp.id); }}
                />
                <input
                  type="text"
                  value={paramInputs[exp.id]?.value ?? ''}
                  onChange={(e) => setParamInputs((prev) => ({ ...prev, [exp.id]: { ...(prev[exp.id] ?? { key: '', value: '' }), value: e.target.value } }))}
                  placeholder={t('experiments.parameterValue')}
                  className="settings-input"
                  style={{ flex: 1, fontSize: 12 }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddParameter(exp.id); }}
                />
                <button className="btn-sm btn-primary" onClick={() => handleAddParameter(exp.id)}>{t('experiments.addParameter')}</button>
              </div>
            </div>
            <div className="exp-metrics">
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>{t('experiments.metrics')}</div>
              {Object.keys(exp.metrics).length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{t('experiments.noMetrics')}</div>
              )}
              {Object.entries(exp.metrics).map(([k, v]) => (
                <div key={k} className="exp-metric" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="metric-label" style={{ flex: 1 }}>{k}</span>
                  <MetricBar value={v} max={compareKey === k ? Math.max(...experiments.map((e) => e.metrics[k] ?? 0), 1) : 1} />
                  <button className="tag-remove" onClick={() => handleRemoveMetric(exp.id, k)} title={t('common.delete')}>×</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
                <input
                  type="text"
                  value={metricInputs[exp.id]?.key ?? ''}
                  onChange={(e) => setMetricInputs((prev) => ({ ...prev, [exp.id]: { ...(prev[exp.id] ?? { key: '', value: '' }), key: e.target.value } }))}
                  placeholder={t('experiments.metricName')}
                  className="settings-input"
                  style={{ flex: 1, fontSize: 12 }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddMetric(exp.id); }}
                />
                <input
                  type="number"
                  value={metricInputs[exp.id]?.value ?? ''}
                  onChange={(e) => setMetricInputs((prev) => ({ ...prev, [exp.id]: { ...(prev[exp.id] ?? { key: '', value: '' }), value: e.target.value } }))}
                  placeholder={t('experiments.metricValue')}
                  className="settings-input"
                  style={{ width: 80, fontSize: 12 }}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddMetric(exp.id); }}
                />
                <button className="btn-sm btn-primary" onClick={() => handleAddMetric(exp.id)}>{t('experiments.addMetric')}</button>
              </div>
            </div>
            <div className="exp-actions">
              {exp.status === 'planned' && <button className="btn-sm" disabled={isExperimentActionBlocked(exp)} onClick={() => { if (!isExperimentActionBlocked(exp)) void updateExperimentStatus(exp.id, 'running'); }}>{t('experiments.btnStart')}</button>}
              {exp.status === 'running' && <button className="btn-sm" disabled={isExperimentActionBlocked(exp)} onClick={() => { if (!isExperimentActionBlocked(exp)) void updateExperimentStatus(exp.id, 'completed'); }}>{t('experiments.btnComplete')}</button>}
              {exp.scriptRuntimeStatus === 'running' ? (
                <button
                  className="btn-sm btn-danger"
                  disabled={cancelRequestIds.has(exp.id)}
                  onClick={() => { void handleCancelScript(exp.id); }}
                >
                  {t('experiments.btnCancel')}
                </button>
              ) : (
                (exp.status === 'planned' || exp.status === 'running') && <button className="btn-sm btn-danger" disabled={isExperimentActionBlocked(exp)} onClick={() => { if (!isExperimentActionBlocked(exp)) void updateExperimentStatus(exp.id, 'cancelled'); }}>{t('experiments.btnCancel')}</button>
              )}
              {exp.status === 'completed' && <button className="btn-sm" disabled={isExperimentActionBlocked(exp)} onClick={() => { if (!isExperimentActionBlocked(exp)) void updateExperimentStatus(exp.id, 'running'); }}>{t('experiments.btnRerun')}</button>}
              <button className="btn-sm btn-secondary" disabled={isExperimentActionBlocked(exp)} onClick={() => { void handleDuplicate(exp.id); }}>{t('common.duplicate')}</button>
              <button className="btn-sm btn-danger" disabled={isExperimentActionBlocked(exp)} onClick={() => { if (!isExperimentActionBlocked(exp)) setDeletingExperimentId(exp.id); }}>{t('common.delete')}</button>
            </div>
            <div className="exp-script" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)' }}>{t('experiments.script')}</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 180, fontSize: 12, color: 'var(--text-secondary)' }}>
                  {exp.scriptAttachment ? (
                    <>
                      <div dir="auto" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{exp.scriptAttachment.displayName}</div>
                      <div>
                        {exp.scriptAttachment.runtime === 'python'
                          ? t('experiments.scriptTypes.python')
                          : t('experiments.scriptTypes.node')}
                        {' · '}{formatScriptSize(exp.scriptAttachment.sizeBytes)}
                      </div>
                    </>
                  ) : (
                    <span>{RUNTIME_STATUS_COPY[locale].not_attached}</span>
                  )}
                </div>
                <button
                  className="btn-sm btn-secondary"
                  disabled={isExperimentActionBlocked(exp)}
                  onClick={() => { void handleSelectScript(exp.id); }}
                >
                  {exp.scriptAttachment
                    ? (locale === 'zh' ? '更换脚本' : 'Replace script')
                    : t('experiments.selectScript')}
                </button>
                {exp.scriptAttachment && (
                  <button
                    className="btn-sm btn-primary"
                    onClick={() => { void handleRunScript(exp.id); }}
                    disabled={isExperimentActionBlocked(exp)}
                  >
                    {t('experiments.runScript')}
                  </button>
                )}
              </div>
              <div aria-live="polite" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {RUNTIME_STATUS_COPY[locale][
                  exp.scriptRuntimeStatus ?? (exp.scriptAttachment ? 'ready' : 'not_attached')
                ]}
              </div>
              {exp.scriptRuntimeIssue && (
                <div role="status" style={{ marginTop: 4, fontSize: 12, color: 'var(--status-failed)' }}>
                  {RUNTIME_FAILURE_COPY[locale][exp.scriptRuntimeIssue]}
                </div>
              )}
            </div>
            <div className="exp-links" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)' }}>{t('experiments.linkedPapers')}</div>
              {papers.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('experiments.linkedPapersEmpty')}</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {papers.map((p) => {
                    const linked = exp.linkedPaperIds.includes(p.id);
                    return (
                      <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 6, borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)' }}>
                        <input type="checkbox" checked={linked} onChange={() => handleTogglePaperLink(exp.id, p.id)} />
                        <span style={{ fontSize: 12 }}>{p.title}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ))}
        {sortedFilteredExperiments.length === 0 && (
          <div className="empty-list" style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 40 }}>
            <p>{experiments.length === 0 ? t('experiments.emptyList') : t('experiments.noMatchingExperiments')}</p>
            {experiments.length > 0 && (query || statusFilter || tagFilter || starredOnly) && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setExperimentSearchQuery('');
                  setStatusFilter('');
                  setTagFilter('');
                  setStarredOnly(false);
                }}
                style={{ marginTop: 8 }}
              >
                {t('common.clear')}
              </button>
            )}
          </div>
        )}
      </div>
      {deletingExperimentId && (
        <ConfirmDialog
          title={t('common.confirmDeleteTitle')}
          message={t('common.confirmDeleteMessage')}
          onConfirm={() => {
            const current = useMetisStore.getState().experiments
              .find((candidate) => candidate.id === deletingExperimentId);
            if (!isExperimentActionBlocked(current)) void removeExperiment(deletingExperimentId);
            setDeletingExperimentId(null);
          }}
          onCancel={() => setDeletingExperimentId(null)}
        />
      )}
      {showBulkDeleteConfirm && (
        <ConfirmDialog
          title={t('experiments.bulkDeleteConfirmTitle')}
          message={t('experiments.bulkDeleteConfirmMessage', { count: selectedIds.size })}
          onConfirm={() => { void confirmBulkDelete(); }}
          onCancel={() => setShowBulkDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
