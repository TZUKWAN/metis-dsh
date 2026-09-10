# Office Engine Implementation Log

Date: 2026-08-25
Scope: GenOffice `docx-engine` / `pptx-engine` integration into METIS Outcomes.

## Completed

- Vendored Apache-2.0 engine sources under `vendor/genoffice/`; `ee/` was not copied.
- Added pure runtime dependencies `fast-xml-parser`, `jszip`, and `utif2`.
- Added `electron/office/genofficeBridge.ts` for DOCX Block-tree projection,
  docxIndex anchoring, original-package alignment, surgical save blocks, and
  legacy fallback.
- Added `electron/office/genofficePptxBridge.ts` for PPTX SlideDeck projection,
  element anchors, text/geometry/fill/stroke dirty patches, and structural-change
  fallback.
- Added original DOCX/PPTX archive persistence and ownership/hash verification in
  `OutcomeMediaService`.
- Wired Word/PPT import commits and exports in the Electron main process.
- Kept METIS OutcomeRepository versioning, OutcomeAssistantService context/source
  governance, PPT Generation Skill strict patches, and formatting UI unchanged.
- Added explicit `engine: 'genoffice' | 'legacy'` test/rollback selectors. Production
  defaults to GenOffice unless `METIS_OFFICE_ENGINE=legacy` is set.

## Evidence

- GenOffice upstream isolated tests: docx-engine 80 files, 859 passed / 1 skipped;
  pptx-engine 76 files, 766 passed.
- METIS P0: 4/4 DOCX samples parsed; all blocks anchored; 4/4 untouched round trips
  had zero ZIP-entry byte differences; 4/4 controlled edits reparsed visibly.
- METIS target tests: Word GenOffice 8/8; PPT GenOffice 4/4.
- Existing Office regression: Word 9/9; PPT 7/7; media/transform/formatting set 36/36.
- `npm run typecheck`: four TypeScript projects passed.

## Deliberately not claimed yet

- No Electron process was started in this implementation pass, per user instruction
  because another agent owns startup/Electron testing.
- No WPS/Word or PowerPoint visual round-trip has been claimed here.
- P3 Tiptap editor replacement is not implemented; current METIS editor remains in
  place over the projected contract.
- The eight SQLite-backed `OutcomePptxMediaIntegration` cases could not run in the
  host Node process because the installed `better-sqlite3` is Electron ABI145 while
  host Node requires ABI141. This is an environment boundary, not a PPT assertion;
  the corresponding Electron-ABI smoke remains owned by the other agent.

## Known design boundaries

- GenOffice text/geometry/fill/stroke surgical patches are used for anchored PPT
  elements. New/deleted/reordered structural PPT elements fall back to METIS's
  existing full writer rather than being silently dropped.
- DOCX/PPT original-package anchors are stored as project-owned Office media and
  referenced through open `page`/`props` records to preserve old strict contracts.
- AI remains fully METIS-owned; GenOffice agent-core, ai-provider, ai-search, and
  Genspark account routing are not integrated.
