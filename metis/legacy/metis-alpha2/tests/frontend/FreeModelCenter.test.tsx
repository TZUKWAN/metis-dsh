/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 免费模型中心（2026-08-23 刘总需求）：安全声明常驻、四区块渲染、
// 扫描/接入/删除/停用走真实桥接调用。

const bridgeApi = {
  freeModelListSources: vi.fn().mockResolvedValue([
    { id: 'src-or', kind: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', enabled: true, hasKey: false },
    { id: 'src-relay', kind: 'newapi', name: '示例中转站', baseUrl: 'https://relay.example/v1', enabled: true, hasKey: true },
  ]),
  freeModelAddSource: vi.fn().mockResolvedValue({ ok: true, id: 'src-new' }),
  freeModelRemoveSource: vi.fn().mockResolvedValue(true),
  freeModelScan: vi.fn().mockResolvedValue({ count: 42 }),
  freeModelListDiscoveries: vi.fn().mockResolvedValue([
    { key: 'src-or|free-model-a', sourceName: 'OpenRouter', sourceKind: 'openrouter', modelId: 'vendor/free-model-a', freeTierNote: 'free tier', latencyMs: 820, probeOk: true, probedAt: 1, discoveredAt: 1, attachedProfileId: null, quotaState: null },
    { key: 'src-or|attached-model', sourceName: 'OpenRouter', sourceKind: 'openrouter', modelId: 'vendor/attached-model', freeTierNote: 'free tier', latencyMs: null, probeOk: null, probedAt: null, discoveredAt: 1, attachedProfileId: 'prof-1', quotaState: 'normal' },
  ]),
  freeModelListAttached: vi.fn().mockResolvedValue([
    { profileId: 'prof-1', discoveryKey: 'src-or|attached-model', sourceName: 'OpenRouter', modelId: 'vendor/attached-model', attachedAt: 1, disabled: false, todayUsedCount: 3, lastUsedAt: null, quotaState: 'normal' },
  ]),
  freeModelAttach: vi.fn().mockResolvedValue({ ok: true, profileId: 'prof-2' }),
  freeModelDetach: vi.fn().mockResolvedValue({ removedAttachment: true, deletedProfile: true }),
  freeModelSetDisabled: vi.fn().mockResolvedValue(true),
  mailboxList: vi.fn().mockResolvedValue([
    { id: 'mb-1', label: 'QQ 邮箱-pool1', user: 'pool1@qq.com', host: 'imap.qq.com', createdAt: 1, lastCheckedAt: 2, lastOkAt: 2, healthy: true },
  ]),
  mailboxAdd: vi.fn().mockResolvedValue({ ok: true, code: '' }),
  mailboxRemove: vi.fn().mockResolvedValue(true),
  mailboxTestFetch: vi.fn().mockResolvedValue({ ok: true, mails: [{ from: 'noreply@x', subject: '验证码 123456', date: 1, codes: ['123456'], links: [] }] }),
};

describe('FreeModelCenter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { metis: unknown }).metis = bridgeApi;
  });

  it('renders the security notice permanently and lists all four sections', async () => {
    const { default: FreeModelCenter } = await import('../../src/personalization/FreeModelCenter.js');
    render(<FreeModelCenter zh={true} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/安全风险声明/u)).toBeTruthy();
    expect(screen.getByText(/不推荐使用陌生中转站/u)).toBeTruthy();
    expect(await screen.findByText('注册邮箱池')).toBeTruthy();
    expect(screen.getByText(/发现列表（每日自动扫描）/u)).toBeTruthy();
    expect(screen.getByText('已配置模型')).toBeTruthy();
    expect(screen.getByText('扫描源')).toBeTruthy();
    // 邮箱池显示绑定项
    expect(await screen.findByText('QQ 邮箱-pool1')).toBeTruthy();
  });

  it('runs a scan through the real bridge and shows the candidate count', async () => {
    const { default: FreeModelCenter } = await import('../../src/personalization/FreeModelCenter.js');
    render(<FreeModelCenter zh={true} />);
    const scanButton = await screen.findByRole('button', { name: /立即扫描/u });
    fireEvent.click(scanButton);
    await waitFor(() => expect(bridgeApi.freeModelScan).toHaveBeenCalledWith(true));
    expect(await screen.findByText(/发现 42 个免费模型候选/u)).toBeTruthy();
  });

  it('attaches a discovered model through the bridge', async () => {
    const { default: FreeModelCenter } = await import('../../src/personalization/FreeModelCenter.js');
    render(<FreeModelCenter zh={true} />);
    const attachButtons = await screen.findAllByRole('button', { name: /接入/u });
    fireEvent.click(attachButtons[0]!);
    await waitFor(() => expect(bridgeApi.freeModelAttach).toHaveBeenCalled());
  });

  it('deletes an attached model with one click', async () => {
    const { default: FreeModelCenter } = await import('../../src/personalization/FreeModelCenter.js');
    render(<FreeModelCenter zh={true} />);
    const removeButton = await screen.findByRole('button', { name: '删除 vendor/attached-model' });
    fireEvent.click(removeButton);
    await waitFor(() => expect(bridgeApi.freeModelDetach).toHaveBeenCalledWith('prof-1'));
  });

  it('adds a mailbox into the pool with kind preset applied', async () => {
    const { default: FreeModelCenter } = await import('../../src/personalization/FreeModelCenter.js');
    render(<FreeModelCenter zh={true} />);
    fireEvent.change(await screen.findByLabelText('邮箱地址'), { target: { value: 'newpool@qq.com' } });
    fireEvent.change(screen.getByLabelText('IMAP 授权码'), { target: { value: 'abcdef123456' } });
    fireEvent.click(screen.getByRole('button', { name: /^绑定/u }));
    await waitFor(() => expect(bridgeApi.mailboxAdd).toHaveBeenCalledWith(expect.objectContaining({ kind: 'qq', user: 'newpool@qq.com' })));
  });
});
