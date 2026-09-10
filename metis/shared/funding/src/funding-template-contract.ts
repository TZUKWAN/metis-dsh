import { z } from 'zod';

export const FUNDING_TEMPLATE_OBSERVATION_VERSION = 1 as const;
export const FUNDING_TEMPLATE_PACKAGE_SCHEMA_VERSION = 1 as const;
export const FUNDING_TEMPLATE_PACKAGE_FORMAT = 'metis-funding-template-package' as const;

export const FUNDING_TEMPLATE_LIMITS = Object.freeze({
  pages: 2_000,
  styles: 2_000,
  blocks: 20_000,
  cellsPerTable: 20_000,
  textCharsPerBlock: 40_000,
  sections: 512,
  instructions: 2_000,
  tables: 1_000,
  slots: 4_000,
  evidencePerAssertion: 128,
} as const);

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
// eslint-disable-next-line no-control-regex -- extracted boundary text rejects C0/C1 except tab/newline
const UNSAFE_MULTILINE = new RegExp('[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]', 'u');
// eslint-disable-next-line no-control-regex -- identifiers and one-line values reject every C0/C1 code point
const UNSAFE_SINGLE_LINE = new RegExp('[\\x00-\\x1f\\x7f-\\x9f]', 'u');

function singleLine(max: number) {
  return z.string().min(1).max(max).refine((value) => !UNSAFE_SINGLE_LINE.test(value), {
    message: 'Single-line text contains unsafe control characters',
  });
}

function multiline(max: number) {
  return z.string().min(1).max(max).refine((value) => !UNSAFE_MULTILINE.test(value), {
    message: 'Extracted text contains unsafe control characters',
  });
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export const FundingTemplateDigestSchema = z.string().regex(DIGEST_PATTERN);
export const FundingTemplateSafeIdSchema = z.string().regex(SAFE_ID_PATTERN);
export const FundingTemplateTimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const FundingObservedBoundsSchema = z.strictObject({
  x: z.number().min(0).max(100_000),
  y: z.number().min(0).max(100_000),
  width: z.number().positive().max(100_000),
  height: z.number().positive().max(100_000),
});

export const FundingObservedMarginsSchema = z.strictObject({
  top: z.number().min(0).max(10_000),
  right: z.number().min(0).max(10_000),
  bottom: z.number().min(0).max(10_000),
  left: z.number().min(0).max(10_000),
});

export const FundingPageObservationSchema = z.strictObject({
  pageNumber: z.number().int().positive().max(FUNDING_TEMPLATE_LIMITS.pages),
  widthPt: z.number().positive().max(100_000),
  heightPt: z.number().positive().max(100_000),
  observedMarginsPt: FundingObservedMarginsSchema.nullable(),
});

export const FundingStyleObservationSchema = z.strictObject({
  styleId: FundingTemplateSafeIdSchema,
  fontFamily: singleLine(240).nullable(),
  fontSizePt: z.number().positive().max(1_000).nullable(),
  fontWeight: z.enum(['normal', 'medium', 'semibold', 'bold']).nullable(),
  italic: z.boolean().nullable(),
  alignment: z.enum(['left', 'center', 'right', 'justify']).nullable(),
  lineSpacingPt: z.number().positive().max(10_000).nullable(),
  paragraphBeforePt: z.number().min(0).max(10_000).nullable(),
  paragraphAfterPt: z.number().min(0).max(10_000).nullable(),
});

export const FundingObservedContentRoleSchema = z.enum([
  'template_label',
  'instruction',
  'placeholder',
  'user_content',
  'unknown',
]);

const FundingObservationHeaderSchema = z.strictObject({
  blockId: FundingTemplateSafeIdSchema,
  pageNumber: z.number().int().positive().max(FUNDING_TEMPLATE_LIMITS.pages),
  ordinal: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  bounds: FundingObservedBoundsSchema,
});

export const FundingParagraphObservationSchema = FundingObservationHeaderSchema.extend({
  kind: z.literal('paragraph'),
  text: multiline(FUNDING_TEMPLATE_LIMITS.textCharsPerBlock),
  contentRole: FundingObservedContentRoleSchema,
  styleId: FundingTemplateSafeIdSchema.nullable(),
});

export const FundingTableCellObservationSchema = z.strictObject({
  rowIndex: z.number().int().min(0).max(10_000),
  columnIndex: z.number().int().min(0).max(10_000),
  rowSpan: z.number().int().positive().max(10_000),
  columnSpan: z.number().int().positive().max(10_000),
  text: z.string().max(FUNDING_TEMPLATE_LIMITS.textCharsPerBlock).refine(
    (value) => !UNSAFE_MULTILINE.test(value),
    { message: 'Extracted cell text contains unsafe control characters' },
  ),
  contentRole: FundingObservedContentRoleSchema,
  styleId: FundingTemplateSafeIdSchema.nullable(),
  bounds: FundingObservedBoundsSchema.nullable(),
});

export const FundingTableObservationSchema = FundingObservationHeaderSchema.extend({
  kind: z.literal('table'),
  rowCount: z.number().int().positive().max(10_000),
  columnCount: z.number().int().positive().max(10_000),
  cells: z.array(FundingTableCellObservationSchema).max(FUNDING_TEMPLATE_LIMITS.cellsPerTable),
});

export const FundingObservedBlockSchema = z.discriminatedUnion('kind', [
  FundingParagraphObservationSchema,
  FundingTableObservationSchema,
]);

function boundsFitPage(
  bounds: z.infer<typeof FundingObservedBoundsSchema>,
  page: z.infer<typeof FundingPageObservationSchema>,
): boolean {
  const epsilon = 0.01;
  return bounds.x + bounds.width <= page.widthPt + epsilon
    && bounds.y + bounds.height <= page.heightPt + epsilon;
}

export const FundingTemplateObservationDocumentSchema = z.strictObject({
  contractVersion: z.literal(FUNDING_TEMPLATE_OBSERVATION_VERSION),
  documentId: FundingTemplateSafeIdSchema,
  sourceFormat: z.enum(['pdf', 'docx']),
  sourceDigest: FundingTemplateDigestSchema,
  extractedAt: FundingTemplateTimestampSchema,
  extractor: z.strictObject({
    name: singleLine(160),
    version: singleLine(80),
  }),
  pageCount: z.number().int().positive().max(FUNDING_TEMPLATE_LIMITS.pages),
  pages: z.array(FundingPageObservationSchema).min(1).max(FUNDING_TEMPLATE_LIMITS.pages),
  styles: z.array(FundingStyleObservationSchema).max(FUNDING_TEMPLATE_LIMITS.styles),
  blocks: z.array(FundingObservedBlockSchema).min(1).max(FUNDING_TEMPLATE_LIMITS.blocks),
}).superRefine((document, context) => {
  if (document.pages.length !== document.pageCount) {
    context.addIssue({ code: 'custom', path: ['pages'], message: 'Every declared page must be observed' });
  }
  for (let index = 0; index < document.pages.length; index += 1) {
    const page = document.pages[index];
    if (page?.pageNumber !== index + 1) {
      context.addIssue({ code: 'custom', path: ['pages', index, 'pageNumber'], message: 'Pages must be complete and ordered' });
    }
    if (page?.observedMarginsPt) {
      const margins = page.observedMarginsPt;
      if (margins.left + margins.right >= page.widthPt
        || margins.top + margins.bottom >= page.heightPt) {
        context.addIssue({ code: 'custom', path: ['pages', index, 'observedMarginsPt'], message: 'Observed margins exceed the page' });
      }
    }
  }

  const styleIds = document.styles.map((style) => style.styleId);
  if (!unique(styleIds)) {
    context.addIssue({ code: 'custom', path: ['styles'], message: 'Style identifiers must be unique' });
  }
  const styleSet = new Set(styleIds);
  const blockIds = document.blocks.map((block) => block.blockId);
  if (!unique(blockIds)) {
    context.addIssue({ code: 'custom', path: ['blocks'], message: 'Block identifiers must be unique' });
  }

  let previousOrdinal = -1;
  let previousPage = 0;
  for (let index = 0; index < document.blocks.length; index += 1) {
    const block = document.blocks[index];
    if (!block) continue;
    const page = document.pages[block.pageNumber - 1];
    if (!page) {
      context.addIssue({ code: 'custom', path: ['blocks', index, 'pageNumber'], message: 'Block references a missing page' });
      continue;
    }
    if (block.pageNumber < previousPage || block.ordinal <= previousOrdinal) {
      context.addIssue({ code: 'custom', path: ['blocks', index, 'ordinal'], message: 'Blocks must be in document order with unique ordinals' });
    }
    previousPage = block.pageNumber;
    previousOrdinal = block.ordinal;
    if (!boundsFitPage(block.bounds, page)) {
      context.addIssue({ code: 'custom', path: ['blocks', index, 'bounds'], message: 'Block bounds exceed the observed page' });
    }

    if (block.kind === 'paragraph') {
      if (block.styleId !== null && !styleSet.has(block.styleId)) {
        context.addIssue({ code: 'custom', path: ['blocks', index, 'styleId'], message: 'Paragraph references an unobserved style' });
      }
      continue;
    }

    const occupied = new Set<string>();
    for (let cellIndex = 0; cellIndex < block.cells.length; cellIndex += 1) {
      const cell = block.cells[cellIndex];
      if (!cell) continue;
      if (cell.rowIndex + cell.rowSpan > block.rowCount
        || cell.columnIndex + cell.columnSpan > block.columnCount) {
        context.addIssue({ code: 'custom', path: ['blocks', index, 'cells', cellIndex], message: 'Cell span exceeds table dimensions' });
      }
      for (let row = cell.rowIndex; row < cell.rowIndex + cell.rowSpan; row += 1) {
        for (let column = cell.columnIndex; column < cell.columnIndex + cell.columnSpan; column += 1) {
          const coordinate = `${row}:${column}`;
          if (occupied.has(coordinate)) {
            context.addIssue({ code: 'custom', path: ['blocks', index, 'cells', cellIndex], message: 'Table cells overlap' });
          }
          occupied.add(coordinate);
        }
      }
      if (cell.styleId !== null && !styleSet.has(cell.styleId)) {
        context.addIssue({ code: 'custom', path: ['blocks', index, 'cells', cellIndex, 'styleId'], message: 'Cell references an unobserved style' });
      }
      if (cell.bounds !== null && !boundsFitPage(cell.bounds, page)) {
        context.addIssue({ code: 'custom', path: ['blocks', index, 'cells', cellIndex, 'bounds'], message: 'Cell bounds exceed the observed page' });
      }
      if (cell.bounds !== null) {
        const epsilon = 0.01;
        if (cell.bounds.x + epsilon < block.bounds.x
          || cell.bounds.y + epsilon < block.bounds.y
          || cell.bounds.x + cell.bounds.width > block.bounds.x + block.bounds.width + epsilon
          || cell.bounds.y + cell.bounds.height > block.bounds.y + block.bounds.height + epsilon) {
          context.addIssue({ code: 'custom', path: ['blocks', index, 'cells', cellIndex, 'bounds'], message: 'Cell bounds exceed the observed table' });
        }
      }
    }
  }
});

export const FundingEvidenceLocatorSchema = z.strictObject({
  documentId: FundingTemplateSafeIdSchema,
  sourceDigest: FundingTemplateDigestSchema,
  pageNumber: z.number().int().positive().max(FUNDING_TEMPLATE_LIMITS.pages),
  blockId: FundingTemplateSafeIdSchema,
  blockKind: z.enum(['page', 'paragraph', 'table', 'table_cell']),
  cell: z.strictObject({
    rowIndex: z.number().int().min(0).max(10_000),
    columnIndex: z.number().int().min(0).max(10_000),
  }).nullable(),
  bounds: FundingObservedBoundsSchema.nullable(),
  observedTextDigest: FundingTemplateDigestSchema.nullable(),
});

export const FundingConfidenceSchema = z.number().min(0).max(1);
const FundingAssertionStateSchema = z.enum(['observed', 'uncertain', 'not_observed']);

function evidenceAssertion<T extends z.ZodType>(valueSchema: T) {
  return z.strictObject({
    state: FundingAssertionStateSchema,
    value: valueSchema.nullable(),
    confidence: FundingConfidenceSchema,
    evidence: z.array(FundingEvidenceLocatorSchema).max(FUNDING_TEMPLATE_LIMITS.evidencePerAssertion),
  }).superRefine((assertion, context) => {
    const checked = assertion as unknown as {
      state: 'observed' | 'uncertain' | 'not_observed';
      value: unknown;
      confidence: number;
      evidence: readonly unknown[];
    };
    if (checked.state === 'not_observed') {
      if (checked.value !== null || checked.confidence !== 0 || checked.evidence.length !== 0) {
        context.addIssue({ code: 'custom', message: 'Unobserved assertions cannot carry a value, confidence, or evidence' });
      }
    } else if (checked.value === null || checked.evidence.length === 0 || checked.confidence <= 0) {
      context.addIssue({ code: 'custom', message: 'Observed and uncertain assertions require a value and evidence' });
    }
  });
}

export const FundingStringAssertionSchema = evidenceAssertion(singleLine(500));
export const FundingNumberAssertionSchema = evidenceAssertion(z.number().min(0).max(100_000));
export const FundingBooleanAssertionSchema = evidenceAssertion(z.boolean());
export const FundingMarginsAssertionSchema = evidenceAssertion(FundingObservedMarginsSchema);
export const FundingPageSizeAssertionSchema = evidenceAssertion(z.strictObject({
  widthPt: z.number().positive().max(100_000),
  heightPt: z.number().positive().max(100_000),
}));
export const FundingFamilyAssertionSchema = evidenceAssertion(z.enum([
  'national_social_science_fund',
  'ministry_humanities_social_sciences',
]));

export const FundingTemplateSectionSchema = z.strictObject({
  sectionId: FundingTemplateSafeIdSchema,
  normalizedTitle: singleLine(300),
  level: z.number().int().min(1).max(6),
  order: z.number().int().min(0).max(FUNDING_TEMPLATE_LIMITS.sections - 1),
  required: FundingBooleanAssertionSchema,
  confidence: FundingConfidenceSchema,
  evidence: z.array(FundingEvidenceLocatorSchema).min(1).max(FUNDING_TEMPLATE_LIMITS.evidencePerAssertion),
});

export const FundingTemplateInstructionSchema = z.strictObject({
  instructionId: FundingTemplateSafeIdSchema,
  sectionId: FundingTemplateSafeIdSchema.nullable(),
  kind: z.enum(['required', 'max_length', 'format', 'submission', 'other']),
  normalizedText: singleLine(500),
  maxLength: z.strictObject({
    value: z.number().int().positive().max(10_000_000),
    unit: z.enum(['characters', 'words']),
  }).nullable(),
  confidence: FundingConfidenceSchema,
  evidence: z.array(FundingEvidenceLocatorSchema).min(1).max(FUNDING_TEMPLATE_LIMITS.evidencePerAssertion),
});

export const FundingTemplateTableSchema = z.strictObject({
  tableId: FundingTemplateSafeIdSchema,
  sectionId: FundingTemplateSafeIdSchema.nullable(),
  rowCount: z.number().int().positive().max(10_000),
  columnCount: z.number().int().positive().max(10_000),
  headers: z.array(z.strictObject({
    columnIndex: z.number().int().min(0).max(10_000),
    normalizedLabel: singleLine(300),
    confidence: FundingConfidenceSchema,
    evidence: z.array(FundingEvidenceLocatorSchema).min(1).max(FUNDING_TEMPLATE_LIMITS.evidencePerAssertion),
  })).max(10_000),
  mergedCells: z.array(z.strictObject({
    rowIndex: z.number().int().min(0).max(10_000),
    columnIndex: z.number().int().min(0).max(10_000),
    rowSpan: z.number().int().positive().max(10_000),
    columnSpan: z.number().int().positive().max(10_000),
  })).max(FUNDING_TEMPLATE_LIMITS.cellsPerTable),
  confidence: FundingConfidenceSchema,
  evidence: z.array(FundingEvidenceLocatorSchema).min(1).max(FUNDING_TEMPLATE_LIMITS.evidencePerAssertion),
});

export const FundingContentSlotSchema = z.strictObject({
  slotId: FundingTemplateSafeIdSchema,
  sectionId: FundingTemplateSafeIdSchema.nullable(),
  normalizedLabel: singleLine(300),
  kind: z.enum(['plain_text', 'rich_text', 'number', 'date', 'table', 'attachment', 'unknown']),
  required: FundingBooleanAssertionSchema,
  maxLength: z.strictObject({
    value: z.number().int().positive().max(10_000_000),
    unit: z.enum(['characters', 'words']),
    confidence: FundingConfidenceSchema,
    evidence: z.array(FundingEvidenceLocatorSchema).min(1).max(FUNDING_TEMPLATE_LIMITS.evidencePerAssertion),
  }).nullable(),
  evidence: z.array(FundingEvidenceLocatorSchema).min(1).max(FUNDING_TEMPLATE_LIMITS.evidencePerAssertion),
});

export const FundingFieldMappingSchema = z.strictObject({
  mappingId: FundingTemplateSafeIdSchema,
  slotId: FundingTemplateSafeIdSchema,
  sourceLabel: singleLine(300),
  canonicalField: z.enum([
    'project_name',
    'applicant',
    'organization',
    'discipline',
    'research_basis',
    'research_objectives',
    'research_methods',
    'research_plan',
    'expected_outputs',
    'budget',
    'schedule',
    'references',
    'custom',
  ]),
  confidence: FundingConfidenceSchema,
  evidence: z.array(FundingEvidenceLocatorSchema).min(1).max(FUNDING_TEMPLATE_LIMITS.evidencePerAssertion),
});

export const FundingTypographyRuleSchema = z.strictObject({
  scope: z.enum(['document_body', 'section_heading', 'table']),
  fontFamily: FundingStringAssertionSchema,
  fontSizePt: FundingNumberAssertionSchema,
  fontWeight: FundingStringAssertionSchema,
  alignment: FundingStringAssertionSchema,
  lineSpacingPt: FundingNumberAssertionSchema,
  paragraphBeforePt: FundingNumberAssertionSchema,
  paragraphAfterPt: FundingNumberAssertionSchema,
});

export const FundingTemplatePackageSchema = z.strictObject({
  format: z.literal(FUNDING_TEMPLATE_PACKAGE_FORMAT),
  schemaVersion: z.literal(FUNDING_TEMPLATE_PACKAGE_SCHEMA_VERSION),
  templateId: FundingTemplateSafeIdSchema,
  templateVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: FundingTemplateTimestampSchema,
  analyzerVersion: z.literal('1.0.0'),
  source: z.strictObject({
    authority: z.literal('user_upload'),
    officialCurrency: z.literal('not_asserted'),
    documentId: FundingTemplateSafeIdSchema,
    sourceFormat: z.enum(['pdf', 'docx']),
    sourceDigest: FundingTemplateDigestSchema,
    observationDigest: FundingTemplateDigestSchema,
    pageCount: z.number().int().positive().max(FUNDING_TEMPLATE_LIMITS.pages),
    fundingFamily: FundingFamilyAssertionSchema,
  }),
  sections: z.array(FundingTemplateSectionSchema).max(FUNDING_TEMPLATE_LIMITS.sections),
  instructions: z.array(FundingTemplateInstructionSchema).max(FUNDING_TEMPLATE_LIMITS.instructions),
  tables: z.array(FundingTemplateTableSchema).max(FUNDING_TEMPLATE_LIMITS.tables),
  contentSlots: z.array(FundingContentSlotSchema).max(FUNDING_TEMPLATE_LIMITS.slots),
  fieldMappings: z.array(FundingFieldMappingSchema).max(FUNDING_TEMPLATE_LIMITS.slots),
  typography: z.array(FundingTypographyRuleSchema).max(3),
  layout: z.strictObject({
    pageSizePt: FundingPageSizeAssertionSchema,
    marginsPt: FundingMarginsAssertionSchema,
  }),
  quality: z.strictObject({
    status: z.enum(['ready', 'needs_review']),
    overallConfidence: FundingConfidenceSchema,
    issues: z.array(z.enum([
      'limited_structure',
      'typography_not_observed',
      'margins_not_observed',
      'conflicting_layout_observations',
      'sensitive_content_excluded',
    ])).max(32).refine(unique, { message: 'Quality issues must be unique' }),
  }),
  privacy: z.strictObject({
    rawTextStored: z.literal(false),
    sourceTextRetention: z.literal('none'),
    sensitiveBlocksExcluded: z.number().int().min(0).max(FUNDING_TEMPLATE_LIMITS.blocks),
  }),
  canonicalDigest: FundingTemplateDigestSchema,
}).superRefine((template, context) => {
  const sectionIds = template.sections.map((section) => section.sectionId);
  const slotIds = template.contentSlots.map((slot) => slot.slotId);
  const instructionIds = template.instructions.map((instruction) => instruction.instructionId);
  const tableIds = template.tables.map((table) => table.tableId);
  const mappingIds = template.fieldMappings.map((mapping) => mapping.mappingId);
  for (const [path, identifiers] of [
    ['sections', sectionIds],
    ['contentSlots', slotIds],
    ['instructions', instructionIds],
    ['tables', tableIds],
    ['fieldMappings', mappingIds],
  ] as const) {
    if (!unique(identifiers)) context.addIssue({ code: 'custom', path: [path], message: 'Identifiers must be unique' });
  }
  if (template.sections.some((section, index) => section.order !== index)) {
    context.addIssue({ code: 'custom', path: ['sections'], message: 'Section order must be contiguous' });
  }
  const sectionSet = new Set(sectionIds);
  const slotSet = new Set(slotIds);
  if (template.instructions.some((item) => item.sectionId !== null && !sectionSet.has(item.sectionId))) {
    context.addIssue({ code: 'custom', path: ['instructions'], message: 'Instruction references an unknown section' });
  }
  if (template.tables.some((item) => item.sectionId !== null && !sectionSet.has(item.sectionId))) {
    context.addIssue({ code: 'custom', path: ['tables'], message: 'Table references an unknown section' });
  }
  if (template.contentSlots.some((item) => item.sectionId !== null && !sectionSet.has(item.sectionId))) {
    context.addIssue({ code: 'custom', path: ['contentSlots'], message: 'Content slot references an unknown section' });
  }
  if (template.fieldMappings.some((item) => !slotSet.has(item.slotId))) {
    context.addIssue({ code: 'custom', path: ['fieldMappings'], message: 'Field mapping references an unknown slot' });
  }
});

export const FundingTemplateAnalysisRequestSchema = z.strictObject({
  templateId: FundingTemplateSafeIdSchema,
  templateVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: FundingTemplateTimestampSchema,
  document: FundingTemplateObservationDocumentSchema,
}).superRefine((request, context) => {
  if (request.createdAt < request.document.extractedAt) {
    context.addIssue({ code: 'custom', path: ['createdAt'], message: 'Template creation cannot predate extraction' });
  }
});

export const FundingTemplateAnalysisResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), template: FundingTemplatePackageSchema }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['invalid_input', 'duplicate_section', 'duplicate_field', 'insufficient_template_evidence', 'invalid_package']),
    issues: z.array(singleLine(500)).min(1).max(256),
  }),
]);

export const FundingTemplateDiffSchema = z.strictObject({
  schemaVersion: z.literal(1),
  templateId: FundingTemplateSafeIdSchema,
  fromVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  toVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  fromDigest: FundingTemplateDigestSchema,
  toDigest: FundingTemplateDigestSchema,
  changes: z.array(z.strictObject({
    kind: z.enum(['added', 'removed', 'changed']),
    entity: z.enum(['source', 'section', 'instruction', 'table', 'content_slot', 'field_mapping', 'typography', 'layout', 'quality']),
    key: FundingTemplateSafeIdSchema,
    beforeDigest: FundingTemplateDigestSchema.nullable(),
    afterDigest: FundingTemplateDigestSchema.nullable(),
  })).max(20_000),
  breaking: z.boolean(),
  diffDigest: FundingTemplateDigestSchema,
});

export type FundingTemplateObservationDocument = z.infer<typeof FundingTemplateObservationDocumentSchema>;
export type FundingParagraphObservation = z.infer<typeof FundingParagraphObservationSchema>;
export type FundingTableObservation = z.infer<typeof FundingTableObservationSchema>;
export type FundingStyleObservation = z.infer<typeof FundingStyleObservationSchema>;
export type FundingEvidenceLocator = z.infer<typeof FundingEvidenceLocatorSchema>;
export type FundingTemplatePackage = z.infer<typeof FundingTemplatePackageSchema>;
export type FundingTemplateAnalysisRequest = z.infer<typeof FundingTemplateAnalysisRequestSchema>;
export type FundingTemplateAnalysisResult = z.infer<typeof FundingTemplateAnalysisResultSchema>;
export type FundingTemplateDiff = z.infer<typeof FundingTemplateDiffSchema>;
