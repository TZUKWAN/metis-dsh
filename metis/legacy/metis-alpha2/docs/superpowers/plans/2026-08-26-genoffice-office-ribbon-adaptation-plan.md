# GenOffice Office Ribbon Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse GenOffice's Docs/Slides ribbon information architecture to expose real, persisted Word and PPT editing capabilities in METIS Outcomes without importing GenOffice's app shell or AI stack.

**Architecture:** Add a small METIS-owned ribbon shell that mirrors the existing GenOffice tab/group model, then pass explicit callbacks from the current `WordEditor` and `PptStudioEditor`. Keep document mutation in typed local helpers and existing `onChange`/save/version flows; unsupported GenOffice features render as disabled/read-only status instead of no-op controls.

**Tech Stack:** React 18/19 TypeScript, Vitest, Testing Library, Lucide icons, existing `WordDocument`/`PptDocument` contracts, vendored GenOffice `docx-engine`/`pptx-engine` bridges.

## Global Constraints

- Reuse GenOffice ribbon grouping and capability names; do not invent a separate visual language.
- METIS remains the AI, project context, version, media ownership, and downgrade contract.
- Do not import GenOffice Electron shell, Genspark branding, `agent-core`, `ai-provider`, `ai-search`, or account routing.
- Every mutating action must update the local draft through `onChange`; only explicit save creates an immutable METIS version.
- Unsupported features must be visibly disabled/read-only and must never be simulated by a no-op button.
- Do not start Electron, WPS, Word, or PowerPoint in this pass.
- Do not rebuild native modules while another Agent owns Electron testing.

---

### Task 1: Add METIS GenOffice-Style Ribbon Shell

**Files:**
- Create: `src/components/OfficeRibbon.tsx`
- Create: `src/components/OfficeRibbon.css`
- Test: `tests/frontend/OfficeRibbon.test.tsx`

**Interfaces:**
- `OfficeRibbonTab = { id: string; label: string; groups: OfficeRibbonGroup[] }`.
- `OfficeRibbonGroup = { id: string; label: string; content: ReactNode }`.
- `OfficeRibbonProps = { tabs: OfficeRibbonTab[]; activeTab: string; onTabChange: (id: string) => void; leading?: ReactNode; trailing?: ReactNode; status?: ReactNode }`.
- Export `OfficeRibbon` and `OfficeRibbonTabButton` only; do not expose implementation state.

- [ ] **Step 1: Write failing tests for tab behavior and accessibility.**

```tsx
it('renders the selected GenOffice-style tab and switches by keyboard', async () => {
  const onTabChange = vi.fn();
  render(
    <OfficeRibbon
      tabs={[{ id: 'home', label: '开始', groups: [{ id: 'clipboard', label: '剪贴板', content: <button>粘贴</button> }] }]}
      activeTab="home"
      onTabChange={onTabChange}
    />,
  );
  const tab = screen.getByRole('tab', { name: '开始' });
  expect(tab).toHaveAttribute('aria-selected', 'true');
  await userEvent.tab();
  await userEvent.keyboard('{Enter}');
  expect(onTabChange).toHaveBeenCalledWith('home');
});

it('does not render groups from inactive tabs', () => {
  render(<OfficeRibbon tabs={tabs} activeTab="insert" onTabChange={vi.fn()} />);
  expect(screen.queryByText('开始组')).not.toBeInTheDocument();
  expect(screen.getByText('插入组')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the focused test and confirm it fails because the shell is missing.**

Run: `npx vitest run tests/frontend/OfficeRibbon.test.tsx`

Expected: FAIL with the missing `OfficeRibbon` module or missing tab role.

- [ ] **Step 3: Implement the shell using the GenOffice ribbon structure.**

The component must render:

```tsx
<section className="office-ribbon" aria-label="Office 编辑工具栏">
  <div className="office-ribbon__topline">
    {leading}
    <div role="tablist" aria-label="Office 功能区">
      {tabs.map((tab) => (
        <button role="tab" aria-selected={tab.id === activeTab} aria-controls={`office-ribbon-panel-${tab.id}`} ...>
          {tab.label}
        </button>
      ))}
    </div>
    {trailing}
  </div>
  <div id={`office-ribbon-panel-${activeTab}`} role="tabpanel" className="office-ribbon__panel">
    {tabs.find((tab) => tab.id === activeTab)?.groups.map((group) => (
      <section className="office-ribbon__group" key={group.id} aria-label={group.label}>
        <div className="office-ribbon__group-content">{group.content}</div>
        <small>{group.label}</small>
      </section>
    ))}
  </div>
  {status}
</section>
```

Use existing METIS semantic CSS variables only. Add responsive horizontal scrolling for the tab row and group panel; do not add gradients, raw theme colors, or unrelated effects.

- [ ] **Step 4: Run focused tests and lint.**

Run: `npx vitest run tests/frontend/OfficeRibbon.test.tsx && npx eslint src/components/OfficeRibbon.tsx`

Expected: all focused tests pass and ESLint exits 0.

---

### Task 2: Wire Word Ribbon and Real Document Operations

**Files:**
- Create: `src/components/OfficeWordOperations.ts`
- Modify: `src/pages/OutcomesPage.tsx:516-638`
- Modify: `src/pages/OutcomesPage.css:6`
- Test: `tests/frontend/OutcomesPage.test.tsx`
- Test: `tests/frontend/OfficeWordOperations.test.ts`

**Interfaces:**
- `createWordBlockId(document, prefix): string` returns a unique contract-safe ID.
- `insertWordTable(document, rows, columns): WordDocument` clamps rows to 200 and columns to 63.
- `insertWordPageBreak(document, afterBlockId): WordDocument` inserts a visible page-break block using the existing Word block/style representation.
- `toggleWordList(document, blockId, kind): WordDocument` toggles `style.list` between `bullet`, `numbered`, and absent.
- `updateWordActiveStyle(document, blockId, patch): WordDocument` applies only finite, contract-safe style fields.
- `wordDocumentStats(document): { words: number; characters: number; paragraphs: number; tables: number; images: number }` is deterministic and read-only.

- [ ] **Step 1: Add failing pure-operation tests.**

```ts
it('inserts a bounded table after the active block', () => {
  const result = insertWordTable(doc, 2, 3);
  expect(result.blocks.at(-1)).toMatchObject({ kind: 'table', rows: [['', '', ''], ['', '', '']] });
});

it('toggles lists without mutating text or unrelated blocks', () => {
  const next = toggleWordList(doc, 'p-1', 'bullet');
  expect(next.blocks[0]).toMatchObject({ text: doc.blocks[0].text, style: { list: 'bullet' } });
});

it('counts document content without treating table cells as paragraphs', () => {
  expect(wordDocumentStats(doc)).toEqual({ words: 2, characters: 8, paragraphs: 1, tables: 0, images: 0 });
});
```

- [ ] **Step 2: Run the pure tests and verify they fail.**

Run: `npx vitest run tests/frontend/OfficeWordOperations.test.ts`

Expected: FAIL because the operations are not yet exported.

- [ ] **Step 3: Implement the operations with immutable updates and bounds.**

Use `structuredClone` only for the returned branch, preserve all unknown `style` keys, and reject invalid IDs by returning the original document. Never create an ID outside `OutcomeIdSchema`'s allowed character set.

- [ ] **Step 4: Run pure tests and typecheck.**

Run: `npx vitest run tests/frontend/OfficeWordOperations.test.ts && npm run typecheck`

Expected: all pure tests pass and all four TypeScript projects pass.

- [ ] **Step 5: Replace the single Word toolbar with GenOffice-style tabs.**

In `WordEditor`, add local `wordTab` state defaulting to `home`, expose bounded `historyRef` actions as ribbon leading controls, and map tabs as follows:

```tsx
const tabs: OfficeRibbonTab[] = [
  { id: 'home', label: '开始', groups: [{ id: 'clipboard', label: '剪贴板', content: ... }, { id: 'font', label: '字体', content: ... }, { id: 'paragraph', label: '段落', content: ... }] },
  { id: 'insert', label: '插入', groups: [{ id: 'tables', label: '表格', content: ... }, { id: 'references', label: '引用', content: ... }, { id: 'breaks', label: '页面', content: ... }] },
  { id: 'layout', label: '布局', groups: [{ id: 'page', label: '页面设置', content: <OutcomeWordFormattingPanel document={doc} onApply={(next, note) => { update(next); setWordNotice(note); }} /> }] },
  { id: 'references', label: '引用', groups: [{ id: 'citations', label: '引用与目录', content: ... }] },
  { id: 'review', label: '审阅', groups: [{ id: 'proofing', label: '校验', content: ... }, { id: 'ai', label: 'METIS AI', content: ... }] },
  { id: 'view', label: '视图', groups: [{ id: 'stats', label: '文档统计', content: ... }] },
];
```

Keep the existing contentEditable rendering and selection capture. Move current font/size/color/weight/alignment controls into the `home` tab rather than duplicating them. Use the existing citation modal for `references`; use a safe text insertion path for tables/page breaks; render the current warning/AI selection boundary in `review`. The `layout` tab must visibly mount `OutcomeWordFormattingPanel`, fixing the existing dead import.

- [ ] **Step 6: Add Word ribbon integration tests.**

Cover: tab switching, undo/redo disabled at history edges, list toggle mutates `document`, insert table creates a real block, layout tab renders the formatting panel, and review statistics are read-only.

- [ ] **Step 7: Run Word focused tests and lint.**

Run: `npx vitest run tests/frontend/OutcomesPage.test.tsx tests/frontend/OutcomeWordFormattingPanel.test.tsx tests/frontend/OfficeWordOperations.test.ts tests/frontend/OfficeRibbon.test.tsx && npx eslint src/pages/OutcomesPage.tsx src/components/OfficeWordOperations.ts src/components/OfficeRibbon.tsx`

Expected: all selected tests pass and ESLint exits 0.

---

### Task 3: Wire PPT Ribbon and Real Slide Operations

**Files:**
- Create: `src/components/OfficePptOperations.ts`
- Modify: `src/pages/OutcomesPage.tsx:705-990`
- Modify: `src/pages/OutcomesPage.css:7,14-20`
- Test: `tests/frontend/OfficePptOperations.test.ts`
- Test: `tests/frontend/OutcomesPage.test.tsx`

**Interfaces:**
- `duplicatePptPage(document, pageIndex): PptDocument` creates unique page/element IDs and marks the new page draft/human-modified.
- `deletePptPage(document, pageIndex): PptDocument` refuses to delete the last page.
- `updatePptElementProps(document, pageIndex, elementId, patch): PptDocument` preserves unknown props and refuses locked/missing elements.
- `setPptElementLayer(document, pageIndex, elementId, layer): PptDocument` supports `front`, `back`, `forward`, and `backward` by deterministic z-index.
- `pptDocumentStats(document): { slides: number; elements: number; text: number; images: number; charts: number }` is read-only.

- [ ] **Step 1: Add failing pure-operation tests.**

```ts
it('duplicates a slide with fresh ids and preserves its elements', () => {
  const next = duplicatePptPage(doc, 0);
  expect(next.pages).toHaveLength(2);
  expect(next.pages[1]?.id).not.toBe(next.pages[0]?.id);
  expect(next.pages[1]?.elements[0]?.id).not.toBe(next.pages[0]?.elements[0]?.id);
});

it('refuses to delete the last slide', () => {
  expect(deletePptPage(singleSlideDoc, 0)).toEqual(singleSlideDoc);
});

it('does not mutate a locked element', () => {
  expect(updatePptElementProps(lockedDoc, 0, 'locked', { fillColor: '#ffffff' })).toEqual(lockedDoc);
});
```

- [ ] **Step 2: Run pure tests and verify they fail.**

Run: `npx vitest run tests/frontend/OfficePptOperations.test.ts`

Expected: FAIL because the operations are not exported.

- [ ] **Step 3: Implement immutable PPT operations.**

Clamp IDs, preserve `props` keys, mark changed pages `humanModified: true` and `status: 'draft'`, and keep all geometry inside the existing ratio grid. Do not add new top-level contract fields.

- [ ] **Step 4: Run pure tests and typecheck.**

Run: `npx vitest run tests/frontend/OfficePptOperations.test.ts && npm run typecheck`

Expected: all pure tests pass and all four TypeScript projects pass.

- [ ] **Step 5: Replace the single PPT toolbar with GenOffice-style tabs.**

Use the existing `themeRoles`, template functions, image controls, generation skill controls, and `onSave` path as callback content inside these tabs:

```tsx
const tabs: OfficeRibbonTab[] = [
  { id: 'home', label: '开始', groups: [{ id: 'clipboard', label: '剪贴板', content: ... }, { id: 'arrange', label: '排列', content: ... }, { id: 'format', label: '格式', content: ... }] },
  { id: 'insert', label: '插入', groups: [{ id: 'slides', label: '幻灯片', content: ... }, { id: 'objects', label: '对象', content: ... }] },
  { id: 'design', label: '设计', groups: [{ id: 'theme', label: '主题', content: ... }, { id: 'templates', label: '模板', content: ... }] },
  { id: 'transitions', label: '切换', groups: [{ id: 'transition-status', label: '切换', content: <UnsupportedOfficeCard ... /> }] },
  { id: 'animations', label: '动画', groups: [{ id: 'animation-status', label: '动画', content: <UnsupportedOfficeCard ... /> }] },
  { id: 'review', label: '审阅', groups: [{ id: 'generation', label: 'METIS Generation Skill', content: ... }, { id: 'media', label: '媒体校验', content: ... }] },
  { id: 'view', label: '视图', groups: [{ id: 'canvas', label: '画布', content: ... }, { id: 'statistics', label: '统计', content: ... }] },
];
```

Wire Home operations to `OfficePptOperations`; keep selected image crop/opacity/mask/rotation/flip in the Home/Format group. Expose fill, border, text color, font size, and z-index fields for unlocked elements using existing `updateSelectedProps`. Wire Design to existing template/theme functions. For transitions/animations, show the explicit boundary message until the contract has actual fields; never write an unused prop that the exporter cannot preserve.

- [ ] **Step 6: Add PPT integration tests.**

Cover: tab switching, duplicate/delete slide, lock boundary, layer action, selected-element style mutation, Design theme action, Insert element action, Review warning/status rendering, and explicit read-only transitions/animations message.

- [ ] **Step 7: Run PPT focused tests and lint.**

Run: `npx vitest run tests/frontend/OutcomesPage.test.tsx tests/frontend/OfficePptOperations.test.ts tests/frontend/OfficeRibbon.test.tsx tests/electron/OutcomePptGenofficePath.test.ts tests/electron/OutcomePptxImageTransform.test.ts && npx eslint src/pages/OutcomesPage.tsx src/components/OfficePptOperations.ts src/components/OfficeRibbon.tsx`

Expected: frontend and non-native Office tests pass; no Electron process starts.

---

### Task 4: Audit GenOffice Capability Boundaries and Documentation

**Files:**
- Modify: `docs/OFFICE_ENGINE_MIGRATION_PLAN.md`
- Modify: `docs/OFFICE_ENGINE_IMPLEMENTATION_LOG.md`
- Modify: `docs/superpowers/specs/2026-08-26-genoffice-office-ribbon-adaptation-design.md`
- Modify: `docs/superpowers/plans/2026-08-26-genoffice-office-ribbon-adaptation-plan.md`
- Test: `tests/engine/OutcomeRuntimeContract.test.ts`

- [ ] **Step 1: Search for newly exposed actions that have no persistence path.**

Run: `rg -n "onClick|onChange|Unsupported|只读|降级|transition|animation" src/components/OfficeRibbon.tsx src/components/OfficeWordOperations.ts src/components/OfficePptOperations.ts src/pages/OutcomesPage.tsx`

Expected: every mutating handler calls a real operation or existing save/media/template bridge; transitions/animations have only explicit read-only status.

- [ ] **Step 2: Add contract regression assertions.**

Assert that representative ribbon operations still parse with `WordDocumentSchema`/`PptDocumentSchema`, unknown `style`/`props` fields remain accepted, and no new top-level fields were introduced.

- [ ] **Step 3: Update migration log with actual feature mapping.**

Record the exact mapped features, the explicit read-only features, and the existing legacy fallback. Do not claim GenOffice app-level feature parity or Electron/WPS visual acceptance.

- [ ] **Step 4: Run focused contract tests and lint.**

Run: `npx vitest run tests/engine/OutcomeRuntimeContract.test.ts && npx eslint src/components/OfficeRibbon.tsx src/components/OfficeWordOperations.ts src/components/OfficePptOperations.ts src/pages/OutcomesPage.tsx`

Expected: tests pass and lint exits 0.

---

### Task 5: Full Verification and Failure Repair

**Files:**
- Modify: only files implicated by failing tests; never revert unrelated Agent changes.
- Evidence: `C:\Users\lauze\AppData\Local\Temp\opencode\metis-office-full-test.log`

- [ ] **Step 1: Run the complete non-Electron typecheck and lint.**

Run: `npm run typecheck`

Then run: `npx eslint src/components/OfficeRibbon.tsx src/components/OfficeWordOperations.ts src/components/OfficePptOperations.ts src/pages/OutcomesPage.tsx`

Expected: both exit 0.

- [ ] **Step 2: Run all Office and Outcomes focused tests.**

Run: `npx vitest run tests/frontend/OfficeRibbon.test.tsx tests/frontend/OfficeWordOperations.test.ts tests/frontend/OfficePptOperations.test.ts tests/frontend/OutcomesPage.test.tsx tests/frontend/OutcomeWordFormattingPanel.test.tsx tests/electron/OutcomeWordGenofficePath.test.ts tests/electron/OutcomePptGenofficePath.test.ts tests/electron/OutcomePptxImageTransform.test.ts`

Expected: all selected tests pass. If `better-sqlite3` ABI mismatch appears, record it and do not rebuild while the other Agent owns Electron testing.

- [ ] **Step 3: Run `npm run test:fast` with output captured.**

Run: `$log='C:\Users\lauze\AppData\Local\Temp\opencode\metis-office-full-test.log'; npm run test:fast *> $log; $code=$LASTEXITCODE; Write-Output "exit=$code log=$log"; Get-Content $log -Tail 25`

Expected: exit 0 with all test files passing. If failures occur, isolate each failure, fix the root cause, rerun the focused test, then rerun the complete suite.

- [ ] **Step 4: Run final static audit.**

Run: `git diff --check`; search for `TODO|TBD|mock|stub|placeholder` in the new ribbon/operations files; verify the spec, plan, and implementation log agree; verify no Electron start command was run.

- [ ] **Step 5: Update the implementation log with real evidence.**

Record exact command results, any native ABI limitation, and the remaining Electron/visual handoff. Do not claim full product acceptance unless the other Agent supplies evidence.
