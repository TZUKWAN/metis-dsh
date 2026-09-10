# GenOffice Office Ribbon Adaptation

## Goal

Expose the existing GenOffice Docs and Slides editing affordances in the METIS
Outcomes editor without creating a second unrelated Office UI. METIS remains the
document, AI, project, version, media-ownership, and downgrade contract; GenOffice
remains the reference for ribbon grouping, labels, interaction order, and the
capabilities that can be mapped safely into the current WordDocument/PptDocument
models.

## Reuse Boundary

- Reuse the GenOffice ribbon information architecture and capability names:
  `Home`, `Insert`, `Layout/Design`, `References/Review`, `View`, plus PPT
  `Transitions` and `Animations` where the persisted METIS contract can carry the
  operation.
- Reuse GenOffice capability logic only where its inputs/outputs can be adapted to
  METIS models without importing GenOffice's Electron shell, Genspark branding,
  agent-core, ai-provider, ai-search, or account routing.
- Do not claim unsupported features. A capability that cannot be persisted or
  exported through the current METIS contract is read-only or visibly marked as a
  safe downgrade, never a no-op button.
- Keep the existing METIS CSS tokens, project shell, assistant pane, immutable
  version save flow, and selection/source governance.

## Word Surface

- Replace the single dense toolbar with a GenOffice-style ribbon tab strip and
  grouped controls while retaining the current contentEditable projection.
- `Home`: undo/redo, paragraph style, font, size, color, bold/italic/underline,
  alignment, list and indent controls.
- `Insert`: citation, table insertion, page break, symbols, and safe media entry
  points that use the existing METIS import/media bridge when available.
- `Layout`: expose the existing `OutcomeWordFormattingPanel` and its real document
  mutation path for page, body, heading, caption, header/footer, and page-number
  settings. The panel must be mounted; it is currently imported but not rendered.
- `References`: reuse the existing citation insertion and add deterministic
  heading/word-count/TOC affordances only when the WordDocument contract can store
  the resulting blocks.
- `Review`: show GenOffice-inspired status cards for imported warnings, preserved
  unsupported blocks, selection context, and METIS local-AI actions. AI remains
  METIS-owned.
- `View`: page width/whole-page display and document statistics where these are
  renderer-only state and do not alter persisted content.

## PPT Surface

- Replace the single dense toolbar with the GenOffice Slides ribbon grouping.
- `Home`: undo/redo, duplicate/delete, lock, z-order, alignment/nudge, and text
  formatting for the selected projected element.
- `Insert`: slide, text, shape, table, chart placeholder, image, and safe AI-image
  association. Existing METIS model mutations remain the source of truth.
- `Design`: ratio, theme colors, real PPT templates, and apply/update template
  actions already backed by METIS persistence.
- `Transitions` and `Animations`: show the GenOffice capability entry points only
  for fields already represented by the METIS open props/theme records; otherwise
  render an explicit unsupported/read-only state and preserve original XML.
- `Review`: generation skill, AI image, warning summary, and version/save boundary.
- `View`: slide list/canvas display controls and grid/fit state without changing
  exported document content.
- Selected images use the existing crop/opacity/mask/rotation/flip controls and
  the GenOffice `srcRect`/transform mapping; media replacement continues through
  `OutcomeMediaService` and never silently reuses stale archive bytes.

## State and Safety

- Each editor owns a bounded local undo/redo history. Every mutating operation
  produces a new draft through the existing `onChange`; only explicit save creates
  an immutable METIS version.
- Tab controls are keyboard reachable, have stable labels, and disable when the
  selected document or element cannot support the operation.
- Unsupported GenOffice features are represented as warnings or read-only cards,
  not simulated implementation.
- Imported original archives and managed media remain project/outcome scoped and
  continue to use the existing ownership and hash checks.
- Keep the existing legacy fallback for structural PPT changes and unsupported
  Word/PPT features.

## Verification

- Add focused frontend tests for Word/PPT ribbon tab switching, disabled boundaries,
  undo/redo, real document mutations, Word formatting-panel mounting, and PPT
  image/shape operations.
- Re-run GenOffice engine tests, METIS Office targeted tests, frontend Outcomes
  tests, typecheck, lint, and the non-Electron full suite.
- Do not start Electron in this pass. Electron ABI smoke, real file import/export,
  and WPS/Word/PowerPoint visual checks remain the other agent's responsibility.
