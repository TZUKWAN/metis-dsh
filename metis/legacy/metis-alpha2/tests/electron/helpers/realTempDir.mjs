/**
 * CI-safe temp fixture root.
 *
 * GitHub Actions Windows runners expose the TMP root in 8.3 short form
 * (e.g. `RUNNER~1`), which the products' anti-hijack realpath checks
 * (Unsafe * root) legitimately reject — those checks compare the given
 * path against its real filesystem resolution. Fixtures must therefore
 * hand the product an ALREADY-RESOLVED real path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function realTempRoot() {
  try {
    return fs.realpathSync.native(os.tmpdir());
  } catch {
    return os.tmpdir();
  }
}

/** mkdtempSync under the resolved real temp root, itself realpath-resolved. */
export function makeRealTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(realTempRoot(), prefix));
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return dir;
  }
}
