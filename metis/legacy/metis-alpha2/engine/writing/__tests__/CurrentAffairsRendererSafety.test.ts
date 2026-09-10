/**
 * REVIEW-468 P0 红测：renderer 不得包含审批/签名/artifact密钥代码。
 *
 * 证明 UI bundle 不包含：
 *  - signReceipt / generateReceiptSecret (HMAC 签名)
 *  - CurrentAffairsApprovalStore (receipt 签发/验证)
 *  - CurrentAffairsArtifactService.writeArtifact (artifact 落盘)
 *  - CurrentAffairsRepositoryService (repository truth — main only)
 *
 * 这些必须仅在 main 进程存在。Renderer 只持 type-only imports + 纯函数。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_DIR = path.resolve('src');

/** 检查 import 行是否包含给定模式（不含注释）。 */
function importContains(filePath: string, pattern: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf-8');
  const importLines = content.split('\n').filter((l) =>
    /^\s*import\s/.test(l) || /^\s*export\s/.test(l) || /\brequire\s*\(/.test(l));
  return importLines.some((l) => l.includes(pattern));
}

/** 递归查找 src/ 下所有 .tsx/.ts 文件（排除 node_modules）。 */
function findSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findSourceFiles(full));
    else if (/\.(tsx|ts)$/.test(entry.name)) results.push(full);
  }
  return results;
}

describe('REVIEW-468 P0: renderer source safety (no HMAC/Approval/Artifact imports)', () => {
  const rendererFiles = findSourceFiles(SRC_DIR).filter((f) =>
    // Exclude engine/ and electron/ — those are not renderer
    !f.includes(path.sep + 'engine' + path.sep) &&
    !f.includes(path.sep + 'electron' + path.sep),
  );

  it('RED: no renderer file imports signReceipt', () => {
    for (const f of rendererFiles) {
      expect(importContains(f, 'signReceipt')).toBe(false);
    }
  });

  it('RED: no renderer file imports generateReceiptSecret', () => {
    for (const f of rendererFiles) {
      expect(importContains(f, 'generateReceiptSecret')).toBe(false);
    }
  });

  it('RED: no renderer file imports CurrentAffairsApprovalStore', () => {
    for (const f of rendererFiles) {
      expect(importContains(f, "CurrentAffairsApprovalStore")).toBe(false);
    }
  });

  it('RED: no renderer file imports writeArtifact', () => {
    for (const f of rendererFiles) {
      expect(importContains(f, 'writeArtifact')).toBe(false);
    }
  });

  it('RED: no renderer file imports CurrentAffairsRepositoryService', () => {
    for (const f of rendererFiles) {
      expect(importContains(f, "CurrentAffairsRepositoryService")).toBe(false);
    }
  });

  it('RED: no renderer file imports verifyReceiptSignature', () => {
    for (const f of rendererFiles) {
      expect(importContains(f, 'verifyReceiptSignature')).toBe(false);
    }
  });

  it('GREEN: renderer Panel file exists and contains NO sensitive engine imports', () => {
    const panelFile = path.join(SRC_DIR, 'research', 'CurrentAffairsPanel.tsx');
    expect(fs.existsSync(panelFile)).toBe(true);
    const content = fs.readFileSync(panelFile, 'utf-8');
    // Forbidden: must NOT import from sensitive modules (ApprovalStore, signReceipt, ArtifactService, RepositoryService)
    const importLines = content.split('\n').filter((l) => l.startsWith('import '));
    const sensitivePatterns = ['ApprovalStore', 'signReceipt', 'ArtifactService', 'RepositoryService',
      'CurrentAffairsApprovalStore', 'CurrentAffairsArtifactService', 'CurrentAffairsRepositoryService',
      'generateReceiptSecret', 'verifyReceiptSignature', 'writeArtifact'];
    for (const line of importLines) {
      for (const pat of sensitivePatterns) {
        expect(line).not.toContain(pat);
      }
    }
    // Panel may communicate with main via preload IPC only — engine imports
    // from src/ are blocked by the renderer safety firewall.
  });
});
