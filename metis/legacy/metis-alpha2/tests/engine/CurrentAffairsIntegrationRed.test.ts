/**
 * FIX-METIS-470 integration red tests — real boundary assertions.
 * Tests: import boundaries, main/preload contract, key store behavior.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('INT-I1: Renderer import firewall', () => {
  function rendererSourceImports(filePath: string): string[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n')
      .filter(l => l.trimStart().startsWith('import '))
      .filter(l => l.includes("from '"))
      .map(l => l.trim());
  }

  it('src/ files must not import engine/writing services or Node builtins', () => {
    const srcDir = path.join(ROOT, 'src');
    const violations: string[] = [];
    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(tsx|ts)$/.test(entry.name)) continue;
        const imports = rendererSourceImports(full);
        for (const imp of imports) {
          if (imp.includes('CurrentAffairsService') ||
              imp.includes('CurrentAffairsApprovalStore') ||
              imp.includes('CurrentAffairsArtifactService') ||
              imp.includes("CurrentAffairsRepositoryService") ||
              imp.includes('signReceipt') ||
              imp.includes('generateReceiptSecret') ||
              imp.includes("from 'node:crypto'") ||
              imp.includes("from 'node:fs'")) {
            violations.push(`${path.relative(ROOT, full)}: ${imp}`);
          }
        }
      }
    }
    walk(srcDir);
    expect(violations).toEqual([]);
  });
});

describe('INT-I2: Main process uses FIX493 durable key store', () => {
  it('main.ts imports loadOrCreateCurrentAffairsReceiptSecret from key store', () => {
    const m = fs.readFileSync(path.join(ROOT, 'electron/main.ts'), 'utf-8');
    expect(m).toContain("import { loadOrCreateCurrentAffairsReceiptSecret } from './CurrentAffairsReceiptKeyStore.js';");
    expect(m).toContain('caReceiptSecret = loadOrCreateCurrentAffairsReceiptSecret(DATA_DIR, safeStorage);');
    expect(m).not.toContain('function loadOrCreateCAReceiptSecret');
    expect(m).not.toContain("import { generateReceiptSecret } from '../engine/runtime/CurrentAffairsRuntimeContract.js';");
  });
});

describe('INT-I3: Preload has strict IPC methods', () => {
  it('preload.ts exports MetisAPI type with CA methods', () => {
    const p = fs.readFileSync(path.join(ROOT, 'electron/preload.ts'), 'utf-8');
    expect(p).toContain('currentAffairs');
    expect(p).toContain('export type MetisAPI');
  });
});

describe('INT-I4: Tool registry hides export, research returns draft', () => {
  it('engine/tools/index.ts has no current_affairs_export handler', () => {
    const tools = fs.readFileSync(path.join(ROOT, 'engine/tools/index.ts'), 'utf-8');
    expect(tools).not.toContain("'current_affairs_export'");
    expect(tools).toContain("'current_affairs_research'");
  });

  it('engine/tools/index.ts research handler is REMOVED (fail-closed until main IPC)', () => {
    const tools = fs.readFileSync(path.join(ROOT, 'engine/tools/index.ts'), 'utf-8');
    // CURRENT_AFFAIRS_SPECS is empty — handlers removed, only main IPC works
    expect(tools).toContain('CURRENT_AFFAIRS_SPECS: ToolSpec[] = []');
    // Handler line is commented out
    expect(tools).toContain('// REMOVED — fail-closed');
    // Handler is commented out (not active)
    const handlerLine = tools.split('\n').find(l => l.includes('currentAffairsResearchHandler'));
    expect(handlerLine).toBeDefined();
    expect(handlerLine!.trim().startsWith('//')).toBe(true);
  });
});
