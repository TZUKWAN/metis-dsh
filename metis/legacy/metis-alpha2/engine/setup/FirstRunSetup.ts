/**
 * First-Run Setup state machine (METIS-301).
 *
 * Reduces first-run configuration to exactly THREE user inputs: API base URL, API key,
 * model name. Everything else gets a sensible default. The flow is a single wizard page:
 *   open app → (if not configured) show 3-field form → save → enter research desktop.
 *
 * This module is the pure logic (defaults, validation, secure-storage check). The UI
 * component (ApiSetupWizard) is wired into the App shell in METIS-501. Tested here without
 * any Electron dependency.
 *
 * Security (task list METIS-301): the API key MUST only be stored via the system secure
 * storage (Electron safeStorage). `assertSecureStorageAvailable` is the gate — if the key
 * cannot be stored securely, the wizard must not proceed to "save".
 */

export interface FirstRunInput {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface FirstRunDefaults {
  baseUrl: string;
  model: string;
}

/** Reasonable defaults so the user only types what they must. */
export const FIRST_RUN_DEFAULTS: FirstRunDefaults = {
  // OpenAI-compatible default; user overrides for GLM/other providers.
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
};

export type SetupStep = 'not_started' | 'awaiting_input' | 'validating' | 'saving' | 'secured' | 'done' | 'error';

export interface SetupState {
  step: SetupStep;
  input: FirstRunInput;
  defaultsApplied: boolean;
  error?: string;
}

export function initialSetupState(): SetupState {
  return {
    step: 'awaiting_input',
    input: { baseUrl: FIRST_RUN_DEFAULTS.baseUrl, apiKey: '', model: FIRST_RUN_DEFAULTS.model },
    defaultsApplied: true,
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate the three inputs before attempting to save. */
export function validateFirstRunInput(input: FirstRunInput): ValidationResult {
  const errors: string[] = [];
  if (!input.baseUrl || input.baseUrl.trim().length === 0) {
    errors.push('API 地址不能为空');
  } else {
    try {
      const u = new URL(input.baseUrl.trim());
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        errors.push('API 地址必须以 http:// 或 https:// 开头');
      }
    } catch {
      errors.push('API 地址格式不正确');
    }
  }
  if (!input.apiKey || input.apiKey.trim().length < 8) {
    errors.push('API 密钥过短（至少 8 个字符）');
  }
  if (!input.model || input.model.trim().length === 0) {
    errors.push('模型名称不能为空');
  }
  return { valid: errors.length === 0, errors };
}

/** Secure-storage availability check interface (injected so tests run offline). */
export interface SecureStorageProbe {
  isAvailable(): boolean;
}

/**
 * Assert that the API key can be stored securely. The wizard MUST NOT offer "save" when
 * this returns false — instead it surfaces a clear error (METIS-301 completion: "secrets
 * only stored in system secure storage").
 */
export function assertSecureStorageAvailable(probe: SecureStorageProbe): { ok: boolean; error?: string } {
  if (!probe.isAvailable()) {
    return {
      ok: false,
      error: '系统安全存储不可用。Metis 不会以明文保存 API 密钥。请在系统设置中启用加密后重试。',
    };
  }
  return { ok: true };
}

/**
 * Full first-run save flow. Returns the final state and, on success, the validated config.
 * Network/provider validation is deferred to METIS-302 (capability probe) — this step only
 * ensures the three inputs are present, well-formed, and the key can be secured.
 */
export interface FirstRunOutcome {
  step: SetupStep;
  error?: string;
  config?: FirstRunInput;
}

export function attemptFirstRunSave(
  input: FirstRunInput,
  probe: SecureStorageProbe,
): FirstRunOutcome {
  const validation = validateFirstRunInput(input);
  if (!validation.valid) {
    return { step: 'error', error: validation.errors.join('；') };
  }
  const storage = assertSecureStorageAvailable(probe);
  if (!storage.ok) {
    return { step: 'error', error: storage.error };
  }
  return { step: 'done', config: input };
}
