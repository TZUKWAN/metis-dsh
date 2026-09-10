# Metis Skill Package Format

Metis Skill packages are versioned ZIP archives (or local development directories) with one strict `metis-skill.json` manifest. Packages may carry Markdown documentation, schemas, assets, and scripts. Installation never executes package scripts; execution is a separate capability boundary.

## Required layout

```text
metis-skill.json
SKILL.md
scripts/
  analyze.mjs
references/
  schema.json
```

GitHub-generated ZIP files may wrap this layout in one repository directory. A package must contain exactly one manifest and every non-manifest file must be declared.

## Manifest

```json
{
  "schemaVersion": 1,
  "id": "user:skills/evidence-synthesis",
  "name": "Evidence synthesis",
  "description": "Synthesize a bounded evidence set.",
  "version": "1.0.0",
  "author": "Example author",
  "license": "MIT",
  "entry": "SKILL.md",
  "systemPromptFile": "SKILL.md",
  "files": [
    {
      "path": "SKILL.md",
      "size": 128,
      "sha256": "<64 lowercase hex characters>",
      "role": "documentation",
      "executable": false
    }
  ]
}
```

The manifest is a strict schema: unknown fields are rejected. `entry` must refer to a declared documentation file. File roles are `documentation`, `script`, `asset`, or `schema`.

## Installer guarantees

- rejects absolute paths, `..`, backslashes, duplicate case-folded paths, symbolic links, junction escapes, unsupported ZIP methods, encrypted archives, corrupt CRC values, suspicious compression ratios, and undeclared files;
- verifies the size and SHA-256 digest of every declared file before publication;
- downloads only credential-free HTTP(S) URLs, blocks private-network destinations, limits redirects to the same host or the controlled GitHub host set, rejects HTTPS downgrade, enforces content type, timeout, and streaming byte limits;
- writes to same-volume staging, flushes files, atomically publishes a version directory, then atomically changes the active-version pointer;
- rolls a newly published directory back when activation fails;
- stores source URL, resolved URL, redirect chain, archive digest, exact manifest digest, and installation time;
- retains versions side by side and supports active-version switching, version-specific uninstall, complete uninstall, and URL updates;
- re-verifies installed manifests and file digests when enumerating installed versions;
- never imports or calls a child-process execution primitive for package scripts.

## GitHub URLs

Repository URLs such as `https://github.com/owner/repository` are resolved through GitHub's archive endpoint. Tree URLs are resolved through `codeload.github.com`. Only the explicit GitHub redirect host set is allowed to cross hosts.

## Limits

The current contract permits at most 512 declared files, 32 MiB per file/archive download, and 96 MiB extracted total. ZIP64, multi-disk ZIP, encrypted ZIP, and non-UTF-8 file names are rejected.

