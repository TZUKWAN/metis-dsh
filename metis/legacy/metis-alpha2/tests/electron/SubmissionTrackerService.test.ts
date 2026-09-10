/**
 * SubmissionTrackerService — 投稿管理（T20）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubmissionTrackerService } from '../../electron/SubmissionTrackerService.js';

let tmpDir: string;
let service: SubmissionTrackerService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-subs-'));
  service = new SubmissionTrackerService(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SubmissionTrackerService', () => {
  it('登记投稿并按项目过滤', () => {
    service.create({ title: '基层治理创新研究', journal: '社会学研究', projectId: 'p-1' });
    service.create({ title: '另一篇', journal: '其他期刊', projectId: 'p-2' });
    expect(service.list('p-1')).toHaveLength(1);
    expect(service.list('p-1')[0]!.journal).toBe('社会学研究');
    expect(service.list()).toHaveLength(2);
  });

  it('空标题或空期刊拒绝创建', () => {
    expect(service.create({ title: '', journal: '期刊' })).toBeNull();
    expect(service.create({ title: '标题', journal: '' })).toBeNull();
  });

  it('状态流转与持久化', () => {
    const record = service.create({ title: '论文A', journal: '期刊B' })!;
    const reloaded = new SubmissionTrackerService(tmpDir);
    expect(reloaded.updateStatus(record.id, 'revise')!.status).toBe('revise');
  });

  it('退修意见逐条管理与修改说明信生成', () => {
    const record = service.create({ title: '论文C', journal: '期刊D' })!;
    service.addComment(record.id, '研究设计部分需说明内生性处理');
    service.addComment(record.id, '表3 与正文数字不一致');
    const withComments = service.list()[0]!;
    expect(withComments.comments).toHaveLength(2);

    service.resolveComment(record.id, withComments.comments[0]!.id, true, '已在研究设计节补充工具变量说明');
    const letter = service.buildResponseLetter(record.id)!;
    expect(letter).toContain('修改说明');
    expect(letter).toContain('意见 1：研究设计部分需说明内生性处理');
    expect(letter).toContain('已按意见修改');
    expect(letter).toContain('工具变量说明');
    expect(letter).toContain('（尚未处理）'); // 第二条未处理
  });

  it('删除投稿', () => {
    const record = service.create({ title: '待删', journal: '期刊' })!;
    expect(service.delete(record.id)).toBe(true);
    expect(service.list()).toHaveLength(0);
  });
});
