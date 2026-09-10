# Personalization Secret Vault

`PersonalizationSecretVault` is the main-process storage boundary for MCP environment references such as `${secret:ZOTERO_API_KEY}`.

## Public renderer boundary

Only three strict request families may be wired through IPC:

- `PersonalizationSecretSetRequestSchema`
- `PersonalizationSecretListRequestSchema`
- `PersonalizationSecretRemoveRequestSchema`

Set and remove use a vault-wide `expectedRevision` compare-and-swap value. List returns that global revision and entries containing exactly `name`, `createdAt`, and `updatedAt`. No public response contains a plaintext value, ciphertext, hash, HMAC, secret reference, storage path, or encryption backend detail.

Do not expose `vault.resolve()` through preload or IPC. It is a main-process-only dependency implementing the `ManagedMcpSecretResolver` shape.

## Main-process construction

The vault directory must already exist beneath the trusted application data directory and must be canonical. Construction fails for a symlink or Windows junction at any path segment.

```ts
const vault = new PersonalizationSecretVault(secretDirectory, safeStorage);
```

The real Electron `safeStorage` object is injected directly. The vault refuses an unavailable encryption backend and, on Linux, refuses `basic_text` and `unknown` backends.

For the Managed MCP runtime:

```ts
const runtime = new ManagedPersonalizationMcpRuntime(
  mcpInstaller,
  vault,
  evidenceEnvelopeService,
);
```

## Storage and integrity properties

- Every plaintext value and the randomly generated 256-bit integrity key are independently protected by Electron safeStorage.
- The complete canonical vault record is authenticated with HMAC-SHA256.
- Each ciphertext has an independent SHA-256 identity and each decrypted value has a name-bound HMAC.
- Mutations acquire an exclusive `wx` lock, reload the current revision under that lock, write a same-directory `wx` staging file, apply mode `0600`, fsync it, atomically rename it, verify the committed record, and fsync the directory where supported.
- Reads use an open file descriptor, `fstat` before and after reading, path identity comparison, size/mode checks, strict JSON parsing, HMAC verification, and repeated canonical-root checks.
- A failed rename leaves the previous committed vault unchanged and removes staging files.
- Two vault instances attempting the same expected revision serialize on the lock; exactly one succeeds and the other receives `revision_conflict`.

## Input restrictions

Names use the MCP environment-name contract and reject runtime-control variables including `PATH`, `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`, `COMSPEC`, and loader-preload variables. Values must be non-empty, non-whitespace, at most 32,768 characters, and contain no C0/C1 control characters.

Errors are fixed codes and never include a secret value. No vault method writes secret material to logs.
