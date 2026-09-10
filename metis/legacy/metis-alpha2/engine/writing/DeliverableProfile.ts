import { z } from 'zod';

export const DeliverableProfileIdSchema = z.enum([
  'core_cn',
  'sci',
  'domestic_thesis',
  'overseas_thesis',
  'research_report',
]);

export const AcademicCitationStyleSchema = z.enum([
  'gbt7714',
  'apa',
  'chicago',
  'ieee',
  'vancouver',
]);

export const DeliverableApprovalStageSchema = z.enum([
  'outline',
  'sources',
  'draft',
  'citation_audit',
  'format_preview',
  'release',
]);

const RuleOwnerSchema = z.strictObject({
  required: z.boolean(),
  ruleSourceRequired: z.literal(true),
  expiresAfterDays: z.number().int().positive().max(366),
});

export const DeliverableProfileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profileVersion: z.string().regex(/^1\.\d+\.\d+$/u),
  id: DeliverableProfileIdSchema,
  displayName: z.strictObject({ zh: z.string().min(1), en: z.string().min(1) }),
  venue: RuleOwnerSchema,
  school: RuleOwnerSchema,
  template: z.strictObject({
    required: z.literal(true),
    sourceRequired: z.literal(true),
    templateIds: z.array(z.string().min(1)).min(1),
    acceptedFormats: z.array(z.enum(['latex', 'docx', 'markdown'])).min(1),
  }),
  structure: z.strictObject({
    requiredSections: z.array(z.string().min(1)).min(1),
    allowCustomSections: z.boolean(),
  }),
  citation: z.strictObject({
    defaultStyle: AcademicCitationStyleSchema,
    allowedStyles: z.array(AcademicCitationStyleSchema).min(1),
    requireStructuredAst: z.boolean(),
    requireLocator: z.boolean(),
    requireTriangulation: z.boolean(),
    requirePassport: z.boolean(),
    rejectRetracted: z.boolean(),
    requireJournalIntegrity: z.boolean(),
  }),
  source: z.strictObject({
    requiredKinds: z.array(z.enum([
      'peer_reviewed', 'primary', 'policy', 'news', 'statistics', 'archive', 'dataset',
    ])).min(1),
    minimumIndependentSources: z.number().int().positive().max(100),
    requireStableIdentifier: z.boolean(),
    freshnessDays: z.number().int().positive().max(3650).nullable(),
  }),
  approval: z.strictObject({
    requiredStages: z.array(DeliverableApprovalStageSchema).min(1),
    releaseRequiresHuman: z.literal(true),
  }),
}).superRefine((profile, context) => {
  const requiredTruthFlags = [
    'requireStructuredAst',
    'requireLocator',
    'requireTriangulation',
    'requirePassport',
    'rejectRetracted',
    'requireJournalIntegrity',
  ] as const;
  for (const flag of requiredTruthFlags) {
    if (!profile.citation[flag]) {
      context.addIssue({
        code: 'custom',
        message: `Citation truth invariant ${flag} cannot be disabled`,
        path: ['citation', flag],
      });
    }
  }
  if (!profile.citation.allowedStyles.includes(profile.citation.defaultStyle)) {
    context.addIssue({
      code: 'custom',
      message: 'Default citation style must be allowed by the profile',
      path: ['citation', 'defaultStyle'],
    });
  }
});

export type DeliverableProfileId = z.infer<typeof DeliverableProfileIdSchema>;
export type AcademicCitationStyle = z.infer<typeof AcademicCitationStyleSchema>;
export type DeliverableProfile = z.infer<typeof DeliverableProfileSchema>;

export const DeliverableProfileBindingSchema = z.strictObject({
  id: DeliverableProfileIdSchema,
  schemaVersion: z.literal(1),
  profileVersion: z.string().regex(/^1\.\d+\.\d+$/u),
});

export type DeliverableProfileBinding = z.infer<typeof DeliverableProfileBindingSchema>;

const common: Pick<DeliverableProfile, 'schemaVersion' | 'profileVersion' | 'approval'> = {
  schemaVersion: 1,
  profileVersion: '1.0.0',
  approval: {
    requiredStages: ['outline', 'sources', 'draft', 'citation_audit', 'format_preview', 'release'],
    releaseRequiresHuman: true,
  },
};

const citationTruth = {
  requireStructuredAst: true,
  requireLocator: true,
  requireTriangulation: true,
  requirePassport: true,
  rejectRetracted: true,
  requireJournalIntegrity: true,
};

function owner(required: boolean) {
  return { required, ruleSourceRequired: true as const, expiresAfterDays: 180 };
}

function template(templateIds: string[]): DeliverableProfile['template'] {
  return {
    required: true,
    sourceRequired: true,
    templateIds,
    acceptedFormats: ['latex', 'docx', 'markdown'],
  };
}

const profiles: DeliverableProfile[] = [
  {
    ...common,
    id: 'core_cn',
    displayName: { zh: '中文核心期刊论文', en: 'Chinese core-journal article' },
    venue: owner(true),
    school: owner(false),
    template: template(['core-cn-journal-venue-template']),
    structure: { requiredSections: ['摘要', '关键词', '正文', '参考文献'], allowCustomSections: true },
    citation: { defaultStyle: 'gbt7714', allowedStyles: ['gbt7714'], ...citationTruth },
    source: { requiredKinds: ['peer_reviewed', 'primary'], minimumIndependentSources: 2, requireStableIdentifier: true, freshnessDays: null },
  },
  {
    ...common,
    id: 'sci',
    displayName: { zh: 'SCI 期刊论文', en: 'SCI journal article' },
    venue: owner(true),
    school: owner(false),
    template: template(['sci-journal-author-guidelines']),
    structure: { requiredSections: ['Abstract', 'Introduction', 'Methods', 'Results', 'Discussion', 'References'], allowCustomSections: true },
    citation: { defaultStyle: 'apa', allowedStyles: ['apa', 'chicago', 'ieee', 'vancouver'], ...citationTruth },
    source: { requiredKinds: ['peer_reviewed', 'primary', 'dataset'], minimumIndependentSources: 2, requireStableIdentifier: true, freshnessDays: null },
  },
  {
    ...common,
    id: 'domestic_thesis',
    displayName: { zh: '国内硕博学位论文', en: 'Domestic graduate thesis' },
    venue: owner(false),
    school: owner(true),
    template: template(['domestic-thesis-school-template']),
    structure: { requiredSections: ['摘要', 'Abstract', '目录', '绪论', '正文', '结论', '参考文献'], allowCustomSections: true },
    citation: { defaultStyle: 'gbt7714', allowedStyles: ['gbt7714'], ...citationTruth },
    source: { requiredKinds: ['peer_reviewed', 'primary'], minimumIndependentSources: 2, requireStableIdentifier: true, freshnessDays: null },
  },
  {
    ...common,
    id: 'overseas_thesis',
    displayName: { zh: '海外硕博学位论文', en: 'Overseas graduate thesis' },
    venue: owner(false),
    school: owner(true),
    template: template(['overseas-thesis-school-template']),
    structure: { requiredSections: ['Abstract', 'Contents', 'Introduction', 'Chapters', 'Conclusion', 'References'], allowCustomSections: true },
    citation: { defaultStyle: 'apa', allowedStyles: ['apa', 'chicago', 'ieee', 'vancouver'], ...citationTruth },
    source: { requiredKinds: ['peer_reviewed', 'primary'], minimumIndependentSources: 2, requireStableIdentifier: true, freshnessDays: null },
  },
  {
    ...common,
    id: 'research_report',
    displayName: { zh: '研究报告', en: 'Research report' },
    venue: owner(true),
    school: owner(false),
    template: template(['research-report-institution-template']),
    structure: { requiredSections: ['执行摘要', '研究问题', '方法', '发现', '建议', '来源与附录'], allowCustomSections: true },
    citation: { defaultStyle: 'gbt7714', allowedStyles: ['gbt7714', 'apa', 'chicago', 'ieee', 'vancouver'], ...citationTruth },
    source: { requiredKinds: ['primary', 'policy', 'news', 'statistics', 'dataset'], minimumIndependentSources: 2, requireStableIdentifier: true, freshnessDays: 30 },
  },
];

export const BUILTIN_DELIVERABLE_PROFILES: readonly DeliverableProfile[] = Object.freeze(
  profiles.map((profile) => Object.freeze(DeliverableProfileSchema.parse(profile))),
);

export function getDeliverableProfile(id: DeliverableProfileId): DeliverableProfile | undefined {
  return BUILTIN_DELIVERABLE_PROFILES.find((profile) => profile.id === id);
}

export function bindDeliverableProfile(id: DeliverableProfileId): DeliverableProfileBinding {
  const profile = getDeliverableProfile(id);
  if (!profile) throw new Error(`Unknown deliverable profile: ${id}`);
  return { id: profile.id, schemaVersion: profile.schemaVersion, profileVersion: profile.profileVersion };
}
