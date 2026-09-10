# Release Notes — Metis Research Workbench 0.1.0-alpha.1

**Release date:** 2026-07-30
**Platform:** Windows (x64)
**Status:** Alpha — for early evaluation, not production use

---

## About This Release

This is the first packaged alpha of Metis Research Workbench, an AI-powered desktop
research assistant for the social sciences. It bundles the full feature set into
NSIS and MSI installers for Windows x64.

This release is intended for evaluators who want to test the integrated research
workflow: paper management, note-taking, PDF reading, LaTeX editing, experiment
tracking, and AI-driven goal workflows — all with local data persistence.

---

## Important: Unsigned Installer

The installers in this release are **not Authenticode code-signed**. Code-signing
material is pending and will be applied to a subsequent release.

**What this means for you:**

- Windows SmartScreen may display "Windows protected your PC" when you run the
  installer.
- Microsoft Defender or third-party antivirus software may show a warning because the
  publisher cannot be verified.

**How to proceed (Windows):**

1. Run the NSIS installer (`Metis-Research-Workbench-Setup-0.1.0-alpha.1-x64.exe`).
2. If SmartScreen appears, click **More info**, then **Run anyway**.
3. If a separate antivirus warning appears, verify the file hash (below) against the
   value published with the release, then proceed at your discretion.

Only run software from sources you trust. If you are uncertain, wait for a
code-signed release.

### SHA-256 checksums

```text
0bf0e74cd920000fb8ee57d66d328cd7fbf00d190b450a93ed7aef17c4d68c60  Metis-Research-Workbench-Setup-0.1.0-alpha.1-x64.exe
ae4a7d730dd23dccf4284a6e6fa404db2c97de88aa566818e606447fc20f220e  Metis-Research-Workbench-0.1.0-alpha.1-x64.msi
```

These values are also published as the release asset
`SHA256SUMS-v0.1.0-alpha.1.txt`.

---

## What's Included

### Core Modules
- Dashboard with reading-goal tracking and activity overview
- Multi-session AI chat with streaming, Markdown, code highlighting, and tool-call cards
- Goal-driven workflows: natural-language goal to auto-generated plan with step-by-step execution
- Paper library with BibTeX import, PDF attachment, tags, ratings, and reading status
- Collections for systematic-review grouping
- Knowledge graph of citation relationships
- Research timeline with activity heatmaps
- LaTeX editor with live KaTeX preview and `pdflatex` compilation
- In-app PDF reader with text extraction and search
- Markdown notes linked to papers and projects
- Experiment tracker with parameters, metrics, and status
- Built-in evaluation suite with dev / candidate / release quality gates

### Engine
- AgentLoop with bounded tool-use and streaming delivery
- Tool ecosystem: built-in tools plus MCP (Model Context Protocol) server support
- Workflow engine with DAG execution and pause / resume / retry
- Goal engine with plan generation, refinement, and memory extraction
- Memory system for cross-session context retention
- Human-in-the-loop approval gate for sensitive operations

### Security
- Renderer isolation (`contextIsolation: true`, `nodeIntegration: false`)
- File-access sandbox with path-traversal and symlink protection
- Shell-command allow-list with human approval
- API key encryption via Electron `safeStorage`
- Single-instance lock to prevent concurrent database access

---

## Verified Quality Baseline

| Check | Result |
|-------|--------|
| Automated tests | 3,271 passing across 186 test files; zero failures, skips, or todos |
| TypeScript type-check | Clean (app, engine, node, electron) |
| ESLint | Clean (flat config) |
| Cold start (development) | PersistenceStore initializes, no fatal errors |
| Cold start (packaged exe) | PersistenceStore initializes, zero stderr errors |
| Restart after crash | SQLite WAL recovery confirmed, no lock errors |
| Single-instance enforcement | Second instance exits, first instance focused |
| Data directory structure | Complete (database, settings, keys, media) |
| Windows packaging | NSIS + MSI produced, exit 0 |

---

## Installation

### Option A — NSIS installer (recommended)

1. Download `Metis-Research-Workbench-Setup-0.1.0-alpha.1-x64.exe`.
2. Run the installer (see the unsigned-installer note above).
3. Choose the installation directory when prompted.
4. Launch **Metis Research Workbench** from the Start Menu or desktop shortcut.

### Option B — MSI installer (enterprise)

1. Download `Metis-Research-Workbench-0.1.0-alpha.1-x64.msi`.
2. Run the MSI, or deploy it with your organization's Windows software-management tooling.
3. The MSI installs per-machine.

---

## First Run

On first launch, Metis displays the provider setup screen:

1. Enter your OpenAI-compatible **API Base URL** (for example,
   `https://api.openai.com/v1`).
2. Enter your **API Key**.
3. Enter your **Model** name.
4. Click **Save** to validate the connection and initialize the agent.

All subsequent features (chat, goals, evals) use this provider. Your API key is
encrypted with the operating system credential store.

---

## Data Location

Metis stores all research data under the application user-data directory:

- **Windows:** `%APPDATA%\Metis Research Workbench\metis-data\`

Contents:

| Path | Purpose |
|------|---------|
| `metis.db` | SQLite database (papers, notes, experiments, sessions, messages) |
| `provider-config.json` | Encrypted provider configuration |
| `settings.json` | Theme and preferences |
| `papers/` | Attached PDF files |
| `research-media/` | Research workspace media |
| `ca-artifacts/` | Current-affairs research artifacts |
| `terminal-workspace/` | Terminal session working directory |

No data leaves this directory except API calls to your configured AI provider.

---

## Known Limitations

- **Unsigned installer.** See the note above. Code signing is pending.
- **Windows only.** macOS and Linux builds are planned for a later release.
- **Single AI provider at a time.** Multi-provider routing is on the roadmap.
- **LaTeX compilation requires a local TeX distribution** (TeX Live or MiKTeX). The
  built-in editor works without one, but `pdflatex` compilation will report
  "noCompiler" until a distribution is installed and on `PATH`.
- **English / Chinese UI only.** Additional localizations are planned.

---

## Uninstallation

- **NSIS:** Use "Add or remove programs" in Windows Settings, or the uninstaller
  in the installation directory.
- **MSI:** Use "Add or remove programs" or `msiexec /x {ProductCode}`.
- **Portable:** Delete the `win-unpacked` directory.

User data (`%APPDATA%\Metis Research Workbench\`) is preserved on uninstall by
default. Delete it manually if you want a full clean-up.

---

## Feedback

This alpha is for evaluation. Please report bugs with reproducible steps through the
[public issue tracker](https://github.com/TZUKWAN/metis-in-social-science/issues).
Remove API keys, private documents, local file paths, and confidential research data
from logs before attaching them.
