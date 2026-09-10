import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function agentChatHandlerSource(): string {
  const source = fs.readFileSync(path.join(process.cwd(), 'electron/main.ts'), 'utf8');
  return source.match(/ipcMain\.handle\('agent:chat',[\s\S]*?ipcMain\.handle\('agent:control'/u)?.[0] ?? '';
}

describe('scenario output-plan production wiring', () => {
  it('returns a failed scenario preflight before any MCP preparation can start', () => {
    const handler = agentChatHandlerSource();
    const preflight = handler.indexOf('const scenarioCompilation = compileScenarioExecutionManifest(resolvedManifest');
    const rejection = handler.indexOf('if (!scenarioCompilation.ok)', preflight);
    const rejectionReturn = handler.indexOf('return createChatTurnErrorResponse', rejection);
    const prepare = handler.indexOf('personalizationMcpBridge.prepare({');

    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(rejection).toBeGreaterThan(preflight);
    expect(rejectionReturn).toBeGreaterThan(rejection);
    expect(prepare).toBeGreaterThan(rejectionReturn);
  });
});
