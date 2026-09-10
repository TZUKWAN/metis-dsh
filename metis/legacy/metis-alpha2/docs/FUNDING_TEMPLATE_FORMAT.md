# Metis Funding Template Package Format

Status: engine contract version 1, analyzer version 1.0.0

This document defines the pure-engine boundary for turning an uploaded funding application form into a reusable, versioned Metis template package. It covers funding applications only. PPT template analysis remains deliberately reserved for a later product design and is not implemented by this contract.

## Design objective

The analyzer must describe only what the uploaded document makes observable. It must not fill missing formatting, infer an official edition, or preserve the applicant's original prose. A package is therefore a structural compilation of:

- observed section hierarchy;
- fixed field labels and canonical field mappings;
- structured instructions and word or character limits;
- table dimensions, header labels, and merged-cell geometry;
- reusable content slots;
- typography, paragraph spacing, page size, and margins when the extractor supplied evidence;
- evidence locators and confidence for every uncertain assertion;
- a canonical SHA-256 digest and a privacy declaration.

The uploaded document is authoritative for the customized template. Built-in knowledge may recognize a broad family such as a National Social Science Fund-style form or a Ministry of Education humanities and social sciences-style form, but it never claims that the upload is the latest official edition.

## Trust boundary

`FundingTemplateAnalyzer` does not read files, open paths, parse ZIP containers, execute macros, invoke LibreOffice, or render PDFs. Those operations belong to a future main-process import adapter with file capability checks and extraction limits.

The engine accepts only `FundingTemplateObservationDocumentSchema`, a strict JSON observation record produced after the main process has safely extracted the document. The record contains:

- source format and SHA-256 digest;
- complete, ordered page observations;
- page dimensions and explicitly observed margins;
- style observations;
- ordered paragraph and table blocks;
- text roles assigned by the extractor;
- page-relative bounds;
- table cells and spans.

The strict schema rejects extra properties, missing pages, unordered pages or blocks, duplicate identifiers, references to unobserved styles, overlapping cells, invalid spans, and bounds outside a page or table.

Extracted text is an input observation, not layout truth. Typography and geometry are recorded only when a style, page, block, or cell observation supports them.

### Current file-observation adapter

`electron/FundingTemplateObservationAdapter.ts` implements the trusted local-file observation boundary without wiring it to IPC:

- it requires a real file contained by a real trusted root;
- it rejects symbolic links, unsupported extensions, oversized files, and identity changes during the read;
- it hashes the stable file bytes before parsing;
- PDF input is parsed by the bundled PDF.js with evaluation disabled and an independent input buffer;
- PDF pages, text lines, font observations, and PDF.js-derived coordinates are compiled directly into `FundingTemplateObservationDocumentSchema`;
- PDF margins, alignment, and paragraph spacing remain unobserved when PDF.js does not expose them;
- DOCX input is inspected as a bounded ZIP/OOXML package without writing archive entries to disk;
- DOCX inspection rejects traversal, duplicate paths, special-file or symlink entries, encryption, unsupported compression, ZIP64, excessive ratios and sizes, CRC failures, macros, embedded active content, DTD/entity declarations, and external or traversing relationships;
- DOCX structure reports only counts and digests, never paragraph or cell text.

WordprocessingML is a flow document format and does not contain trustworthy final paragraph or table coordinates. Contract version 1 requires non-null block bounds. The adapter therefore returns `docx_layout_unobservable` after successful privacy-safe DOCX inspection instead of inventing coordinates. A future connection must either evolve the observation contract to represent unobserved bounds explicitly or render a sanitized DOCX in a trusted main-process conversion step and observe the resulting PDF. This limitation is deliberate and fail-closed.

## Evidence and uncertainty

Observable template assertions use three states:

| State | Meaning | Required fields |
| --- | --- | --- |
| `observed` | All supporting observations agree | non-null value, positive confidence, evidence locator |
| `uncertain` | There is evidence, but observations conflict or only partially agree | selected value, fractional confidence, evidence locator |
| `not_observed` | The extractor supplied no supporting observation | null value, zero confidence, empty evidence |

An evidence locator binds an assertion to:

- document identifier;
- original source digest;
- page number;
- block identifier and kind;
- optional table-cell coordinates;
- observed bounds;
- SHA-256 of the observed text, without retaining that text in the locator.

This prevents a missing font, margin, line spacing, or paragraph spacing from being silently replaced by a model guess.

## Privacy behavior

The package declares:

```json
{
  "rawTextStored": false,
  "sourceTextRetention": "none"
}
```

Paragraphs and cells marked `user_content` are not copied into the package. Text matching common sensitive patterns such as email addresses, mobile numbers, identity numbers, addresses, and secret-like values is excluded from template output. Evidence locators retain only a text digest.

Safe template labels and general instructions may be normalized into the package because they are necessary to reconstruct the form. The analyzer never stores full applicant responses.

## Package structure

Every successful analysis returns `FundingTemplatePackageSchema`:

```text
format                    metis-funding-template-package
schemaVersion             serialization contract version
templateId                stable user-owned identifier
templateVersion           monotonically increasing template version
createdAt                 caller-supplied timestamp
analyzerVersion           deterministic analyzer version
source                    user-upload authority and source bindings
sections                  ordered hierarchy
instructions              structured instructions and length limits
tables                    dimensions, safe headers, and merged cells
contentSlots              reusable authoring slots
fieldMappings             source label to canonical Metis field
typography                body, heading, and table evidence assertions
layout                    page-size and margin evidence assertions
quality                   confidence and review issues
privacy                   raw-text retention declaration
canonicalDigest           SHA-256 of canonical package content
```

`source.authority` is always `user_upload`. `source.officialCurrency` is always `not_asserted`. `source.fundingFamily` is an evidence assertion, not an official-version declaration.

## Content slots and mappings

Sections, non-heading fixed labels, and safe table headers can become content slots. Each slot includes:

- a stable deterministic identifier;
- the parent section, when observable;
- a normalized label;
- a content kind such as plain text, rich text, number, date, table, or attachment;
- required and maximum-length assertions;
- evidence locators.

Field mappings translate observed labels into a bounded canonical vocabulary such as `project_name`, `applicant`, `research_basis`, `research_methods`, `budget`, or `expected_outputs`. Unrecognized labels remain `custom`; they are not coerced into a misleading semantic field.

## Analysis API

The main integration entry point is:

```ts
analyzeFundingTemplate(request: unknown): FundingTemplateAnalysisResult
```

The request must satisfy `FundingTemplateAnalysisRequestSchema`:

```ts
{
  templateId: string;
  templateVersion: number;
  createdAt: number;
  document: FundingTemplateObservationDocument;
}
```

The result is a strict discriminated union. It returns either a verified package or one of these fail-closed codes:

- `invalid_input`;
- `duplicate_section`;
- `duplicate_field`;
- `insufficient_template_evidence`;
- `invalid_package`.

No failure result contains applicant text.

## Persistence API

The pure engine does not choose a storage directory or write files. The future trusted repository layer should use these functions:

```ts
verifyFundingTemplatePackage(raw: unknown): FundingTemplatePackageVerification
serializeFundingTemplatePackage(template: FundingTemplatePackage): string
decodeFundingTemplatePackage(serialized: string): FundingTemplatePackageVerification
```

`serializeFundingTemplatePackage` refuses a structurally invalid or digest-mismatched object. Its output is canonical JSON with sorted object keys. `decodeFundingTemplatePackage` performs strict schema and digest verification before returning a package.

A trusted repository should save the exact canonical string using its existing atomic-write, containment, version-conflict, and durability mechanisms. A renderer must never choose the physical path or assert that the digest is valid.

## Trusted repository and service

The main-process implementation is split into two explicit trust layers:

- `FundingTemplateService` validates an import request, invokes the real PDF/DOCX observation adapter, analyzes and verifies the package, and only then asks the repository to commit it.
- `FundingTemplateRepository` owns the physical directory beneath a trusted base, immutable versions, compare-and-swap state, activation, archive, restore, and integrity verification.

The repository uses two state slots and a small pointer file. A new state is written and synchronized to the inactive slot before one atomic pointer rename makes it active. A `wx` lock serializes concurrent writers. Readers use only the committed slot and fail closed when the pointer, outer state digest, inner package digest, diff digest, or strict schema is invalid. They never silently recover from an uncommitted slot.

Every template identity is scoped by `ownerId`, `projectId`, and `templateId`. Updates require the expected repository revision, active version, and active package digest. Versions are immutable and contiguous; a reanalysis with an unchanged source hash is rejected. Activating an older version, archiving, and restoring all create new repository revisions without deleting version history.

Persisted state contains normalized reusable structure and evidence digests only. It does not store the uploaded file path or applicant prose. Common email, telephone, identity-number, and secret-like strings are rejected again at the repository boundary, even if a caller recomputes a package digest.

The service intentionally returns `docx_layout_unobservable` when a DOCX package exposes flow content and page settings but not trustworthy final element coordinates. It does not manufacture PDF-like bounds. A future rendering-backed DOCX adapter may satisfy that requirement without changing the package contract.

## Reanalysis and version differences

A new analysis of the same template must use a greater `templateVersion`. After both packages have been verified, the caller can compute:

```ts
diffFundingTemplatePackages(previous, next): FundingTemplateDiff
```

The diff binds both package digests and reports added, removed, or changed source observations, sections, instructions, tables, slots, field mappings, typography, layout, and quality state. The diff itself has a canonical digest. Structural removals and changes to sections, slots, mappings, or layout are marked breaking.

The diff does not mutate either package and does not decide migration policy. A repository or UI can use it to show what changed before replacing a saved version.

## Main-process integration sequence

The production connection should follow this order:

1. Receive the PDF or DOCX through the existing file-capability boundary.
2. Validate size, type, path containment, and archive safety in the main process.
3. Extract pages, paragraphs, tables, styles, and bounds without executing macros or embedded programs.
4. Classify applicant-filled material as `user_content` where observable.
5. Build and validate `FundingTemplateObservationDocumentSchema`.
6. Call `analyzeFundingTemplate` in the engine.
7. Show `quality.status`, issues, confidence, and evidence coverage to the user without asking for per-action execution permission.
8. Serialize and persist only after `verifyFundingTemplatePackage` succeeds.
9. On reanalysis, increment `templateVersion`, compute a diff, and persist the new immutable version.

The UI may allow the user to edit a copy of the resulting template, but edits must create a new version and a new digest. They must not rewrite source evidence or turn `not_observed` fields into `observed` claims.

## Non-goals in version 1

- No PPT layout compilation. The product space is reserved for a later design.
- No claim that a recognized family is an official or current form.
- No model-generated replacement for missing layout evidence.
- No file parsing or file-system writes inside the engine.
- No retention of applicant prose.
- No automatic execution of macros, scripts, links, or embedded objects.
- No renderer-controlled storage path or digest assertion.

## Verification coverage

The engine attack matrix covers:

- missing and out-of-order pages;
- non-monotonic blocks;
- blocks and cells outside observed bounds;
- fabricated and duplicate styles;
- duplicate sections and table columns;
- applicant and sensitive-text leakage;
- missing typography and margin evidence;
- insufficient structural evidence;
- canonical determinism and persistence round trips;
- package digest tampering;
- strict extra-property rejection;
- integrity-bound, monotonic reanalysis diffs.

The representative National Social Science Fund-style and Ministry-style fixtures test family recognition only. They are not embedded official templates and are not represented as the latest forms.
