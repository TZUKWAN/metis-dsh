// @vitest-environment jsdom
/**
 * METIS-WX-1 — WeChat Bot settings section UI tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SettingsWeChatBotSection from '../../src/components/SettingsWeChatBotSection';

const UNBOUND_STATUS = {
  phase: 'unbound', botId: '', userId: '', activeProjectId: '', activeSessionId: '',
  boundAt: 0, busy: false, lastError: '', lastInboundAt: '', qrContent: '', menuWaiting: false, recentLog: [],
};

const BOUND_STATUS = {
  phase: 'bound', botId: 'bot-1', userId: 'wx-user-1', activeProjectId: 'proj-a', activeSessionId: 'wx:wx-user-1:1',
  boundAt: 1000, busy: false, lastError: '', lastInboundAt: '2026-08-03T00:00:00Z', qrContent: '', menuWaiting: false,
  recentLog: [
    { at: '2026-08-03T00:00:00Z', direction: 'in', text: '帮我分析 RAG' },
    { at: '2026-08-03T00:00:01Z', direction: 'out', text: '已完成分析…' },
  ],
};

function mockMetis(overrides: Record<string, unknown> = {}) {
  const metis = {
    wechatGetStatus: vi.fn(async () => ({ ok: true, status: UNBOUND_STATUS })),
    wechatBeginLogin: vi.fn(async () => ({ ok: true, qrContent: 'https://weixin.qq.com/qr/1' })),
    wechatPollLogin: vi.fn(async () => ({ phase: 'login_pending', ok: false })),
    wechatSubmitVerifyCode: vi.fn(async () => ({ ok: true })),
    wechatLogout: vi.fn(async () => ({ ok: true })),
    wechatSendTest: vi.fn(async () => ({ ok: true })),
    wechatSetProject: vi.fn(async () => ({ ok: true })),
    listProjects: vi.fn(async () => ({ success: true, projects: [{ id: 'proj-a', title: 'RAG 调研' }] })),
    ...overrides,
  };
  (window as unknown as { metis: unknown }).metis = metis;
  return metis;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).metis;
});

describe('SettingsWeChatBotSection', () => {
  it('offers QR binding when unbound and advances through the login flow', async () => {
    let phase = 'unbound';
    let qrContent = '';
    const metis = mockMetis({
      wechatGetStatus: vi.fn(async () => ({ ok: true, status: { ...UNBOUND_STATUS, phase, qrContent } })),
      wechatBeginLogin: vi.fn(async () => {
        phase = 'login_pending';
        qrContent = 'https://weixin.qq.com/qr/1';
        return { ok: true, qrContent };
      }),
    });
    render(<SettingsWeChatBotSection />);

    await waitFor(() => expect(metis.wechatGetStatus).toHaveBeenCalled());
    const bindButton = screen.getByTestId('wechat-begin-login');
    fireEvent.click(bindButton);

    await waitFor(() => {
      expect(metis.wechatBeginLogin).toHaveBeenCalled();
      // QR payload is rendered for scanning.
      expect(screen.getByTestId('wechat-qr')).toBeDefined();
      expect(screen.getByText(/请用手机微信扫描二维码/)).toBeDefined();
    });
  });

  it('shows the scan confirmation phase', async () => {
    mockMetis({
      wechatGetStatus: vi.fn(async () => ({ ok: true, status: { ...UNBOUND_STATUS, phase: 'login_scaned', qrContent: 'qr' } })),
    });
    render(<SettingsWeChatBotSection />);

    await waitFor(() => {
      expect(screen.getByText(/已扫描/)).toBeDefined();
    });
  });

  it('asks for a verification code when the gateway requires one', async () => {
    const metis = mockMetis({
      wechatGetStatus: vi.fn(async () => ({ ok: true, status: { ...UNBOUND_STATUS, phase: 'need_verifycode', qrContent: 'qr' } })),
    });
    render(<SettingsWeChatBotSection />);

    await waitFor(() => expect(screen.getByTestId('wechat-verify-code')).toBeDefined());
    fireEvent.change(screen.getByTestId('wechat-verify-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('wechat-verify-submit'));
    await waitFor(() => {
      expect(metis.wechatSubmitVerifyCode).toHaveBeenCalledWith('123456');
    });
  });

  it('shows bound state with project binding, test send and activity log', async () => {
    const metis = mockMetis({
      wechatGetStatus: vi.fn(async () => ({ ok: true, status: BOUND_STATUS })),
    });
    render(<SettingsWeChatBotSection />);

    await waitFor(() => expect(screen.getByTestId('wechat-bound-area')).toBeDefined());
    expect(screen.getByText(/已连接/)).toBeDefined();
    expect(screen.getByText(/wx-user-1/)).toBeDefined();

    // Project dropdown reflects the bound project.
    const select = screen.getByTestId('wechat-project-select') as HTMLSelectElement;
    expect(select.value).toBe('proj-a');

    // Test message flows through the full agent path.
    fireEvent.change(screen.getByTestId('wechat-test-input'), { target: { value: '测试一下' } });
    fireEvent.click(screen.getByTestId('wechat-test-send'));
    await waitFor(() => {
      expect(metis.wechatSendTest).toHaveBeenCalledWith('测试一下');
      expect(screen.getByText(/已处理并回复/)).toBeDefined();
    });

    // Activity log lists inbound/outbound entries.
    expect(screen.getByText(/帮我分析 RAG/)).toBeDefined();
    expect(screen.getByText(/已完成分析/)).toBeDefined();
  });

  it('unbinds and returns to the login state', async () => {
    const metis = mockMetis({
      wechatGetStatus: vi.fn(async () => ({ ok: true, status: BOUND_STATUS })),
    });
    render(<SettingsWeChatBotSection />);

    await waitFor(() => expect(screen.getByTestId('wechat-bound-area')).toBeDefined());
    fireEvent.click(screen.getByTestId('wechat-logout'));
    await waitFor(() => {
      expect(metis.wechatLogout).toHaveBeenCalled();
      expect(screen.getByText(/已解绑/)).toBeDefined();
    });
  });
});
