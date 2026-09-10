/**
 * iLink Bot API types (WeChat channel).
 *
 * Mirrors the protocol used by the official Tencent WeChat channel plugin
 * (Tencent/openclaw-weixin, MIT): JSON over HTTP, bytes fields as base64.
 * This is the same protocol the ZCode desktop bot uses for its WeChat link.
 */

export const ILINK_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const ILINK_DEFAULT_BOT_TYPE = '3';

export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const;

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

export interface TextItem {
  text?: string;
}

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  hd_size?: number;
}

export interface VoiceItem {
  media?: CDNMedia;
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  playtime?: number;
  /** 语音转文字内容（when available） */
  text?: string;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface VideoItem {
  media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: CDNMedia;
}

export interface ToolCallStartItem {
  tool_name?: string;
  tool_call_id?: string;
}

export interface ToolCallResultItem {
  tool_name?: string;
  tool_call_id?: string;
  status?: string;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  tool_call_start_item?: ToolCallStartItem;
  tool_call_result_item?: ToolCallResultItem;
}

/** Unified inbound/outbound message (proto: WeixinMessage). */
export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

export interface GetUpdatesRequest {
  /** Full context buf cached locally; send "" when none (first request or after reset). */
  get_updates_buf?: string;
}

export interface GetUpdatesResponse {
  ret?: number;
  /** Error code from the server (e.g. -14 = session timeout). */
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  /** Full context buf to cache locally and send on the next request. */
  get_updates_buf?: string;
  /** Server-suggested timeout (ms) for the next getUpdates long-poll. */
  longpolling_timeout_ms?: number;
}

export interface SendMessageRequest {
  msg?: WeixinMessage;
}

export interface SendMessageResponse {
  ret?: number;
  errmsg?: string;
}

export interface SendTypingRequest {
  ilink_user_id?: string;
  typing_ticket?: string;
  status?: number;
}

export interface SendTypingResponse {
  ret?: number;
  errmsg?: string;
}

export interface GetConfigResponse {
  ret?: number;
  errmsg?: string;
  /** Base64-encoded typing ticket for sendTyping. */
  typing_ticket?: string;
}

export interface NotifyRequest {
  scope?: string;
}

export interface NotifyResponse {
  ret?: number;
  errmsg?: string;
}

export interface QrCodeResponse {
  qrcode?: string;
  /** QR payload to render (URL or protocol string). */
  qrcode_img_content?: string;
}

export type QrLoginStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect';

export interface QrStatusResponse {
  status?: QrLoginStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  /** The user id of the person who scanned the QR code. */
  ilink_user_id?: string;
  /** New host to redirect polling to when status is scaned_but_redirect. */
  redirect_host?: string;
  errmsg?: string;
}
