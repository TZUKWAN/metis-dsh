/**
 * AutonomousProfileService — 自主科研独立配置与用户画像（自主改造 A）。
 *
 * 自主科研不基于某个现有项目：它有自己的策略与约束（领域/方法/成果形式/
 * 期刊层次/语言/篇幅/行为约束），加上"从用户行为习惯学到的画像"（memory +
 * learningEngine），共同构成每次自主运行的用户上下文。配置持久化于
 * dataDir/autonomous-profile.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';

export interface AutonomousConstraints {
  fieldPreference: string;
  methodPreference: 'any' | 'quantitative' | 'qualitative' | 'mixed';
  outputForm: 'any' | 'journal_article' | 'report';
  journalTier: 'any' | 'core' | 'general';
  language: 'zh' | 'en';
  lengthTarget: string;
  customRules: string[];
}

export interface AutonomousProfile {
  version: 1;
  defaultPrompt: string;
  defaultBatchSize: number;
  injectUserProfile: boolean;
  constraints: AutonomousConstraints;
}

/** 平台硬约束：不可删除，任何自主运行都必须遵守。 */
export const AUTONOMOUS_HARD_RULES: readonly string[] = [
  '所有引用必须真实可查：文献性论断必须来自本地文献库或可验证来源，禁止编造作者/年份/结论。',
  '所有数字必须来自确定性工具输出（统计/检索），禁止模型笔算编数。',
  '研究结论不得超出证据边界；替代解释至少回应一个。',
  '每个阶段产出落库为版本化成果，过程可审计。',
];

const DEFAULT_PROFILE: AutonomousProfile = {
  version: 1,
  defaultPrompt: '',
  defaultBatchSize: 3,
  injectUserProfile: true,
  constraints: {
    fieldPreference: '',
    methodPreference: 'any',
    outputForm: 'journal_article',
    journalTier: 'core',
    language: 'zh',
    lengthTarget: '8000-12000 字',
    customRules: [],
  },
};

function cloneProfile(value: AutonomousProfile): AutonomousProfile {
  return JSON.parse(JSON.stringify(value)) as AutonomousProfile;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export class AutonomousProfileService {
  private readonly filePath: string;
  private profile: AutonomousProfile;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'autonomous-profile.json');
    this.profile = this.load();
  }

  private load(): AutonomousProfile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as AutonomousProfile;
      if (parsed && typeof parsed === 'object' && parsed.constraints) {
        return {
          version: 1,
          defaultPrompt: typeof parsed.defaultPrompt === 'string' ? parsed.defaultPrompt : '',
          defaultBatchSize: Math.min(5, Math.max(1, Math.trunc(Number(parsed.defaultBatchSize) || 3))),
          injectUserProfile: parsed.injectUserProfile !== false,
          constraints: {
            fieldPreference: String(parsed.constraints.fieldPreference ?? '').slice(0, 200),
            methodPreference: pickEnum(parsed.constraints.methodPreference, ['any', 'quantitative', 'qualitative', 'mixed'] as const, 'any'),
            outputForm: pickEnum(parsed.constraints.outputForm, ['any', 'journal_article', 'report'] as const, 'any'),
            journalTier: pickEnum(parsed.constraints.journalTier, ['any', 'core', 'general'] as const, 'any'),
            language: parsed.constraints.language === 'en' ? 'en' : 'zh',
            lengthTarget: String(parsed.constraints.lengthTarget ?? '').slice(0, 60),
            customRules: Array.isArray(parsed.constraints.customRules)
              ? parsed.constraints.customRules.filter((rule): rule is string => typeof rule === 'string').slice(0, 20).map((rule) => rule.slice(0, 300))
              : [],
          },
        };
      }
    } catch { /* 首次运行 */ }
    return cloneProfile(DEFAULT_PROFILE);
  }

  private persist(): void {
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.profile, null, 1), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch { /* 尽力而为 */ }
  }

  getProfile(): AutonomousProfile {
    return cloneProfile(this.profile);
  }

  saveProfile(patch: Partial<Pick<AutonomousProfile, 'defaultPrompt' | 'defaultBatchSize' | 'injectUserProfile'>> & {
    constraints?: Partial<AutonomousConstraints>;
  }): AutonomousProfile {
    if (typeof patch.defaultPrompt === 'string') this.profile.defaultPrompt = patch.defaultPrompt.slice(0, 2000);
    if (typeof patch.defaultBatchSize === 'number') this.profile.defaultBatchSize = Math.min(5, Math.max(1, Math.trunc(patch.defaultBatchSize) || 3));
    if (typeof patch.injectUserProfile === 'boolean') this.profile.injectUserProfile = patch.injectUserProfile;
    if (patch.constraints) {
      const c = patch.constraints;
      if (typeof c.fieldPreference === 'string') this.profile.constraints.fieldPreference = c.fieldPreference.slice(0, 200);
      this.profile.constraints.methodPreference = pickEnum(c.methodPreference, ['any', 'quantitative', 'qualitative', 'mixed'] as const, this.profile.constraints.methodPreference);
      this.profile.constraints.outputForm = pickEnum(c.outputForm, ['any', 'journal_article', 'report'] as const, this.profile.constraints.outputForm);
      this.profile.constraints.journalTier = pickEnum(c.journalTier, ['any', 'core', 'general'] as const, this.profile.constraints.journalTier);
      if (c.language === 'zh' || c.language === 'en') this.profile.constraints.language = c.language;
      if (typeof c.lengthTarget === 'string') this.profile.constraints.lengthTarget = c.lengthTarget.slice(0, 60);
      if (Array.isArray(c.customRules)) {
        this.profile.constraints.customRules = c.customRules
          .filter((rule): rule is string => typeof rule === 'string' && rule.trim().length > 0)
          .slice(0, 20)
          .map((rule) => rule.slice(0, 300));
      }
    }
    this.persist();
    return this.getProfile();
  }

  /** 组装自主科研的用户上下文：提示词 + 独立约束（含硬规则）+ 用户画像。 */
  buildContext(input: { prompt: string; memoryContext?: string; learningContext?: string }): string {
    const blocks: string[] = [];
    const trimmedPrompt = input.prompt.trim();
    if (trimmedPrompt) {
      blocks.push(`## 用户本次指令\n${trimmedPrompt}`);
    }
    const c = this.profile.constraints;
    const constraintLines: string[] = [];
    if (c.fieldPreference.trim()) constraintLines.push(`- 研究领域偏好：${c.fieldPreference}`);
    constraintLines.push(`- 方法偏好：${methodLabel(c.methodPreference)}`);
    constraintLines.push(`- 成果形式：${outputLabel(c.outputForm)}`);
    constraintLines.push(`- 期刊层次目标：${c.journalTier === 'core' ? '核心期刊（CSSCI/SSCI 水平）' : c.journalTier === 'general' ? '一般公开学术出版物' : '不限'}`);
    constraintLines.push(`- 写作语言：${c.language === 'zh' ? '中文' : '英文'}`);
    if (c.lengthTarget.trim()) constraintLines.push(`- 篇幅目标：${c.lengthTarget}`);
    for (const rule of c.customRules) constraintLines.push(`- 用户自定义约束：${rule}`);
    for (const rule of AUTONOMOUS_HARD_RULES) constraintLines.push(`- 硬性约束（必须遵守）：${rule}`);
    blocks.push(`## 策略与约束\n${constraintLines.join('\n')}`);

    if (this.profile.injectUserProfile) {
      const profileParts: string[] = [];
      if (input.memoryContext && input.memoryContext.trim()) {
        profileParts.push(input.memoryContext.trim().slice(0, 3000));
      }
      if (input.learningContext && input.learningContext.trim()) {
        profileParts.push(input.learningContext.trim().slice(0, 1500));
      }
      if (profileParts.length > 0) {
        blocks.push(`## 用户画像（从行为习惯学习，用于对齐研究方向与风格）\n${profileParts.join('\n\n')}`);
      }
    }
    return blocks.join('\n\n');
  }

  registerIpc(): void {
    ipcMain.handle('autonomousProfile:get', () => this.getProfile());
    ipcMain.handle('autonomousProfile:save', (_event, raw: unknown) => this.saveProfile((raw ?? {}) as never));
    ipcMain.handle('autonomousProfile:hardRules', () => AUTONOMOUS_HARD_RULES);
  }
}

function methodLabel(method: AutonomousConstraints['methodPreference']): string {
  switch (method) {
    case 'quantitative': return '定量';
    case 'qualitative': return '定性';
    case 'mixed': return '混合方法';
    default: return '不限';
  }
}

function outputLabel(form: AutonomousConstraints['outputForm']): string {
  switch (form) {
    case 'journal_article': return '期刊论文';
    case 'report': return '研究报告';
    default: return '不限';
  }
}
