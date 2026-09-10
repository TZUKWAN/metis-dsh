/**
 * WeChatBotService — Metis 微信 Bot 运行时（METIS-WX-1）。
 *
 * 与 ZCode 微信 Bot 同一协议（腾讯官方 iLink Bot API）与同一体验模型：
 *   - 扫码绑定微信 → 长轮询收消息 → 消息进入 Metis agent 会话 → 完成摘要回发
 *   - 命令体系与 ZCode 对齐：/项目 /模型 /状态 /新建 /继续 /停止 /帮助
 *   - 数字菜单选择（项目列表）
 *   - get_updates_buf 游标持久化（重启不丢消息）
 *   - bot token 加密存储（SecureStorage）
 *
 * 设计要点：依赖全部注入（可测）；单消息串行处理（busy 时提示等待）；
 * 轮询循环由 start() 驱动、runOnce() 暴露单次迭代（测试用）。
 */

import {
  MessageItemType,
  MessageState,
  MessageType,
  TypingStatus,
  type WeixinMessage,
} from '../engine/im/types.js';
import type { IlinkClient } from '../engine/im/IlinkClient.js';
import { downloadCdnMedia, mediaKindToMime, type CdnMediaRef } from '../engine/im/MediaCodec.js';
import fs from 'node:fs';
import path from 'node:path';

export type WeChatBotPhase =
  | 'unbound'
  | 'login_pending'
  | 'login_scaned'
  | 'need_verifycode'
  | 'bound'
  | 'error';

export interface WeChatBotState {
  botId: string;
  baseUrl: string;
  /** The WeChat user id that bound the bot. */
  userId: string;
  /** getUpdates cursor; persisted so restarts never lose messages. */
  getUpdatesBuf: string;
  /** Active project scope for agent turns (F12 memory isolation). */
  activeProjectId: string;
  /** Active persisted session id (wx:{userId} — recreated by /新建). */
  activeSessionId: string;
  boundAt: number;
  lastError: string;
  /** ISO timestamp of the last inbound message. */
  lastInboundAt: string;
  /** Bot token encrypted by the secure store (never plaintext on disk). */
  tokenCipher: string;
}

export interface WeChatBotDeps {
  client: IlinkClient;
  /** Secure token store (Electron safeStorage backed): encrypt/decrypt a string. */
  store: { encrypt(plain: string): string; decrypt(cipher: string): string };
  /** Path to the bot-state.json file. */
  statePath: string;
  /** Directory where inbound WeChat media is saved (created lazily). */
  mediaDir: string;
  /** Overridable CDN downloader (tests inject a fake; defaults to the real codec). */
  downloadMedia?: (ref: CdnMediaRef) => Promise<{ buffer: Buffer; mime: string; extension: string; bytes: number }>;
  /**
   * Execute one agent turn for the given user message inside a persisted
   * session. Implemented by the main process (reuses runPersistedChatTurn +
   * memory injection). attachments carry locally saved WeChat media the agent
   * may read with its file tools.
   */
  runTurn: (opts: {
    sessionId: string;
    userText: string;
    projectId?: string;
    signal?: AbortSignal;
    attachments?: Array<{ path: string; name: string; mime: string }>;
    images?: Array<{ mime?: string; dataBase64: string }>;
  }) => Promise<{ ok: boolean; answer?: string; error?: string }>;
  listProjects: () => Array<{ id: string; title: string }>;
  getModelName: () => string;
  /** Whether the configured provider accepts inline images (vision). */
  supportsVision?: () => boolean;
  now?: () => number;
}

export interface WeChatBotStatusView {
  phase: WeChatBotPhase;
  botId: string;
  userId: string;
  activeProjectId: string;
  activeSessionId: string;
  boundAt: number;
  busy: boolean;
  lastError: string;
  lastInboundAt: string;
  /** QR payload while login is pending. */
  qrContent: string;
  /** Whether a numeric menu is waiting for a choice. */
  menuWaiting: boolean;
  recentLog: Array<{ at: string; direction: 'in' | 'out'; text: string }>;
}

const MENU_TTL_MS = 5 * 60_000;
const LOG_CAPACITY = 30;

function sanitizeSessionPart(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

/** Light markdown cleanup so replies read well inside WeChat. */
export function cleanForWechat(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (/^#{1,6}\s/.test(trimmed)) return trimmed.replace(/^#{1,6}\s/, '');
      if (/^```/.test(trimmed)) return '';
      if (/^\|/.test(trimmed)) return trimmed.replace(/\|/g, ' ').replace(/^ +-+ +/, '').trim();
      if (/^[-*]\s/.test(trimmed)) return trimmed;
      return line;
    })
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .slice(0, 4000);
}

export class WeChatBotService {
  private readonly deps: WeChatBotDeps;
  private state: WeChatBotState;
  private phase: WeChatBotPhase = 'unbound';
  private qrCode = '';
  /** 二维码渲染负载（网关返回的绑定 URL）；qrCode 仅作轮询 token。 */
  private qrRenderContent = '';
  private qrVerifyCode = '';
  private busy = false;
  private running = false;
  private abortController: AbortController | null = null;
  private pollLoopPromise: Promise<void> | null = null;
  private pendingMenu: { kind: 'project'; items: Array<{ id: string; title: string }>; prompt: string; expiresAt: number } | null = null;
  private recentLog: Array<{ at: string; direction: 'in' | 'out'; text: string }> = [];
  private readonly now: () => number;

  constructor(deps: WeChatBotDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.state = this.loadState();
  }

  // ─── State persistence ───────────────────────────────────────

  private loadState(): WeChatBotState {
    try {
      if (fs.existsSync(this.deps.statePath)) {
        const raw = JSON.parse(fs.readFileSync(this.deps.statePath, 'utf-8')) as Partial<WeChatBotState>;
        return {
          botId: raw.botId ?? '',
          baseUrl: raw.baseUrl ?? '',
          userId: raw.userId ?? '',
          getUpdatesBuf: raw.getUpdatesBuf ?? '',
          activeProjectId: raw.activeProjectId ?? '',
          activeSessionId: raw.activeSessionId ?? '',
          boundAt: raw.boundAt ?? 0,
          lastError: raw.lastError ?? '',
          lastInboundAt: raw.lastInboundAt ?? '',
          tokenCipher: raw.tokenCipher ?? '',
        };
      }
    } catch {
      /* corrupt state file → start fresh */
    }
    return {
      botId: '', baseUrl: '', userId: '', getUpdatesBuf: '',
      activeProjectId: '', activeSessionId: '', boundAt: 0, lastError: '', lastInboundAt: '', tokenCipher: '',
    };
  }

  private saveState(): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.statePath), { recursive: true });
      fs.writeFileSync(this.deps.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch {
      /* persistence is best-effort; never break the bot over a state write */
    }
  }

  private loadToken(): string | undefined {
    if (!this.state.tokenCipher) return undefined;
    try {
      const plain = this.deps.store.decrypt(this.state.tokenCipher);
      return plain || undefined;
    } catch {
      this.state.tokenCipher = '';
      this.saveState();
      return undefined;
    }
  }

  private saveToken(token: string): void {
    this.state.tokenCipher = this.deps.store.encrypt(token);
    this.saveState();
  }

  private log(direction: 'in' | 'out', text: string): void {
    this.recentLog.push({ at: new Date(this.now()).toISOString(), direction, text: text.slice(0, 120) });
    if (this.recentLog.length > LOG_CAPACITY) {
      this.recentLog = this.recentLog.slice(-LOG_CAPACITY);
    }
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  /** Restore a previously bound session and resume polling. */
  start(): void {
    if (this.running) return;
    const token = this.loadToken();
    if (!token || !this.state.botId) {
      this.phase = 'unbound';
      return;
    }
    this.deps.client.setToken(token);
    if (this.state.baseUrl) this.deps.client.setBaseUrl(this.state.baseUrl);
    this.phase = 'bound';
    this.running = true;
    this.pollLoopPromise = this.pollLoop();
    void this.deps.client.notifyStart(this.state.botId).catch(() => {});
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.abortController) this.abortController.abort();
    await this.deps.client.notifyStop(this.state.botId).catch(() => {});
    if (this.pollLoopPromise) {
      await this.pollLoopPromise.catch(() => {});
    }
    this.pollLoopPromise = null;
  }

  async logout(): Promise<void> {
    await this.stop();
    this.state.botId = '';
    this.state.userId = '';
    this.state.getUpdatesBuf = '';
    this.state.tokenCipher = '';
    this.phase = 'unbound';
    this.qrRenderContent = '';
    this.saveState();
  }

  getStatus(): WeChatBotStatusView {
    return {
      phase: this.phase,
      botId: this.state.botId,
      userId: this.state.userId,
      activeProjectId: this.state.activeProjectId,
      activeSessionId: this.state.activeSessionId,
      boundAt: this.state.boundAt,
      busy: this.busy,
      lastError: this.state.lastError,
      lastInboundAt: this.state.lastInboundAt,
      qrContent: this.qrRenderContent || this.qrCode,
      menuWaiting: this.pendingMenu !== null,
      recentLog: [...this.recentLog],
    };
  }

  // ─── QR login ────────────────────────────────────────────────

  async beginLogin(): Promise<{ ok: boolean; qrContent?: string; error?: string }> {
    try {
      const existingToken = this.loadToken();
      const qr = await this.deps.client.getBotQrcode(existingToken ? [existingToken] : []);
      const content = qr.qrcode_img_content ?? qr.qrcode ?? '';
      if (!content) {
        this.phase = 'error';
        this.state.lastError = 'Gateway returned an empty QR code';
        this.saveState();
        return { ok: false, error: 'empty_qrcode' };
      }
      // The gateway distinguishes the render payload (qrcode_img_content, a
      // URL) from the poll token (qrcode). Polling with the full URL is
      // immediately reported as expired, so keep the raw token for status
      // polls and return the render payload to the UI.
      this.qrCode = qr.qrcode ?? content;
      this.qrRenderContent = content;
      this.qrVerifyCode = '';
      this.phase = 'login_pending';
      return { ok: true, qrContent: content };
    } catch (err) {
      this.phase = 'error';
      this.state.lastError = (err as Error).message;
      this.saveState();
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Advance the login state machine one step (renderer polls this).
   * Returns the new phase so the UI can react (scaned / need_verifycode / bound).
   */
  async pollLogin(): Promise<{ phase: WeChatBotPhase; ok: boolean; error?: string }> {
    if (this.phase !== 'login_pending' && this.phase !== 'login_scaned' && this.phase !== 'need_verifycode') {
      return { phase: this.phase, ok: this.phase === 'bound' };
    }
    try {
      const status = await this.deps.client.pollQrStatus(this.qrCode, this.qrVerifyCode || undefined);
      switch (status.status) {
        case 'wait':
          return { phase: this.phase, ok: false };
        case 'scaned':
          this.phase = 'login_scaned';
          return { phase: this.phase, ok: false };
        case 'scaned_but_redirect': {
          // IDC redirect: switch to the suggested host and keep polling.
          const next = status.redirect_host ?? status.baseurl;
          if (next) {
            this.deps.client.setBaseUrl(next.startsWith('http') ? next : `https://${next}`);
            this.state.baseUrl = this.deps.client.currentBaseUrl;
            this.saveState();
          }
          return { phase: 'login_scaned', ok: false };
        }
        case 'need_verifycode':
          this.phase = 'need_verifycode';
          return { phase: this.phase, ok: false };
        case 'verify_code_blocked':
          this.phase = 'error';
          this.state.lastError = 'Verify code blocked by gateway';
          this.saveState();
          return { phase: this.phase, ok: false, error: 'verify_code_blocked' };
        case 'expired':
          this.phase = 'error';
          this.state.lastError = 'QR expired — start a new login';
          this.saveState();
          return { phase: this.phase, ok: false, error: 'qr_expired' };
        case 'binded_redirect':
          // Already bound to this instance: existing credentials remain valid.
          this.phase = 'bound';
          this.running = true;
          this.pollLoopPromise = this.pollLoop();
          return { phase: 'bound', ok: true };
        case 'confirmed': {
          const token = status.bot_token ?? '';
          if (!token) {
            this.phase = 'error';
            this.state.lastError = 'Gateway confirmed scan but returned no token';
            this.saveState();
            return { phase: this.phase, ok: false, error: 'missing_token' };
          }
          this.saveToken(token);
          this.deps.client.setToken(token);
          this.state.botId = status.ilink_bot_id ?? '';
          this.state.userId = status.ilink_user_id ?? '';
          this.state.boundAt = this.now();
          this.state.lastError = '';
          if (status.baseurl) {
            this.deps.client.setBaseUrl(status.baseurl);
            this.state.baseUrl = this.deps.client.currentBaseUrl;
          }
          this.saveState();
          this.phase = 'bound';
          this.running = true;
          this.pollLoopPromise = this.pollLoop();
          void this.deps.client.notifyStart(this.state.botId).catch(() => {});
          return { phase: 'bound', ok: true };
        }
        default:
          return { phase: this.phase, ok: false };
      }
    } catch (error) {
      // Network/gateway errors during polling: keep waiting, but record the real
      // cause so the settings UI and app log show why instead of a generic failure.
      const message = error instanceof Error ? error.message : String(error);
      this.state.lastError = `扫码状态查询失败：${message}`;
      this.saveState();
      console.warn(`[WeChatBot] poll error: ${message}`);
      return { phase: this.phase, ok: false, error: message };
    }
  }

  submitVerifyCode(code: string): void {
    this.qrVerifyCode = code.trim();
    if (this.phase === 'need_verifycode') {
      this.phase = 'login_pending';
    }
  }

  // ─── Settings helpers ────────────────────────────────────────

  setActiveProject(projectId: string): void {
    this.state.activeProjectId = projectId;
    this.saveState();
  }

  async sendTestMessage(text: string): Promise<{ ok: boolean; error?: string }> {
    if (this.phase !== 'bound' || !this.state.userId) {
      return { ok: false, error: 'not_bound' };
    }
    return this.handleChat(this.state.userId, text);
  }

  // ─── Poll loop ───────────────────────────────────────────────

  /** One poll iteration (exposed for tests; the loop calls this repeatedly). Returns false on network failure. */
  async runOnce(): Promise<boolean> {
    if (this.phase !== 'bound') return true;
    let resp;
    try {
      resp = await this.deps.client.getUpdates(this.state.getUpdatesBuf);
    } catch {
      return false; // caller applies backoff
    }
    if (resp.errcode === -14 || resp.ret === -14) {
      // Session timeout: reset cursor and reconnect on the next iteration.
      this.state.getUpdatesBuf = '';
      this.saveState();
      return true;
    }
    if (resp.errcode !== undefined && resp.errcode !== 0) {
      this.state.lastError = `getUpdates errcode=${resp.errcode} ${resp.errmsg ?? ''}`.slice(0, 200);
      this.saveState();
      return true;
    }
    if (resp.get_updates_buf !== undefined && resp.get_updates_buf !== this.state.getUpdatesBuf) {
      this.state.getUpdatesBuf = resp.get_updates_buf;
      this.saveState();
    }
    for (const msg of resp.msgs ?? []) {
      await this.handleMessage(msg);
    }
    return true;
  }

  private async pollLoop(): Promise<void> {
    let backoffMs = 1000;
    while (this.running && this.phase === 'bound') {
      const ok = await this.runOnce();
      if (ok) {
        backoffMs = 1000;
      } else {
        // Network failure: exponential backoff so we never hammer the gateway.
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 15_000);
      }
      if (this.running) await sleep(200);
    }
  }

  // ─── Message handling ────────────────────────────────────────

  private sessionIdFor(userId: string): string {
    if (!this.state.activeSessionId) {
      // Fresh session per /新建: timestamped so repeated /新建 accumulates history.
      this.state.activeSessionId = `wx:${sanitizeSessionPart(userId)}:${this.now()}`;
      this.saveState();
    }
    return this.state.activeSessionId;
  }

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    if (msg.message_type !== MessageType.USER) return;
    const from = msg.from_user_id ?? '';
    if (!from) return;
    if (msg.message_state !== undefined && msg.message_state !== MessageState.NEW && msg.message_state !== MessageState.FINISH) return;
    const items = msg.item_list ?? [];
    const textItem = items.find((item) => item.type === MessageItemType.TEXT)?.text_item;
    const text = (textItem?.text ?? '').trim();
    this.state.lastInboundAt = new Date(this.now()).toISOString();
    this.saveState();

    if (!text) {
      // Media message (METIS-WX-2): download, decrypt, save locally; files are
      // handed to the agent for analysis, images/video are acknowledged.
      const imageItem = items.find((item) => item.type === MessageItemType.IMAGE)?.image_item;
      const voiceItem = items.find((item) => item.type === MessageItemType.VOICE)?.voice_item;
      const fileItem = items.find((item) => item.type === MessageItemType.FILE)?.file_item;
      const videoItem = items.find((item) => item.type === MessageItemType.VIDEO)?.video_item;

      if (voiceItem?.text?.trim()) {
        // Gateway-provided voice transcription: treat as text.
        await this.handleChat(from, voiceItem.text.trim(), msg.context_token);
        return;
      }
      if (fileItem) {
        const saved = await this.saveMedia('file', fileItem.media, fileItem.file_name, from);
        if (saved) {
          await this.handleChat(from, '请分析我发送的文件', msg.context_token, [saved]);
          return;
        }
        await this.send(from, '文件下载失败，请重试或直接在桌面端导入。', msg.context_token);
        return;
      }
      if (imageItem) {
        const saved = await this.saveMedia('image', imageItem.media, undefined, from);
        if (saved && this.deps.supportsVision?.()) {
          // Vision-capable provider: hand the image to the agent for analysis.
          try {
            const buffer = fs.readFileSync(saved.path);
            const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // base64 inflates ~33%; keep the wire sane
            if (buffer.length <= MAX_IMAGE_BYTES) {
              await this.handleChat(from, '请分析这张图片', msg.context_token, undefined, [{
                mime: saved.mime,
                dataBase64: buffer.toString('base64'),
              }]);
              return;
            }
          } catch { /* fall through to save-only notice */ }
        }
        await this.send(from, saved
          ? `已收到图片并保存到本地：${saved.path}`
          : '收到图片（暂不支持解析内容，可在桌面端查看）。', msg.context_token);
        return;
      }
      if (voiceItem) {
        const saved = await this.saveMedia('voice', voiceItem.media, undefined, from);
        await this.send(from, saved
          ? `已收到语音并保存到本地：${saved.path}（暂不支持转文字）`
          : '收到语音（暂不支持转文字）。', msg.context_token);
        return;
      }
      if (videoItem) {
        const saved = await this.saveMedia('video', videoItem.media, undefined, from);
        await this.send(from, saved
          ? `已收到视频并保存到本地：${saved.path}（暂不支持视频分析）`
          : '收到视频（暂不支持分析）。', msg.context_token);
        return;
      }
      await this.deps.client.sendMessage(from, '收到媒体消息，请用文字描述你的需求。', {
        contextToken: msg.context_token,
        runId: msg.run_id,
      });
      return;
    }

    // Numeric menu choice?
    if (this.pendingMenu && /^\d+$/.test(text)) {
      await this.handleMenuChoice(from, Number(text), msg);
      return;
    }

    if (text.startsWith('/')) {
      await this.handleCommand(from, text, msg);
      return;
    }

    await this.handleChat(from, text, msg.context_token);
  }

  private async send(to: string, text: string, contextToken?: string): Promise<void> {
    this.log('out', text);
    await this.deps.client.sendMessage(to, text, { contextToken });
  }

  /** Download + decrypt + save an inbound CDN media file. Returns null on failure. */
  private async saveMedia(
    kind: 'image' | 'voice' | 'file' | 'video',
    media: CdnMediaRef | undefined,
    originalName: string | undefined,
    userId: string,
  ): Promise<{ path: string; name: string; mime: string } | null> {
    if (!media) return null;
    if (!media.full_url && !media.encrypt_query_param) return null;
    try {
      const downloader = this.deps.downloadMedia ?? downloadCdnMedia;
      const downloaded = await downloader(media);
      const { mime, extension } = mediaKindToMime(kind, originalName);
      const dir = path.join(this.deps.mediaDir, sanitizeSessionPart(userId));
      fs.mkdirSync(dir, { recursive: true });
      const base = originalName?.replace(/[^A-Za-z0-9._-]/g, '_') || `${kind}-${this.now()}`;
      const safeName = `${this.now()}-${base.endsWith(`.${extension}`) ? base : `${base}.${extension}`}`;
      const filePath = path.join(dir, safeName);
      fs.writeFileSync(filePath, downloaded.buffer);
      this.log('in', `[媒体] ${kind} ${safeName}`);
      return { path: filePath, name: safeName, mime: downloaded.mime || mime };
    } catch {
      return null;
    }
  }

  private async handleChat(
    from: string,
    text: string,
    contextToken?: string,
    attachments?: Array<{ path: string; name: string; mime: string }>,
    images?: Array<{ mime?: string; dataBase64: string }>,
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.busy) {
      await this.send(from, '⏳ 正在处理上一条任务，完成后会回复你。', contextToken);
      return { ok: false, error: 'busy' };
    }
    const sessionId = this.sessionIdFor(from);
    this.busy = true;
    this.log('in', text);
    try {
      // Typing indicator while the agent works.
      const config = await this.deps.client.getConfig().catch(() => ({ typing_ticket: undefined }));
      void this.deps.client.sendTyping(from, config.typing_ticket, TypingStatus.TYPING).catch(() => {});

      this.abortController = new AbortController();
      const result = await this.deps.runTurn({
        sessionId,
        userText: text,
        projectId: this.state.activeProjectId || undefined,
        signal: this.abortController.signal,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(images && images.length > 0 ? { images } : {}),
      });
      void this.deps.client.sendTyping(from, config.typing_ticket, TypingStatus.CANCEL).catch(() => {});
      if (result.ok && result.answer) {
        await this.send(from, cleanForWechat(result.answer), contextToken);
        return { ok: true };
      }
      const errorText = result.error ?? '任务未能完成，请稍后重试。';
      await this.send(from, `❌ ${cleanForWechat(errorText)}`, contextToken);
      return { ok: false, error: errorText };
    } finally {
      this.busy = false;
      this.abortController = null;
    }
  }

  private async handleCommand(from: string, raw: string, msg: WeixinMessage): Promise<void> {
    const [command, ...rest] = raw.slice(1).trim().split(/\s+/);
    const arg = rest.join(' ').trim();
    const ctx = msg.context_token;
    this.log('in', raw);

    switch (command.toLowerCase()) {
      case '帮助':
      case 'help': {
        await this.send(from, [
          '📋 Metis 微信助手命令：',
          '/帮助 — 显示本列表',
          '/状态 — 当前连接与项目',
          '/项目 — 列出并选择项目（回复数字）',
          '/项目 <关键词> — 直接切换项目',
          '/模型 — 显示当前模型',
          '/新建 — 开启新会话',
          '/继续 — 继续当前会话',
          '/停止 — 中断当前任务',
          '',
          '直接发送文字即可开始研究问答。',
        ].join('\n'), ctx);
        return;
      }
      case '状态': {
        const project = this.deps.listProjects().find((p) => p.id === this.state.activeProjectId);
        await this.send(from, [
          '📊 Metis 状态：',
          `连接：${this.phase === 'bound' ? '已绑定 ✓' : '未绑定'}`,
          `模型：${this.deps.getModelName()}`,
          `项目：${project ? project.title : '未绑定（/项目 选择）'}`,
          `会话：${this.state.activeSessionId || '无'}`,
          this.busy ? '状态：处理中…' : '状态：空闲',
        ].join('\n'), ctx);
        return;
      }
      case '新建': {
        const sessionId = this.state.activeSessionId;
        this.state.activeSessionId = '';
        this.saveState();
        await this.send(from, sessionId
          ? '✅ 已开启新会话（旧会话已保留在本地库中）。'
          : '✅ 已开启新会话。', ctx);
        return;
      }
      case '项目': {
        const projects = this.deps.listProjects();
        if (projects.length === 0) {
          await this.send(from, '当前没有可用项目。', ctx);
          return;
        }
        if (arg) {
          const matched = projects.find((p) => p.id.toLowerCase() === arg.toLowerCase())
            ?? projects.find((p) => p.title.toLowerCase().includes(arg.toLowerCase()));
          if (!matched) {
            await this.send(from, `未找到项目「${arg}」。发送 /项目 查看全部项目。`, ctx);
            return;
          }
          this.setActiveProject(matched.id);
          await this.send(from, `✅ 已切换到项目：${matched.title}`, ctx);
          return;
        }
        const lines = projects.map((p, i) => `${i + 1}. ${p.title || p.id}`);
        this.pendingMenu = {
          kind: 'project',
          items: projects,
          prompt: '回复数字选择项目：',
          expiresAt: this.now() + MENU_TTL_MS,
        };
        await this.send(from, `📁 选择项目（回复数字）：\n${lines.join('\n')}`, ctx);
        return;
      }
      case '模型': {
        await this.send(from, `🤖 当前模型：${this.deps.getModelName()}\n如需更换，请在 Metis 设置 → 模型连接 中配置。`, ctx);
        return;
      }
      case '继续': {
        await this.handleChat(from, '继续', ctx);
        return;
      }
      case '停止': {
        if (this.abortController) {
          this.abortController.abort();
          await this.send(from, '⏹ 已发送中断请求。', ctx);
        } else {
          await this.send(from, '当前没有正在运行的任务。', ctx);
        }
        return;
      }
      default:
        await this.send(from, `未知命令：/${command}\n发送 /帮助 查看全部命令。`, ctx);
    }
  }

  private async handleMenuChoice(from: string, choice: number, msg: WeixinMessage): Promise<void> {
    const menu = this.pendingMenu;
    if (!menu) return;
    if (this.now() > menu.expiresAt) {
      this.pendingMenu = null;
      await this.send(from, '菜单已过期，请重新发送命令。', msg.context_token);
      return;
    }
    const item = menu.items[choice - 1];
    if (!item) {
      await this.send(from, `无效选择，请输入 1-${menu.items.length}。`, msg.context_token);
      return;
    }
    this.pendingMenu = null;
    if (menu.kind === 'project') {
      this.setActiveProject(item.id);
      await this.send(from, `✅ 已切换到项目：${item.title}`, msg.context_token);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
