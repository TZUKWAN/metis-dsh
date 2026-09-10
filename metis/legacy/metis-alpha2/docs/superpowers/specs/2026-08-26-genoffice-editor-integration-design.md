# GenOffice Editor Integration Design

**Goal:** Replace METIS's simplified self-built Word/PPT editing chrome and editing behavior with the corresponding GenOffice editor implementations while preserving METIS's outcome, version, AI, project-isolation, and IPC governance.

## Scope

The integration covers four editor families:

- Word: GenOffice Docs Ribbon, Tiptap/ProseMirror document editor, pagination, selection, tables, lists, undo/redo, comments, revisions, headers/footers, and DOCX round-trip.
- PowerPoint: GenOffice Slides Ribbon, Konva slide canvas, text editing, object selection, transforms, thumbnails, layout, theme, and PPTX round-trip.
- Excel: GenOffice Sheets workbook UI and XLSX gateway, introduced as a distinct spreadsheet document model rather than a projection into Word/PPT structures.
- PDF: GenOffice PDF page viewer/editor, text/image layers, annotations, forms, search, and PDF save path.

The first visible action row in METIS remains the owner of METIS operations. Its order is:

```text
保存版本 -> 排版 -> 导出 DOCX -> 投稿 -> 复制
```

The `排版` action is placed immediately before `导出 DOCX`. It opens the METIS formatting surface and applies changes to the active GenOffice document model before METIS creates a new immutable outcome version.

## Reuse Boundary

Reuse from the checked-out GenOffice source at `D:\LATEXTEST\tools\genoffice`:

- `apps/docs/src/renderer/components/**`
- `apps/docs/src/renderer/editor/**`
- `apps/docs/src/renderer/App.tsx` editor setup and document-state logic
- `apps/slides/src/renderer/components/**`
- `apps/slides/src/renderer/SlideCanvas.tsx`, `TextEditOverlay.tsx`, and editor actions
- `apps/sheets/src/renderer/**`, `apps/sheets/src/domain/**`, and XLSX gateway modules needed by the workbook editor
- `apps/pdf/src/renderer/**` and PDF main/preload modules required by the editor
- `packages/ui/src/**` shared ribbon UI, icons, dropdowns, colors, and tokens
- `packages/docx-engine`, `packages/pptx-engine`, and `packages/pptx-render` already vendored in METIS

Do not import GenOffice application shell, Genspark account/authentication, Genspark AI services, telemetry, project store, or GenOffice branding.

## METIS Ownership

METIS remains authoritative for:

- `OutcomeRepository`, immutable versions, CAS, autosave and restore.
- Project ownership, project context, source attribution and cross-project blocking.
- METIS AgentLoop, provider settings, AI patch validation and cancellation.
- Main/preload IPC validation and user-data paths.
- Outcome tree, assistant history, submissions, scenarios and research runtime.

GenOffice editors receive an in-memory document model and emit document edits/events. They must not write directly to METIS SQLite, bypass the METIS version service, or invoke GenOffice AI/provider/project persistence.

## Adapter Contracts

Each editor family gets an adapter with four responsibilities:

1. Convert the persisted METIS document or imported archive into the GenOffice editor model.
2. Track the active selection and dirty blocks/elements/cells/pages.
3. Convert editor changes into a METIS document patch without losing untouched data.
4. Convert a committed METIS version back into the editor model after save or restore.

The Word adapter must preserve GenOffice `docxIndex` anchors and the original archive reference. The PPT adapter must preserve page/shape indexes and media references. The Excel and PDF adapters must use their native GenOffice models and must not silently coerce unsupported content into plain text.

## Failure Semantics

- Invalid or unsupported imported content is shown with a concrete warning and remains available through the original archive/passthrough path when the engine supports it.
- A failed save, export, import, AI patch, or version conflict leaves the current editor draft untouched.
- A dirty draft blocks destructive import/restore/export operations until the user explicitly saves or discards it.
- Unsupported features are reported as unsupported; no placeholder data or fabricated success state is allowed.
- Old METIS versions without GenOffice metadata remain readable through the legacy compatibility adapter until migration is proven safe.

## Verification

Every editor phase requires:

- A failing regression test before production code changes for each new behavior.
- Focused unit/contract tests for model conversion, selection, dirty tracking and failure paths.
- Existing METIS outcome/version/AI tests unchanged and passing.
- Real Electron tests with the production preload and isolated SQLite profile.
- Import/edit/save/reopen/export exercises using actual DOCX, PPTX, XLSX and PDF fixtures.
- Typecheck, scoped lint, full test suite, Electron build, ABI smoke and visual inspection at desktop and narrow widths.

## Non-goals

- Do not redesign METIS navigation, scenario runtime, Goal runtime or research pages.
- Do not claim native Microsoft Word/PowerPoint visual parity without a real file round-trip check.
- Do not replace the METIS AI assistant with GenOffice AI.
- Do not delete the legacy adapter until old-version compatibility and new-path Electron regression tests pass.
