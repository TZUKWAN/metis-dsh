/**
 * LaTeX Live Preview Page — integrated LaTeX editing, compilation, and preview.
 *
 * Features:
 *   - Split-pane: LaTeX source editor (left) + compiled preview (right)
 *   - Template library: article, report, beamer, IEEE conference
 *   - Real compilation via pdflatex (if available) with error highlighting
 *   - KaTeX math rendering for inline preview
 *   - Citation integration with paper library
 *   - Math symbol toolbar for quick insertion
 *   - Export to PDF (via backend compilation service)
 *
 * Note: Full LaTeX compilation requires pdflatex backend. If not available,
 * the page shows a simplified preview with KaTeX math rendering.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useMetisStore } from '../store';
import { useTranslation } from '../i18n';
import katex from 'katex';
import 'katex/dist/katex.min.css';

import type { PaperItem } from '../store';
import type { FileCapabilityDescriptor } from '../../engine/runtime/FileCapabilityContract';

// ─── Helpers ──────────────────────────────────────────────────────

function generateBibtexKey(paper: PaperItem): string {
  const firstAuthor = paper.authors[0]?.split(' ').pop() ?? 'unknown';
  const shortTitle = paper.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(' ').slice(0, 3).join('');
  return `${firstAuthor.toLowerCase()}${paper.year}${shortTitle}`;
}

function extractCiteKeys(source: string): string[] {
  const keys = new Set<string>();
  const regex = /\\cite[pt]?\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const raw = match[1] ?? '';
    for (const key of raw.split(',')) {
      const trimmed = key.trim();
      if (trimmed) keys.add(trimmed);
    }
  }
  return Array.from(keys);
}

function paperToBibtex(paper: PaperItem): string {
  const key = generateBibtexKey(paper);
  const type = paper.venue ? 'article' : 'misc';
  const fields = [
    `  title={${paper.title}}`,
    `  author={${paper.authors.join(' and ')}}`,
    `  year={${paper.year}}`,
  ];
  if (paper.venue) fields.push(`  journal={${paper.venue}}`);
  if (paper.doi) fields.push(`  doi={${paper.doi}}`);
  return `@${type}{${key},\n${fields.join(',\n')}\n}`;
}

// ─── LaTeX Templates ────────────────────────────────────────────

interface LatexTemplate {
  id: string;
  name: string;
  description: string;
  content: string;
}

const TEMPLATES: LatexTemplate[] = [
  {
    id: 'article',
    name: 'Article',
    description: 'Standard research article',
    content: `\\documentclass[12pt,a4paper]{article}

% Packages
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{cite}
\\usepackage{booktabs}
\\usepackage{geometry}
\\geometry{margin=1in}

\\title{Your Paper Title}
\\author{Author Name \\\\
  Affiliation \\\\
  \\texttt{email@example.com}}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
Your abstract here. Summarize the key contributions and findings of your paper.
\\end{abstract}

\\section{Introduction}
Introduce the problem and your contributions.

\\section{Related Work}
Discuss related research and how your work differs.

\\section{Methodology}
Describe your approach in detail.

\\section{Experiments}
\\subsection{Setup}
Describe the experimental setup.

\\subsection{Results}
Present your results.

\\begin{table}[h]
\\centering
\\begin{tabular}{lcc}
\\toprule
Method & Accuracy & F1 Score \\\\
\\midrule
Baseline & 85.2 & 0.84 \\\\
Ours & \\textbf{92.1} & \\textbf{0.91} \\\\
\\bottomrule
\\end{tabular}
\\caption{Comparison results}
\\end{table}

\\section{Discussion}
Discuss implications and limitations.

\\section{Conclusion}
Summarize your contributions.

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}`,
  },
  {
    id: 'report',
    name: 'Report',
    description: 'Technical report with chapters',
    content: `\\documentclass[12pt,a4paper]{report}

\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{cite}
\\usepackage{geometry}
\\geometry{margin=1in}

\\title{Technical Report Title}
\\author{Author Name}
\\date{\\today}

\\begin{document}

\\maketitle
\\tableofcontents

\\chapter{Introduction}
Background and motivation.

\\chapter{Literature Review}
Review of existing work.

\\chapter{Methodology}
Detailed methodology description.

\\chapter{Results and Analysis}
Experimental results.

\\chapter{Conclusions}
Summary and future work.

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}`,
  },
  {
    id: 'beamer',
    name: 'Beamer Slides',
    description: 'Presentation slides',
    content: `\\documentclass[aspectratio=169]{beamer}

\\usetheme{Madrid}
\\usecolortheme{default}

\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}

\\title{Presentation Title}
\\subtitle{Subtitle}
\\author{Author Name}
\\institute{Institution}
\\date{\\today}

\\begin{document}

\\begin{frame}
\\titlepage
\\end{frame}

\\begin{frame}{Outline}
\\tableofcontents
\\end{frame}

\\section{Introduction}

\\begin{frame}{Problem Statement}
\\begin{itemize}
  \\item First key point
  \\item Second key point
  \\item Third key point
\\end{itemize}
\\end{frame}

\\section{Methodology}

\\begin{frame}{Our Approach}
\\begin{columns}
\\begin{column}{0.5\\textwidth}
\\begin{itemize}
  \\item Step 1
  \\item Step 2
  \\item Step 3
\\end{itemize}
\\end{column}
\\begin{column}{0.5\\textwidth}
% Insert figure here
\\centering
\\textit{Figure placeholder}
\\end{column}
\\end{columns}
\\end{frame}

\\section{Results}

\\begin{frame}{Results}
\\begin{table}
\\centering
\\begin{tabular}{lcc}
\\toprule
Method & Accuracy & F1 \\\\
\\midrule
Baseline & 85.2 & 0.84 \\\\
Ours & \\textbf{92.1} & \\textbf{0.91} \\\\
\\bottomrule
\\end{tabular}
\\caption{Comparison}
\\end{table}
\\end{frame}

\\section{Conclusion}

\\begin{frame}{Conclusion}
\\begin{itemize}
  \\item Summary of contributions
  \\item Future directions
\\end{itemize}

\\vspace{1em}
\\centering
\\Large Thank you!
\\end{frame}

\\end{document}`,
  },
  {
    id: 'ieee',
    name: 'IEEE Conference',
    description: 'IEEE conference paper format',
    content: `\\documentclass[conference]{IEEEtran}

\\usepackage{cite}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{algorithmic}
\\usepackage{graphicx}
\\usepackage{textcomp}

\\title{Your Paper Title Here\\thanks{This work was supported by...}}

\\author{\\IEEEauthorblockN{First Author}
\\IEEEauthorblockA{Affiliation\\\\
Email: author@example.com}
\\and
\\IEEEauthorblockN{Second Author}
\\IEEEauthorblockA{Affiliation\\\\
Email: author2@example.com}}

\\begin{document}

\\maketitle

\\begin{abstract}
Your abstract here. IEEE abstracts are typically 150-250 words.
\\end{abstract}

\\begin{IEEEkeywords}
keyword1, keyword2, keyword3
\\end{IEEEkeywords}

\\section{Introduction}
\\label{sec:intro}
Introduce the problem. IEEE papers emphasize technical contributions.

\\section{Related Work}
\\label{sec:related}
Review existing approaches.

\\section{Proposed Method}
\\label{sec:method}
Describe your method in detail.

\\subsection{Problem Formulation}
Define the problem formally.

\\subsection{Algorithm}
Describe your algorithm.

\\section{Experimental Results}
\\label{sec:results}
Present experiments.

\\section{Conclusion}
\\label{sec:conclusion}
Summarize contributions.

\\bibliographystyle{IEEEtran}
\\bibliography{references}

\\end{document}`,
  },
];

// ─── Math Symbols ───────────────────────────────────────────────

interface MathSymbol {
  label: string;
  latex: string;
  category: string;
}

const MATH_SYMBOLS: MathSymbol[] = [
  { label: 'α', latex: '\\alpha', category: 'Greek' },
  { label: 'β', latex: '\\beta', category: 'Greek' },
  { label: 'γ', latex: '\\gamma', category: 'Greek' },
  { label: 'δ', latex: '\\delta', category: 'Greek' },
  { label: 'ε', latex: '\\epsilon', category: 'Greek' },
  { label: 'θ', latex: '\\theta', category: 'Greek' },
  { label: 'λ', latex: '\\lambda', category: 'Greek' },
  { label: 'μ', latex: '\\mu', category: 'Greek' },
  { label: 'σ', latex: '\\sigma', category: 'Greek' },
  { label: 'Σ', latex: '\\Sigma', category: 'Greek' },
  { label: '∫', latex: '\\int', category: 'Operators' },
  { label: '∑', latex: '\\sum', category: 'Operators' },
  { label: '∏', latex: '\\prod', category: 'Operators' },
  { label: '√', latex: '\\sqrt{}', category: 'Operators' },
  { label: 'frac', latex: '\\frac{}{}', category: 'Operators' },
  { label: '≤', latex: '\\leq', category: 'Relations' },
  { label: '≥', latex: '\\geq', category: 'Relations' },
  { label: '≠', latex: '\\neq', category: 'Relations' },
  { label: '≈', latex: '\\approx', category: 'Relations' },
  { label: '∈', latex: '\\in', category: 'Relations' },
  { label: '→', latex: '\\rightarrow', category: 'Arrows' },
  { label: '⇒', latex: '\\Rightarrow', category: 'Arrows' },
  { label: '∞', latex: '\\infty', category: 'Misc' },
  { label: '∂', latex: '\\partial', category: 'Misc' },
  { label: '∇', latex: '\\nabla', category: 'Misc' },
];

// ─── Compile Error Parser ───────────────────────────────────────

interface CompileError {
  line: number;
  message: string;
  severity: 'error' | 'warning';
}

// ─── Main Component ─────────────────────────────────────────────

export default function LatexPreviewPage() {
  const { papers } = useMetisStore();
  const { t } = useTranslation();
  const defaultTemplate = TEMPLATES[0];
  const [source, setSource] = useState(defaultTemplate?.content ?? '');
  const [activeTemplate, setActiveTemplate] = useState(defaultTemplate?.id ?? 'article');
  const [compileStatus, setCompileStatus] = useState<'idle' | 'compiling' | 'success' | 'error' | 'noCompiler'>('idle');
  const [compileErrors, setCompileErrors] = useState<CompileError[]>([]);
  const [showSymbolPanel, setShowSymbolPanel] = useState(false);
  const [showTemplatePanel, setShowTemplatePanel] = useState(false);
  const [showCitationPanel, setShowCitationPanel] = useState(false);
  const [showCiteCheckPanel, setShowCiteCheckPanel] = useState(false);
  const [citeCheckResult, setCiteCheckResult] = useState<{ missing: string[]; unused: string[] }>({ missing: [], unused: [] });
  const [autoCompile, setAutoCompile] = useState(false);
  const [pdfCapability, setPdfCapability] = useState<FileCapabilityDescriptor | null>(null);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null);
  const [compilerMessage, setCompilerMessage] = useState<string | null>(null);
  const [bibSource, setBibSource] = useState(() => papers.map((p) => paperToBibtex(p)).join('\n\n'));
  const bibSourceRef = useRef(bibSource);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  // AI polish of the current editor selection (main-process one-shot).
  const [aiPolishResult, setAiPolishResult] = useState<string | null>(null);
  const [aiPolishLoading, setAiPolishLoading] = useState(false);
  const [aiPolishError, setAiPolishError] = useState(false);
  // The editor selection captured when polish starts (used by Replace).
  const aiPolishRangeRef = useRef<{ start: number; end: number } | null>(null);

  useEffect(() => {
    bibSourceRef.current = bibSource;
  }, [bibSource]);

  useEffect(() => {
    if (!pdfCapability) {
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional initialization
      setPdfPreviewUrl(null);
      return;
    }
    let active = true;
    let objectUrl: string | null = null;
    void window.metis?.useFileCapability({
      capabilityId: pdfCapability.capabilityId,
      operation: 'read',
      maxBytes: 16 * 1024 * 1024,
    }).then((result) => {
      if (!active || !result.success || result.operation !== 'read') return;
      const pdfBytes = Uint8Array.from(result.data);
      objectUrl = URL.createObjectURL(new Blob([pdfBytes.buffer], { type: 'application/pdf' }));
      setPdfPreviewUrl(objectUrl);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [pdfCapability]);

  // Citation integrity check
  const handleCheckCitations = useCallback(() => {
    const citeKeys = extractCiteKeys(source);
    const libraryKeys = new Set(papers.map((p) => generateBibtexKey(p)));
    const missing = citeKeys.filter((k) => !libraryKeys.has(k));
    const unused = Array.from(libraryKeys).filter((k) => !citeKeys.includes(k));
    setCiteCheckResult({ missing, unused });
    setShowCiteCheckPanel(true);
    setShowCitationPanel(false);
    setShowSymbolPanel(false);
    setShowTemplatePanel(false);
  }, [source, papers]);

  // Real compile via IPC
  const handleCompile = useCallback(async () => {
    setCompileStatus('compiling');
    setCompileErrors([]);
    setCompilerMessage(null);

    try {
      const metis = window.metis;
      if (!metis || !metis.compileLatex) {
        setCompileStatus('error');
        setCompilerMessage('LaTeX compilation API not available');
        return;
      }

      const defaultBib = papers.map((p) => paperToBibtex(p)).join('\n\n');
      const bibContent = source.includes('\\bibliography{references}') || source.includes('\\addbibresource{references.bib}')
        ? bibSourceRef.current || defaultBib
        : undefined;
      const result = await metis.compileLatex(source, bibContent);

      if (result.status === 'noCompiler') {
        setCompileStatus('noCompiler');
        setCompilerMessage(t('latex.statusNoCompiler'));
        setPdfCapability(null);
      } else if (result.status === 'success') {
        setCompileStatus('success');
        setCompileErrors(result.issues.map((issue) => ({
          line: issue.line,
          severity: issue.severity,
          message: issue.severity === 'error'
            ? t('latex.compileIssueError')
            : t('latex.compileIssueWarning'),
        })));
        setPdfCapability(result.pdf);
        setCompilerMessage(null);
      } else {
        setCompileStatus('error');
        setCompileErrors(result.issues.map((issue) => ({
          line: issue.line,
          severity: issue.severity,
          message: issue.severity === 'error'
            ? t('latex.compileIssueError')
            : t('latex.compileIssueWarning'),
        })));
        setCompilerMessage(t('latex.compileUnavailable'));
        setPdfCapability(null);
      }
    } catch {
      setCompileStatus('error');
      setCompilerMessage(t('latex.compileUnavailable'));
      setPdfCapability(null);
    }
  }, [source, papers, t]);

  // Auto-compile handler
  const handleSourceChange = useCallback((value: string) => {
    setSource(value);
    if (autoCompile) {
      // Debounced auto-compile could be added here
    }
  }, [autoCompile]);

  const insertSymbol = useCallback((latex: string) => {
    setSource((prev) => prev + latex);
  }, []);

  const insertCitation = useCallback((entry: { key: string; entry: string }) => {
    setBibSource((prev: string) => {
      if (prev.includes(entry.key)) return prev;
      return prev ? `${prev}\n\n${entry.entry}` : entry.entry;
    });
    setSource((prev) => {
      const textarea = sourceRef.current;
      if (textarea) {
        const start = textarea.selectionStart ?? prev.length;
        const end = textarea.selectionEnd ?? prev.length;
        const before = prev.slice(0, start);
        const after = prev.slice(end);
        const insertion = `\\cite{${entry.key}}`;
        window.requestAnimationFrame(() => {
          const pos = start + insertion.length;
          textarea.setSelectionRange(pos, pos);
          textarea.focus();
        });
        return `${before}${insertion}${after}`;
      }
      return `${prev}\\cite{${entry.key}}`;
    });
    setShowCitationPanel(false);
  }, []);

  /** Run AI polish on the current editor selection. */
  const runAiPolish = async () => {
    const textarea = sourceRef.current;
    const metis = window.metis;
    if (aiPolishLoading || !textarea || !metis?.aiPolishLatex) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const selected = source.slice(start, end).trim();
    if (!selected) return;
    aiPolishRangeRef.current = { start, end };
    setAiPolishLoading(true);
    setAiPolishResult(null);
    setAiPolishError(false);
    try {
      const result = await metis.aiPolishLatex({ text: selected, action: 'polish' });
      if (result.ok && result.text) {
        setAiPolishResult(result.text);
      } else {
        setAiPolishError(true);
      }
    } catch {
      setAiPolishError(true);
    } finally {
      setAiPolishLoading(false);
    }
  };

  /** Replace the captured selection with the polished text. */
  const applyAiPolish = () => {
    const range = aiPolishRangeRef.current;
    if (!range || aiPolishResult === null) return;
    setSource((prev) => `${prev.slice(0, range.start)}${aiPolishResult}${prev.slice(range.end)}`);
    setAiPolishResult(null);
    aiPolishRangeRef.current = null;
  };

  const loadTemplate = useCallback((template: LatexTemplate) => {    setSource(template.content);
    setActiveTemplate(template.id);
    setShowTemplatePanel(false);
    setCompileStatus('idle');
    setCompileErrors([]);
    setPdfCapability(null);
    setCompilerMessage(null);
  }, []);

  // Line count for editor
  const lineCount = source.split('\n').length;

  // Generate preview HTML with KaTeX-rendered math
  const previewHtml = useMemo(() => generatePreview(source), [source]);

  // Keyboard shortcut: Ctrl+Enter to compile
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        void handleCompile();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleCompile]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '8px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
      }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 16, color: 'var(--text-primary)' }}>{t('latex.pageTitle')}</h2>
          <span style={{
            fontSize: 10,
            padding: '2px 8px',
            borderRadius: 4,
            background: compileStatus === 'success' ? 'var(--status-completed-bg)' : compileStatus === 'error' || compileStatus === 'noCompiler' ? 'var(--status-failed-bg)' : compileStatus === 'compiling' ? 'var(--status-running-bg)' : 'var(--bg-card)',
            color: compileStatus === 'success' ? 'var(--status-completed)' : compileStatus === 'error' || compileStatus === 'noCompiler' ? 'var(--status-failed)' : compileStatus === 'compiling' ? 'var(--status-running)' : 'var(--text-secondary)',
            border: '1px solid var(--border)',
          }}>
            {compileStatus === 'idle' ? t('latex.statusReady') : compileStatus === 'compiling' ? t('latex.statusCompiling') : compileStatus === 'success' ? t('latex.statusSuccess') : compileStatus === 'noCompiler' ? t('latex.statusNoCompiler') : t('latex.statusErrorCount', { count: compileErrors.length })}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="btn-secondary"
            onClick={() => setShowTemplatePanel(!showTemplatePanel)}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >
            {t('latex.toolbarTemplates')}
          </button>
          <button
            className="btn-secondary"
            onClick={() => setShowSymbolPanel(!showSymbolPanel)}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >
            {t('latex.toolbarMath')}
          </button>
          <button
            className="btn-secondary"
            onClick={() => setShowCitationPanel(!showCitationPanel)}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >
            {t('latex.toolbarCite', { count: papers.length })}
          </button>
          <button
            className="btn-secondary"
            onClick={() => handleCheckCitations()}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >
            {t('latex.toolbarCheckCitations')}
          </button>
          <button
            className="btn-secondary"
            data-testid="latex-ai-polish"
            disabled={aiPolishLoading}
            onClick={() => void runAiPolish()}
            style={{ fontSize: 11, padding: '4px 10px' }}
            title={t('latex.aiPolishTooltip')}
          >
            {aiPolishLoading ? t('latex.aiPolishLoading') : t('latex.aiPolish')}
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
            <input
              type="checkbox"
              checked={autoCompile}
              onChange={(e) => setAutoCompile(e.target.checked)}
            />
            {t('latex.toolbarAutoCompile')}
          </label>
          <button
            className="btn-primary"
            onClick={() => void handleCompile()}
            disabled={compileStatus === 'compiling'}
            style={{ fontSize: 11, padding: '4px 14px' }}
            title="Ctrl+Enter"
          >
            {t('latex.toolbarCompile')}
          </button>
        </div>
      </div>

      {/* AI polish result */}
      {aiPolishError && (
        <div role="alert" style={{ padding: '8px 12px', margin: '8px 16px', background: 'var(--status-failed-bg)', color: 'var(--status-failed)', borderRadius: 6, fontSize: 13 }}>
          {t('latex.aiPolishFailed')}
        </div>
      )}
      {aiPolishResult !== null && (
        <div className="modal-overlay" onClick={() => setAiPolishResult(null)}>
          <div className="modal modal-wide" data-testid="latex-ai-polish-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t('latex.aiPolishResultTitle')}</h3>
            <div style={{ maxHeight: '55vh', overflowY: 'auto', marginTop: 12, fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
              {aiPolishResult}
            </div>
            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button className="btn-primary" data-testid="latex-ai-polish-apply" onClick={applyAiPolish}>
                {t('latex.aiPolishApply')}
              </button>
              <button className="btn-secondary" onClick={() => setAiPolishResult(null)}>{t('common.cancel')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Template Panel */}
      {showTemplatePanel && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', display: 'flex', gap: 8 }}>
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.id}
              onClick={() => loadTemplate(tpl)}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: activeTemplate === tpl.id ? '2px solid var(--accent-primary)' : '1px solid var(--border)',
                background: activeTemplate === tpl.id ? 'var(--accent-primary-bg, var(--bg-card))' : 'var(--bg-card)',
                cursor: 'pointer',
                textAlign: 'left',
                color: 'var(--text-primary)',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 12 }}>{t(`latex.template${tpl.id.charAt(0).toUpperCase()}${tpl.id.slice(1)}Name` as 'latex.templateArticleName')}</div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{t(`latex.template${tpl.id.charAt(0).toUpperCase()}${tpl.id.slice(1)}Desc` as 'latex.templateArticleDesc')}</div>
            </button>
          ))}
        </div>
      )}

      {/* Math Symbol Panel */}
      {showSymbolPanel && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {MATH_SYMBOLS.map((sym) => (
              <button
                key={sym.latex}
                onClick={() => insertSymbol(sym.latex)}
                title={`${sym.latex} (${sym.category})`}
                style={{
                  width: 36,
                  height: 32,
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  background: 'var(--bg-card)',
                  cursor: 'pointer',
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text-primary)',
                }}
              >
                {sym.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Citation Panel */}
      {showCitationPanel && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', maxHeight: 200, overflowY: 'auto' }}>
          {papers.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center' }}>
              {t('latex.citationEmpty')}
            </div>
          ) : (
            papers.map((p) => {
              const cite = { key: generateBibtexKey(p), entry: paperToBibtex(p), title: p.title };
              return (
                <button
                  key={cite.key}
                  onClick={() => insertCitation(cite)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '4px 8px',
                    border: 'none',
                    borderRadius: 4,
                    background: 'transparent',
                    cursor: 'pointer',
                    fontSize: 11,
                    color: 'var(--text-primary)',
                    marginBottom: 2,
                  }}
                  onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'var(--bg-hover, var(--border))'; }}
                  onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; }}
                >
                  <span style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>\cite{'{'}{cite.key}{'}'}</span>
                  {' — '}{cite.title}
                </button>
              );
            })
          )}
        </div>
      )}

      {/* Citation Check Panel */}
      {showCiteCheckPanel && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', maxHeight: 200, overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <strong style={{ fontSize: 12, color: 'var(--text-primary)' }}>{t('latex.citeCheckTitle')}</strong>
            <button className="btn-sm" onClick={() => setShowCiteCheckPanel(false)}>{t('common.close')}</button>
          </div>
          {citeCheckResult.missing.length === 0 && citeCheckResult.unused.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--success)' }}>{t('latex.citeCheckOk')}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {citeCheckResult.missing.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, color: 'var(--status-failed)', fontWeight: 600, marginBottom: 4 }}>{t('latex.citeCheckMissing')}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{citeCheckResult.missing.join(', ')}</div>
                </div>
              )}
              {citeCheckResult.unused.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, color: 'var(--status-warning)', fontWeight: 600, marginBottom: 4 }}>{t('latex.citeCheckUnused')}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{citeCheckResult.unused.join(', ')}</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Main Content: Split Pane */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left: Source Editor */}
        <div style={{ flex: 1, display: 'flex', borderRight: '1px solid var(--border)', minWidth: 0 }}>
          {/* Line Numbers */}
          <div style={{
            padding: '8px 8px 8px 12px',
            background: 'var(--bg-secondary)',
            color: 'var(--text-muted)',
            fontSize: 12,
            fontFamily: 'monospace',
            lineHeight: '20px',
            textAlign: 'right',
            userSelect: 'none',
            minWidth: 40,
          }}>
            {Array.from({ length: lineCount }, (_, i) => {
              const lineNum = i + 1;
              const hasError = compileErrors.some((e) => e.line === lineNum);
              return (
                <div key={i} style={{ color: hasError ? 'var(--status-failed)' : 'var(--text-muted)', fontWeight: hasError ? 600 : 400 }}>
                  {lineNum}
                </div>
              );
            })}
          </div>

          {/* Text Area */}
          <textarea
            ref={sourceRef}
            value={source}
            onChange={(e) => handleSourceChange(e.target.value)}
            spellCheck={false}
            style={{
              flex: 1,
              padding: '8px 12px',
              border: 'none',
              outline: 'none',
              fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
              fontSize: 13,
              lineHeight: '20px',
              resize: 'none',
              background: compileErrors.length > 0 ? 'var(--status-warning-bg)' : 'var(--bg-card)',
              color: 'var(--text-primary)',
              tabSize: 2,
            }}
          />
        </div>

        {/* Right: Preview / Errors / PDF */}
        <div style={{ flex: 1, overflow: 'auto', minWidth: 0, background: 'var(--bg-card)' }}>
          {compileErrors.length > 0 ? (
            <div style={{ padding: 16 }}>
              <h3 style={{ color: 'var(--status-failed)', fontSize: 14, marginBottom: 12 }}>{t('latex.errorsTitle')}</h3>
              {compileErrors.map((err, i) => (
                <div key={i} style={{
                  padding: '8px 12px',
                  marginBottom: 8,
                  borderRadius: 6,
                  background: err.severity === 'error' ? 'var(--status-failed-bg)' : 'var(--status-warning-bg)',
                  border: `1px solid ${err.severity === 'error' ? 'var(--status-failed)' : 'var(--status-warning)'}`,
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: err.severity === 'error' ? 'var(--status-failed)' : 'var(--status-warning)' }}>
                    {err.severity === 'error' ? t('latex.errorsError') : t('latex.errorsWarning')} {err.line > 0 ? t('latex.errorsLine', { line: err.line }) : ''}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-primary)', marginTop: 2 }}>{err.message}</div>
                </div>
              ))}
            </div>
          ) : pdfCapability ? (
            <div style={{ padding: 16, height: '100%' }}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  PDF compiled successfully
                </span>
                <button
                  className="btn-sm btn-secondary"
                  onClick={() => { void window.metis?.useFileCapability({ capabilityId: pdfCapability.capabilityId, operation: 'file' }); }}
                >
                  {t('latex.openPdf')}
                </button>
                <button
                  className="btn-sm btn-secondary"
                  onClick={() => { void window.metis?.useFileCapability({ capabilityId: pdfCapability.capabilityId, operation: 'folder' }); }}
                >
                  {t('latex.openFolder')}
                </button>
              </div>
              <iframe
                src={pdfPreviewUrl ?? 'about:blank'}
                style={{ width: '100%', height: 'calc(100% - 30px)', border: '1px solid var(--border)', borderRadius: 4 }}
                title="Compiled PDF"
              />
            </div>
          ) : compilerMessage ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
              <div style={{ fontSize: 14, marginBottom: 8, color: 'var(--status-failed)' }}>{compilerMessage}</div>
              <p style={{ fontSize: 12 }}>{t('latex.previewInstructions')}</p>
            </div>
          ) : previewHtml ? (
            <div style={{ padding: 24 }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 12, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                {t('latex.previewDisclaimer')}
              </div>
              <div
                style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text-primary)' }}
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-secondary)' }}>
              <div style={{ textAlign: 'center' }}>
                <svg viewBox="0 0 24 24" width="48" height="48" stroke="var(--text-muted)" fill="none" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12 }}>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
                <h3>{t('latex.previewTitle')}</h3>
                <p style={{ fontSize: 13 }}>{t('latex.previewInstructions')}</p>
                <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {t('latex.previewGetStarted')}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Status Bar */}
      <div style={{
        padding: '4px 16px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: 11,
        color: 'var(--text-secondary)',
      }}>
        <span>{t('latex.statusBarLinesChars', { lines: lineCount, chars: source.length, template: TEMPLATES.find((tp) => tp.id === activeTemplate)?.name ?? t('latex.statusBarCustom') })}</span>
        <span>{t('latex.statusBarCitations', { count: papers.length })} · {compileErrors.length > 0 ? t('latex.statusBarIssueCount', { count: compileErrors.length }) : t('latex.statusBarNoIssues')}</span>
      </div>
    </div>
  );
}

// ─── Preview Generator ──────────────────────────────────────────

function generatePreview(source: string): string {
  let html = '';

  // Extract title
  const titleMatch = source.match(/\\title\{([^}]+)\}/);
  if (titleMatch?.[1]) {
    html += `<h1 style="text-align:center; margin-bottom:8px; color: var(--text-primary);">${escapeHtml(titleMatch[1])}</h1>`;
  }

  // Extract author
  const authorMatch = source.match(/\\author\{([^}]+)\}/);
  if (authorMatch?.[1]) {
    html += `<p style="text-align:center; color:var(--text-secondary); margin-bottom:16px;">${escapeHtml(authorMatch[1].replace(/\\\\/g, ' · '))}</p>`;
  }

  // Extract abstract
  const abstractMatch = source.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/);
  if (abstractMatch?.[1]) {
    html += `<div style="background:var(--bg-secondary); padding:12px 16px; border-radius:8px; border-left:3px solid var(--accent-primary); margin-bottom:16px; color:var(--text-primary);">`;
    html += `<strong>Abstract:</strong> ${escapeHtml(abstractMatch[1].trim())}`;
    html += `</div>`;
  }

  // Process sections
  let processed = source;
  processed = processed.replace(/\\begin\{document\}[\s\S]*?\\maketitle/, '');
  processed = processed.replace(/\\begin\{abstract\}[\s\S]*?\\end\{abstract\}/, '');
  processed = processed.replace(/\\end\{document\}/, '');
  processed = processed.replace(/\\(maketitle|tableofcontents|bibliographystyle|bibliography)\{[^}]*\}/g, '');

  // Replace sections with HTML
  processed = processed.replace(/\\section\{([^}]+)\}/g, (_, title) => `<h2 style="margin-top:20px; border-bottom:1px solid var(--border); padding-bottom:4px; color:var(--text-primary);">${escapeHtml(title)}</h2>`);
  processed = processed.replace(/\\subsection\{([^}]+)\}/g, (_, title) => `<h3 style="margin-top:12px; color:var(--text-primary);">${escapeHtml(title)}</h3>`);

  // Replace basic formatting
  processed = processed.replace(/\\textbf\{([^}]+)\}/g, '<strong>$1</strong>');
  processed = processed.replace(/\\textit\{([^}]+)\}/g, '<em>$1</em>');
  processed = processed.replace(/\\cite\{([^}]+)\}/g, '<span style="color:var(--accent-primary);">[$1]</span>');

  // Replace itemize/enumerate
  processed = processed.replace(/\\begin\{itemize\}/g, '<ul>');
  processed = processed.replace(/\\end\{itemize\}/g, '</ul>');
  processed = processed.replace(/\\begin\{enumerate\}/g, '<ol>');
  processed = processed.replace(/\\end\{enumerate\}/g, '</ol>');
  processed = processed.replace(/\\item\s/g, '<li>');

  // Render inline math with KaTeX
  processed = renderMathInText(processed);

  // Clean up remaining LaTeX commands
  processed = processed.replace(/\\[a-zA-Z]+(\{[^}]*\})?/g, '');
  processed = processed.replace(/\{|\}/g, '');

  // Clean up excessive whitespace
  processed = processed.replace(/\n{3,}/g, '\n\n');

  // Wrap text in paragraphs
  const paragraphs = processed.split('\n\n').filter((p) => p.trim().length > 0);
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed.startsWith('<h') || trimmed.startsWith('<ul') || trimmed.startsWith('<ol')) {
      html += trimmed;
    } else {
      html += `<p style="margin:8px 0; color:var(--text-primary);">${trimmed}</p>`;
    }
  }

  return html || '<p style="color:var(--text-secondary);">No previewable content found.</p>';
}

/**
 * Render LaTeX math expressions in text using KaTeX.
 * Handles both inline ($...$) and display ($$...$$) math.
 */
function renderMathInText(text: string): string {
  // Display math: $$...$$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => {
    try {
      const rendered = katex.renderToString(math.trim(), { displayMode: true, throwOnError: false });
      return rendered;
    } catch {
      return `<pre style="color:var(--status-failed);">$$${math}$$</pre>`;
    }
  });

  // Inline math: $...$ (not preceded by \)
  text = text.replace(/(?<!\\)\$([^$\n]+?)\$/g, (_, math) => {
    try {
      const rendered = katex.renderToString(math.trim(), { displayMode: false, throwOnError: false });
      return rendered;
    } catch {
      return `<span style="color:var(--status-failed);">$${math}$</span>`;
    }
  });

  return text;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
