# GenOffice Editor Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make METIS Outcomes use GenOffice's familiar Office-style editors and Ribbon behavior for Word, PPT, Excel and PDF while keeping METIS versioning, AI, project isolation and IPC as the source of truth.

**Architecture:** Add thin METIS-host adapters around the existing GenOffice editor implementations. The adapters translate between persisted METIS outcome documents and GenOffice native editor models, while all saves, AI changes, source attribution and version creation continue through the existing METIS services. Migrate Word first, then PPT, then introduce native Excel and PDF editor hosts.

**Tech Stack:** React 19, TypeScript 6, Electron 41, Tiptap/ProseMirror, Konva/react-konva, Univer, pdf.js/pdf-lib, GenOffice Apache-2.0 editor sources, existing METIS OutcomeRepository and IPC.

## Global Constraints

- Work only in `D:\LATEXTEST\metis-alpha2-release`; `D:\LATEXTEST\tools\genoffice` is read-only reference/source input and is never modified by this plan.
- Preserve all existing dirty and untracked files; never use `git reset`, `git clean`, wholesale restore, recursive deletion, or source-tree overwrite.
- Do not import GenOffice application shell, Genspark auth, Genspark AI, telemetry, project store, or branding.
- METIS remains the owner of outcome versions, CAS, project isolation, AI context, source attribution, and IPC validation.
- The action-row order is `保存版本 -> 排版 -> 导出 DOCX -> 投稿 -> 复制`.
- Every production behavior change follows a red-green regression cycle.
- No unsupported feature may be represented by fake data or a fabricated success state.

---

### Task 1: Establish GenOffice source and METIS adapter boundaries

**Files:**
- Read: `docs/OFFICE_ENGINE_MIGRATION_PLAN.md`
- Read: `vendor/genoffice/README-VENDORED.md`
- Modify: `tsconfig.node.json`, `tsconfig.app.json`, `electron/tsconfig.json` only if adapter imports require explicit path aliases
- Create: `electron/office/genofficeEditorTypes.ts`
- Create: `electron/office/genofficeEditorBoundary.ts`
- Test: `tests/electron/GenofficeEditorBoundary.test.ts`

**Interfaces:**
- `GenofficeEditorKind = 'word' | 'ppt' | 'spreadsheet' | 'pdf'`
- `GenofficeEditorSession<TModel>` contains `kind`, `documentId`, `model`, `dirty`, `selection`, `revision`, and `close()`.
- `assertGenofficeEditorBoundary(value)` rejects direct persistence/provider access from editor adapters.

- [ ] **Step 1: Add the boundary test**

```ts
it('allows editor model state but rejects persistence and provider capabilities', () => {
  expect(() => assertGenofficeEditorBoundary({ kind: 'word', model: {}, dirty: false })).not.toThrow()
  expect(() => assertGenofficeEditorBoundary({ kind: 'word', model: {}, persistence: {} })).toThrow()
  expect(() => assertGenofficeEditorBoundary({ kind: 'word', model: {}, provider: {} })).toThrow()
})
```

- [ ] **Step 2: Run the focused test and verify it fails because the boundary is missing**

Run: `npx vitest run tests/electron/GenofficeEditorBoundary.test.ts --reporter=dot`

- [ ] **Step 3: Implement the minimal typed boundary and runtime assertion**

Keep it limited to editor-kind/model/dirty/selection/revision and reject keys named `persistence`, `provider`, `projectStore`, `telemetry`, or `auth`.

- [ ] **Step 4: Run the focused test and typecheck**

Run: `npx vitest run tests/electron/GenofficeEditorBoundary.test.ts --reporter=dot`

Expected: the focused test passes.

Run: `npm run typecheck`

Expected: exit code 0.

### Task 2: Host the GenOffice Docs editor in METIS

**Files:**
- Create: `src/outcomes/genoffice/GenofficeWordEditor.tsx`
- Create: `src/outcomes/genoffice/genofficeWordAdapter.ts`
- Create: `src/outcomes/genoffice/genofficeWordAdapter.test.ts`
- Create: `src/outcomes/genoffice/GenofficeWordEditor.css`
- Modify: `src/pages/OutcomesPage.tsx`
- Modify: `src/pages/OutcomesPage.css`
- Test: `tests/frontend/GenofficeWordEditor.test.tsx`
- Test: `tests/electron/OutcomeWordGenofficePath.test.ts`

**Interfaces:**
- `createGenofficeWordModel(input: { document: WordDocument; originalArchive?: Uint8Array }): GenofficeWordModel`
- `projectGenofficeWordModel(model: GenofficeWordModel): { document: WordDocument; dirtyBlocks: string[]; selection?: WordSelection }`
- `GenofficeWordEditor` props: `document`, `outcomeId`, `projectId`, `baseVersion`, `onChange`, `onSave`, `onSelectionChange`, `onNotice`, `onOpenAi`, `onOpenLayout`.

- [ ] **Step 1: Write red adapter tests for projection and stable selection**

The tests must cover a paragraph, heading, table, image anchor, empty document, changed block detection, and a selection mapped back to the original block anchor. Assert that untouched blocks remain unchanged and that unsupported passthrough data is preserved in adapter metadata.

- [ ] **Step 2: Run the adapter tests and verify the expected missing-adapter failure**

Run: `npx vitest run src/outcomes/genoffice/genofficeWordAdapter.test.ts --reporter=dot`

- [ ] **Step 3: Implement the Word adapter using GenOffice `Block`/`docxIndex` types**

Use the existing vendored engine contracts and the existing METIS `WordDocument` storage schema. Do not cast the whole METIS document to a GenOffice document. Keep original archive and anchor metadata in the existing open metadata records already used by `OutcomeWordDocxService`.

- [ ] **Step 4: Run adapter tests and then add the editor harness test**

Run: `npx vitest run src/outcomes/genoffice/genofficeWordAdapter.test.ts --reporter=dot`

Expected: adapter tests pass.

The editor harness test must assert that the mounted top-level editor contains GenOffice Ribbon tab semantics, a single editor surface, one selection owner, and no active `.word-toolbar` legacy editor.

- [ ] **Step 5: Implement the editor host by extracting the minimum GenOffice Docs editor setup**

Reuse GenOffice `Ribbon`, editor extensions, pagination and editor actions. Remove only GenOffice app-shell callbacks and route file operations through METIS callbacks. Keep METIS assistant and version callbacks at the host boundary.

- [ ] **Step 6: Replace the production Word editor branch in `OutcomesPage.tsx`**

Render `GenofficeWordEditor` for Word outcomes. Keep the legacy editor only behind an explicit compatibility path used by old versions or a test-only adapter, not as the default production renderer. Preserve the right-side METIS assistant.

- [ ] **Step 7: Run focused Word renderer and Electron tests**

Run: `npx vitest run tests/frontend/GenofficeWordEditor.test.tsx tests/frontend/OutcomesPage.test.tsx tests/frontend/OfficeWordRibbon.test.tsx --reporter=dot`

Run: `npx vitest run tests/electron/OutcomeWordGenofficePath.test.ts tests/electron/OutcomeWordDocxWiring.test.ts --reporter=dot`

Expected: all focused tests pass; failures are fixed before continuing.

### Task 3: Move `排版` into the METIS outcome action row

**Files:**
- Modify: `src/pages/OutcomesPage.tsx`
- Modify: `src/pages/OutcomesPage.css`
- Modify: `src/components/OutcomeWordFormattingPanel.tsx` only for host callback compatibility
- Test: `tests/frontend/OutcomesPage.test.tsx`

- [ ] **Step 1: Add a red placement and behavior test**

Render a saved Word outcome and assert the action-row button order is `保存版本`, `排版`, `导出 DOCX`, `投稿`, `复制`. Click `排版`, apply a page-margin change, and assert the editor model changes while the version number remains unchanged until `保存版本` is clicked.

- [ ] **Step 2: Run the test to verify the current order/behavior fails**

Run: `npx vitest run tests/frontend/OutcomesPage.test.tsx -t "places layout before DOCX export" --reporter=dot`

- [ ] **Step 3: Implement the action-row button and modal/panel wiring**

The panel must consume the active GenOffice Word model through the host adapter. It must not call `saveOutcome` until the user activates the existing save-version action.

- [ ] **Step 4: Run the focused test and Word renderer tests**

Run: `npx vitest run tests/frontend/OutcomesPage.test.tsx tests/frontend/OutcomeWordFormattingPanel.test.tsx tests/frontend/GenofficeWordEditor.test.tsx --reporter=dot`

### Task 4: Host the GenOffice Slides editor in METIS

**Files:**
- Create: `src/outcomes/genoffice/GenofficePptEditor.tsx`
- Create: `src/outcomes/genoffice/genofficePptAdapter.ts`
- Create: `src/outcomes/genoffice/genofficePptAdapter.test.ts`
- Create: `src/outcomes/genoffice/GenofficePptEditor.css`
- Modify: `src/pages/OutcomesPage.tsx`
- Modify: `src/pages/OutcomesPage.css`
- Test: `tests/frontend/GenofficePptEditor.test.tsx`
- Test: `tests/electron/OutcomePptGenofficePath.test.ts`

- [ ] **Step 1: Write red PPT adapter tests**

Cover page order, shape identity, text edit, image media reference, locked shape behavior, selected page/element mapping, ratio, and dirty patch extraction. Assert that page/element IDs remain stable through projection.

- [ ] **Step 2: Run the tests and verify missing adapter behavior**

Run: `npx vitest run src/outcomes/genoffice/genofficePptAdapter.test.ts --reporter=dot`

- [ ] **Step 3: Implement the adapter using GenOffice SlideDeck/RenderSlide types**

Use `genofficePptxBridge` and existing media ownership checks. Keep METIS template, theme, generation skill, and version metadata outside the GenOffice model and merge them only at the host boundary.

- [ ] **Step 4: Implement the editor host with GenOffice Ribbon, Konva SlideCanvas, TextEditOverlay and thumbnails**

Route save and AI patch events to METIS. Do not import GenOffice app-level IPC or AI panel.

- [ ] **Step 5: Replace the default METIS DOM PPT editor path**

Keep the existing model-level PPT tests and compatibility adapter, but make the GenOffice host the production editor for imported and newly created PPT outcomes.

- [ ] **Step 6: Run focused PPT tests and Electron smoke**

Run: `npx vitest run tests/frontend/GenofficePptEditor.test.tsx tests/frontend/OutcomesPage.test.tsx tests/electron/OutcomePptGenofficePath.test.ts tests/electron/OutcomePptxService.test.ts --reporter=dot`

### Task 5: Introduce a native GenOffice Sheets outcome editor

**Files:**
- Create: `src/outcomes/genoffice/GenofficeSpreadsheetEditor.tsx`
- Create: `src/outcomes/genoffice/genofficeSpreadsheetAdapter.ts`
- Create: `src/outcomes/genoffice/genofficeSpreadsheetAdapter.test.ts`
- Create: `src/outcomes/genoffice/GenofficeSpreadsheetEditor.css`
- Modify: `engine/runtime/OutcomeRuntimeContract.ts`
- Modify: `src/pages/OutcomesPage.tsx`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Create: `tests/frontend/GenofficeSpreadsheetEditor.test.tsx`
- Create: `tests/electron/OutcomeSpreadsheetWiring.test.ts`

- [ ] **Step 1: Add strict spreadsheet outcome contract tests**

The contract must include workbook identity, sheet order, cell values/formulas, active selection, and original archive reference. It must reject a spreadsheet payload being parsed as a Word/PPT document.

- [ ] **Step 2: Run the tests and verify the new contract is absent**

Run: `npx vitest run tests/electron/OutcomeSpreadsheetWiring.test.ts --reporter=dot`

- [ ] **Step 3: Implement the minimal spreadsheet contract and adapter**

Use GenOffice Sheets workbook/domain/gateway types. Preserve formulas and cell types; never flatten a workbook into a text string.

- [ ] **Step 4: Wire import, save-version and export through METIS IPC**

Every IPC handler validates project/outcome ownership, dirty state, base version and archive reference before reading/writing XLSX bytes.

- [ ] **Step 5: Implement the GenOffice workbook host**

Reuse Sheets selection, formula bar, Ribbon and grid behaviors. Keep the METIS assistant as an adjacent panel with explicit selection context.

- [ ] **Step 6: Run spreadsheet focused tests and real isolated Electron import/save/reopen/export**

Run: `npx vitest run tests/frontend/GenofficeSpreadsheetEditor.test.tsx tests/electron/OutcomeSpreadsheetWiring.test.ts --reporter=dot`

Use an isolated Electron profile and a real `.xlsx` fixture. Assert the reopened workbook retains formulas, sheet order and edited cells.

### Task 6: Host the GenOffice PDF editor

**Files:**
- Create: `src/outcomes/genoffice/GenofficePdfEditor.tsx`
- Create: `src/outcomes/genoffice/genofficePdfAdapter.ts`
- Create: `src/outcomes/genoffice/genofficePdfAdapter.test.ts`
- Create: `src/outcomes/genoffice/GenofficePdfEditor.css`
- Modify: `engine/runtime/OutcomeRuntimeContract.ts`
- Modify: `src/pages/OutcomesPage.tsx`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Create: `tests/frontend/GenofficePdfEditor.test.tsx`
- Create: `tests/electron/OutcomePdfWiring.test.ts`

- [ ] **Step 1: Add red PDF adapter tests**

Cover page count, text selection, annotation creation, image edit state, search result navigation, dirty tracking, and save failure preserving the draft.

- [ ] **Step 2: Run the tests and verify missing PDF adapter behavior**

Run: `npx vitest run src/outcomes/genoffice/genofficePdfAdapter.test.ts --reporter=dot`

- [ ] **Step 3: Implement native PDF model and adapter**

Use GenOffice PDF page/edit state and pdf.js/pdf-lib/PDFium paths already present in the source checkout. Do not convert PDF to an `other.text` outcome for editing.

- [ ] **Step 4: Wire PDF import, save-version and export**

Use the same METIS project ownership and immutable version checks as Word/PPT. A failed PDF rewrite must not create a new version.

- [ ] **Step 5: Implement the PDF editor host and assistant selection context**

Reuse the GenOffice page toolbar, text/image layers, annotation/form controls and search. Keep METIS assistant actions explicit and source-attributed.

- [ ] **Step 6: Run focused PDF tests and isolated Electron round-trip**

Run: `npx vitest run tests/frontend/GenofficePdfEditor.test.tsx tests/electron/OutcomePdfWiring.test.ts --reporter=dot`

Use a real PDF fixture, add an annotation, save a new version, reopen it and assert the annotation remains.

### Task 7: Remove the custom Ribbon and legacy production editor paths

**Files:**
- Modify: `src/pages/OutcomesPage.tsx`
- Modify: `src/components/OfficeRibbon.tsx`
- Modify: `src/components/OfficeWordRibbon.tsx`
- Modify: `src/components/OfficePptRibbon.tsx`
- Modify: `src/pages/OutcomesPage.css`
- Preserve: model operations used by compatibility adapters and tests until the migration audit is complete
- Test: `tests/frontend/OutcomesPage.test.tsx`

- [ ] **Step 1: Add a production-path audit test**

Assert that Word/PPT outcomes mount GenOffice editor hosts, that the custom `office-ribbon__panel` is absent from production editor DOM, and that hidden legacy toolbars are not used as the active editor.

- [ ] **Step 2: Run the audit test and record any stale path**

Run: `npx vitest run tests/frontend/OutcomesPage.test.tsx -t "uses GenOffice editors" --reporter=dot`

- [ ] **Step 3: Remove only the default custom production branches**

Do not delete compatibility model operations or historical data fields until the migration and full regression gates pass.

- [ ] **Step 4: Run the full frontend suite**

Run: `npx vitest run tests/frontend --reporter=dot`

Fix every regression before proceeding.

### Task 8: Full METIS integration and visual verification

**Files:**
- Modify: `electron/main.ts`, `electron/preload.ts`, `src/App.tsx` only where integration requires it
- Create: `scripts/electron-genoffice-outcomes-e2e.cjs`
- Create: `test-results/genoffice-outcomes-e2e-20260826.json`
- Create: `test-results/genoffice-outcomes-visual-20260826/`
- Modify: `docs/OFFICE_ENGINE_MIGRATION_PLAN.md` with actual evidence only
- Modify: `CLAUDE_STATE.md` with actual evidence only

- [ ] **Step 1: Run typecheck and scoped lint**

Run: `npm run typecheck`

Run: `npx eslint src/outcomes src/pages/OutcomesPage.tsx src/components/OutcomeWordFormattingPanel.tsx electron/office electron/OutcomeWordDocxService.ts electron/OutcomePptxService.ts electron/main.ts electron/preload.ts tests/frontend tests/electron`

- [ ] **Step 2: Rebuild Host Node ABI and run the full Node suite**

Run: `npm run rebuild:node`

Run: `npm test -- --reporter=dot`

Expected: zero failed tests; skipped tests are enumerated with reasons.

- [ ] **Step 3: Build Electron and verify native ABI**

Run: `npm run build:electron`

Run: `npm exec -- electron scripts/verify-electron-sqlite.cjs`

Expected: exit 0 and Electron module ABI 145 with a working SQLite query.

- [ ] **Step 4: Execute the isolated real-user E2E**

The E2E must create/open one outcome of each supported kind, edit it using the real editor host, invoke `排版` for Word, save a new version, close/reopen the app with the same isolated profile, and export/reopen the resulting DOCX/PPTX/XLSX/PDF. It must record project ownership, version numbers, dirty-state failures and renderer errors.

Run: `node scripts/electron-genoffice-outcomes-e2e.cjs --report test-results/genoffice-outcomes-e2e-20260826.json`

- [ ] **Step 5: Capture and inspect visual states**

Capture Word and PPT at 1440px, 1100px, 850px and 650px widths in light and dark themes. Capture Excel and PDF at desktop and narrow widths. Inspect Ribbon group alignment, active tabs, familiar Office hierarchy, editor selection, overflow and assistant separation. Do not accept a screenshot only because it exists; record concrete geometry and interaction findings.

- [ ] **Step 6: Run full integration and final audit**

Run: `npm run acceptance:commercial`

Run: `git diff --check`

Run: `npm run typecheck`

Run: `npm test -- --reporter=dot`

Only mark a domain complete when its implementation files, focused tests, real Electron evidence and round-trip evidence all exist. All unsupported or environment-blocked items remain explicitly pending.
