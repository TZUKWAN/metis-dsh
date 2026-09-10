/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileCapabilitySelectionResult } from '../../engine/runtime/FileCapabilityContract.js';
import type {
  FundingTemplateDiffResponse,
  FundingTemplateGetResponse,
  FundingTemplateImportResponse,
  FundingTemplateIpcRequest,
  FundingTemplateListResponse,
  FundingTemplateRestoreResponse,
  FundingTemplateActivateResponse,
  FundingTemplateArchiveResponse,
  FundingTemplateSummary,
  FundingTemplateVersionView,
} from '../../engine/runtime/FundingTemplateRuntimeContract.js';
import { useMetisStore } from '../../src/store.js';
import FundingTemplatePanel, {
  type FundingTemplatePanelDependencies,
} from '../../src/personalization/FundingTemplatePanel.js';

const D1 = 'a'.repeat(64);
const D2 = 'b'.repeat(64);
const D3 = 'c'.repeat(64);
const CAPABILITY = `fc_${'A'.repeat(32)}`;

const summary: FundingTemplateSummary = {
  ownerId: 'renderer-owner',
  projectId: 'project-1',
  templateId: 'user:fund-template',
  templateRevision: 1,
  activeVersion: 1,
  activeDigest: D1,
  latestVersion: 1,
  archivedAt: null,
  createdAt: 1_900_000_000_000,
  updatedAt: 1_900_000_000_001,
};

const version: FundingTemplateVersionView = {
  templateVersion: 1,
  packageDigest: D1,
  sourceDigest: D2,
  observationDigest: D3,
  savedAt: 1_900_000_000_001,
  sourceFormat: 'pdf',
  pageCount: 3,
  quality: { status: 'ready', overallConfidence: 0.94, issues: [] },
  structure: {
    sectionCount: 7,
    instructionCount: 10,
    tableCount: 2,
    contentSlotCount: 14,
    fieldMappingCount: 12,
    typographyRuleCount: 3,
    layoutEvidence: 'observed',
  },
};

const diff = {
  schemaVersion: 1 as const,
  templateId: summary.templateId,
  fromVersion: 1,
  toVersion: 2,
  fromDigest: D1,
  toDigest: D2,
  changes: [{
    kind: 'changed' as const,
    entity: 'layout' as const,
    entityKeyDigest: D3,
    beforeDigest: D1,
    afterDigest: D2,
  }],
  breaking: true,
  diffDigest: D3,
};

function selectedFile(mime = 'application/pdf'): FileCapabilitySelectionResult {
  return {
    success: true,
    capability: {
      capabilityId: CAPABILITY,
      kind: 'file',
      mime,
      displayName: 'private.person@example.com-application.pdf',
      operations: ['file', 'read'],
      issuedAt: 100,
      expiresAt: 10_000,
    },
  };
}

type Request<Action extends FundingTemplateIpcRequest['action']> = Extract<FundingTemplateIpcRequest, { action: Action }>;

let deps: FundingTemplatePanelDependencies;
let operationCounter = 0;

function operationId(): string {
  operationCounter += 1;
  return `00000000-0000-4000-8000-${String(operationCounter).padStart(12, '0')}`;
}

function listSuccess(request: Request<'list'>, templates: FundingTemplateSummary[] = [summary]): FundingTemplateListResponse {
  return {
    ok: true, contractVersion: 1, action: 'list', operationId: request.operationId,
    ownerId: 'renderer-owner', projectId: request.projectId, templates,
  };
}

function getSuccess(request: Request<'get'>): FundingTemplateGetResponse {
  return {
    ok: true, contractVersion: 1, action: 'get', operationId: request.operationId,
    ownerId: 'renderer-owner', projectId: request.projectId, template: summary, version,
  };
}

beforeEach(() => {
  useMetisStore.setState({ locale: 'zh' });
  operationCounter = 0;
  deps = {
    createOperationId: operationId,
    selectFileCapability: vi.fn().mockResolvedValue(selectedFile()),
    importTemplate: vi.fn().mockImplementation((request: Request<'import'>): Promise<FundingTemplateImportResponse> => Promise.resolve({
      ok: true, contractVersion: 1, action: 'import', operationId: request.operationId,
      ownerId: 'renderer-owner', projectId: request.projectId,
      template: { ...summary, templateId: request.templateId },
      version: { ...version },
      diff: null,
    })),
    listTemplates: vi.fn().mockImplementation((request: Request<'list'>) => Promise.resolve(listSuccess(request))),
    getTemplate: vi.fn().mockImplementation((request: Request<'get'>) => Promise.resolve(getSuccess(request))),
    getTemplateDiff: vi.fn().mockImplementation((request: Request<'diff'>): Promise<FundingTemplateDiffResponse> => Promise.resolve({
      ok: true, contractVersion: 1, action: 'diff', operationId: request.operationId,
      ownerId: 'renderer-owner', projectId: request.projectId, diff,
    })),
    activateTemplate: vi.fn().mockImplementation((request: Request<'activate'>): Promise<FundingTemplateActivateResponse> => Promise.resolve({
      ok: true, contractVersion: 1, action: 'activate', operationId: request.operationId,
      ownerId: 'renderer-owner', projectId: request.projectId,
      template: { ...summary, templateRevision: 2, activeVersion: request.targetVersion },
    })),
    archiveTemplate: vi.fn().mockImplementation((request: Request<'archive'>): Promise<FundingTemplateArchiveResponse> => Promise.resolve({
      ok: true, contractVersion: 1, action: 'archive', operationId: request.operationId,
      ownerId: 'renderer-owner', projectId: request.projectId,
      template: { ...summary, templateRevision: 2, archivedAt: 1_900_000_001_000 },
    })),
    restoreTemplate: vi.fn().mockImplementation((request: Request<'restore'>): Promise<FundingTemplateRestoreResponse> => Promise.resolve({
      ok: true, contractVersion: 1, action: 'restore', operationId: request.operationId,
      ownerId: 'renderer-owner', projectId: request.projectId,
      template: { ...summary, templateRevision: 2, archivedAt: null },
    })),
  };
});

afterEach(cleanup);

async function renderPanel(projectId: string | null = 'project-1') {
  const view = render(<FundingTemplatePanel projectId={projectId} dependencies={deps} />);
  if (projectId) {
    await waitFor(() => expect(deps.listTemplates).toHaveBeenCalledTimes(1));
  } else {
    await act(async () => { await Promise.resolve(); });
  }
  return view;
}

describe('FundingTemplatePanel project and privacy boundary', () => {
  it('disables every operation without an active project and never invokes IPC', async () => {
    await renderPanel(null);
    expect(screen.getByText(/先打开或创建研究项目/u)).toBeDefined();
    expect(deps.listTemplates).not.toHaveBeenCalled();
    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('loads project-scoped templates and shows automatic truth verification without permission prompts', async () => {
    await renderPanel();
    expect(deps.listTemplates).toHaveBeenCalledWith(expect.objectContaining({
      contractVersion: 1, action: 'list', projectId: 'project-1', includeArchived: true,
    }));
    expect((await screen.findAllByText('user:fund-template')).length).toBeGreaterThan(0);
    expect(screen.getByText(/真实性、摘要、版本与差异由主进程自动核验/u)).toBeDefined();
    expect(screen.queryByText(/批准权限|确认授权/u)).toBeNull();
  });

  it('never renders selected file names, local paths, applicant prose, PII, or raw bytes', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /选择 PDF 或 DOCX/u }));
    await waitFor(() => expect(deps.selectFileCapability).toHaveBeenCalledWith('funding-template'));
    expect(await screen.findByText(/已选择 PDF/u)).toBeDefined();
    expect(document.body.textContent).not.toMatch(/private\.person@example\.com|application\.pdf|[A-Za-z]:\\|applicant narrative|Uint8Array/iu);
  });

  it('rejects unsupported selected MIME types before import', async () => {
    vi.mocked(deps.selectFileCapability).mockResolvedValueOnce(selectedFile('text/plain'));
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /选择 PDF 或 DOCX/u }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/仅支持 PDF 或 DOCX/u));
    expect(deps.importTemplate).not.toHaveBeenCalled();
  });
});

describe('FundingTemplatePanel lifecycle', () => {
  it('creates from a one-time capability with an exact owner-blind request and clears the consumed selection', async () => {
    vi.mocked(deps.listTemplates).mockImplementation((request) => Promise.resolve(listSuccess(request, [])));
    await renderPanel();
    fireEvent.change(screen.getByLabelText('模板标识'), { target: { value: 'user:new-fund-template' } });
    fireEvent.click(screen.getByRole('button', { name: /选择 PDF 或 DOCX/u }));
    await screen.findByText(/已选择 PDF/u);
    fireEvent.click(screen.getByRole('button', { name: '创建模板' }));
    await waitFor(() => expect(deps.importTemplate).toHaveBeenCalledTimes(1));
    const request = vi.mocked(deps.importTemplate).mock.calls[0]![0];
    expect(request).toEqual(expect.objectContaining({
      contractVersion: 1, action: 'import', projectId: 'project-1', templateId: 'user:new-fund-template',
      fileCapabilityId: CAPABILITY, capabilityUse: 'consume_once', expectedTemplateRevision: 0,
      expectedActiveVersion: null, expectedActiveDigest: null,
    }));
    expect(request).not.toHaveProperty('ownerId');
    expect(request).not.toHaveProperty('filePath');
    expect(screen.queryByText(/已选择 PDF/u)).toBeNull();
  });

  it('reanalyzes with current CAS and can reverify the exact returned adjacent diff', async () => {
    vi.mocked(deps.importTemplate).mockImplementationOnce((request: Request<'import'>) => Promise.resolve({
      ok: true, contractVersion: 1, action: 'import', operationId: request.operationId,
      ownerId: 'renderer-owner', projectId: request.projectId,
      template: { ...summary, templateRevision: 2, activeVersion: 2, activeDigest: D2, latestVersion: 2 },
      version: { ...version, templateVersion: 2, packageDigest: D2 },
      diff,
    }));
    await renderPanel();
    await waitFor(() => expect(deps.getTemplate).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /选择 PDF 或 DOCX/u }));
    await screen.findByText(/已选择 PDF/u);
    fireEvent.click(screen.getByRole('button', { name: '重新分析' }));
    await waitFor(() => expect(deps.importTemplate).toHaveBeenCalledWith(expect.objectContaining({
      expectedTemplateRevision: 1, expectedActiveVersion: 1, expectedActiveDigest: D1,
    })));
    fireEvent.click(await screen.findByRole('button', { name: '重新核验版本差异' }));
    await waitFor(() => expect(deps.getTemplateDiff).toHaveBeenCalledWith(expect.objectContaining({
      fromVersion: 1, toVersion: 2, fromDigest: D1, toDigest: D2,
    })));
    expect(await screen.findByText(/破坏性变更/u)).toBeDefined();
  });

  it('activates a target version using the selected template CAS without a confirmation dialog', async () => {
    await renderPanel();
    await waitFor(() => expect(deps.getTemplate).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('目标版本'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: '激活版本' }));
    await waitFor(() => expect(deps.activateTemplate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'activate', templateId: summary.templateId, expectedTemplateRevision: 1,
      expectedActiveVersion: 1, expectedActiveDigest: D1, targetVersion: 1,
    })));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('archives and restores with exact CAS and no permission confirmation', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '归档模板' }));
    await waitFor(() => expect(deps.archiveTemplate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'archive', expectedTemplateRevision: 1, expectedActiveVersion: 1, expectedActiveDigest: D1,
    })));
    await waitFor(() => expect(screen.getByRole('button', { name: '恢复模板' })).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: '恢复模板' }));
    await waitFor(() => expect(deps.restoreTemplate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'restore', expectedTemplateRevision: 2, expectedActiveVersion: 1, expectedActiveDigest: D1,
    })));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows fixed fail-closed errors and rejects mismatched response operations or projects', async () => {
    vi.mocked(deps.listTemplates).mockImplementationOnce((request) => Promise.resolve({
      ...listSuccess(request), projectId: 'other-project', templates: [{ ...summary, projectId: 'other-project' }],
    }));
    await renderPanel();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/响应无效/u));
    expect(screen.queryByText(summary.templateId)).toBeNull();
  });
});

describe('FundingTemplatePanel safe summary and accessibility', () => {
  it('shows only version-safe counts, quality state, truncated digests, and no source labels', async () => {
    await renderPanel();
    await waitFor(() => expect(deps.getTemplate).toHaveBeenCalled());
    expect(await screen.findByText(/章节 7/)).toBeDefined();
    expect(screen.getByText(/内容槽 14/)).toBeDefined();
    expect(screen.getByLabelText('版本安全摘要').textContent).toContain('可信度94%');
    expect(screen.getByText(/aaaaaaaaaaaa/u)).toBeDefined();
    expect(document.body.textContent).not.toMatch(/Research basis|Applicant|Required maximum/iu);
  });

  it('exposes a labelled region, assertive focused errors, polite status, and labelled controls', async () => {
    await renderPanel();
    expect(screen.getByRole('region', { name: '基金申报模板' })).toBeDefined();
    expect(screen.getByLabelText('模板标识')).toBeDefined();
    expect(screen.getByLabelText('目标版本')).toBeDefined();
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    vi.mocked(deps.selectFileCapability).mockResolvedValueOnce({ success: false, code: 'file_capability_unavailable' });
    fireEvent.click(screen.getByRole('button', { name: /选择 PDF 或 DOCX/u }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')));
    expect(screen.getByRole('alert').getAttribute('aria-live')).toBe('assertive');
  });

  it('switches visible, status, error, and accessible labels to English while retaining error codes', async () => {
    useMetisStore.setState({ locale: 'en' });
    await renderPanel();
    expect(screen.getByRole('region', { name: 'Funding application templates' })).toBeDefined();
    expect(screen.getByText('Automatic truth verification')).toBeDefined();
    expect(screen.getByLabelText('Template identifier')).toBeDefined();
    expect(screen.getByLabelText('Target version')).toBeDefined();
    const metrics = screen.getByLabelText('Version-safe summary');
    expect(metrics.textContent).toContain('Confidence94%');
    expect(metrics.textContent).toContain('Quality statusReady');

    fireEvent.click(screen.getByRole('button', { name: 'Choose PDF or DOCX' }));
    expect(await screen.findByText(/PDF selected\. The capability will be consumed once/u)).toBeDefined();

    vi.mocked(deps.selectFileCapability).mockResolvedValueOnce({
      success: false,
      code: 'file_capability_unavailable',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Choose PDF or DOCX' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The selected file capability expired or is unavailable');
    expect(alert.textContent).toContain('(file_capability_unavailable)');
    expect(document.activeElement).toBe(alert);
    expect(document.body.textContent).not.toContain('基金申报模板');
  });

  it('keeps responsive, keyboard, reduced-motion, and forced-colors safeguards in its scoped stylesheet', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/personalization/FundingTemplatePanel.css'),
      'utf8',
    );
    expect(css).toContain('.funding-template-panel button:focus-visible');
    expect(css).toContain('@media (max-width: 820px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media (forced-colors: active)');
  });
});
