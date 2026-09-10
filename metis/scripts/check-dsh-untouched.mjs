#!/usr/bin/env node
/**
 * check-dsh-untouched.mjs（Phase 06 / T6-001~T6-008）
 *
 * 守护不变量：DSH 上游源码零修改。任何 `metis/**` 之外的 tracked 变化
 * （working tree 或 staged）都导致退出码 1 并列出违例路径。
 *
 * 用法：node scripts/check-dsh-untouched.mjs [--baseline <commit>]
 * 基线 commit 读取 metis/DSH_BASELINE.json，可用 --baseline 覆盖。
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const metisRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(metisRoot, '..');

function readBaseline(override) {
  if (override) return override;
  const file = path.join(metisRoot, 'DSH_BASELINE.json');
  if (!existsSync(file)) {
    console.error('[check-dsh-untouched] 缺少 metis/DSH_BASELINE.json——无法确定基线 commit。');
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  if (!baseline.commit) {
    console.error('[check-dsh-untouched] DSH_BASELINE.json 缺少 commit 字段。');
    process.exit(1);
  }
  return baseline.commit;
}

function git(args) {
  return execSync(`git ${args}`, { cwd: repoRoot, encoding: 'utf8' });
}

function collectViolations(baselineCommit) {
  // 只比较 tracked 变化：diff 名字集合（不含 untracked；metis/** 由调用方过滤，
  // untracked 的新文件不属于"修改上游文件"）。
  const ranges = [
    ['working tree', `diff --name-only ${baselineCommit} -- .`],
    ['staged', `diff --cached --name-only ${baselineCommit} -- .`],
  ];
  const violations = [];
  for (const [scope, command] of ranges) {
    const output = git(command);
    for (const line of output.split('\n')) {
      const file = line.trim();
      if (!file) continue;
      // T6-003：metis/** 是 METIS 的唯一开发位置，允许新增/修改。
      if (file === 'metis' || file.startsWith('metis/')) continue;
      violations.push({ scope, file });
    }
  }
  return violations;
}

function main() {
  const argv = process.argv.slice(2);
  const overrideIndex = argv.indexOf('--baseline');
  const baselineCommit = readBaseline(overrideIndex >= 0 ? argv[overrideIndex + 1] : undefined);

  let violations;
  try {
    violations = collectViolations(baselineCommit);
  } catch (error) {
    console.error('[check-dsh-untouched] git 命令失败：', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  if (violations.length === 0) {
    console.log(`[check-dsh-untouched] OK — DSH 上游自基线 ${baselineCommit} 起零修改（仅 metis/** 变动）。`);
    process.exit(0);
  }

  console.error(`[check-dsh-untouched] 违例：检测到 ${violations.length} 处 metis/** 之外的上游修改（基线 ${baselineCommit}）：`);
  const seen = new Set();
  for (const { scope, file } of violations) {
    const entry = `${file}  [${scope}]`;
    if (!seen.has(entry)) {
      seen.add(entry);
      console.error(`  ${entry}`);
    }
  }
  process.exit(1);
}

main();
