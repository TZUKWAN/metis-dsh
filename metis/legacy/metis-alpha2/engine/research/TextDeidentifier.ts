/**
 * TextDeidentifier — 定性资料脱敏（T23，研究伦理）。
 *
 * 确定性规则：手机号/固话/身份证/邮箱/邮编/网址 → 类型占位符；
 * 用户提供的敏感词表（人名/机构/地名）→ [人物A] 序号占位（同一词全文
 * 同一占位，保持可分析性）。零模型调用。
 */

export interface DeidentifyResult {
  text: string;
  maskedCounts: Record<string, number>;
  totalMasked: number;
}

const PATTERNS: Array<{ re: RegExp; label: string }> = [
  // 顺序敏感：长格式（身份证）必须先于短格式（手机/电话/邮编），
  // 否则短模式会把长号码切碎。
  { re: /\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/gu, label: '[身份证号]' },
  { re: /1[3-9]\d{9}/gu, label: '[手机号]' },
  { re: /(?:\d{3,4}-)?\d{7,8}(?!\d)/gu, label: '[电话]' },
  { re: /[\w.+-]+@[\w-]+\.[\w.]+/gu, label: '[邮箱]' },
  { re: /\b\d{6}(?!\d)/gu, label: '[邮编]' },
  { re: /https?:\/\/[^\s，。；)）]+/gu, label: '[网址]' },
];

export function deidentifyText(text: string, extraTerms: string[] = []): DeidentifyResult {
  let output = text;
  const maskedCounts: Record<string, number> = {};
  let totalMasked = 0;

  const count = (label: string, occurrences: number) => {
    maskedCounts[label] = (maskedCounts[label] ?? 0) + occurrences;
    totalMasked += occurrences;
  };

  for (const { re, label } of PATTERNS) {
    const found = output.match(re);
    if (found && found.length > 0) {
      count(label, found.length);
      output = output.replace(re, label);
    }
  }

  // 自定义敏感词 → 序号化占位（保持同一实体同一占位）。
  const terms = [...new Set(extraTerms.map((term) => term.trim()).filter((term) => term.length >= 2))]
    .sort((a, b) => b.length - a.length); // 长词优先，避免子串误吞
  let personIndex = 0;
  for (const term of terms) {
    if (!output.includes(term)) continue;
    personIndex += 1;
    const label = `[敏感信息${personIndex}]`;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const occurrences = (output.match(new RegExp(escaped, 'gu')) ?? []).length;
    count(label, occurrences);
    output = output.replace(new RegExp(escaped, 'gu'), label);
  }

  return { text: output, maskedCounts, totalMasked };
}
