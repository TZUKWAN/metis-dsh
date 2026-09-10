/**
 * Chatbot 站点清单持久化（2026-09-05 刘总规格书：Topic Workspace Chatbot 协作）。
 * 从 CollabPage 提取的纯函数——站点增删改、URL 净化、分栏比例范围。
 * 【比例语义】METIS 侧 55–60%、Chatbot 侧 40–45%：splitRatio 表示 Chatbot
 * 面板占比，范围 [0.40, 0.45]，默认 0.42（旧协同对话的 0.52 语义已废弃，
 * 读到越界历史值一律回落默认）。
 */

export interface ChatbotSite {
  id: string;
  name: string;
  url: string;
}

export const DEFAULT_CHATBOT_SITES: ChatbotSite[] = [
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/' },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  { id: 'kimi', name: 'Kimi', url: 'https://www.kimi.com/' },
  { id: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/' },
  { id: 'glm', name: '智谱 GLM', url: 'https://chatglm.cn/' },
];

export const CHATBOT_SITES_STORAGE_KEY = 'metis-chatbot-sites-v1';
export const CHATBOT_LAST_AI_KEY = 'metis-chatbot-ai';
export const CHATBOT_SPLIT_STORAGE_KEY = 'metis-chatbot-split-v2';
export const CHATBOT_SPLIT_DEFAULT = 0.42;
export const CHATBOT_SPLIT_MIN = 0.4;
export const CHATBOT_SPLIT_MAX = 0.45;

export function loadChatbotSplitRatio(raw: string | null): number {
  const value = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(value) || value < CHATBOT_SPLIT_MIN || value > CHATBOT_SPLIT_MAX) {
    return CHATBOT_SPLIT_DEFAULT;
  }
  return value;
}

export function loadChatbotSites(raw: string | null): ChatbotSite[] {
  // 从未编辑过 → 默认列表；编辑过（哪怕删空）→ 尊重用户选择。
  if (raw === null) return DEFAULT_CHATBOT_SITES;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_CHATBOT_SITES;
    const sites = parsed
      .filter((item): item is ChatbotSite => (
        typeof item === 'object' && item !== null
        && typeof (item as ChatbotSite).id === 'string'
        && typeof (item as ChatbotSite).name === 'string'
        && typeof (item as ChatbotSite).url === 'string'
        && /^https?:/i.test((item as ChatbotSite).url)
      ))
      .slice(0, 24);
    return sites;
  } catch {
    return DEFAULT_CHATBOT_SITES;
  }
}

export function normalizeChatbotUrl(trimmed: string): string | null {
  if (!trimmed) return null;
  const withProtocol = /^https?:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}
