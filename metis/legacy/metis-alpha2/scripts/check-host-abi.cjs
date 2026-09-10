/**
 * Host ABI gate: better-sqlite3 must LOAD under the current host Node.
 *
 * Deliberately does NOT pin a specific NODE_MODULE_VERSION number — that
 * value is host-specific (Node 22 CI runners, Node 25 dev machines and
 * Electron's Node all differ) and hard-coding it failed every non-dev
 * environment. The real engineering contract is: the native module loads and
 * executes a query under the running Node. ABI/parent mismatches surface as
 * load errors here; the vitest suites catch the rest.
 */
const Database = require('better-sqlite3');
new Database(':memory:').prepare('select 1').get();
console.log(`HOST_ABI_OK (node ${process.versions.node}, modules ${process.versions.modules})`);
