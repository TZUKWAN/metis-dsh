import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { auditMath, type MathAuditResult } from '../MathAuditor.js';

function issueTypes(result: MathAuditResult, type: string): MathAuditResult['inlineIssues'] {
  return [...result.inlineIssues, ...result.environments.flatMap((e) => e.issues)].filter((i) => i.type === type);
}

describe('MathAuditor', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'math-audit-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTex(name: string, content: string) {
    await fs.writeFile(path.join(tmpDir, name), content, 'utf-8');
  }

  it('flags double dollar display math', async () => {
    await writeTex('main.tex', '$$E = mc^2$$\n');
    const result = await auditMath(tmpDir);
    expect(issueTypes(result, 'double_dollar_display').length).toBe(1);
  });

  it('flags deprecated eqnarray', async () => {
    await writeTex('main.tex', '\\begin{eqnarray}\na &=& b \\\\\n\\end{eqnarray}\n');
    const result = await auditMath(tmpDir);
    expect(issueTypes(result, 'deprecated_eqnarray').length).toBe(1);
  });

  it('flags unlabeled numbered equation', async () => {
    await writeTex('main.tex', '\\begin{equation}\nE = mc^2\n\\end{equation}\n');
    const result = await auditMath(tmpDir);
    expect(issueTypes(result, 'unlabeled_numbered_equation').length).toBe(1);
  });

  it('does not flag starred equations without label', async () => {
    await writeTex('main.tex', '\\begin{equation*}\nE = mc^2\n\\end{equation*}\n');
    const result = await auditMath(tmpDir);
    expect(result.totalIssues).toBe(0);
  });

  it('flags displaystyle in inline math', async () => {
    await writeTex('main.tex', '$\\displaystyle \\sum_{i=1}^n x_i$\n');
    const result = await auditMath(tmpDir);
    expect(issueTypes(result, 'display_style_inline').length).toBe(1);
  });

  it('flags non-ASCII characters in inline math', async () => {
    await writeTex('main.tex', '$α + β$\n');
    const result = await auditMath(tmpDir);
    expect(issueTypes(result, 'unicode_math_character').length).toBe(1);
  });

  it('reports labeled equations as clean', async () => {
    await writeTex('main.tex', '\\begin{equation}\\label{eq:emc}\nE = mc^2\n\\end{equation}\n');
    const result = await auditMath(tmpDir);
    expect(result.totalIssues).toBe(0);
  });
});
