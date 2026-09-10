/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settingsWithoutKey = {
  provider: 'openai',
  model: 'gpt-image-1',
  endpoint: 'https://api.example.test/v1/images/generations',
  defaultQuality: 'high' as const,
  hasApiKey: false,
};

const settingsWithKey = { ...settingsWithoutKey, hasApiKey: true };

describe('SettingsImageGenerationSection', () => {
  let getOutcomeImageSettings: ReturnType<typeof vi.fn>;
  let setOutcomeImageSettings: ReturnType<typeof vi.fn>;
  let listPersonalizationSecrets: ReturnType<typeof vi.fn>;
  let setPersonalizationSecret: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getOutcomeImageSettings = vi.fn().mockResolvedValue({ ok: true, settings: settingsWithoutKey });
    setOutcomeImageSettings = vi.fn().mockResolvedValue({ ok: true, settings: settingsWithKey });
    listPersonalizationSecrets = vi.fn().mockResolvedValue({ ok: true, revision: 7, secrets: [] });
    setPersonalizationSecret = vi.fn().mockResolvedValue({ ok: true, revision: 8 });
    Object.defineProperty(window, 'metis', {
      configurable: true,
      writable: true,
      value: { getOutcomeImageSettings, setOutcomeImageSettings, listPersonalizationSecrets, setPersonalizationSecret },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'metis', { configurable: true, writable: true, value: undefined });
  });

  it('reads real settings and only reports configured when the returned settings and vault metadata agree', async () => {
    listPersonalizationSecrets.mockResolvedValueOnce({
      ok: true,
      revision: 7,
      secrets: [{ name: 'OUTCOME_IMAGE_API_KEY', createdAt: 1, updatedAt: 2 }],
    });
    getOutcomeImageSettings.mockResolvedValueOnce({ ok: true, settings: settingsWithKey });
    const { default: Section } = await import('../../src/components/SettingsImageGenerationSection.js');
    render(<Section />);

    expect((await screen.findByTestId('image-generation-settings-state')).textContent).toBe('已配置');
    expect(getOutcomeImageSettings).toHaveBeenCalledTimes(1);
    expect(listPersonalizationSecrets).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId('image-generation-provider') as HTMLInputElement).value).toBe('openai');
    expect((screen.getByTestId('image-generation-model') as HTMLInputElement).value).toBe('gpt-image-1');
    const key = screen.getByTestId('image-generation-api-key') as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(key.value).toBe('');
    expect(screen.getByText(/原值不会显示/u)).toBeTruthy();
  });

  it('stores a replacement key in the existing vault before persisting only its secret reference', async () => {
    const { default: Section } = await import('../../src/components/SettingsImageGenerationSection.js');
    render(<Section />);
    await screen.findByTestId('image-generation-save');
    fireEvent.change(screen.getByTestId('image-generation-provider'), { target: { value: 'custom-image' } });
    fireEvent.change(screen.getByTestId('image-generation-api-key'), { target: { value: 'image-secret-value' } });
    fireEvent.click(screen.getByTestId('image-generation-save'));

    await waitFor(() => expect(setPersonalizationSecret).toHaveBeenCalledTimes(1));
    expect(setPersonalizationSecret).toHaveBeenCalledWith(expect.objectContaining({
      contractVersion: 1,
      expectedRevision: 7,
      name: 'OUTCOME_IMAGE_API_KEY',
      value: 'image-secret-value',
    }));
    await waitFor(() => expect(setOutcomeImageSettings).toHaveBeenCalledWith({
      provider: 'custom-image',
      model: 'gpt-image-1',
      endpoint: 'https://api.example.test/v1/images/generations',
      defaultQuality: 'high',
      apiKeyRef: '${secret:OUTCOME_IMAGE_API_KEY}',
    }));
    expect((screen.getByTestId('image-generation-api-key') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('image-generation-settings-notice').textContent).toContain('未执行外部 Provider 连通性测试');
  });

  it('does not claim a settings save succeeded when the settings ABI returns an error', async () => {
    setOutcomeImageSettings.mockResolvedValueOnce({ ok: false, code: 'settings_write_failed' });
    const { default: Section } = await import('../../src/components/SettingsImageGenerationSection.js');
    render(<Section />);
    await screen.findByTestId('image-generation-save');
    fireEvent.click(screen.getByTestId('image-generation-save'));

    await waitFor(() => expect(setOutcomeImageSettings).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('image-generation-settings-notice').textContent).toContain('图片生成设置写入失败，未保存');
    expect(screen.queryByText('成果图片生成配置已保存。未执行外部 Provider 连通性测试。')).toBeNull();
  });

  it('reports an unavailable bridge without treating it as an unconfigured provider', async () => {
    Object.defineProperty(window, 'metis', { configurable: true, writable: true, value: undefined });
    const { default: Section } = await import('../../src/components/SettingsImageGenerationSection.js');
    render(<Section />);

    expect((await screen.findByTestId('image-generation-settings-state')).textContent).toBe('状态不可用');
    expect(screen.getByTestId('image-generation-settings-notice').textContent).toContain('没有读取或保存任何配置');
    expect((screen.getByTestId('image-generation-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a real settings-read failure as unavailable rather than manufacturing an unconfigured state', async () => {
    getOutcomeImageSettings.mockResolvedValueOnce({ ok: false, code: 'settings_read_failed' });
    const { default: Section } = await import('../../src/components/SettingsImageGenerationSection.js');
    render(<Section />);

    expect((await screen.findByTestId('image-generation-settings-state')).textContent).toBe('状态不可用');
    expect(screen.getByTestId('image-generation-settings-notice').textContent).toContain('settings_read_failed');
    expect((screen.getByTestId('image-generation-save') as HTMLButtonElement).disabled).toBe(true);
  });
});
