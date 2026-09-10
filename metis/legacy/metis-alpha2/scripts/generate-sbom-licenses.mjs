import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  evidenceRoot,
  fail,
  packageMetadata,
  projectRoot,
  sha256File,
  utcNow,
  writeJson,
} from './release-lib.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const lockPath = resolve(projectRoot, 'package-lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
  fail('A package-lock v3 packages map is required for compliance generation.');
}

function packageNameFromPath(packagePath) {
  const marker = 'node_modules/';
  const index = packagePath.lastIndexOf(marker);
  return index < 0 ? null : packagePath.slice(index + marker.length);
}

function normalizeLicense(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && typeof value.type === 'string') return value.type.trim();
  if (Array.isArray(value)) return value.map(normalizeLicense).filter(Boolean).join(' OR ');
  return '';
}

function licenseEvidence(packageDir) {
  const names = readdirSync(packageDir).filter((name) => /^(licen[cs]e|copying|notice|third[-_ ]party)/i.test(name));
  const evidence = [];
  const visit = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      fail(`License evidence must not contain symbolic links: ${path}`);
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(resolve(path, entry));
      return;
    }
    if (!stat.isFile()) {
      fail(`Unsupported license evidence entry: ${path}`);
    }
    const name = relative(packageDir, path).split(sep).join('/');
    evidence.push({ name, path, sha256: sha256File(path), text: readFileSync(path, 'utf8') });
  };
  for (const name of names.sort()) visit(resolve(packageDir, name));
  return evidence.sort((a, b) => a.name.localeCompare(b.name));
}

const components = [];
const notices = [];
const missing = [];
for (const [packagePath, lockEntry] of Object.entries(lock.packages)) {
  if (!packagePath || lockEntry.dev === true) continue;
  const packageDir = resolve(projectRoot, packagePath);
  const metadataPath = resolve(packageDir, 'package.json');
  if (!existsSync(metadataPath)) {
    if (lockEntry.optional === true) continue;
    missing.push(`${packagePath}: installed package metadata is missing`);
    continue;
  }
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  const name = metadata.name || packageNameFromPath(packagePath);
  const version = metadata.version || lockEntry.version;
  const license = normalizeLicense(metadata.license ?? metadata.licenses);
  if (!name || !version) {
    missing.push(`${packagePath}: package name or version is missing`);
    continue;
  }
  if (!license || /^(unknown|unlicensed|see license in)$/i.test(license)) {
    missing.push(`${name}@${version}: usable license metadata is missing (${JSON.stringify(license)})`);
    continue;
  }
  const evidence = licenseEvidence(packageDir);
  const component = {
    type: 'library',
    'bom-ref': `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
    group: name.startsWith('@') ? name.split('/')[0].slice(1) : undefined,
    name,
    version,
    purl: `pkg:npm/${name.split('/').map(encodeURIComponent).join('/')}@${encodeURIComponent(version)}`,
    licenses: [{ expression: license }],
    hashes: [{ alg: 'SHA-256', content: sha256File(metadataPath) }],
    properties: [
      { name: 'metis:package-lock-path', value: packagePath },
      { name: 'metis:package-lock-integrity', value: lockEntry.integrity || 'not-recorded' },
      { name: 'metis:license-evidence-count', value: String(evidence.length) },
    ],
  };
  components.push(component);
  notices.push({ name, version, license, evidence });
}

if (missing.length > 0) {
  fail(`License/SBOM generation is fail-closed. Resolve these entries:\n${missing.join('\n')}`);
}

components.sort((a, b) => a.purl.localeCompare(b.purl));
notices.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
const product = packageMetadata();
const complianceDir = resolve(evidenceRoot, 'compliance');
mkdirSync(complianceDir, { recursive: true });

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: utcNow(),
    tools: { components: [{ type: 'application', name: 'Metis release compliance generator', version: '1' }] },
    component: {
      type: 'application',
      name: product.name,
      version: product.version,
      'bom-ref': `pkg:npm/${product.name}@${product.version}`,
    },
    properties: [
      { name: 'metis:scope', value: 'installed production dependency inventory from package-lock v3' },
      { name: 'metis:package-lock-sha256', value: sha256File(lockPath) },
    ],
  },
  components,
};
writeJson(resolve(complianceDir, 'sbom.cdx.json'), sbom);

const noticeText = notices.map((item) => {
  const header = [`${item.name}@${item.version}`, `Declared license: ${item.license}`];
  if (item.evidence.length === 0) {
    header.push('License file evidence: none shipped by the installed package; declaration is from package.json.');
  } else {
    for (const evidence of item.evidence) {
      header.push(`License file: ${evidence.name}`, `SHA-256: ${evidence.sha256}`, '', evidence.text.trim());
    }
  }
  return `${'='.repeat(80)}\n${header.join('\n')}\n`;
}).join('\n');
writeFileSync(resolve(complianceDir, 'THIRD_PARTY_LICENSES.txt'), `${noticeText}\n`, 'utf8');
writeJson(resolve(complianceDir, 'license-inventory.json'), {
  schemaVersion: 1,
  generatedAt: utcNow(),
  packageLockSha256: sha256File(lockPath),
  packages: notices.map((item) => ({
    name: item.name,
    version: item.version,
    license: item.license,
    evidence: item.evidence.map(({ name, sha256 }) => ({ name, sha256 })),
  })),
});
console.log(`Compliance evidence written for ${components.length} installed production dependencies.`);
