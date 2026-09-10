import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(resolve(process.cwd(), 'electron/main.ts'), 'utf8');
const runtimeSource = readFileSync(resolve(process.cwd(), 'electron/PersonalizationRuntimeService.ts'), 'utf8');

describe('project Metis.md production chat wiring', () => {
  it('loads the repository-authorized project manager and projects its exact view before resolving chat', () => {
    const chatHandler = mainSource.match(/ipcMain\.handle\('agent:chat',[\s\S]*?ipcMain\.handle\('agent:control'/u)?.[0] ?? '';
    expect(chatHandler).not.toBe('');
    expect(chatHandler).toContain('ensureWorkspaceManager(effectiveProjectId)');
    expect(chatHandler).toContain('projectMetisRulesFromWorkspace(');
    expect(chatHandler).toContain('{ ...workspaceManager.read(), projectId: effectiveProjectId }');
    // projectRulesId 传参已演进为条件展开（strict schema 拒绝显式 null）：
    // 存在时必须仍以第五个属性传入 resolveForAgent，且 projectRule 作为
    // 第二参数紧随其后。
    expect(chatHandler).toMatch(/\.\.\.\(projectRulesId \? \{ projectRulesId \} : \{\}\),\s*\}, projectRule\)/u);
  });

  it('fails closed when project authorization, file integrity, or personalization resolution fails', () => {
    const chatHandler = mainSource.match(/ipcMain\.handle\('agent:chat',[\s\S]*?ipcMain\.handle\('agent:control'/u)?.[0] ?? '';
    expect(chatHandler).toMatch(/if \(!workspaceManager\)[\s\S]*?personalization_resolution_failed/u);
    expect(chatHandler).toMatch(/if \(!projection\.ok\)[\s\S]*?personalization_resolution_failed/u);
    expect(chatHandler).toMatch(/if \(!resolved\?\.ok\)[\s\S]*?personalization_resolution_failed/u);
  });

  it('invalidates a cached manifest when the authoritative project rule layer no longer matches', () => {
    expect(runtimeSource).toContain('activeManifestMatchesProjectRule(');
    expect(runtimeSource).toContain('manifest.definitionRevisions[projectRulesId] === projectRule.revision');
    expect(runtimeSource).toContain('layer.content === projectRule.markdown');
  });
});
