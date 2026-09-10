/**
 * Static architecture guards for the single ProjectShell layout contract.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..', '..');

function readProjectFile(relativePath: string): string {
  return readFileSync(resolve(projectRoot, relativePath), 'utf8');
}

describe('single ProjectShell ownership invariant', () => {
  it('does not allow ChatPage or App.css to restore a standalone chat shell', () => {
    const chatPageSource = readProjectFile('src/pages/ChatPage.tsx');
    const appStyles = readProjectFile('src/App.css');

    expect(chatPageSource).not.toContain('chat-page-container');
    expect(appStyles).not.toContain('.chat-page-container');
  });

  it('requires every ChatPage caller to provide the layout owner', () => {
    const chatPageSource = readProjectFile('src/pages/ChatPage.tsx');

    expect(chatPageSource).toMatch(
      /renderLayout:\s*\(slots:\s*ChatPageLayoutSlots\)\s*=>\s*ReactNode;/,
    );
    expect(chatPageSource).not.toMatch(/renderLayout\?\s*:/);
    expect(chatPageSource).toMatch(/return renderLayout\(\{[\s\S]*?leftPanel,[\s\S]*?workspace,[\s\S]*?rightPanel,[\s\S]*?\}\);/);
  });

  it('keeps RightPanel tab and preview transitions outside RightPanel', () => {
    const rightPanelSource = readProjectFile('src/components/RightPanel.tsx');

    expect(rightPanelSource).not.toMatch(/useState\s*<RightPanelTab>/);
    expect(rightPanelSource).not.toContain('lastPreview');
    expect(rightPanelSource).not.toMatch(/useEffect\s*\([\s\S]*previewContent/);
    expect(rightPanelSource).toContain('onActiveTabChange(nextTab)');
  });

  it('routes every session selection through the guarded transition', () => {
    const chatPageSource = readProjectFile('src/pages/ChatPage.tsx');
    const directSessionWrites = chatPageSource.match(/setCurrentSessionId\(/g) ?? [];

    expect(directSessionWrites).toHaveLength(1);
    expect(chatPageSource).toContain('onSelect={activateSession}');
    expect(chatPageSource).toContain('sessionGenerationRef.current += 1');
    expect(chatPageSource).toContain('activeChatRequestRef.current = null');
  });

  it('does not retain a parallel Zustand chat state owner', () => {
    const storeSource = readProjectFile('src/store.ts');

    for (const legacySymbol of [
      'chatMessages',
      'chatInput',
      'setChatInput',
      'sendMessage',
    ]) {
      expect(storeSource).not.toContain(legacySymbol);
    }
  });
});
