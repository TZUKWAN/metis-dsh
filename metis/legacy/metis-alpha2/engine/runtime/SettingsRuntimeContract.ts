import { z } from 'zod';

export const ThemeModeSchema = z.enum(['light', 'dark', 'system']);
export type ThemeMode = z.infer<typeof ThemeModeSchema>;

export const AccentThemeSchema = z.enum(['gold', 'blue', 'green', 'gray']);
export type AccentTheme = z.infer<typeof AccentThemeSchema>;

/** Free-form accent: any #RRGGBB hex, applied globally with derived hover/soft/focus tokens. */
export const CustomAccentSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const AccentSettingSchema = z.union([AccentThemeSchema, CustomAccentSchema]);
export type AccentSetting = z.infer<typeof AccentSettingSchema>;

const SafeProviderLabelSchema = z.string()
  .trim()
  .min(1)
  .max(2_048)
// eslint-disable-next-line no-control-regex
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: 'Provider label contains unsafe control characters',
  });

export const SettingsViewSchema = z.strictObject({
  configured: z.boolean(),
  baseUrl: SafeProviderLabelSchema.optional(),
  model: SafeProviderLabelSchema.optional(),
  hasApiKey: z.boolean(),
  needsReauth: z.boolean(),
  theme: ThemeModeSchema,
  /** Accent color theme. Defaults to blue (the original ink-navy look). */
  accent: AccentSettingSchema.default('blue'),
  providerVision: z.boolean().default(false),
  providerMaxContextTokens: z.number().int().min(0).default(0),
  /**
   * The user explicitly chose 「稍后配置」 in the first-run wizard. Persisted
   * so the wizard does not reappear on every launch; research execution stays
   * provider-gated regardless — this only skips the setup PROMPT.
   */
  setupSkipped: z.boolean().default(false),
});
export type SettingsView = z.infer<typeof SettingsViewSchema>;

export const SettingsUpdateRequestSchema = z.strictObject({
  /** Optional so accent-only (or vision-only) updates stay valid. */
  theme: ThemeModeSchema.optional(),
  accent: AccentSettingSchema.optional(),
  /** METIS-WX-2: whether the configured model accepts inline images. */
  providerVision: z.boolean().optional(),
  /** User-declared max context tokens (0 = auto-detect from model name). */
  providerMaxContextTokens: z.number().int().min(0).max(2_000_000).optional(),
});
export type SettingsUpdateRequest = z.infer<typeof SettingsUpdateRequestSchema>;

export const SettingsMutationResultSchema = z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), code: z.literal('settings_saved') }),
  z.strictObject({
    success: z.literal(false),
    code: z.enum(['settings_update_unavailable', 'secure_setup_required']),
  }),
]);
export type SettingsMutationResult = z.infer<typeof SettingsMutationResultSchema>;

export function createSettingsViewRecovery(): SettingsView {
  return {
    configured: false,
    hasApiKey: false,
    needsReauth: false,
    theme: 'light',
    accent: 'blue',
    providerVision: false,
    providerMaxContextTokens: 0,
    setupSkipped: false,
  };
}

export function decodeSettingsView(input: unknown): SettingsView {
  const parsed = SettingsViewSchema.safeParse(input);
  return parsed.success ? parsed.data : createSettingsViewRecovery();
}

export function decodeSettingsUpdateRequest(input: unknown): SettingsUpdateRequest | undefined {
  const parsed = SettingsUpdateRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export function createSettingsMutationFailure(
  code: 'settings_update_unavailable' | 'secure_setup_required' = 'settings_update_unavailable',
): SettingsMutationResult {
  return { success: false, code };
}

export function decodeSettingsMutationResult(input: unknown): SettingsMutationResult {
  const parsed = SettingsMutationResultSchema.safeParse(input);
  return parsed.success ? parsed.data : createSettingsMutationFailure();
}
