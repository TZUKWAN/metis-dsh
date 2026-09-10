/**
 * MethodLibraryService — 方法库（T4）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MethodLibraryService } from '../../electron/MethodLibraryService.js';

let tmpDir: string;
let service: MethodLibraryService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-methods-'));
  service = new MethodLibraryService(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('MethodLibraryService', () => {
  it('创建方法并从步骤模板提取参数占位', () => {
    const method = service.createMethod({
      name: '文献缺口分析',
      description: '对某主题做缺口分析',
      steps: [
        { template: '检索关于{{主题}}的核心文献' },
        { template: '基于{{主题}}提出三个研究问题，并考虑{{方法偏好}}视角' },
      ],
    })!;
    expect(method).not.toBeNull();
    expect(method.params).toEqual({ 主题: '', 方法偏好: '' });
    expect(method.steps).toHaveLength(2);
    expect(method.runCount).toBe(0);
  });

  it('无效输入（空名或空步骤）返回 null', () => {
    expect(service.createMethod({ name: '', steps: [{ template: 'x' }] })).toBeNull();
    expect(service.createMethod({ name: '有名', steps: [] })).toBeNull();
  });

  it('渲染步骤时替换参数占位，缺失参数给出提示', () => {
    const method = service.createMethod({
      name: '渲染测试',
      steps: [{ template: '分析{{主题}}并用{{方法}}视角' }],
    })!;
    const rendered = service.renderSteps(method.id, { 主题: '乡村振兴', 方法: '制度分析' })!;
    expect(rendered[0]!.instruction).toBe('分析乡村振兴并用制度分析视角');

    const partial = service.renderSteps(method.id, { 主题: '乡村振兴' })!;
    expect(partial[0]!.instruction).toContain('请补充：方法');
  });

  it('运行记录计数、更新使用统计并持久化', () => {
    const method = service.createMethod({
      name: '运行统计',
      steps: [{ template: '执行{{任务}}' }],
    })!;
    service.recordRun(method.id, 'proj-1', { 任务: '综述' }, 'applied');
    service.recordRun(method.id, null, { 任务: '编码' }, 'cancelled');

    const reloaded = new MethodLibraryService(tmpDir);
    const persisted = reloaded.listMethods().find((m) => m.id === method.id)!;
    expect(persisted.runCount).toBe(2);
    expect(persisted.lastRunAt).not.toBeNull();
    const runs = reloaded.listRuns(method.id);
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.outcome).sort()).toEqual(['applied', 'cancelled']);
  });

  it('更新方法（改名/改步骤/开关分步确认）并重算参数', () => {
    const method = service.createMethod({
      name: '原名',
      steps: [{ template: '步骤A {{参数}}' }],
    })!;
    const updated = service.updateMethod(method.id, {
      name: '新名',
      steps: [{ template: '新步骤 {{参数甲}} {{参数乙}}' }],
      confirmEachStep: true,
    })!;
    expect(updated.name).toBe('新名');
    expect(updated.confirmEachStep).toBe(true);
    expect(Object.keys(updated.params).sort()).toEqual(['参数乙', '参数甲'].sort());
  });

  it('删除方法同时清理其运行记录', () => {
    const method = service.createMethod({ name: '待删', steps: [{ template: 'x' }] })!;
    service.recordRun(method.id, null, {}, 'applied');
    expect(service.deleteMethod(method.id)).toBe(true);
    expect(service.listRuns(method.id)).toHaveLength(0);
    expect(service.getMethod(method.id)).toBeNull();
  });
});

describe('MethodLibraryService — 内置方法（T12/T13）', () => {
  it('首次初始化预置三个内置方法且幂等', () => {
    const names = service.listMethods().map((m) => m.name);
    expect(names).toContain('文献综述矩阵');
    expect(names).toContain('研究缺口分析');
    expect(names).toContain('扎根编码辅助');
    // 再次实例化（模拟重启）不重复。
    const again = new MethodLibraryService(tmpDir);
    expect(again.listMethods().filter((m) => m.id === 'builtin-review-matrix')).toHaveLength(1);
  });

  it('内置方法删除后不被复活', () => {
    expect(service.deleteMethod('builtin-review-matrix')).toBe(true);
    const again = new MethodLibraryService(tmpDir);
    expect(again.listMethods().some((m) => m.id === 'builtin-review-matrix')).toBe(false);
    expect(again.listMethods().some((m) => m.id === 'builtin-gap-analysis')).toBe(true);
  });

  it('内置方法步骤引用真实工具', () => {
    const review = service.getMethod('builtin-review-matrix')!;
    const allTemplates = review.steps.map((s) => s.template).join(' ');
    expect(allTemplates).toContain('search_paper_text');
    expect(allTemplates).toContain('verify_numbers');
    const coding = service.getMethod('builtin-grounded-coding')!;
    expect(coding.steps.map((s) => s.template).join(' ')).toContain('save_note_code');
    expect(coding.confirmEachStep).toBe(true);
  });
});
