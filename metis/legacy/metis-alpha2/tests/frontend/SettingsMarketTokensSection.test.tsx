/**
 * SettingsMarketTokensSection — 市场/集成令牌统一管理测试（任务E）。
 * 覆盖：令牌槽渲染、已配置状态、加密保存（值不回显）、删除。
 *
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('SettingsMarketTokensSection', () => {
  let listPersonalizationSecrets: ReturnType<typeof vi.fn>;
  let setPersonalizationSecret: ReturnType<typeof vi.fn>;
  let removePersonalizationSecret: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listPersonalizationSecrets = vi.fn().mockResolvedValue({
      ok: true,
      revision: 1,
      secrets: [{ name: 'MARKET_GITHUB_TOKEN', createdAt: 1, updatedAt: 2 }],
    });
    setPersonalizationSecret = vi.fn().mockResolvedValue({ ok: true, revision: 2 });
    removePersonalizationSecret = vi.fn().mockResolvedValue({ ok: true, revision: 3 });
    Object.defineProperty(window, 'metis', {
      configurable: true,
      writable: true,
      value: { listPersonalizationSecrets, setPersonalizationSecret, removePersonalizationSecret },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'metis', { configurable: true, writable: true, value: undefined });
  });

  it('渲染四个令牌槽并显示已配置状态', async () => {
    const { default: Section } = await import('../../src/components/SettingsMarketTokensSection.js');
    render(<Section />);
    expect(await screen.findByTestId('market-token-MARKET_GITHUB_TOKEN')).toBeTruthy();
    expect(screen.getByTestId('market-token-MARKET_SKILLHUB_TOKEN')).toBeTruthy();
    expect(screen.getByTestId('market-token-MARKET_MCPMARKET_CN_TOKEN')).toBeTruthy();
    expect(screen.getByTestId('market-token-MARKET_MCPMARKET_COM_TOKEN')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('market-token-state-MARKET_GITHUB_TOKEN').textContent).toBe('已配置'));
    expect(screen.getByTestId('market-token-state-MARKET_SKILLHUB_TOKEN').textContent).toBe('未配置');
  });

  it('每个令牌槽提供可点击的来源网址与是否必须配置说明', async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    Object.assign(window.metis, { openExternal });
    const { default: Section } = await import('../../src/components/SettingsMarketTokensSection.js');
    render(<Section />);
    expect(await screen.findByText('github.com/settings/tokens')).toBeTruthy();
    expect(screen.getByText('skillhub.cn')).toBeTruthy();
    expect(screen.getByText('mcpmarket.cn')).toBeTruthy();
    expect(screen.getByText('mcpmarket.com')).toBeTruthy();
    expect(screen.getByText('非必须：不配置也可用，仅受匿名限额。')).toBeTruthy();
    expect(screen.getByText('无需配置：当前不接入该源。')).toBeTruthy();
    expect(screen.getByText('非必须：搜索/详情无需令牌。')).toBeTruthy();
    expect(screen.getByText('无需配置：当前不可访问。')).toBeTruthy();
    fireEvent.click(screen.getByText('github.com/settings/tokens'));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/settings/tokens');
  });

  it('加密保存令牌：以槽名调用 secret vault 且输入清空', async () => {
    const { default: Section } = await import('../../src/components/SettingsMarketTokensSection.js');
    render(<Section />);
    const input = await screen.findByTestId('market-token-input-MARKET_GITHUB_TOKEN');
    fireEvent.change(input, { target: { value: 'ghp_test123' } });
    fireEvent.click(screen.getByTestId('market-token-save-MARKET_GITHUB_TOKEN'));
    await waitFor(() => expect(setPersonalizationSecret).toHaveBeenCalledTimes(1));
    const request = setPersonalizationSecret.mock.calls[0]![0] as { name: string; value: string; expectedRevision: number };
    expect(request.name).toBe('MARKET_GITHUB_TOKEN');
    expect(request.value).toBe('ghp_test123');
    expect(request.expectedRevision).toBe(1);
    expect((screen.getByTestId('market-token-input-MARKET_GITHUB_TOKEN') as HTMLInputElement).value).toBe('');
  });

  it('删除已配置令牌', async () => {
    const { default: Section } = await import('../../src/components/SettingsMarketTokensSection.js');
    render(<Section />);
    await screen.findByTestId('market-token-remove-MARKET_GITHUB_TOKEN');
    fireEvent.click(screen.getByTestId('market-token-remove-MARKET_GITHUB_TOKEN'));
    await waitFor(() => expect(removePersonalizationSecret).toHaveBeenCalledTimes(1));
    const request = removePersonalizationSecret.mock.calls[0]![0] as { name: string };
    expect(request.name).toBe('MARKET_GITHUB_TOKEN');
  });
});
