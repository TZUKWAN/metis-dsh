# Metis Personalization Architecture

## Decision

Metis separates a stable execution engine from user-owned research definitions.

The runtime does not seed or select domain scenarios. A scenario exists only after the
user creates, installs, or imports it. This keeps academic assumptions in editable data
rather than in application code.

## Definition graph

Five versioned definition types form the personalization graph:

```text
Scenario
  ├─ Agent[]
  │    ├─ Skill[]
  │    ├─ MCP[]
  │    ├─ tool[]
  │    ├─ memory
  │    └─ output
  ├─ Skill[]
  ├─ MCP[]
  ├─ Metis.md[]
  ├─ workflow[]
  ├─ memory
  ├─ Full Access
  └─ output
```

Definitions use stable namespaced IDs and immutable revisions. User editing produces a
new revision rather than mutating history.

## Persistence

`PersonalizationRepository` stores definitions, revisions, run manifests, run state,
asset bindings, and evidence envelopes in SQLite.

Skill/MCP package assets and project `Metis.md` files live on disk under main-process
control. Definitions refer to those assets through managed records rather than arbitrary
renderer paths.

No startup path calls `seedBuiltins`; existing internal factory rows from development or
older profiles are not projected into the user interface or selected by chat.

## Runtime resolution

When a user selects a scenario, main resolves the exact definition graph:

1. Decode the renderer request.
2. Load the requested enabled user scenario.
3. Load the exact Agent, Skill, MCP, and rule revisions.
4. Add active project `Metis.md` when a project is selected.
5. Validate dependency references and workflow bindings.
6. Expand every workflow step with the selected Agent's Skill, MCP, and tool bindings;
   Skill-owned MCP tools are expanded into that same step.
7. Create a resolved run manifest and prompt stack.
8. Bind the manifest to the session, project, scenario, rules, capabilities, and output
   contract.
9. Persist the frozen snapshot for restart recovery.

Chat starts with no scenario selected, even when definitions exist. An explicit user
selection wins. While the selector is empty, the longest matching user-authored trigger
phrase activates its scenario; with no match, chat skips this resolution path and does
not fall back to an internal general-research scenario.

## Rule precedence

Prompt layers are resolved from general to specific:

```text
system runtime policy
  -> effective Skill instructions for the current step
  -> executing Agent instructions and Agent output contract
  -> global Metis.md
  -> scenario Metis.md
  -> active project Metis.md
  -> scenario output contract
  -> current user instruction
```

The exact ordered stack is part of the run snapshot. Each workflow step receives only its
executing Agent and effective Skills; prompts belonging to other steps are not copied into
that step. Rules and the scenario output contract continue to apply to every step.

## Workflow execution

Any non-empty workflow, including a one-step workflow, runs through the durable scenario
coordinator. Steps are executed in dependency order. A failed step blocks only its
downstream dependants, and completed steps are checkpointed for restart recovery.

The effective capabilities of a step are computed as follows:

```text
explicit step bindings
  + executing Agent's Skills, MCPs, and tools
  + MCPs and tools required by those Skills
  = frozen step execution profile
```

Only the resulting step tool list is passed to `AgentLoop`. Managed MCP services can be
prepared for the run, but a step cannot invoke an MCP tool unless that tool is present in
its frozen execution profile.

The resolved step also freezes the Agent's model preference, retry limit, memory policy,
and output contract. A preferred model creates an AgentLoop against the current Provider
connection with that model name. Retry count and maximum turns are enforced per step.

Scenario and Agent memory policies are intersected. Completed run records are queried by
the resulting session, project, and/or scenario filters; retained outputs and artifact
references are clipped to the smaller configured summary limit before entering a later
step prompt.

## Full Access and live steering

`FullAccessPolicy` is resolved in main and passed to `AgentLoop`, the workflow executor,
tool dispatcher, and managed MCP bridge. The renderer cannot add an authority field to an
ordinary chat request.

Full Access removes per-action confirmation. It does not remove the user's ability to
steer or interrupt a run. Steering instructions are queued against the active session;
interrupt propagates through the agent and tool execution path.

## Skill boundary

Skills enter through three modes:

- renderer-authored Markdown;
- a selected ZIP/directory package;
- a supported HTTPS/GitHub URL.

The main process validates and persists the source, assets, digest, and definition. A
simple input/output schema is represented as structured fields; complex existing schemas
are preserved unless the user explicitly replaces them.

## MCP boundary

MCP definitions enter through a requirement builder or URL installer. Activation uses a
managed runtime record. Executable, arguments, working directory, exposed tools, and
environment references come from the installed record rather than arbitrary renderer
fields.

Secrets are stored in the main-process vault and resolved by name at activation time.

## Truth boundary

Personalization may change research behavior but cannot authoritatively set:

- evidence observation state;
- source version or correction state;
- citation provenance;
- artifact integrity;
- publishable/claim-eligible status.

Those values come from repository state, adapters, evidence envelopes, receipts, and
artifact verification. The UI intentionally shows this as an automatic system layer
without turning it into a per-step permission flow.

## Presentation scope

The contract retains a capability value for future presentation work, but alpha.2 does
not seed, expose, or execute a presentation scenario. Template decomposition and layout
selection require a separate user-defined design before that space is enabled.
