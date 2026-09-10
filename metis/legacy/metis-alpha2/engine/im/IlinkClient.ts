/**
 * iLink Bot API client — the official Tencent WeChat channel protocol
 * (same gateway the ZCode desktop bot uses for its WeChat link).
 *
 * JSON over HTTP at {baseUrl}/ilink/bot/* with Bearer token auth.
 * getUpdates is a long-poll: the server holds the request until new messages
 * arrive or the timeout elapses; the caller must echo back get_updates_buf
 * on every request (cached locally so restarts never lose messages).
 */

import {
  ILINK_DEFAULT_BASE_URL,
  ILINK_DEFAULT_BOT_TYPE,
  MessageState,
  MessageType,
  type GetConfigResponse,
  type GetUpdatesRequest,
  type GetUpdatesResponse,
  type NotifyRequest,
  type NotifyResponse,
  type QrCodeResponse,
  type QrStatusResponse,
  type SendMessageRequest,
  type SendMessageResponse,
  type SendTypingRequest,
  type SendTypingResponse,
  type TextItem,
  type WeixinMessage,
} from './types.js';

export interface IlinkClientOptions {
  /** API base URL; may be switched on IDC redirect. */
  baseUrl?: string;
  /** Bot token from QR login. */
  token?: string;
  /** Regular request timeout (ms). */
  timeoutMs?: number;
  /** Long-poll getUpdates timeout (ms); server holds the request up to this. */
  longPollTimeoutMs?: number;
  /** Self-declared bot identity, UA-style, for observability only. */
  botAgent?: string;
  /** Stable client version advertised in iLink-App-ClientVersion. */
  clientVersion?: string;
  /** Stable app id advertised in iLink-App-Id. */
  appId?: string;
}

export interface SendMessageOptions {
  contextToken?: string;
  runId?: string;
  clientId?: string;
}

function randomWechatUin(): string {
  return String(Math.floor(Math.random() * 0xffffffff));
}

export class IlinkClient {
  private baseUrl: string;
  private token?: string;
  private readonly timeoutMs: number;
  private readonly longPollTimeoutMs: number;
  private readonly botAgent: string;
  private readonly clientVersion: string;
  private readonly appId: string;

  constructor(options: IlinkClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? ILINK_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.longPollTimeoutMs = options.longPollTimeoutMs ?? 45_000;
    this.botAgent = options.botAgent ?? 'MetisWorkbench/0.1';
    this.clientVersion = options.clientVersion ?? '1.0.0';
    this.appId = options.appId ?? 'metis-workbench';
  }

  /** Switch the API base URL (used on scaned_but_redirect IDC redirect). */
  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  get currentBaseUrl(): string {
    return this.baseUrl;
  }

  /** Set/refresh the bot token after login. */
  setToken(token: string): void {
    this.token = token;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomWechatUin(),
      'iLink-App-Id': this.appId,
      'iLink-App-ClientVersion': this.clientVersion,
    };
    if (this.token?.trim()) {
      headers.Authorization = `Bearer ${this.token.trim()}`;
    }
    if (this.botAgent) {
      headers['X-Bot-Agent'] = this.botAgent;
    }
    return headers;
  }

  private async requestJson(
    method: 'GET' | 'POST',
    endpoint: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    const url = `${this.baseUrl}/${endpoint.replace(/^\/+/, '')}`;
    const timeout = timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method,
        headers: this.buildHeaders(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300);
        throw new Error(`iLink ${method} ${endpoint} HTTP ${response.status}: ${detail}`);
      }
      const text = await response.text();
      return text ? (JSON.parse(text) as unknown) : {};
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── QR login ────────────────────────────────────────────────

  /**
   * Request a fresh QR code. Pass previously bound tokens so the server can
   * associate the new scan with existing accounts (multi-account support).
   */
  async getBotQrcode(localTokenList: string[] = []): Promise<QrCodeResponse> {
    const raw = await this.requestJson(
      'POST',
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(ILINK_DEFAULT_BOT_TYPE)}`,
      { local_token_list: localTokenList },
      15_000,
    );
    return raw as QrCodeResponse;
  }

  /**
   * Long-poll the scan status. The server holds the request for ~35s; any
   * network hiccup should be treated as `wait` and retried by the caller.
   */
  async pollQrStatus(qrcode: string, verifyCode?: string): Promise<QrStatusResponse> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    const raw = await this.requestJson('GET', endpoint, undefined, this.longPollTimeoutMs);
    return raw as QrStatusResponse;
  }

  // ─── Messaging ───────────────────────────────────────────────

  /** Long-poll inbound messages. Echo back the returned get_updates_buf next time. */
  async getUpdates(getUpdatesBuf?: string): Promise<GetUpdatesResponse> {
    const body: GetUpdatesRequest = { get_updates_buf: getUpdatesBuf ?? '' };
    const raw = await this.requestJson('POST', 'ilink/bot/getupdates', body, this.longPollTimeoutMs);
    return raw as GetUpdatesResponse;
  }

  /** Send a plain text message to a user (to_user_id from inbound messages). */
  async sendMessage(toUserId: string, text: string, options: SendMessageOptions = {}): Promise<SendMessageResponse> {
    const textItem: TextItem = text ? { text } : {};
    const msg: WeixinMessage = {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: options.clientId ?? `metis-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: text ? [{ type: 1, text_item: textItem }] : undefined,
      context_token: options.contextToken,
      run_id: options.runId,
    };
    const req: SendMessageRequest = { msg };
    const raw = await this.requestJson('POST', 'ilink/bot/sendmessage', req);
    return raw as SendMessageResponse;
  }

  /** Send a typing indicator (typing_ticket comes from getConfig). */
  async sendTyping(userId: string, typingTicket?: string, status = 1): Promise<SendTypingResponse> {
    const req: SendTypingRequest = { ilink_user_id: userId, typing_ticket: typingTicket, status };
    const raw = await this.requestJson('POST', 'ilink/bot/sendtyping', req);
    return raw as SendTypingResponse;
  }

  /** Fetch bot config (e.g. typing ticket). */
  async getConfig(): Promise<GetConfigResponse> {
    const raw = await this.requestJson('POST', 'ilink/bot/getconfig', {});
    return raw as GetConfigResponse;
  }

  /** Notify the server that a session started. */
  async notifyStart(scope?: string): Promise<NotifyResponse> {
    const body: NotifyRequest = scope ? { scope } : {};
    const raw = await this.requestJson('POST', 'ilink/bot/msg/notifystart', body);
    return raw as NotifyResponse;
  }

  /** Notify the server that a session stopped. */
  async notifyStop(scope?: string): Promise<NotifyResponse> {
    const body: NotifyRequest = scope ? { scope } : {};
    const raw = await this.requestJson('POST', 'ilink/bot/msg/notifystop', body);
    return raw as NotifyResponse;
  }
}
