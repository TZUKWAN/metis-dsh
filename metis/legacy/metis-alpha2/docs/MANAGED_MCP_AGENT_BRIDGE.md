# Managed MCP Agent Bridge

This note documents the main-process integration boundary for exposing an installed personalization MCP to a run-scoped AgentLoop.

## Required main-process dependencies

Construct `PersonalizationMcpToolBridge` with:

- the single `ManagedPersonalizationMcpRuntime` owned by the main process;
- an authoritative definition source, normally `PersonalizationRepository.get`;
- the authoritative `PersonalizationMcpInstaller` as descriptor source;
- a durable evidence sink that records the complete signed `EvidenceEnvelope` outside model context.

The IPC or chat runtime must derive the owner tuple from the invoking main frame. Renderer input must never supply `webContentsId`, `processId`, `routingId`, or `generation` as authority.

## Run preparation

Call `bridge.prepare` with the already resolved and digest-verified run manifest, its exact session/project binding, the main-derived owner tuple, an optional run abort signal, and all names already present in the run-scoped `ToolRegistry` as `reservedToolNames`.

Preparation fails closed when:

- the manifest digest or session/project binding differs;
- an MCP is missing, disabled, malformed, or at a different revision;
- the installation descriptor is missing or changes during startup;
- declared tools differ from the descriptor or runtime handshake;
- a tool name conflicts with a builtin/another MCP or is absent from `manifest.allowedTools`;
- an input schema is unsupported or contains unsafe provider-facing names/enums.

On success, `run.registrations` contains immutable `{ spec, handler }` pairs. Register these pairs into a fresh run-scoped registry and dispatcher before constructing the AgentLoop. The dispatcher has no handler-unregister API, so it must not be reused after `run.close()`.

## Evidence boundary

The handler never returns MCP payload text. The complete payload exists only inside the signed envelope sent to the evidence sink. AgentLoop receives the fixed result:

```json
{"status":"external_evidence_recorded","truthState":"unverified","reviewStatus":"pending"}
```

Remote tool descriptions and JSON Schema descriptions/defaults are not forwarded to the provider. Tool input remains structurally validated both by `ToolDispatcher` and by `ManagedPersonalizationMcpRuntime`.

## Lifecycle cleanup

Always call `await run.close()` in the run-level `finally` block. The run also closes automatically when:

- its supplied abort signal fires;
- a handler is invoked from another session;
- runtime invocation, evidence binding, or evidence persistence fails.

Main-process navigation and renderer destruction should additionally call `ManagedPersonalizationMcpRuntime.shutdownWebContents(webContentsId)` as a final capability-revocation layer.
