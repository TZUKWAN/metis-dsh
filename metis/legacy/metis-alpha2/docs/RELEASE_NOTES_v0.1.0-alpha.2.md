# Metis in Social Science 0.1.0-alpha.2

Release date: 2026-07-30
Status: public alpha for Windows x64

## Overview

Alpha.2 introduces the Personalization Center and changes how Metis approaches research
scenarios. The application no longer ships a catalog of predefined journal, thesis,
funding, monograph, policy, or presentation workflows. It provides a blank, versioned
system in which each user defines the Agents, Skills, MCP services, rules, workflow,
memory, and output plan appropriate to their own work.

The release also includes a redesigned first-run screen, a responsive academic interface,
project-scoped `Metis.md`, Full Access execution with live steering, Skill/MCP installers,
and Windows packaging updates.

## Personalization Center

The lower-left **Personalization** action opens five user-owned definition areas:

- Scenarios
- Agents
- Skills
- MCP
- `Metis.md`

A fresh profile begins with all five areas empty. Existing internal factory scenarios are
not seeded, shown, or selected as a fallback.

### Scenario editor

Users can define:

- Name, description, enable state, trigger phrases, and capability.
- Exact Agent, Skill, MCP, and `Metis.md` bindings.
- Multi-step workflow order and dependencies.
- Agent, tools, Skills, MCP services, and turn budget per workflow step.
- Full Access behavior, live steering, and restart persistence.
- Memory scope, retained decisions/artifacts, and summary size.
- Output format, primary deliverable, supporting artifacts, and quality criteria.

Long forms now expose a Save action at the top as well as the end of the editor.

### Agent editor

Agents expose role, system instructions, optional model preference, tools, Skills, MCP
bindings, memory policy, output plan, maximum turns, and retry behavior.

### Skill installation and editing

Three acquisition modes are available:

1. Write and save Markdown directly.
2. Install a ZIP or directory Skill package with scripts and supporting files.
3. Install a supported Skill source from an HTTPS or GitHub URL.

The editor includes visual input/output schema rows. Users can define field name, type,
description, and required state without writing raw JSON.

### MCP installation

Two acquisition modes are available:

1. Describe the required service and let the managed MCP builder generate it.
2. Install a supported MCP package or repository URL.

MCP credentials use named secret references. Secret values are not shown in renderer
configuration responses or exported personalization bundles.

### `Metis.md`

Rules can be global, scenario-scoped, or project-scoped. Project rules are edited from the
Personalization Center and use the active project workspace. Existing `AGENTS.md` text is
migrated without discarding user content.

### Revisions and bundles

- Each save creates a new definition revision.
- Earlier user revisions can be restored.
- Definitions can be archived.
- A selected definition and its dependencies can be exported as a bundle.
- Imported bundles do not contain secret values.

## Full Access and live control

Full Access runs do not stop for a confirmation before every tool action. Users can send
steering instructions while work is active or interrupt the run.

Scenario execution uses a session-bound frozen manifest. Editing a definition affects a
future run, not the already-running snapshot.

Automatic evidence, source, correction, provenance, and publishability controls remain
runtime-owned and cannot be disabled by editable scenario or Agent text.

## Interface changes

- Personalization now matches the main academic design system in light and dark themes.
- The first-run model-provider form is centered and uses the full application canvas.
- The application sidebar becomes an icon rail on very narrow viewports.
- Personalization tabs remain usable at narrow widths without clipped buttons.
- Empty states guide users to create a definition instead of displaying placeholder
  presets.
- ScenarioLauncher is now a compact blank-state route to Personalization; the obsolete
  119 KB predefined humanities planner was removed from the production bundle.

## Runtime and desktop changes

- Normal chat no longer silently selects a general-research scenario.
- Personalization services no longer seed built-in scenario definitions at startup.
- Custom scenarios remain selectable from chat and bind their exact ID to the request.
- Markdown, package, and URL Skills persist through the main-process extension service.
- Generated and URL MCP services use the managed runtime and activation state.
- Project rules and personalization revisions persist in SQLite and on disk as
  appropriate.
- The Electron production build uses a single-instance application lock.

## Verification performed for this release candidate

- Four TypeScript projects compile with zero errors.
- The production Vite/Electron build completes.
- The complete frontend suite passes: 35 files and 863 tests.
- Personalization service, installer, MCP builder, and project-rules focused tests pass.
- The SQLite personalization runtime passes under the Electron Node ABI.
- Real Electron visual acceptance captured 70 light/dark and responsive states with no
  detected overlap, clipped controls, inaccessible save actions, or horizontal page
  overflow.

These checks do not guarantee that every third-party Skill, MCP server, or model provider
is correct. Users should evaluate external extensions and provider behavior independently.

## Windows assets

The GitHub Release is expected to include:

- `Metis-Research-Workbench-Setup-0.1.0-alpha.2-x64.exe`
- `Metis-Research-Workbench-0.1.0-alpha.2-x64.msi`
- `SHA256SUMS-v0.1.0-alpha.2.txt`
- Source archives generated by GitHub

### Unsigned alpha warning

The Windows installers may be unsigned. SmartScreen can display an "unrecognized app"
warning. Verify that the asset came from the official GitHub repository and compare its
SHA-256 checksum before running it.

## Upgrade notes

1. Back up important projects and exported artifacts.
2. Close every running Metis window.
3. Install alpha.2 over the existing per-user installation, or use the MSI according to
   your Windows environment.
4. Launch Metis and verify the configured provider.
5. Open Personalization. No predefined scenarios will be added automatically.

Existing user-created definitions and project data are not intentionally removed by this
upgrade.

## Known limitations

- This is an alpha release.
- Windows x64 is the packaged target.
- Installers may be unsigned.
- AI responses require the user's own compatible provider and credentials.
- The release intentionally contains no predefined research scenarios.
- Presentation/PPT generation remains an open user-defined design space and is not a
  built-in workflow in alpha.2.
- Some exports require external tools such as a TeX distribution.
- Behavior of third-party Skills, MCP servers, and model endpoints depends on those
  external projects and services.

## License

The source code is released under the Apache License 2.0. See [LICENSE](../LICENSE).
