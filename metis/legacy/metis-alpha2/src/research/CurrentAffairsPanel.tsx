/**
 * CurrentAffairsPanel — typed window.metis bridge, no local Record casting.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { z } from 'zod';
import type { SourceReviewRequest } from '@engine/runtime/CurrentAffairsRuntimeContract.js';
import './CurrentAffairsPanel.css';

// eslint-disable-next-line no-control-regex
const SAFE_ID_RE = /^[^\x00-\x1F\x7F-\x9F\\/\s]{1,256}$/u;

const CA_IMPORT_SCHEMA = z.strictObject({
  title: z.string().min(1).max(1000).optional(),
  selectedSourceIds: z.array(z.string().regex(SAFE_ID_RE)).min(1).max(500).optional(),
});

type ReviewKind = SourceReviewRequest['caKind'];
type ReviewCorrection = SourceReviewRequest['correctionState'];

const CA_KINDS: readonly ReviewKind[] = ['policy_document','official_statistics','authoritative_news','legislative_record','regulatory_filing','expert_testimony','institutional_report'] as const;
const CORR_STATES: readonly ReviewCorrection[] = ['clean','corrected','retracted'] as const;

const isReviewKind = (v: string): v is ReviewKind => CA_KINDS.some(k => k === v);
const isReviewCorrection = (v: string): v is ReviewCorrection => CORR_STATES.some(c => c === v);

type Phase ='idle' | 'loading' | 'executing' | 'awaiting_approval'
  | 'approved' | 'rejected' | 'exporting' | 'exported' | 'cancelled' | 'error';

// ── Operation token ───────────────────────────────────────────

class OpToken {
  #settled = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #gen: number;
  #gens: { current: number };
  #cancelled: { current: boolean };
  #onTimeout: () => void;
  constructor(gens: { current: number }, cancelled: { current: boolean }, ms: number, onTimeout: () => void) {
    this.#gens = gens; this.#cancelled = cancelled; this.#onTimeout = onTimeout;
    this.#gen = ++gens.current;
    this.#timer = setTimeout(() => {
      if (!this.#settled && gens.current === this.#gen && !cancelled.current) { this.#settled = true; this.#timer = null; this.#onTimeout(); }
    }, ms);
  }
  done(): boolean {
    if (this.#settled || this.#cancelled.current || this.#gens.current !== this.#gen) return false;
    this.#settled = true; this.clearTimer(); return true;
  }
  invalidate() { this.#settled = true; this.clearTimer(); }
  clearTimer() { if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; } }
}

// ── Component ─────────────────────────────────────────────────

export default function CurrentAffairsPanel({ projectId }: { projectId: string }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [title, setTitle] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);

  const wfRef = useRef(crypto.randomUUID());
  const pfRef = useRef(`ca-${crypto.randomUUID()}`);
  const opGens = useRef(0);
  const cancelled = useRef(false);
  const activeToken = useRef<OpToken | null>(null);

  const [ctx, setCtx] = useState<{ wf: string; pf: string; mv: number; cd: string; ssd: string } | null>(null);
  const [pv, setPv] = useState<Array<{ heading: string; content: string }>>([]);
  const [receipt, setReceipt] = useState<{ receiptId: string; nonce: string } | null>(null);
  const [exportText, setExportText] = useState('');

  interface SourceEntry { sourceId: string; title: string; kind: string; eligible: boolean; reason: string; reviewStatus: string; hash: string; correctionState: string | null; updatedAt: number; }
  const [available, setAvailable] = useState<SourceEntry[]>([]);
  const [srcLoading, setSrcLoading] = useState(false);
  const [srcErr, setSrcErr] = useState('');
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewKind, setReviewKind] = useState<ReviewKind>('policy_document');
  const [reviewCorr, setReviewCorr] = useState<ReviewCorrection>('clean');
  const [reviewNote, setReviewNote] = useState('');

  useEffect(() => () => { cancelled.current = true; activeToken.current?.invalidate(); }, []);
  useEffect(() => { if (errorMsg && errorRef.current) errorRef.current.focus(); }, [errorMsg]);

  const newOp = useCallback((ms: number, msg: string) => {
    activeToken.current?.invalidate();
    const t = new OpToken(opGens, cancelled, ms, () => { setPhase('error'); setErrorMsg(msg); });
    activeToken.current = t; return t;
  }, []);

  // ── Load sources via currentAffairsListSources ──────────────
  const loadSources = useCallback(async () => {
    setSrcLoading(true); setSrcErr('');
    try {
      const result = await window.metis?.currentAffairsListSources?.({ version: 1, operationId: `ls-${crypto.randomUUID()}`, projectId });
      if (cancelled.current || !result) return;
      if (!result.ok) { setSrcErr(result.code); return; }
      const entries = result.sources.filter(s => !s.deleted);
      if (!entries.length) { setSrcErr('没有符合条件的时政来源'); return; }
      setAvailable(entries.map(s => ({
        sourceId: s.sourceId, title: s.title, kind: s.kind ?? '',
        eligible: s.eligible, reason: s.reason, reviewStatus: s.reviewStatus,
        hash: s.contentDigest ?? '', correctionState: s.correctionState, updatedAt: s.updatedAt,
      })));
    } catch { setSrcErr('加载来源失败'); } finally { if (!cancelled.current) setSrcLoading(false); }
  }, [projectId]);

  useEffect(() => { void loadSources(); }, [loadSources]); // eslint-disable-line react-hooks/set-state-in-effect

  const doReview = useCallback(async () => {
    if (!reviewingId) return;
    const entry = available.find(s => s.sourceId === reviewingId);
    if (!entry) return;
    try {
      const r = await window.metis?.currentAffairsReviewSource?.({ version: 1, operationId: `rv-${crypto.randomUUID()}`, projectId, sourceId: reviewingId, caKind: reviewKind, correctionState: reviewCorr, expectedSourceVersionHash: entry.hash, expectedUpdatedAt: entry.updatedAt, note: reviewNote || undefined });
      if (cancelled.current || !r) return;
      if (!r.ok) { setSrcErr(r.code); return; }
      setReviewingId(null); setReviewNote(''); setReviewKind('policy_document'); setReviewCorr('clean');
      await loadSources();
    } catch (e) { setSrcErr(e instanceof Error ? e.message : '审核失败'); }
  }, [projectId, reviewingId, reviewKind, reviewCorr, reviewNote, available, loadSources]);

  const toggle = useCallback((id: string) => { setSelectedIds(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]); }, []);

  const [jsonInput, setJsonInput] = useState('');
  const [showJson, setShowJson] = useState(false);
  const importJson = useCallback(() => {
    let raw: unknown;
    try { raw = JSON.parse(jsonInput); } catch { setErrorMsg('JSON 格式无效'); return; }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { setErrorMsg('JSON 必须是对象'); return; }
    const parsed = CA_IMPORT_SCHEMA.safeParse(raw);
    if (!parsed.success) { setErrorMsg('导入数据格式不正确'); return; }
    const { title: t, selectedSourceIds: ids } = parsed.data;
    if (t !== undefined) setTitle(t.trim());
    if (ids !== undefined) {
      setSelectedIds(
        ids
          .filter((id, i, a) => a.indexOf(id) === i)
          .filter(id => available.some(s => s.sourceId === id)),
      );
    }
    setShowJson(false); setErrorMsg('');
  }, [jsonInput, available]);

  // ── Execute ─────────────────────────────────────────────────
  const issueAutomaticReceipt = useCallback(async (nextCtx: { wf: string; pf: string; mv: number; cd: string; ssd: string }) => {
    const opId = `a-${crypto.randomUUID()}`;
    const tok = newOp(15_000, '内部收据签发超时');
    try {
      const req = { version: 1 as const, operationId: opId, projectId, workflowId: nextCtx.wf, profileId: nextCtx.pf, manifestVersion: nextCtx.mv, contentDigest: nextCtx.cd, sourceSnapshotDigest: nextCtx.ssd };
      const result = await window.metis?.currentAffairsApprove?.(req);
      if (!result) {
        if (tok.done()) { setErrorMsg('内部收据签发失败'); setPhase('error'); }
        return false;
      }
      if (!tok.done()) return false;
      if (!result.ok) { setErrorMsg(result.code); setPhase('error'); return false; }
      setReceipt({ receiptId: result.receipt.receiptId, nonce: result.receipt.nonce });
      setPhase('approved');
      return true;
    } catch (error) {
      if (tok.done()) { setErrorMsg(error instanceof Error ? error.message : '内部收据签发失败'); setPhase('error'); }
      return false;
    }
  }, [projectId, newOp]);

  const execute = useCallback(async () => {
    if (!selectedIds.length) { setErrorMsg('请至少选择一个来源'); return; }
    if (!title.trim()) { setErrorMsg('请输入标题'); return; }
    const opId = `r-${crypto.randomUUID()}`;
    const tok = newOp(30_000, '执行超时');
    const req = { version: 1 as const, operationId: opId, projectId, workflowId: wfRef.current, profileId: pfRef.current, manifestVersion: 1, title: title.trim(), selectedSourceIds: selectedIds };
    setPhase('executing'); setErrorMsg('');
    try {
      const result = await window.metis?.currentAffairsResearch?.(req);
      if (!result || !tok.done()) return;
      if (!result.ok) { setErrorMsg(result.errors.join('; ')); setPhase('error'); return; }
      const nextCtx = { wf: req.workflowId, pf: req.profileId, mv: req.manifestVersion, cd: result.contentDigest, ssd: result.sourceSnapshotDigest };
      setCtx(nextCtx);
      if (result.preview?.sections) setPv(result.preview.sections);
      if (result.errors.length) setErrorMsg(result.errors.join('; '));
      if (result.readyForApproval) {
        setPhase('awaiting_approval');
        await issueAutomaticReceipt(nextCtx);
      } else {
        setPhase('error');
      }
    } catch (e) { if (tok.done()) { setErrorMsg(e instanceof Error ? e.message : '失败'); setPhase('error'); } }
  }, [projectId, title, selectedIds, newOp, issueAutomaticReceipt]);

  // ── Approve ─────────────────────────────────────────────────
  // ── Cancel ──────────────────────────────────────────────────
  const cancel = useCallback(async () => {
    if (!ctx) { setPhase('cancelled'); return; }
    // Without receipt: discard_draft (awaiting_approval phase)
    if (!receipt?.receiptId) {
      // Invalidate the in-flight automatic receipt request before discarding the
      // draft so a late response cannot resurrect a cancelled workflow.
      activeToken.current?.invalidate();
      const opId = `c-${crypto.randomUUID()}`;
      try {
        const result = await window.metis?.currentAffairsCancel?.({ action: 'discard_draft' as const, version: 1 as const, operationId: opId, projectId, workflowId: ctx.wf });
        if (!result || !result.ok) {
          setErrorMsg('取消失败'); return;
        }
      } catch { setErrorMsg('取消失败'); return; }
      setPhase('cancelled'); setReceipt(null); return;
    }
    // With receipt: revoke_approval (approved phase)
    const opId = `c-${crypto.randomUUID()}`;
    const tok = newOp(10_000, '取消超时');
    try {
      const req = { action: 'revoke_approval' as const, version: 1 as const, operationId: opId, projectId, workflowId: ctx.wf, profileId: ctx.pf, manifestVersion: ctx.mv, contentDigest: ctx.cd, sourceSnapshotDigest: ctx.ssd, receiptId: receipt.receiptId, receiptNonce: receipt.nonce };
      const result = await window.metis?.currentAffairsCancel?.(req);
      if (!result || !tok.done()) return;
      if (!result.ok) { setErrorMsg('code' in result ? result.code : '取消失败'); return; }
    } catch (e) { if (tok.done()) { setErrorMsg(e instanceof Error ? e.message : '取消失败'); return; } }
    setPhase('cancelled'); setReceipt(null);
  }, [projectId, ctx, receipt, newOp]);

  const recover = useCallback(() => {
    activeToken.current?.invalidate();
    wfRef.current = crypto.randomUUID(); pfRef.current = `ca-${crypto.randomUUID()}`;
    setPhase('idle'); setReceipt(null); setExportText(''); setCtx(null); setPv([]); setErrorMsg('');
  }, []);

  // ── Export ──────────────────────────────────────────────────
  const doExport = useCallback(async () => {
    if (!ctx || !receipt) { setErrorMsg('内部收据尚未签发'); return; }
    const opId = `e-${crypto.randomUUID()}`;
    const tok = newOp(30_000, '导出超时');
    setPhase('exporting'); setErrorMsg('');
    try {
      const req = { version: 1 as const, operationId: opId, projectId, workflowId: ctx.wf, profileId: ctx.pf, manifestVersion: ctx.mv, contentDigest: ctx.cd, sourceSnapshotDigest: ctx.ssd, receiptId: receipt.receiptId, receiptNonce: receipt.nonce };
      const result = await window.metis?.currentAffairsExport?.(req);
      if (!result || !tok.done()) { setPhase('approved'); return; }
      if (!result.ok) { setErrorMsg(result.code); setPhase('error'); return; }
      setExportText(`Artifact: ${result.artifactId} v${result.artifactVersion} / 记录: ${result.recordCount}`); setPhase('exported');
    } catch (e) { if (tok.done()) { setErrorMsg(e instanceof Error ? e.message : '导出失败'); setPhase('error'); } }
  }, [projectId, ctx, receipt, newOp]);

  // ── Render ──────────────────────────────────────────────────
  const showBar = phase !== 'idle' && phase !== 'loading';
  const labels: Record<Phase, string> = { idle: '', loading: '加载…', executing: '执行中…', awaiting_approval: '自动真实性复核中', approved: '内部收据已签发', rejected: '已拒绝', exporting: '导出中…', exported: '导出完成', cancelled: '已取消', error: '出错' };

  return (<div className="ca-panel" role="region" aria-label="时政研究工作流">
    <h2>时政研究</h2>
    {showBar && <div className="ca-phase-bar" role="status" aria-live="polite"><span className={`ca-phase-dot ca-phase--${phase}`} aria-hidden="true" /><span>{labels[phase]}</span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
        {phase === 'awaiting_approval' && <><span className="ca-auto-receipt">正在自动复核来源并签发内部收据…</span><button className="ca-btn ca-btn--sm" onClick={cancel}>打断</button></>}
        {phase === 'approved' && <><button className="ca-btn ca-btn--primary ca-btn--sm" onClick={doExport}>导出</button><button className="ca-btn ca-btn--sm" onClick={cancel}>取消</button></>}
        {(phase === 'error' || phase === 'rejected' || phase === 'cancelled' || phase === 'exported') && <button className="ca-btn ca-btn--sm" onClick={recover}>重新开始</button>}
      </div>
    </div>}
    {errorMsg && <div className="ca-alert" role="alert" ref={errorRef} tabIndex={-1}>{errorMsg}</div>}
    {(phase === 'idle' || phase === 'loading') && <div className="ca-form">
      <div className="ca-field"><label htmlFor="ca-title">标题 *</label><input id="ca-title" value={title} onChange={e => setTitle(e.target.value)} /></div>
      <fieldset className="ca-fieldset"><legend>来源</legend>
        <button className="ca-btn ca-btn--sm" onClick={loadSources} disabled={srcLoading}>{srcLoading ? '加载中…' : '加载来源'}</button>
        {srcErr && <p style={{ fontSize: 12, color: 'var(--status-failed)', marginTop: 8 }} role="alert">{srcErr}</p>}
        {!srcLoading && !srcErr && !available.length && <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>没有符合条件的来源</p>}
        {!!available.length && <ul className="ca-source-list" style={{ marginTop: 8, listStyle: 'none', padding: 0 }}>{available.map(s => { const sel = selectedIds.includes(s.sourceId); return <li key={s.sourceId} className="ca-source-item"><span className="ca-source-kind">{s.kind}</span><span className="ca-source-title">{s.title}</span>{s.hash && <span style={{ fontSize: 10, color: 'var(--status-completed)', marginRight: 8 }}>✓</span>}{!s.eligible && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 8 }}>{s.reason}</span>}{!s.eligible && s.hash && <button className="ca-btn ca-btn--sm" onClick={() => setReviewingId(s.sourceId)} aria-label={`审核 ${s.title}`}>审核</button>}{s.eligible && <button className={`ca-btn ca-btn--sm ${sel ? 'ca-btn--danger' : 'ca-btn--primary'}`} onClick={() => toggle(s.sourceId)} aria-pressed={sel}>{sel ? '移除' : '选择'}</button>}</li>; })}</ul>}
        {reviewingId && <div className="ca-review-dialog" role="dialog" aria-label="审核来源"><h4>审核来源</h4><label>CA 分类: <select value={reviewKind} onChange={e => { const v = e.target.value; if (isReviewKind(v)) setReviewKind(v); }}>{CA_KINDS.map(k => <option key={k} value={k}>{k}</option>)}</select></label><label>修正状态: <select value={reviewCorr} onChange={e => { const v = e.target.value; if (isReviewCorrection(v)) setReviewCorr(v); }}>{CORR_STATES.map(c => <option key={c} value={c}>{c}</option>)}</select></label><label>备注: <input value={reviewNote} onChange={e => setReviewNote(e.target.value)} /></label><div className="ca-form-actions"><button className="ca-btn ca-btn--primary ca-btn--sm" onClick={doReview}>确认审核</button><button className="ca-btn ca-btn--sm" onClick={() => setReviewingId(null)}>取消</button></div></div>}
      </fieldset>
      {!!selectedIds.length && <div>已选 {selectedIds.length} 个来源</div>}
      <details className="ca-json-import"><summary>JSON 导入</summary>{!showJson ? <button className="ca-btn ca-btn--sm" onClick={() => setShowJson(true)}>输入</button> : <div className="ca-field"><textarea id="ca-json" rows={8} value={jsonInput} onChange={e => setJsonInput(e.target.value)} /><div className="ca-form-actions"><button className="ca-btn ca-btn--primary" onClick={importJson}>导入</button><button className="ca-btn" onClick={() => setShowJson(false)}>取消</button></div></div>}</details>
      <div className="ca-form-actions"><button className="ca-btn ca-btn--primary ca-btn--lg" onClick={execute} disabled={!selectedIds.length || !title.trim()}>执行验证</button></div>
    </div>}
    {!!pv.length && <div className="ca-preview" aria-label="预览"><h3>预览</h3>{pv.map(s => <section key={s.heading}><h4>{s.heading}</h4><pre>{s.content}</pre></section>)}{receipt && <section><h4>凭据</h4><p>Receipt: {receipt.receiptId}</p></section>}{exportText && <section><h4>导出</h4><pre>{exportText}</pre></section>}</div>}
  </div>);
}
