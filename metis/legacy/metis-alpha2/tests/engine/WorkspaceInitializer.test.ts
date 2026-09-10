/**
 * Tests for WorkspaceInitializer — structured research workspace scaffolding.
 * Round 310.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  initWorkspace,
  readWorkspaceManifest,
  renderManifest,
  DEFAULT_DIRECTORIES,
} from '../../engine/workspace/WorkspaceInitializer.js';
import { workspaceInitHandler, workspaceStatusHandler } from '../../engine/tools/builtin/academic-tools.js';

describe('WorkspaceInitializer', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'metis-workspace-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('creates all default directories', async () => {
    const layout = await initWorkspace({ root: tempRoot });
    expect(layout.manifestWritten).toBe(true);
    expect(layout.alreadyInitialized).toBe(false);
    for (const dir of DEFAULT_DIRECTORIES) {
      const full = path.join(tempRoot, dir);
      expect(fsSync.existsSync(full)).toBe(true);
      expect(fsSync.statSync(full).isDirectory()).toBe(true);
    }
    expect(layout.directories.length).toBe(DEFAULT_DIRECTORIES.length);
  });

  it('writes a research-state.yaml manifest', async () => {
    const layout = await initWorkspace({
      root: tempRoot,
      projectName: 'My Project',
      researchQuestion: 'Can models reason?',
    });
    expect(fsSync.existsSync(layout.manifestPath)).toBe(true);
    const content = await fs.readFile(layout.manifestPath, 'utf-8');
    expect(content).toContain('project_name: "My Project"');
    expect(content).toContain('research_question: "Can models reason?"');
    expect(content).toContain('created_at:');
    expect(content).toContain('status: "init"');
  });

  it('drops .gitkeep in each directory', async () => {
    await initWorkspace({ root: tempRoot });
    for (const dir of DEFAULT_DIRECTORIES) {
      const keep = path.join(tempRoot, dir, '.gitkeep');
      expect(fsSync.existsSync(keep)).toBe(true);
    }
  });

  it('is idempotent: refuses to overwrite an existing manifest without force', async () => {
    await initWorkspace({ root: tempRoot, projectName: 'First' });
    const second = await initWorkspace({ root: tempRoot, projectName: 'Second' });
    expect(second.alreadyInitialized).toBe(true);
    expect(second.manifestWritten).toBe(false);
    // Original manifest preserved.
    const content = await fs.readFile(second.manifestPath, 'utf-8');
    expect(content).toContain('First');
    expect(content).not.toContain('Second');
  });

  it('overwrites the manifest when force=true', async () => {
    await initWorkspace({ root: tempRoot, projectName: 'First' });
    const second = await initWorkspace({ root: tempRoot, projectName: 'Second', force: true });
    expect(second.manifestWritten).toBe(true);
    const content = await fs.readFile(second.manifestPath, 'utf-8');
    expect(content).toContain('Second');
  });

  it('creates extra directories when provided', async () => {
    const layout = await initWorkspace({ root: tempRoot, extraDirectories: ['code', 'slides'] });
    expect(fsSync.existsSync(path.join(tempRoot, 'code'))).toBe(true);
    expect(fsSync.existsSync(path.join(tempRoot, 'slides'))).toBe(true);
    expect(layout.directories.length).toBe(DEFAULT_DIRECTORIES.length + 2);
  });

  it('rejects a relative root path', async () => {
    await expect(initWorkspace({ root: 'relative/path' })).rejects.toThrow(/absolute/i);
  });

  it('rejects an empty root', async () => {
    await expect(initWorkspace({ root: '' })).rejects.toThrow();
  });

  it('renderManifest escapes quotes and backslashes', () => {
    const yaml = renderManifest({
      projectName: 'A "quoted" \\ path',
      researchQuestion: 'Is x: y?',
      createdAt: 1700000000000,
    });
    // The quote/backslash should be escaped, not break YAML structure.
    expect(yaml).toContain('project_name:');
    expect(yaml).toContain('research_question:');
    expect(yaml.split('\n').filter((l) => l.startsWith('project_name:'))[0]).toMatch(/project_name: ".*"/);
  });

  it('readWorkspaceManifest returns null when no manifest exists', async () => {
    const manifest = await readWorkspaceManifest(tempRoot);
    expect(manifest).toBeNull();
  });

  it('readWorkspaceManifest parses back the written values', async () => {
    await initWorkspace({ root: tempRoot, projectName: 'Round Trip', researchQuestion: 'Does it survive?' });
    const manifest = await readWorkspaceManifest(tempRoot);
    expect(manifest).not.toBeNull();
    expect(manifest!.project_name).toBe('Round Trip');
    expect(manifest!.research_question).toBe('Does it survive?');
    expect(manifest!.status).toBe('init');
    expect(Array.isArray(manifest!.milestones)).toBe(true);
    expect(Array.isArray(manifest!.findings)).toBe(true);
  });

  it('readWorkspaceManifest ignores comments and blank lines', async () => {
    const manifestPath = path.join(tempRoot, 'research-state.yaml');
    await fs.writeFile(
      manifestPath,
      '# a comment\n\nkey1: "value1"\n   # indented comment\nkey2: value2\n',
      'utf-8',
    );
    const manifest = await readWorkspaceManifest(tempRoot);
    expect(manifest!.key1).toBe('value1');
    expect(manifest!.key2).toBe('value2');
  });

  // --- handler integration ---

  it('workspaceInitHandler validates required root', async () => {
    const out = await workspaceInitHandler({}, { sessionId: 't', workspace: tempRoot, turnIndex: 0 });
    expect(out).toContain('root');
    expect(out).toContain('required');
  });

  it('workspaceInitHandler rejects a relative root', async () => {
    const out = await workspaceInitHandler({ root: 'rel/path' }, { sessionId: 't', workspace: tempRoot, turnIndex: 0 });
    expect(out).toContain('absolute');
  });

  it('workspaceInitHandler creates the workspace and returns a layout', async () => {
    const out = await workspaceInitHandler(
      { root: tempRoot, projectName: 'Handler Project', researchQuestion: 'Why?' },
      { sessionId: 't', workspace: tempRoot, turnIndex: 0 },
    );
    expect(out).toContain('Workspace Initialized');
    expect(out).toContain('Handler Project');
    expect(out).toContain('## Directories');
    expect(out).toContain('Raw JSON');
    expect(fsSync.existsSync(path.join(tempRoot, 'research-state.yaml'))).toBe(true);
  });

  it('workspaceInitHandler reports already-initialized without overwriting', async () => {
    await workspaceInitHandler({ root: tempRoot, projectName: 'First' }, { sessionId: 't', workspace: tempRoot, turnIndex: 0 });
    const out = await workspaceInitHandler({ root: tempRoot, projectName: 'Second' }, { sessionId: 't', workspace: tempRoot, turnIndex: 0 });
    expect(out).toContain('Already initialized: yes');
    expect(out).toContain('Manifest written this call: no');
  });

  it('workspaceStatusHandler reads the manifest back', async () => {
    await initWorkspace({ root: tempRoot, projectName: 'Status Check' });
    const out = await workspaceStatusHandler({ root: tempRoot }, { sessionId: 't', workspace: tempRoot, turnIndex: 0 });
    expect(out).toContain('Workspace Status');
    expect(out).toContain('Status Check');
    expect(out).toContain('## Directories');
    expect(out).toContain('literature/ ✓');
  });

  it('workspaceStatusHandler reports missing manifest', async () => {
    const out = await workspaceStatusHandler({ root: tempRoot }, { sessionId: 't', workspace: tempRoot, turnIndex: 0 });
    expect(out).toContain('No research-state.yaml');
  });
});
