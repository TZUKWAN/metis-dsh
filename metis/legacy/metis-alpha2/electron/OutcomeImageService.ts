/** Durable, project-scoped image-generation runtime for Outcomes. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ImageGenerationSettingsSchema,
  ImageGenerationSettingsUpdateSchema,
  OUTCOME_IMAGE_SECRET_REF,
  OutcomeImageGenerateRequestSchema,
  OutcomeImageGenerateResultSchema,
  OutcomeImageSettingsGetResultSchema,
  OutcomeImageSettingsSaveResultSchema,
  type ImageGenerationSettings,
  type OutcomeImageGenerateResult,
  type OutcomeImageSettingsGetResult,
  type OutcomeImageSettingsSaveResult,
} from '../engine/runtime/OutcomeRuntimeContract.js';
import type { OutcomeMediaService } from './OutcomeMediaService.js';
import type { OutcomeRepository } from './OutcomeRepository.js';
import type { PersonalizationSecretVault } from './PersonalizationSecretVault.js';

type SettingsRow = {
  provider: string;
  model: string;
  endpoint: string;
  encrypted_api_key: string;
  default_quality: string;
};

const EMPTY_SETTINGS = Object.freeze({
  provider: '', model: '', endpoint: '', defaultQuality: 'standard' as const, hasApiKey: false,
});
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_PREFIX = Buffer.from([255, 216, 255]);
const MAX_PROVIDER_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_BASE64_CHARS = 20_000_000;

function failure(code: Exclude<OutcomeImageGenerateResult, { ok: true }>['code']): OutcomeImageGenerateResult {
  return OutcomeImageGenerateResultSchema.parse({ ok: false, code });
}

function settingsFailure(code: Exclude<OutcomeImageSettingsSaveResult, { ok: true }>['code']): OutcomeImageSettingsSaveResult {
  return OutcomeImageSettingsSaveResultSchema.parse({ ok: false, code });
}

/**
 * This service intentionally owns no provider credentials.  It keeps only the
 * fixed Secret Vault reference in SQLite and resolves plaintext inside the
 * main process immediately before the provider request.
 */
export class OutcomeImageService {
  constructor(private readonly options: {
    db: Database.Database;
    repository: OutcomeRepository;
    media: OutcomeMediaService;
    secretVault: PersonalizationSecretVault | null;
    /** 内容规范·绘图段（2026-09-01）：按项目解析后注入生成 prompt。 */
    fetchImpl?: typeof fetch;
    now?: () => number;
    /** 成果提示词工程(任务4/5):绘图行为规范 Override。 */
    resolveBehaviorPrompt?: (promptId: string, outcomeId?: string | null) => string | null;
  /** T8：Profile 全局风格段。 */
  getGlobalPrompt?: (officeKind: string, outcomeId: string | null) => string | null;
  }) {}

  getSettings(): OutcomeImageSettingsGetResult {
    try {
      return OutcomeImageSettingsGetResultSchema.parse({ ok: true, settings: this.settingsSnapshot() });
    } catch {
      return OutcomeImageSettingsGetResultSchema.parse({ ok: false, code: 'settings_read_failed' });
    }
  }

  private settingsSnapshot(): ImageGenerationSettings {
    const row = this.readRow();
    if (!row) return ImageGenerationSettingsSchema.parse(EMPTY_SETTINGS);
    const hasApiKey = row?.encrypted_api_key === OUTCOME_IMAGE_SECRET_REF
      && Boolean(this.options.secretVault?.resolve(OUTCOME_IMAGE_SECRET_REF));
    const parsed = ImageGenerationSettingsSchema.safeParse({
      provider: row.provider,
      model: row.model,
      endpoint: row.endpoint,
      defaultQuality: row.default_quality,
      hasApiKey,
    });
    if (!parsed.success) throw new Error('outcome_image_settings_row_invalid');
    return parsed.data;
  }

  saveSettings(raw: unknown): OutcomeImageSettingsSaveResult {
    const parsed = ImageGenerationSettingsUpdateSchema.safeParse(raw);
    if (!parsed.success) return settingsFailure('invalid_request');
    if (parsed.data.apiKeyRef !== null) {
      const vault = this.options.secretVault;
      if (!vault) return settingsFailure('storage_unavailable');
      // list() distinguishes an unavailable/corrupt vault from a valid vault
      // that simply does not contain the required named secret.
      const listed = vault.list({ contractVersion: 1, operationId: randomUUID() });
      if (!listed.ok) return settingsFailure('storage_unavailable');
      if (!vault.resolve(OUTCOME_IMAGE_SECRET_REF)) return settingsFailure('secret_not_found');
    }
    try {
      this.options.db.prepare('INSERT INTO image_generation_settings (id,provider,model,endpoint,encrypted_api_key,default_quality,updated_at) VALUES (1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,model=excluded.model,endpoint=excluded.endpoint,encrypted_api_key=excluded.encrypted_api_key,default_quality=excluded.default_quality,updated_at=excluded.updated_at')
        .run(parsed.data.provider, parsed.data.model, parsed.data.endpoint, parsed.data.apiKeyRef ?? '', parsed.data.defaultQuality, (this.options.now ?? Date.now)());
      return OutcomeImageSettingsSaveResultSchema.parse({ ok: true, settings: this.settingsSnapshot() });
    } catch {
      return settingsFailure('settings_write_failed');
    }
  }

  async generate(raw: unknown): Promise<OutcomeImageGenerateResult> {
    const parsed = OutcomeImageGenerateRequestSchema.safeParse(raw);
    if (!parsed.success) return failure('invalid_request');
    const request = parsed.data;
    try {
      if (!this.options.repository.get(request.projectId, request.outcomeId)) return failure('outcome_not_found');
    } catch {
      return failure('outcome_not_found');
    }
    const row = this.readRow();
    const apiKey = row?.encrypted_api_key === OUTCOME_IMAGE_SECRET_REF
      ? this.options.secretVault?.resolve(OUTCOME_IMAGE_SECRET_REF)
      : undefined;
    if (!row?.provider || !row.model || !row.endpoint || !apiKey) return failure('image_generation_unconfigured');

    const userPrompt = request.visualContext
      ? `${request.prompt}\nVisual context: ${request.visualContext}`
      : request.prompt;
    // 成果提示词工程(任务4):科研绘图行为规范前置(Override;空=不附加,与升级前行为一致)。
    const figureBehavior = this.options.resolveBehaviorPrompt?.('image.generation') ?? null;
    const globalStylePrompt = this.options.getGlobalPrompt?.('image', null) ?? null;
    const prompt = figureBehavior && figureBehavior.trim()
      ? `${figureBehavior.trim()}\n\n${userPrompt}`
      : userPrompt;
    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      response = await (this.options.fetchImpl ?? fetch)(row.endpoint, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: row.model, prompt, quality: request.quality ?? row.default_quality, response_format: 'b64_json' }),
      });
    } catch {
      return failure('image_generation_provider_failed');
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return failure('image_generation_provider_http_error');

    let encoded: unknown;
    try {
      const payload = await response.json() as { data?: Array<{ b64_json?: unknown }> };
      encoded = payload.data?.[0]?.b64_json;
    } catch {
      return failure('image_generation_provider_response_invalid');
    }
    if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > MAX_BASE64_CHARS || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
      return failure('image_generation_provider_response_invalid');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_PROVIDER_IMAGE_BYTES || bytes.toString('base64') !== encoded) {
      return failure('image_generation_provider_response_invalid');
    }
    const mimeType = bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
      ? 'image/png' as const
      : bytes.subarray(0, JPEG_PREFIX.length).equals(JPEG_PREFIX)
        ? 'image/jpeg' as const
        : null;
    if (!mimeType) return failure('image_generation_provider_response_invalid');

    try {
      const extension = mimeType === 'image/png' ? 'png' : 'jpg';
      const media = await this.options.media.persistGenerated(
        request.projectId,
        request.outcomeId,
        bytes,
        mimeType,
        `AI-generated-${(this.options.now ?? Date.now)()}-${randomUUID()}.${extension}`,
      );
      return media
        ? OutcomeImageGenerateResultSchema.parse({ ok: true, media, mimeType })
        : failure('image_generation_media_persist_failed');
    } catch {
      return failure('image_generation_media_persist_failed');
    }
  }

  private readRow(): SettingsRow | undefined {
    return this.options.db.prepare('SELECT provider,model,endpoint,encrypted_api_key,default_quality FROM image_generation_settings WHERE id=1').get() as SettingsRow | undefined;
  }
}
