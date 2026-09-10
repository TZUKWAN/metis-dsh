/**
 * Memory Manager — 本地记忆系统
 *
 * 三层记忆：
 *  1. Project Memory: 用户可编辑的项目级记忆（CLAUDE_MEMORY.md）
 *  2. Conversation Summary: 长对话自动摘要，存入 SQLite
 *  3. Cross-Session Memory: 关键决策、用户偏好，存入 SQLite memory 表
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PersistenceStore } from '../persistence/PersistenceStore.js';

export interface MemoryEntry {
  key: string;
  value: string;
  category: string;
  createdAt: number;
  updatedAt: number;
}

export class MemoryManager {
  private readonly store: PersistenceStore;
  private readonly projectMemoryPath: string;
  private readonly dataDir: string;

  constructor(store: PersistenceStore, dataDir: string) {
    this.store = store;
    this.projectMemoryPath = path.join(dataDir, 'CLAUDE_MEMORY.md');
    this.dataDir = dataDir;
  }

  // ─── Project Memory ─────────────────────────────────────────

  /**
   * 任务2 上下文隔离：projectId 存在时读 per-project 记忆文件
   * （project-memory/<sha256(projectId)>/MEMORY.md，与 WorkspaceAgentsManager
   * 同一目录隔离方案）；仅显式 global 调用（无 projectId）才读全局
   * CLAUDE_MEMORY.md。此前单个全局文件会注入所有项目的 prompt——A 项目的
   * 「项目记忆」必然串进 B 项目，本方法收敛该泄漏。
   */
  loadProjectMemory(projectId?: string): string {
    const target = this.projectMemoryFile(projectId);
    try {
      if (fs.existsSync(target)) {
        return fs.readFileSync(target, 'utf-8');
      }
    } catch { /* ignore */ }
    return '';
  }

  saveProjectMemory(content: string, projectId?: string): void {
    const target = this.projectMemoryFile(projectId);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf-8');
    } catch { /* ignore */ }
  }

  private projectMemoryFile(projectId?: string): string {
    if (!projectId?.trim()) return this.projectMemoryPath;
    const dirName = createHash('sha256').update(projectId.trim(), 'utf8').digest('hex');
    return path.join(this.dataDir, 'project-memory', dirName, 'MEMORY.md');
  }

  // ─── Conversation Summary ───────────────────────────────────

  getConversationSummary(sessionId: string): string {
    const entry = this.store.getMemory(`summary:${sessionId}`);
    return entry?.value ?? '';
  }

  saveConversationSummary(sessionId: string, summary: string): void {
    this.store.setMemory(`summary:${sessionId}`, summary, 'conversation_summary');
  }

  // ─── Cross-Session Memory (METIS-F12: optional projectId scoping) ──

  recordKeyDecision(decision: string, context?: string, projectId?: string): void {
    const now = Date.now();
    const key = `decision:${now}`;
    const value = context ? `${decision}\n\nContext: ${context}` : decision;
    if (projectId) {
      this.store.setMemoryScoped(projectId, key, value, 'key_decision');
    } else {
      this.store.setMemory(key, value, 'key_decision');
    }
  }

  getKeyDecisions(limit = 20, projectId?: string): MemoryEntry[] {
    return this.store.getMemoryByCategory('key_decision', projectId).slice(0, limit);
  }

  recordPreference(key: string, value: string, projectId?: string): void {
    if (projectId) {
      this.store.setMemoryScoped(projectId, `pref:${key}`, value, 'preference');
    } else {
      this.store.setMemory(`pref:${key}`, value, 'preference');
    }
  }

  getPreference(key: string, projectId?: string): string | undefined {
    return projectId
      ? this.store.getMemoryScoped(projectId, `pref:${key}`)?.value
      : this.store.getMemory(`pref:${key}`)?.value;
  }

  getAllPreferences(projectId?: string): MemoryEntry[] {
    return this.store.getMemoryByCategory('preference', projectId);
  }

  // ─── General Memory ─────────────────────────────────────────

  set(key: string, value: string, category = 'general', projectId?: string): void {
    if (projectId) {
      this.store.setMemoryScoped(projectId, key, value, category);
    } else {
      this.store.setMemory(key, value, category);
    }
  }

  get(key: string, projectId?: string): string | undefined {
    return projectId
      ? this.store.getMemoryScoped(projectId, key)?.value
      : this.store.getMemory(key)?.value;
  }

  getByCategory(category: string, projectId?: string): MemoryEntry[] {
    return this.store.getMemoryByCategory(category, projectId);
  }

  delete(key: string, projectId?: string): void {
    if (projectId) {
      this.store.deleteMemoryScoped(projectId, key);
    } else {
      this.store.deleteMemory(key);
    }
  }

  // ─── Context Injection ──────────────────────────────────────

  /**
   * 构建注入 AgentLoop system prompt 的记忆上下文。
   * 包含 project memory + 最近的关键决策 + 用户偏好。
   *
   * 任务2 上下文隔离（默认隔离，显式共享）：projectId 存在时只注入
   * 「该项目的 per-project 记忆文件 + 该项目 scope 的 DB 行」；全局行与全局
   * CLAUDE_MEMORY.md 只在显式 global 调用（无 projectId）时注入。此前
   * mergeScopedAndGlobal 会把其他项目对话自动提取的全局 key_decision /
   * preference 行合进每个项目的 prompt——已删除该合并。
   *
   * STATUS: WIRED.
   * The Electron main process appends this context to the skillPrompt /
   * resolvedSystemPrompt before each chat turn, so recorded key decisions,
   * project memory, and user preferences now flow back into the agent. The
   * scenario runtime additionally builds its own per-step context
   * (ScenarioWorkflowService.scenarioMemoryContext).
   */
  buildMemoryContext(projectId?: string): string {
    const parts: string[] = [];

    const projectMemory = this.loadProjectMemory(projectId);
    if (projectMemory.trim()) {
      parts.push('## Project Memory\n' + projectMemory.trim());
    }

    const byUpdatedDesc = (a: MemoryEntry, b: MemoryEntry) => b.updatedAt - a.updatedAt;
    const decisions = this.store.getMemoryByCategory('key_decision', projectId).sort(byUpdatedDesc).slice(0, 10);
    if (decisions.length > 0) {
      parts.push(
        '## Recent Key Decisions\n' +
        decisions.map((d) => `- ${new Date(d.updatedAt).toLocaleDateString()}: ${d.value}`).join('\n')
      );
    }

    const prefs = this.store.getMemoryByCategory('preference', projectId).sort(byUpdatedDesc).slice(0, 50);
    if (prefs.length > 0) {
      parts.push(
        '## User Preferences\n' +
        prefs.map((p) => `- ${p.key.replace('pref:', '')}: ${p.value}`).join('\n')
      );
    }

    if (parts.length === 0) return '';
    return '\n\n---\n\n' + parts.join('\n\n');
  }
}
