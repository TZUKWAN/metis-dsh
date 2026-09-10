<div align="center">

# 📖 Metis in Social Science

# A Local-First AI Research Workbench

**Executable Scenarios × Runtime-Enforced Research Integrity**

Built for social science and every kind of evidence-based writing.
AI conversation, literature management, deep PDF reading, notes, deliverable
editing, and reproducible research workflows — in one desktop workspace —
with **integrity computed by deterministic engine code, not model discretion**.

[⬇️ Download for Windows](https://github.com/TZUKWAN/metis-in-social-science/releases/latest) ·
[🀄 中文文档](README.md) ·
[🧩 Personalization Guide](docs/PERSONALIZATION_GUIDE.md) ·
[📝 Changelog](docs/RELEASE_NOTES_v0.1.0-alpha.2.md) ·
[🐛 Issues](https://github.com/TZUKWAN/metis-in-social-science/issues)

![Platform](https://img.shields.io/badge/platform-Windows%20x64-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Electron](https://img.shields.io/badge/Electron-41-47848F)
![React](https://img.shields.io/badge/React-19-61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)
![Tests](https://img.shields.io/badge/tests-2900%2B-brightgreen)

</div>

---

## 🤔 What is Metis?

Computational and evidence-based social science today interleaves four activities
supported by four disconnected tools: source management (Zotero-style reference
managers), PDF reading and annotation, drafting and revision, and delegating parts
of the workflow to a generic LLM chat. The cost is well known: **context is rebuilt
by hand at every tool boundary, claimed provenance decays with every copy-paste,
and the audit trails scholarship requires simply do not survive tool borders.**

Meanwhile, the integrity risks of LLM-assisted research are measurable: audits of
ChatGPT-generated references found substantial fabrication. For agent systems the
risk compounds — an agent that *claims* it ran an experiment, citing numbers no
tool ever produced, is producing **paper-shaped text, not paper-shaped evidence**.
RAG-style mitigations usually deploy on the *model side* — prompts, sampling, or
post-hoc checks — rather than as system-level guarantees that hostile or careless
configurations cannot bypass.

> **Metis' answer**: turn both concerns into runtime-computed properties —
> what the AI is allowed to do (executable scenarios), and whether output deserves
> academic trust (enforced integrity).

Metis is **local-first**: the primary store is a SQLite database on your machine,
files live in project workspaces, provider API keys live in OS-level secure
storage. Data leaves your machine only when you explicitly invoke a model call,
an academic API query, or a mail fetch.

---

## 🎯 Two Design Commitments

### 1️⃣ Executable Scenarios

A scenario is a **versioned, dependency-resolvable configuration graph**: it binds
agents, skills, MCP servers, rules documents (Metis.md), multi-step workflows,
memory policies, and output contracts.

- At session start, the personalization resolver resolves the scenario and *all*
  referenced definitions — missing, mistyped, disabled, or corrupted dependencies
  abort startup with machine-readable reasons (fail-closed)
- The result is frozen into a **run manifest**: every prompt layer carries a
  SHA-256 digest; the system prompt is a stable priority-ordered synthesis whose
  per-layer source and hash are inspectable at runtime
- **A running session executes its frozen manifest** — edits only create future
  revisions (r+1). What ran can be reconstructed afterwards.

Authoring is LLM-assisted but constrained by **deterministic phase gates and a
trust boundary**: identity, revision, and provenance fields are pinned to the
persisted definition — **the model cannot rewrite its own scaffolding.**

### 2️⃣ Runtime-Enforced Research Integrity

Evidence ledgering, numeric-claim tracing, cross-validated references,
cryptographically signed citation receipts, and a nine-dimension integrity report —
all computed by **deterministic engine code** outside the model's action space:

| You control | The Metis runtime controls |
| --- | --- |
| Research behavior, roles, workflows, tools, memory, outputs, quality bars | Execution snapshots, evidence ledger, source states, revision identity, provenance, integrity reports |
| Which skills or MCP servers to install and bind | How installed code registers, how observations are recorded |
| When to steer, stop, edit, archive, restore | Whether a run may claim "verified, revised, publishable" |

---

## 📸 Screenshots

> Captured from the running system.

### 🏠 Research Project Workspace

Project library, an **AI-inferred research phase** progress bar, scenario-bound AI
conversation, and synchronized task / artifact / note panels. Bottom toolbar:
add material · learn skill · name conversation · select model · thinking effort.

![Research Project Workspace](docs/screenshots/research-project-chat.png)

### 🎬 Scenario Library & Editor

Three-pane scenario workbench: library (categories, 7-day trash), phased
definition forms (01 basics → 02 deliverable → 03 workflow → 04 Scenario Metis.md
→ 05 output plan), and the **scenario configuration assistant** that compiles
natural language into definitions.

![Scenario Library & Editor](docs/screenshots/scenario-editor.png)

### 📚 Project Materials

NCPSSD (Chinese) & OpenAlex (SCI/SSCI) search with core-journal filtering,
method library, research notes, full-text extraction, PDF import, audio
transcription, and literature feeds.

![Project Materials](docs/screenshots/project-materials.png)

### 📝 Outcome Workbench

In-app DOCX editing with element-level formatting, version history, and an
**AI outcome assistant** bound to the current project & outcome.

![Outcome Editor](docs/screenshots/outcome-word-editor.png)

### ⚙️ Model Connections

Any OpenAI-compatible endpoint (name + base URL + model + context window);
multiple independent connections; API keys masked and stored in the OS vault,
never echoed back to the renderer.

![Model Connections](docs/screenshots/settings-model-connections.png)

---

## 🧩 Core Features

### 🎬 Scenario AI Compiler

Describe what you need in natural language; the compiler builds the scenario in
**five phases, each closed by a deterministic acceptance gate** — failures return
to the model immediately with concrete issues instead of exploding at the end:

| Phase | Content | Gate (excerpt) |
| --- | --- | --- |
| 1️⃣ Basics | name · description · capability | name non-empty; description ≥ 20 chars; capability set |
| 2️⃣ Deliverable | type · length · sections | type in enum; length a non-empty string; sections with stable ids & titles |
| 3️⃣ Workflow | steps · prompts · criteria | every step has stable id, name, dedicated prompt, criteria |
| 4️⃣ Rules | Metis.md layer | rendered rules are not an empty template |
| 5️⃣ Output plan | format · artifacts · quality | primary deliverable, supporting artifacts, quality criteria complete |

**Two-stage driving**: a *planning turn* registers the outline (ids + names), then
the main process drives *one fill turn per item* — each step's prompt, criteria,
and skill/MCP bindings written and rendered piece by piece. Each phase researches
online first, then writes. Missing skills/MCP servers are **auto-searched,
verified, installed, and bound** (HTTPS-only, content-inspected, capped per build,
fully visible in the event stream). The result is auto-saved; unsaved leaves prompt.

**Trust boundary**: identity fields (`id/kind/contractVersion/revision/provenance`)
are pinned from the persisted scenario; strict Zod validation rejects failing
candidates wholesale. Enabled scenarios resolve into a **frozen run manifest**;
workflow completion criteria are enforced with bounded repair loops
(≤5 iterations, ≤2 retries per step).

### 🔬 Integrity Pipeline

- **Evidence Ledger** — SHA-256 of every tool call's input/output, raw I/O
  retained; tampering detectable by re-hashing
- **Self-Deception Guard** — numeric-claim tracing (untraceable numbers: warn ≤2,
  critical >2), experiment-execution proof (claiming an experiment without an
  execute_code record is critical), fabricated DOI/arXiv detection (critical),
  self-consistency scan (warn)
- **Citation Truth Receipts** — references cross-validated against expected
  title/author/year; source snapshots digested; receipts HMAC-signed (keys in the
  OS vault) with TTL and constant-time verification; optional three-source
  triangulation (Crossref + OpenAlex + Semantic Scholar) and retraction screening
- **Nine-dimension weighted score** with verdict bands: **S ≥ 80 pass · 60–79
  warn · < 60 fail** — weights deliberately favor tracing, authenticity,
  retraction, and faithfulness over formatting
- **Fail-closed export gate** — citations need fresh receipts, numeric claims need
  evidence bindings, figure/table references must resolve to real artifacts
- **Evidence anchors** pin claims to exact source locations (page / char range /
  timestamp / row) with text snapshots and source version hashes — updated sources
  mark evidence **STALE**
- **Claim graph** — many-to-many claim↔evidence relations with per-link weights;
  claim status computed (supported / contested / refuted / unsupported)
- **Non-switchable runtime layer** — the hard safety boundary, capability
  permissions, evidence and revision identity live outside the model's action space

> ⚠️ The integrity score is **decision support, not proof** — green means "no
> automated check failed"; it guides human review rather than replacing it.

### 🤖 Agent Engine

A framework-free TypeScript turn-based core (deliberately no agent framework, so
the trust boundary stays auditable):

- **Budgeted context assembly** — six built-in profiles (micro_4k → deep, 4K–200K
  tokens, per-tool char quotas, max turns)
- **Semantic overflow recovery** — overflow-class failures trigger aggressive
  history recompression and *continue the same step*; other failures retry normally
- **Loop guards** — identical-response detection (k=3, tool-argument fingerprints
  included to avoid false positives), session tool-call budget, bounded temperature
  escalation on repeated repair (defaults: 12 turns, base temp 0.2, 120 s per-turn
  timeout, 1,800 s run timeout)
- **Hard safety boundary** — destructive commands (recursive deletes, formatting,
  shutdown, encoded one-liners, forced VCS operations, system-path writes) rejected
  by pattern analysis that deliberately resists quote obfuscation; not disableable
  by full-access mode, scenario text, or agent output
- **HITL approvals** — gated tools enter an approval queue; the run pauses until a
  human decides
- **Bounded repair loops & multi-agent orchestration** — per-step run records with
  explicit list bounds, so a runaway session cannot bloat persistence unboundedly

### 📚 Literature & Reading

Deep PDF reading (persistent highlights/annotations, region notes, AI explanation,
one-click literature notes, STALE detection) · NCPSSD & OpenAlex search · metadata
auto-completion (DOI/arXiv, never overwriting manual edits) · arXiv RSS with
per-item AI summaries · Ctrl+K full-text search (SQL-level) · BibTeX/CSV/RIS/HTML/
Notion export · comparison matrix with AI analysis · evidence anchors · claim graph.

### 📝 Outcome Workbench (Word / PPT)

Outcomes are formal deliverables — never a dumping ground for run logs or tool
intermediates. In-app DOCX/PPTX editing (element-level formatting), version
history with review states (draft → review → approved), AI collaboration
(full-document and selection-scoped edits saved as new versions, per-turn sources
listed), import/export — and a **fail-closed export gate**.

### 🧠 Personalization Center

Five **empty** definition stores out of the box — no preset journal templates,
thesis workflows, or demos. The platform ships editors and a runtime, not
assumptions about your research:

| Type | Binds (excerpt) |
| --- | --- |
| 🎬 Scenario | trigger phrases; agent/skill/MCP/rules bindings; multi-step workflow; memory scope; output contract |
| 🤖 Agent | role, system prompt, model preference, tools/skills/MCP, memory policy, output plan, turn & retry caps |
| 🛠️ Skill | Markdown instructions + optional packaged scripts/files; input/output schema fields |
| 🔌 MCP server | install source, transport, named secret references (values never returned to the renderer) |
| 📜 Metis.md rules | global / scenario / project scoped rule documents |

Every save creates an immutable revision (r+1); built-ins are protected and fork
into editable copies on edit; definition graphs export/import as bundles
(credentials never included); three acquisition channels (marketplaces, local
packages, URLs) verify before saving.

### 🆓 Free Model Center (experimental)

A batched, rate-limited subsystem that discovers and registers on widely deployed
open-source "new-api" style OpenAI-compatible gateways: status probe → verification
code via IMAP (inbox + junk, base64/QP MIME decoded) → registration (≤3 attempts) →
login → quota check (converted to USD) → token minting (encrypted into the OS
vault) → model listing. A **pricing-table gate** keeps the free list honest: a model
is free only if its pricing entry is explicitly zero; off-table entries are treated
as unknown and never as free. Scheduler: batches of five sites, 3–5 s randomized
delays, per-site progress streamed to the UI. Explicitly experimental and
third-party dependent.

### 🗂️ More

Flashcard spaced repetition · weekly reading reports · LaTeX AI polish
(command-preserving) · in-app LaTeX preview · dark theme · bilingual UI ·
command palette (Ctrl+K) · experiment view with reproducibility tracking
(environment fingerprints, multi-run variance).

---

## 🏗️ Architecture

Three layers with **contract-first IPC** — every cross-boundary payload is strictly
schema-validated (excess-key-rejecting contracts, bounded strings, control-character
rejection, enum error codes). Step results are discriminated unions; run records
bound every list (artifact refs ≤256, tool-call summaries ≤104) so a runaway session
cannot bloat persistence unboundedly.

```
Renderer — React 19 SPA (sandboxed, no Node) · 24 top-level pages
Preload bridge — contextIsolated whitelist API (~1,940 lines) · renderer auth gate
Main process — ~90 service modules + the Metis engine (framework-free TypeScript)
  AgentLoop · ContextEngine + BudgetManager · tool registry/dispatch/presentation
  EvidenceLedger · IntegrityReporter · SelfDeceptionGuard · CitationTruth
  personalization resolver · scenario compiler + gates · workflow/goal engines
  multi-agent orchestrator · MCP manager (stdio) · OpenAI-compatible provider + SSE
Persistence — local SQLite (better-sqlite3) · OS key vault · project workspace files
```

**Design principles**: local-first with explicit exits · zero preset research
assumptions · determinism at trust boundaries · integrity by computation, not
declaration · real paths over mocks.

**Implementation metrics** (measured on the release tree): 24 top-level pages ·
38 engine module directories · ≈90 main-process service modules · main.ts 9,911
lines · preload.ts 1,940 lines · 635 TypeScript/TSX files (≈8.3 MB) · 409 test
files · recorded engine suite run 154 files / 1,843 tests all green · recorded
frontend suite 1,141 tests all green · 4 typecheck projects, zero errors.

---

## 📦 Install

1. Download `Metis-Research-Workbench-Setup-<version>-x64.exe` from
   [**Releases**](https://github.com/TZUKWAN/metis-in-social-science/releases/latest)
2. Run the installer (custom directory supported)
3. If Windows SmartScreen appears (the installer is not code-signed), choose
   **"More info → Run anyway"**
4. First launch: configure an OpenAI-compatible provider (Settings → Model
   connections), create a research project, import literature or start chatting,
   and optionally build your first scenario in the Scenario page

---

## 🛠️ Development

```bash
git clone https://github.com/TZUKWAN/metis-in-social-science.git
cd metis-in-social-science
npm install

npm run dev:electron      # development (Vite HMR + Electron)
npm run build             # production build
npm test                  # full test suites
npm run test:fast         # frontend suite only
npm run typecheck         # 4 projects
npm run lint

# Package a Windows installer (NSIS → release/)
npm run rebuild:electron
npx electron-builder --win nsis
```

> 💡 `better-sqlite3` is a native module: development (Node ABI) and packaging
> (Electron ABI) need different binaries — switch with `npm run rebuild:node` /
> `npm run rebuild:electron`.

**Stack**: Electron 41 · React 19 · TypeScript (strict) · Vite · better-sqlite3 ·
pdfjs-dist · Zod · Vitest · electron-builder.

---

## ❓ FAQ

<details>
<summary><b>Where is my data? Is it uploaded?</b></summary>
Local SQLite + project workspace files on your machine. Content leaves only when
you explicitly invoke model calls, academic API queries, mail fetches, or
marketplace searches.
</details>

<details>
<summary><b>Are API keys safe?</b></summary>
Keys are processed by the main process and stored in OS-level secure storage —
masked after saving, never echoed to the renderer, never written into definitions,
export bundles, or settings responses.
</details>

<details>
<summary><b>Which models are supported?</b></summary>
Any OpenAI-compatible API (`/v1/chat/completions` + SSE). Model-agnostic — bring
your own.
</details>

<details>
<summary><b>Does an integrity score ≥ 80 mean the content is trustworthy?</b></summary>
No. Green means "no automated check failed" — necessary, not sufficient. Numeric
tracing is text-based; the safety boundary is pattern-based. The report guides
human review; it does not replace it.
</details>

<details>
<summary><b>macOS / Linux?</b></summary>
Windows x64 only at present; the stack is cross-platform but unverified elsewhere.
</details>

---

## 🗺️ Positioning & Limits

| Capability | Metis | Reference managers | Notes+LLM | Autonomous AI scientists | Agent lab frameworks |
| --- | :-: | :-: | :-: | :-: | :-: |
| Local-first primary store | ● | ● | ● | ◐ | ◐ |
| Project-scoped corpus + PDF reading | ● | ◐ | ◐ | ✗ | ✗ |
| Executable multi-step scenarios | ● | ◐ | ◐ | ● | ● |
| Frozen run manifest (edit isolation) | ● | ✗ | ✗ | ✗ | ✗ |
| Runtime evidence ledger + integrity score | ● | ✗ | ✗ | ✗ | ✗ |
| Signed expiring citation receipts | ● | ✗ | ✗ | ✗ | ✗ |
| In-app deliverable editing (DOCX/PPTX) | ● | ✗ | ◐ | ✗ | ✗ |
| HITL approvals + hard safety boundary | ● | ✗ | ✗ | ✗ | ✗ |
| Autonomous paper generation | ◐ | ✗ | ✗ | ● | ● |

● native ◐ partial ✗ absent. Qualitative, "designed-for" markers — not benchmarks.

**Known limits**: no benchmark evaluation · heuristic boundary guards (text-based
numeric tracing; pattern-based safety boundary) · integrity score is decision
support, not proof · free-model subsystem is optional and experimental ·
Windows x64 only at present.

---

## 🤝 Contributing · 📄 License

[Contributing](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) ·
[Security](SECURITY.md)

Licensed under the [MIT License](LICENSE).

---

<div align="center">

**Metis — your research, your rules, your local machine.**
**Every deliverable comes with an honest report of what the system did,
and how much of it is verifiable.**

</div>

