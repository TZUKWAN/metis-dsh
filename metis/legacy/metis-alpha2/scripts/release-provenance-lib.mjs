import { manifestDigest } from './release-lib.mjs';

const SHA256_RE = /^[a-f0-9]{64}$/u;

export function githubRepositorySlug(remote) {
  if (typeof remote !== 'string' || remote.length === 0 || /[\r\n\0]/u.test(remote)) return null;
  const scp = remote.match(/^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u);
  if (scp) return scp[1];
  try {
    const parsed = new URL(remote);
    if (!['https:', 'ssh:', 'git:'].includes(parsed.protocol)
      || parsed.hostname.toLowerCase() !== 'github.com'
      || (parsed.username && parsed.username !== 'git')
      || parsed.password
      || parsed.port
      || parsed.search
      || parsed.hash) return null;
    const slug = parsed.pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '');
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(slug) ? slug : null;
  } catch {
    return null;
  }
}

export function assertProvenanceManifest(manifest, expectedStage, expectedSchemaVersion = 1) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Invalid ${expectedStage} provenance manifest.`);
  }
  if (manifest.schemaVersion !== expectedSchemaVersion || manifest.stage !== expectedStage) {
    throw new Error(`Unexpected ${expectedStage} provenance schema or stage.`);
  }
  if (typeof manifest.manifestSha256 !== 'string' || !SHA256_RE.test(manifest.manifestSha256)) {
    throw new Error(`Missing or invalid ${expectedStage} provenance digest.`);
  }
  const { manifestSha256, ...body } = manifest;
  if (manifestDigest(body) !== manifestSha256) {
    throw new Error(`${expectedStage} provenance manifest digest mismatch.`);
  }
  return manifest;
}

export function assertReleaseGitState(state) {
  if (!state?.clean) {
    throw new Error('Release provenance is fail-closed: commit or otherwise clear all tracked and untracked source changes before producing a candidate.');
  }
  if (!state.originRepository || !state.upstream || !state.upstreamHead || !state.headMatchesUpstream) {
    throw new Error('Release provenance requires a GitHub origin and a checked-out commit exactly matching its upstream branch.');
  }
  return state;
}
