import { describe, expect, it } from 'vitest';
import {
  MarkdownSkillApplyRequestSchema,
  PackageSkillApplyRequestSchema,
  PersonalizationExtensionApplyRequestSchema,
  PersonalizationExtensionIpcRequestSchema,
  RequirementsMcpApplyRequestSchema,
  UrlMcpApplyRequestSchema,
  UrlSkillApplyRequestSchema,
  decodePersonalizationExtensionResponse,
} from '../../engine/runtime/PersonalizationExtensionContract.js';

const context = {
  sessionId: 'session-one',
  projectId: 'project-one',
  operationId: '00000000-0000-4000-8000-000000000001',
  runManifestDigest: 'a'.repeat(64),
  observedAt: 100,
};

function markdownRequest() {
  return {
    contractVersion: 1,
    mode: 'skill_markdown',
    id: 'user:skills/my-skill',
    name: 'My skill',
    description: 'A directly authored skill.',
    author: 'Researcher',
    version: '1.0.0',
    markdown: '# Instructions\n\nUse traceable sources.',
    toolIds: [],
    mcpIds: [],
    tags: ['research'],
    maxTurns: 20,
    inputSchema: null,
    outputSchema: null,
    expectedRevision: 0,
    evidenceContext: context,
  };
}

describe('PersonalizationExtensionContract', () => {
  it('accepts the three exact Skill modes', () => {
    expect(MarkdownSkillApplyRequestSchema.safeParse(markdownRequest()).success).toBe(true);
    expect(PackageSkillApplyRequestSchema.safeParse({
      contractVersion: 1,
      mode: 'skill_package',
      sourceCapabilityId: 'fc_0123456789abcdef0123456789abcdef',
      expectedId: null,
      expectedRevision: 0,
      evidenceContext: context,
    }).success).toBe(true);
    expect(UrlSkillApplyRequestSchema.safeParse({
      contractVersion: 1,
      mode: 'skill_url',
      url: 'https://example.com/skill.zip',
      expectedArchiveSha256: null,
      expectedId: null,
      expectedVersion: null,
      expectedRevision: 0,
      evidenceContext: context,
    }).success).toBe(true);
  });

  it('requires package installs to declare whether they create or update a Skill identity', () => {
    const request = {
      contractVersion: 1,
      mode: 'skill_package',
      sourceCapabilityId: 'fc_0123456789abcdef0123456789abcdef',
      expectedRevision: 3,
      evidenceContext: context,
    } as const;
    expect(PackageSkillApplyRequestSchema.safeParse(request).success).toBe(false);
    expect(PackageSkillApplyRequestSchema.safeParse({
      ...request,
      expectedId: null,
    }).success).toBe(false);
    expect(PackageSkillApplyRequestSchema.safeParse({
      ...request,
      expectedId: 'user:skills/updated-skill',
    }).success).toBe(true);
    expect(PackageSkillApplyRequestSchema.safeParse({
      ...request,
      expectedId: 'url:skills/wrong-install-mode',
    }).success).toBe(false);
    expect(PackageSkillApplyRequestSchema.safeParse({
      ...request,
      expectedRevision: 0,
      expectedId: null,
    }).success).toBe(true);
    expect(PackageSkillApplyRequestSchema.safeParse({
      ...request,
      expectedRevision: 0,
      expectedId: 'user:skills/not-a-new-install',
    }).success).toBe(false);
    expect(PersonalizationExtensionIpcRequestSchema.safeParse({
      contractVersion: 1,
      mode: 'skill_package',
      operationId: context.operationId,
      sourceCapabilityId: request.sourceCapabilityId,
      expectedRevision: 2,
      expectedId: null,
    }).success).toBe(false);
  });

  it('binds URL Skill create and update identities to revision in runtime and IPC schemas', () => {
    const runtimeRequest = {
      contractVersion: 1,
      mode: 'skill_url',
      url: 'https://example.com/skill.zip',
      expectedArchiveSha256: null,
      expectedVersion: null,
      evidenceContext: context,
    } as const;
    const ipcRequest = {
      contractVersion: 1,
      mode: 'skill_url',
      operationId: context.operationId,
      url: runtimeRequest.url,
      expectedArchiveSha256: null,
      expectedVersion: null,
    } as const;

    expect(UrlSkillApplyRequestSchema.safeParse({
      ...runtimeRequest,
      expectedRevision: 0,
      expectedId: null,
    }).success).toBe(true);
    expect(UrlSkillApplyRequestSchema.safeParse({
      ...runtimeRequest,
      expectedRevision: 2,
      expectedId: 'url:skills/research-helper',
    }).success).toBe(true);

    expect(UrlSkillApplyRequestSchema.safeParse({
      ...runtimeRequest,
      expectedRevision: 0,
      expectedId: 'url:skills/research-helper',
    }).success).toBe(false);
    expect(UrlSkillApplyRequestSchema.safeParse({
      ...runtimeRequest,
      expectedRevision: 2,
      expectedId: null,
    }).success).toBe(false);
    expect(PersonalizationExtensionIpcRequestSchema.safeParse({
      ...ipcRequest,
      expectedRevision: 0,
      expectedId: 'url:skills/research-helper',
    }).success).toBe(false);
    expect(PersonalizationExtensionIpcRequestSchema.safeParse({
      ...ipcRequest,
      expectedRevision: 2,
      expectedId: null,
    }).success).toBe(false);

    expect(UrlSkillApplyRequestSchema.safeParse({
      ...runtimeRequest,
      expectedRevision: 2,
      expectedId: 'user:skills/wrong-url-target',
    }).success).toBe(false);
    expect(PersonalizationExtensionIpcRequestSchema.safeParse({
      ...ipcRequest,
      expectedRevision: 2,
      expectedId: 'user:skills/wrong-url-target',
    }).success).toBe(false);
  });

  it('accepts the two exact MCP modes', () => {
    expect(RequirementsMcpApplyRequestSchema.safeParse({
      contractVersion: 1,
      mode: 'mcp_requirements',
      operationId: context.operationId,
      requirement: 'Build a bounded echo tool.',
      requestedPackageId: 'bounded-echo',
      definitionId: 'generated:mcp/bounded-echo',
      expectedRevision: 0,
      evidenceContext: context,
      runProbe: true,
    }).success).toBe(true);
    expect(UrlMcpApplyRequestSchema.safeParse({
      contractVersion: 1,
      mode: 'mcp_url',
      definitionId: 'url:mcp/reference-server',
      manifestUrl: 'https://example.com/mcp/manifest.json',
      expectedManifestSha256: null,
      expectedRevision: 0,
      evidenceContext: context,
    }).success).toBe(true);
  });

  it.each([
    ['verified', true],
    ['clean', true],
    ['publishable', true],
    ['truth', { state: 'verified' }],
    ['apiKey', 'secret-value'],
    ['secret', 'secret-value'],
  ])('rejects smuggled field %s from every extension request', (key, value) => {
    expect(PersonalizationExtensionApplyRequestSchema.safeParse({ ...markdownRequest(), [key]: value }).success).toBe(false);
  });

  it('enforces mode namespaces so external definitions cannot overwrite built-ins', () => {
    expect(MarkdownSkillApplyRequestSchema.safeParse({ ...markdownRequest(), id: 'builtin:skills/literature-review' }).success).toBe(false);
    expect(RequirementsMcpApplyRequestSchema.safeParse({
      contractVersion: 1,
      mode: 'mcp_requirements',
      operationId: context.operationId,
      requirement: 'Build a bounded echo tool.',
      requestedPackageId: 'bounded-echo',
      definitionId: 'url:mcp/bounded-echo',
      expectedRevision: 0,
      evidenceContext: context,
      runProbe: false,
    }).success).toBe(false);
  });

  it('binds Builder operation identity to the evidence context', () => {
    expect(RequirementsMcpApplyRequestSchema.safeParse({
      contractVersion: 1,
      mode: 'mcp_requirements',
      operationId: '00000000-0000-4000-8000-000000000002',
      requirement: 'Build a bounded echo tool.',
      requestedPackageId: 'bounded-echo',
      definitionId: 'generated:mcp/bounded-echo',
      expectedRevision: 0,
      evidenceContext: context,
      runProbe: true,
    }).success).toBe(false);
  });

  it('rejects credential-bearing Skill and MCP URLs and raw secret properties', () => {
    const urlSkill = {
      contractVersion: 1,
      mode: 'skill_url',
      url: 'https://example.com/skill.zip?api_key=secret',
      expectedArchiveSha256: null,
      expectedId: null,
      expectedVersion: null,
      expectedRevision: 0,
      evidenceContext: context,
    };
    expect(UrlSkillApplyRequestSchema.safeParse(urlSkill).success).toBe(false);
    expect(UrlMcpApplyRequestSchema.safeParse({
      contractVersion: 1,
      mode: 'mcp_url',
      definitionId: 'url:mcp/reference-server',
      manifestUrl: 'https://user:secret@example.com/manifest.json',
      expectedManifestSha256: null,
      expectedRevision: 0,
      evidenceContext: context,
    }).success).toBe(false);
  });

  it('uses an explicit fail-closed decoder for malformed service output', () => {
    expect(decodePersonalizationExtensionResponse({ ok: true, verified: true })).toEqual({
      ok: false,
      mode: null,
      code: 'invalid_request',
      detailCode: 'invalid_response',
      compensated: false,
    });
  });
});
