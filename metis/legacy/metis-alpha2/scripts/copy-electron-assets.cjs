/**
 * copy-electron-assets — 把 tsc 不拷贝的非 TS 运行时资产补进 dist-electron。
 *
 * 背景：genoffice docx-engine 的 emf-converter 是纯 .mjs/.d.mts 资产目录，
 * `tsc -p electron/tsconfig.json` 只 emit TS 编译产物，clean 后这些文件缺失，
 * 导致主进程 ERR_MODULE_NOT_FOUND（metafile.js 静态 import index.mjs）。
 * 在 build:electron 的 tsc 之后、vite build 之前运行。
 */
const { cpSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');

const projectRoot = resolve(__dirname, '..');

const assetCopies = [
  {
    from: 'vendor/genoffice/docx-engine/src/vendor/emf-converter',
    to: 'dist-electron/vendor/genoffice/docx-engine/src/vendor/emf-converter',
  },
];

for (const { from, to } of assetCopies) {
  const fromAbs = resolve(projectRoot, from);
  if (!existsSync(fromAbs)) continue;
  cpSync(fromAbs, resolve(projectRoot, to), { recursive: true });
  process.stdout.write(`[copy-electron-assets] ${from} -> ${to}\n`);
}
