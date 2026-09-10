/**
 * Evidence tools — expose provenance, reference validation, audit, and integrity
 * capabilities to the agent as callable tools.
 */

import type { ToolSpec, ToolResult } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';
import {
  addClaim,
  updateClaim,
  listClaims,
  findClaim,
  updateProjectMeta,
  loadManifest,
  manifestToPlain,
  claimToPlain,
  type ClaimStatus,
} from '../../manifest/ClaimManifest.js';
import { verifyClaim, type ClaimVerificationResult } from '../../evidence/ClaimVerifier.js';

// ─── Tool Specs ────────────────────────────────────────────

export const PROVENANCE_TOOL: ToolSpec = {
  name: 'provenance_check',
  description: 'Trace the origin of factual claims in your output. Checks whether numerical claims, DOIs, and arXiv references are backed by tool results or external sources.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to analyze for claim provenance (e.g., your draft output)' },
    },
    required: ['text'],
  },
};

export const REFERENCE_CHECK_TOOL: ToolSpec = {
  name: 'reference_check',
  description: 'Verify that cited papers actually exist. Checks DOIs against doi.org and arXiv IDs against export.arxiv.org. Also detects known retracted papers.',
  parameters: {
    type: 'object',
    properties: {
      refs: { type: 'string', description: 'Comma-separated or newline-separated DOIs and/or arXiv IDs to verify' },
    },
    required: ['refs'],
  },
};

export const AUDIT_REPORT_TOOL: ToolSpec = {
  name: 'audit_report',
  description: 'Generate an audit report of the provided text. Shows the immutable hash-chained operation log and integrity scoring for tamper-evident record keeping.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to audit' },
    },
    required: ['text'],
  },
};

export const INTEGRITY_REPORT_TOOL: ToolSpec = {
  name: 'integrity_report',
  description: 'Generate a comprehensive research integrity report with 9-dimension scoring: experiment reproducibility, data sourcing, reference authenticity, operation audit, self-consistency, retraction check, provenance coverage, claim faithfulness, writing/format quality, and overall trust score. Optional texDir triggers LaTeX writing audits (latex_integrity_report, section_audit).',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Final agent output text to evaluate' },
      texDir: { type: 'string', description: 'Optional directory containing .tex files to run LaTeX writing/format audits' },
      bibPath: { type: 'string', description: 'Optional path to .bib file for reference integrity check when texDir is provided' },
    },
    required: ['text'],
  },
};

export const VERIFY_CLAIM_TOOL: ToolSpec = {
  name: 'verify_claim',
  description: 'Check whether a specific factual claim is supported by the text of a cited paper. Provide the claim and a DOI, arXiv ID, or direct PDF URL. The tool downloads the open-access PDF, extracts text, ranks the most relevant passages by keyword overlap, and, when an LLM provider is available, performs a semantic support / contradiction judgment.',
  parameters: {
    type: 'object',
    properties: {
      claim: { type: 'string', description: 'The factual claim to verify (e.g., "The proposed method improves accuracy over the baseline")' },
      doi: { type: 'string', description: 'DOI of the cited paper (optional if arxivId or pdfUrl is provided)' },
      arxivId: { type: 'string', description: 'arXiv ID of the cited paper (optional if doi or pdfUrl is provided)' },
      pdfUrl: { type: 'string', description: 'Direct URL to an open-access PDF (optional; used if identifier resolution fails)' },
    },
    required: ['claim'],
  },
};

export const CLAIM_MANIFEST_ADD_TOOL: ToolSpec = {
  name: 'claim_manifest_add',
  description: 'Add a claim to the project manifest. Claims are persisted across sessions so a new chat can resume long-running research.',
  parameters: {
    type: 'object',
    properties: {
      claim: { type: 'string', description: 'The factual claim text' },
      source: { type: 'string', description: 'Human-readable source citation' },
      doi: { type: 'string', description: 'DOI if available' },
      arxivId: { type: 'string', description: 'arXiv ID if available' },
      status: { type: 'string', enum: ['proposed', 'verified', 'single_index', 'mismatch', 'contradicted', 'unverifiable', 'gap'], description: 'Initial status' },
      evidenceArtifacts: { type: 'array', items: { type: 'string' }, description: 'List of evidence artifacts (DOIs, URLs, file paths)' },
      gapReason: { type: 'string', description: 'If status is gap, explain why' },
    },
    required: ['claim', 'status'],
  },
};

export const CLAIM_MANIFEST_UPDATE_TOOL: ToolSpec = {
  name: 'claim_manifest_update',
  description: 'Update the status or evidence of an existing claim in the manifest.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Claim ID returned by claim_manifest_add' },
      status: { type: 'string', enum: ['proposed', 'verified', 'single_index', 'mismatch', 'contradicted', 'unverifiable', 'gap'], description: 'New status' },
      evidenceArtifacts: { type: 'array', items: { type: 'string' }, description: 'Updated evidence artifacts' },
      gapReason: { type: 'string', description: 'Updated gap reason' },
    },
    required: ['id'],
  },
};

export const CLAIM_MANIFEST_LIST_TOOL: ToolSpec = {
  name: 'claim_manifest_list',
  description: 'List claims in the project manifest, optionally filtered by status.',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['proposed', 'verified', 'single_index', 'mismatch', 'contradicted', 'unverifiable', 'gap'], description: 'Optional status filter' },
    },
  },
};

export const CLAIM_MANIFEST_VERIFY_TOOL: ToolSpec = {
  name: 'claim_manifest_verify',
  description: 'Verify a claim against the text of its cited paper and sync the result into the project claim manifest. If the claim is not already in the manifest, it is created automatically.',
  parameters: {
    type: 'object',
    properties: {
      claimId: { type: 'string', description: 'Existing claim ID to update (optional if claim text is provided)' },
      claim: { type: 'string', description: 'The factual claim text (required if claimId is not provided)' },
      doi: { type: 'string', description: 'DOI of the cited paper' },
      arxivId: { type: 'string', description: 'arXiv ID of the cited paper' },
      pdfUrl: { type: 'string', description: 'Direct PDF URL (used if DOI/arXiv resolution fails)' },
      createIfMissing: { type: 'boolean', description: 'Create a new manifest entry if no matching claim is found (default true)' },
    },
    required: [],
  },
};

export const PROJECT_META_UPDATE_TOOL: ToolSpec = {
  name: 'project_meta_update',
  description: 'Update project-level metadata in the manifest (project name and research question).',
  parameters: {
    type: 'object',
    properties: {
      projectName: { type: 'string', description: 'Project name' },
      researchQuestion: { type: 'string', description: 'Research question' },
    },
  },
};

// ─── Handlers ──────────────────────────────────────────────

export const provenanceCheckHandler: ToolHandler = async (args) => {
  const text = String(args.text ?? '');
  if (!text.trim()) return 'No text provided for provenance analysis.';

  try {
    const { ProvenanceChain } = await import('../../evidence/ProvenanceChain.js');
    const chain = new ProvenanceChain('evidence-tool');
    const entries = chain.autoTrace(text, 0);

    if (entries.length === 0) {
      return 'No traceable claims found in the provided text.';
    }

    const verified = entries.filter((e) => e.confidence >= 0.5);
    const report = chain.generateReport();
    const lines = [
      `# Provenance Analysis`,
      `Total claims detected: ${entries.length}`,
      `Verifiable claims: ${verified.length}`,
      `Unverifiable claims: ${entries.length - verified.length}`,
      `Average confidence: ${(report.stats.averageConfidence * 100).toFixed(0)}%`,
      '',
      '## Claim Details',
      ...entries.map((e) => {
        const icon = e.confidence >= 0.8 ? '[通过]' : e.confidence >= 0.5 ? '[警告]' : '[失败]';
        return `${icon} **${e.claim.slice(0, 80)}** — ${e.sourceType} (confidence: ${(e.confidence * 100).toFixed(0)}%)`;
      }),
    ];
    return lines.join('\n');
  } catch (err) {
    return `Provenance check failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const referenceCheckHandler: ToolHandler = async (args) => {
  const refsStr = String(args.refs ?? '');
  if (!refsStr.trim()) return 'No references provided.';

  try {
    const { getReferenceValidator } = await import('../../evidence/ReferenceValidator.js');
    const validator = getReferenceValidator();

    const refs = refsStr.split(/[,;\n]+/).map((r) => r.trim()).filter(Boolean);
    const results = await Promise.all(
      refs.map(async (ref) => {
        if (ref.startsWith('10.')) return validator.validateDoi(ref);
        return validator.validateArxiv(ref);
      }),
    );

    return validator.formatSummary(results);
  } catch (err) {
    return `Reference check failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

async function generateIntegrityReport(
  text: string,
  texDir?: string,
  bibPath?: string,
): Promise<string> {
  if (!text.trim()) return 'No text provided for integrity evaluation.';

  try {
    const { getIntegrityReporter } = await import('../../evidence/IntegrityReporter.js');
    const { ProvenanceChain } = await import('../../evidence/ProvenanceChain.js');
    const { getReferenceValidator } = await import('../../evidence/ReferenceValidator.js');
    const { loadManifest } = await import('../../manifest/ClaimManifest.js');
    const { runLaTeXIntegrityReport } = await import('../../writing/LaTeXIntegrityReporter.js');
    const { auditSections } = await import('../../writing/SectionAuditor.js');

    const reporter = getIntegrityReporter();

    // Run provenance analysis
    const chain = new ProvenanceChain('integrity-check');
    chain.autoTrace(text, 0);
    const provenanceReport = chain.generateReport();

    // Extract DOIs and arXiv IDs for validation
    const dois = text.match(/\b10\.\d{4,}\/[\w._\-()/]+\b/g) ?? [];
    const arxivs = text.match(/\b(?:arXiv:\s*)?\d{4}\.\d{4,5}(?:v\d+)?\b/g) ?? [];
    const validator = getReferenceValidator();
    const refResults = await Promise.all([
      ...dois.map((d) => validator.validateDoi(d)),
      ...arxivs.map((a) => validator.validateArxiv(a)),
    ]);

    // Load any previously audited claims from the manifest
    const manifest = await loadManifest();

    // Optionally run LaTeX writing/format audits
    const writingToolResults: ToolResult[] = [];
    let writingAudit: import('../../evidence/IntegrityReporter.js').WritingAuditSummary | undefined;

    if (texDir && texDir.trim()) {
      const recommendations: string[] = [];
      const topIssues: Array<{ tool: string; message: string; severity?: string }> = [];

      try {
        const latexReport = await runLaTeXIntegrityReport({ texDir, bibPath });
        writingToolResults.push({
          toolName: 'latex_integrity_report',
          content: [
            `# LaTeX Integrity Report`,
            `Project: ${latexReport.texDir}`,
            `Total issues: ${latexReport.severity.total}`,
            `Severity — critical: ${latexReport.severity.critical}, high: ${latexReport.severity.high}, medium: ${latexReport.severity.medium}, low: ${latexReport.severity.low}`,
          ].join('\n'),
          status: 'ok',
          toolCallId: '',
          metadata: {},
        });

        for (const issue of latexReport.sections.latex.issues.slice(0, 3)) {
          topIssues.push({ tool: 'latex_integrity_report', message: `[${issue.type}] ${issue.file}:${issue.line} — ${issue.message}` });
        }
        for (const fig of latexReport.sections.figures.figures) {
          for (const issue of fig.issues.slice(0, 2)) {
            topIssues.push({ tool: 'figure_audit', message: `[${issue.type}] ${fig.includePath} — ${issue.message}` });
          }
        }
        for (const table of latexReport.sections.tables.tables) {
          for (const issue of table.issues.slice(0, 2)) {
            topIssues.push({ tool: 'table_audit', message: `[${issue.type}] ${table.environment} — ${issue.message}` });
          }
        }
        recommendations.push(...latexReport.recommendations);
      } catch (latexErr) {
        writingToolResults.push({
          toolName: 'latex_integrity_report',
          content: `LaTeX integrity audit failed: ${latexErr instanceof Error ? latexErr.message : String(latexErr)}`,
          status: 'error',
          toolCallId: '',
          metadata: {},
        });
      }

      try {
        const sectionReport = await auditSections(texDir);
        writingToolResults.push({
          toolName: 'section_audit',
          content: [
            `# Section Structure Audit Report`,
            `Sections found: ${sectionReport.sections.length}`,
            `Total issues: ${sectionReport.totalIssues}`,
          ].join('\n'),
          status: 'ok',
          toolCallId: '',
          metadata: {},
        });

        for (const issue of sectionReport.recommendations.slice(0, 5)) {
          recommendations.push(issue);
        }
        // Section audit only exposes issue counts/recommendations; surface recommendations as issues.
        if (sectionReport.totalIssues > 0) {
          topIssues.push({
            tool: 'section_audit',
            message: `共 ${sectionReport.totalIssues} 个结构问题（如缺失章节、顺序错误、空章节等）`,
          });
        }
      } catch (sectionErr) {
        writingToolResults.push({
          toolName: 'section_audit',
          content: `Section audit failed: ${sectionErr instanceof Error ? sectionErr.message : String(sectionErr)}`,
          status: 'error',
          toolCallId: '',
          metadata: {},
        });
      }

      // Aggregate severity from the synthetic tool-result strings we generated.
      const { getIntegrityReporter } = await import('../../evidence/IntegrityReporter.js');
      const fallbackSummary = getIntegrityReporter().extractWritingAuditSummary?.(writingToolResults);
      writingAudit = {
        totalIssues: fallbackSummary?.totalIssues ?? 0,
        critical: fallbackSummary?.critical ?? 0,
        high: fallbackSummary?.high ?? 0,
        medium: fallbackSummary?.medium ?? 0,
        low: fallbackSummary?.low ?? 0,
        toolsFound: writingToolResults.filter((tr) => tr.status === 'ok').length,
        topIssues: topIssues.slice(0, 10),
        recommendations: [...new Set(recommendations)],
      };
    }

    const report = reporter.generate({
      provenance: provenanceReport,
      referenceResults: refResults,
      claimManifestEntries: manifest.claims,
      toolResults: writingToolResults,
      writingAudit,
      sessionId: 'integrity-check',
    });

    return reporter.formatReport(report);
  } catch (err) {
    return `Integrity report failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const auditReportHandler: ToolHandler = async (args) => {
  const text = String(args.text ?? '');
  if (!text.trim()) return 'No text provided for audit report.';
  return generateIntegrityReport(
    text,
    args.texDir ? String(args.texDir) : undefined,
    args.bibPath ? String(args.bibPath) : undefined,
  );
};

export const integrityReportHandler: ToolHandler = async (args) => {
  const text = String(args.text ?? '');
  return generateIntegrityReport(
    text,
    args.texDir ? String(args.texDir) : undefined,
    args.bibPath ? String(args.bibPath) : undefined,
  );
};

export const verifyClaimHandler: ToolHandler = async (args, context) => {
  const claim = String(args.claim ?? '');
  if (!claim.trim()) return 'Error: claim is required.';

  const doi = args.doi ? String(args.doi) : undefined;
  const arxivId = args.arxivId ? String(args.arxivId) : undefined;
  const pdfUrl = args.pdfUrl ? String(args.pdfUrl) : undefined;

  if (!doi && !arxivId && !pdfUrl) {
    return 'Error: at least one of doi, arxivId, or pdfUrl is required.';
  }

  try {
    const { verifyClaim } = await import('../../evidence/ClaimVerifier.js');
    const result = await verifyClaim({ claim, doi, arxivId, pdfUrl, provider: context?.provider });

    const lines = [
      `# Claim Verification Report`,
      `Claim: ${result.claim}`,
      `Identifier: ${result.identifier} (${result.identifierType})`,
      `Final verdict: ${result.verdict}`,
      `Keyword verdict: ${result.keywordVerdict}`,
      `PDF downloaded: ${result.pdfDownloaded ? 'Yes' : 'No'}`,
      `Reasoning: ${result.reasoning}`,
      '',
      '## Source metadata',
      JSON.stringify(result.metadata, null, 2),
    ];

    if (result.semantic) {
      lines.push(
        '',
        '## LLM semantic judgment',
        `Verdict: ${result.semantic.verdict}`,
        `Confidence: ${(result.semantic.confidence * 100).toFixed(0)}%`,
        `Reasoning: ${result.semantic.reasoning}`,
        `Cited passages: ${result.semantic.passageIndices.join(', ') || 'none'}`,
      );
    }

    if (result.topPassages.length > 0) {
      lines.push('', '## Most relevant passages');
      for (const [idx, passage] of result.topPassages.entries()) {
        const pageInfo = passage.page ? ` (page ${passage.page})` : '';
        lines.push(`[${idx + 1}] Score ${passage.score.toFixed(2)}${pageInfo}: ${passage.text}`);
      }
    }

    lines.push('', '## Raw JSON', JSON.stringify(result, null, 2));
    return lines.join('\n');
  } catch (err) {
    return `Claim verification failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

function verificationToManifestStatus(result: ClaimVerificationResult): {
  status: ClaimStatus;
  gapReason?: string;
} {
  const semanticVerdict = result.semantic?.verdict ?? result.verdict;

  switch (semanticVerdict) {
    case 'SUPPORTED':
      return { status: 'verified' };
    case 'LIKELY_SUPPORTED':
      return { status: 'single_index', gapReason: 'Evidence is encouraging but indirect or hedged.' };
    case 'INSUFFICIENT_EVIDENCE':
      return { status: 'gap', gapReason: 'Source text does not clearly support the claim.' };
    case 'CONTRADICTED':
      return { status: 'contradicted', gapReason: 'A relevant passage contradicts the claim.' };
    case 'NO_TEXT_AVAILABLE':
      return { status: 'unverifiable', gapReason: 'No open-access PDF or usable text available.' };
    case 'ERROR':
      return { status: 'unverifiable', gapReason: `Verification error: ${result.reasoning}` };
    default:
      return { status: 'unverifiable', gapReason: 'Unexpected verification result.' };
  }
}

function buildEvidenceArtifacts(
  result: ClaimVerificationResult,
  identifiers: { doi?: string; arxivId?: string; pdfUrl?: string },
): string[] {
  const artifacts: string[] = [];
  if (identifiers.doi) artifacts.push(`DOI:${identifiers.doi}`);
  if (identifiers.arxivId) artifacts.push(`arXiv:${identifiers.arxivId}`);
  if (identifiers.pdfUrl) artifacts.push(`PDF:${identifiers.pdfUrl}`);
  if (result.pdfUrl && result.pdfUrl !== identifiers.pdfUrl) artifacts.push(`Resolved PDF:${result.pdfUrl}`);

  for (const [idx, passage] of result.topPassages.slice(0, 3).entries()) {
    artifacts.push(`[${idx + 1}] ${passage.text.slice(0, 240)}`);
  }
  return artifacts;
}

export const claimManifestVerifyHandler: ToolHandler = async (args, context) => {
  const claimId = args.claimId ? String(args.claimId) : undefined;
  const claimText = args.claim ? String(args.claim) : undefined;
  const doi = args.doi ? String(args.doi) : undefined;
  const arxivId = args.arxivId ? String(args.arxivId) : undefined;
  const pdfUrl = args.pdfUrl ? String(args.pdfUrl) : undefined;
  const createIfMissing = args.createIfMissing !== false;

  if (!claimId && !claimText) {
    return 'Error: claimId or claim is required.';
  }
  if (!doi && !arxivId && !pdfUrl) {
    return 'Error: at least one of doi, arxivId, or pdfUrl is required.';
  }

  try {
    const existing = claimId
      ? await findClaim({ id: claimId })
      : await findClaim({ claim: claimText, doi, arxivId, pdfUrl });

    if (claimId && !existing) {
      return `Claim ${claimId} not found in manifest.`;
    }

    const claimToVerify = claimText ?? existing?.claim ?? '';
    const result = await verifyClaim({
      claim: claimToVerify,
      doi,
      arxivId,
      pdfUrl,
      provider: context?.provider,
    });

    const { status, gapReason } = verificationToManifestStatus(result);
    const artifacts = buildEvidenceArtifacts(result, { doi, arxivId, pdfUrl });

    let entry;
    if (existing) {
      entry = await updateClaim(existing.id, {
        status,
        gapReason,
        evidenceArtifacts: artifacts,
      });
    } else if (createIfMissing) {
      entry = await addClaim({
        claim: claimToVerify,
        source: result.identifier,
        doi,
        arxivId,
        pdfUrl,
        status,
        gapReason,
        evidenceArtifacts: artifacts,
      });
    } else {
      return 'No matching claim found and createIfMissing is false.';
    }

    const lines = [
      `# Claim Manifest Verification Report`,
      `Entry ID: ${entry!.id}`,
      `Claim: ${entry!.claim}`,
      `Identifier: ${result.identifier} (${result.identifierType})`,
      `Final verdict: ${result.verdict}`,
      `Manifest status: ${entry!.status}`,
      `Keyword verdict: ${result.keywordVerdict}`,
      result.semantic
        ? `LLM confidence: ${(result.semantic.confidence * 100).toFixed(0)}%`
        : '',
      `Reasoning: ${result.reasoning}`,
      `Gap reason: ${entry!.gapReason ?? 'none'}`,
      '',
      '## Evidence artifacts',
      ...entry!.evidenceArtifacts!.map((a) => `- ${a}`),
      '',
      '## Raw JSON',
      JSON.stringify({ verification: result, manifest: claimToPlain(entry!) }, null, 2),
    ];
    return lines.filter(Boolean).join('\n');
  } catch (err) {
    return `Claim manifest verification failed: ${err instanceof Error ? err.message : String(err)}`;
  }
};

// ─── Registration Helpers ──────────────────────────────────

export const claimManifestAddHandler: ToolHandler = async (args) => {
  const claim = String(args.claim ?? '');
  if (!claim.trim()) return 'Error: claim is required.';

  const validStatuses = ['proposed', 'verified', 'single_index', 'mismatch', 'contradicted', 'unverifiable', 'gap'];
  const status = String(args.status ?? 'proposed');
  if (!validStatuses.includes(status)) return `Error: status must be one of ${validStatuses.join(', ')}.`;

  try {
    const entry = await addClaim({
      claim,
      source: args.source ? String(args.source) : undefined,
      doi: args.doi ? String(args.doi) : undefined,
      arxivId: args.arxivId ? String(args.arxivId) : undefined,
      status: status as Parameters<typeof addClaim>[0]['status'],
      evidenceArtifacts: Array.isArray(args.evidenceArtifacts) ? args.evidenceArtifacts.map(String) : undefined,
      gapReason: args.gapReason ? String(args.gapReason) : undefined,
    });
    return `Claim added to manifest with ID: ${entry.id}\n\n${JSON.stringify(claimToPlain(entry), null, 2)}`;
  } catch (err) {
    return `Failed to add claim: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const claimManifestUpdateHandler: ToolHandler = async (args) => {
  const id = String(args.id ?? '');
  if (!id.trim()) return 'Error: id is required.';

  try {
    const updates: Parameters<typeof updateClaim>[1] = {};
    if (args.status !== undefined) updates.status = String(args.status) as Parameters<typeof updateClaim>[1]['status'];
    if (args.evidenceArtifacts !== undefined) updates.evidenceArtifacts = Array.isArray(args.evidenceArtifacts) ? args.evidenceArtifacts.map(String) : [];
    if (args.gapReason !== undefined) updates.gapReason = String(args.gapReason);

    const entry = await updateClaim(id, updates);
    if (!entry) return `Claim ${id} not found.`;
    return `Claim ${id} updated.\n\n${JSON.stringify(claimToPlain(entry), null, 2)}`;
  } catch (err) {
    return `Failed to update claim: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const claimManifestListHandler: ToolHandler = async (args) => {
  try {
    const status = args.status ? String(args.status) : undefined;
    const claims = await listClaims(status ? { status: status as NonNullable<Parameters<typeof listClaims>[0]>['status'] } : undefined);
    const manifest = await loadManifest();
    return `Project: ${manifest.projectName ?? 'Untitled'}\nResearch question: ${manifest.researchQuestion ?? 'Not set'}\n\nClaims (${claims.length}):\n${claims.map((c, idx) => `[${idx + 1}] (${c.status}) ${c.claim}${c.source ? ` — ${c.source}` : ''}`).join('\n')}\n\nRaw JSON:\n${JSON.stringify({ ...manifestToPlain(manifest), filteredClaims: claims.map(claimToPlain) }, null, 2)}`;
  } catch (err) {
    return `Failed to list claims: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const projectMetaUpdateHandler: ToolHandler = async (args) => {
  try {
    await updateProjectMeta({
      projectName: args.projectName ? String(args.projectName) : undefined,
      researchQuestion: args.researchQuestion ? String(args.researchQuestion) : undefined,
    });
    const manifest = await loadManifest();
    return `Project metadata updated.\n\n${JSON.stringify(manifestToPlain(manifest), null, 2)}`;
  } catch (err) {
    return `Failed to update project metadata: ${err instanceof Error ? err.message : String(err)}`;
  }
};

export const EVIDENCE_TOOL_SPECS: ToolSpec[] = [
  PROVENANCE_TOOL,
  REFERENCE_CHECK_TOOL,
  AUDIT_REPORT_TOOL,
  INTEGRITY_REPORT_TOOL,
  VERIFY_CLAIM_TOOL,
  CLAIM_MANIFEST_ADD_TOOL,
  CLAIM_MANIFEST_UPDATE_TOOL,
  CLAIM_MANIFEST_LIST_TOOL,
  CLAIM_MANIFEST_VERIFY_TOOL,
  PROJECT_META_UPDATE_TOOL,
];

export function getEvidenceToolSpecs(): ToolSpec[] {
  return EVIDENCE_TOOL_SPECS;
}

export function getEvidenceToolHandlers(): Map<string, ToolHandler> {
  const map = new Map<string, ToolHandler>();
  map.set('provenance_check', provenanceCheckHandler);
  map.set('reference_check', referenceCheckHandler);
  map.set('audit_report', auditReportHandler);
  map.set('integrity_report', integrityReportHandler);
  map.set('verify_claim', verifyClaimHandler);
  map.set('claim_manifest_add', claimManifestAddHandler);
  map.set('claim_manifest_update', claimManifestUpdateHandler);
  map.set('claim_manifest_list', claimManifestListHandler);
  map.set('claim_manifest_verify', claimManifestVerifyHandler);
  map.set('project_meta_update', projectMetaUpdateHandler);
  return map;
}
