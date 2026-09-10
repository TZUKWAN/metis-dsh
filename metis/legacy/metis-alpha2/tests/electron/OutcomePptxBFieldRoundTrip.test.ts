/**
 * OutcomePptxService B 方案字段 round-trip 实证。
 *
 * 构造覆盖全部 B 方案视觉字段（元素填充/边框/文字颜色/字号/字体 +
 * 主题 primary/accent/surface/text/titleFont/bodyFont + 页面背景）的文档，
 * 真实导出为 PPTX，再真实导入回来，断言字段保留度；同时把样本写入
 * test-results/ 供 PowerPoint/WPS 实机打开验证。
 */

import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { OutcomePptxService } from '../../electron/OutcomePptxService.js';
import { PptDocumentSchema, type PptDocument } from '../../engine/runtime/OutcomeRuntimeContract.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-pptx-bfield-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const bFieldDocument: PptDocument = {
  type: 'ppt',
  ratio: '16:9',
  theme: {
    primary: '#236c91',
    accent: '#b66c2e',
    surface: '#fdf6ec',
    text: '#183b59',
    titleFont: 'Source Han Serif SC',
    bodyFont: 'Source Han Sans SC',
  },
  templateId: null,
  generationSkillId: null,
  pages: [
    {
      id: 'page-cover',
      title: 'B 方案字段实证',
      pageType: 'cover',
      humanModified: true,
      status: 'complete',
      elements: [
        { id: 'cover-title', type: 'text', x: 4, y: 3, width: 24, height: 4, locked: false, props: { text: 'B 方案字段实证封面', fontSize: 32, fontFamily: 'Source Han Serif SC', textColor: '#236c91', bold: true } },
        { id: 'cover-subtitle', type: 'text', x: 4, y: 8, width: 24, height: 2, locked: false, props: { text: '副标题使用正文字体与正文颜色', fontSize: 14, fontFamily: 'Source Han Sans SC', textColor: '#183b59' } },
        { id: 'cover-rect', type: 'rect', x: 2, y: 12, width: 28, height: 4, locked: false, props: { fillColor: '#236c91', borderColor: '#b66c2e', borderWidth: 2.5 } },
        { id: 'cover-round', type: 'roundRect', x: 26, y: 1, width: 5, height: 5, locked: false, props: { fillColor: '#b66c2e', borderColor: '#183b59', borderWidth: 1 } },
        { id: 'cover-ellipse', type: 'ellipse', x: 1, y: 1, width: 3, height: 3, locked: false, props: { fillColor: '#fdf6ec', borderColor: '#236c91', borderWidth: 3 } },
      ],
    },
    {
      id: 'page-content',
      title: '第二页内容',
      pageType: 'content',
      humanModified: true,
      status: 'complete',
      elements: [
        { id: 'content-heading', type: 'text', x: 2, y: 1, width: 28, height: 3, locked: false, props: { text: '内容页标题', fontSize: 24, fontFamily: 'Source Han Serif SC', textColor: '#183b59' } },
        { id: 'content-body', type: 'text', x: 2, y: 5, width: 14, height: 6, locked: false, props: { text: '正文文本块，验证字体、字号与颜色。', fontSize: 12, fontFamily: 'Source Han Sans SC', textColor: '#183b59' } },
        { id: 'content-line', type: 'line', x: 2, y: 12, width: 28, height: 1, locked: false, props: { borderColor: '#236c91', borderWidth: 1.5 } },
        { id: 'content-arrow', type: 'arrow', x: 18, y: 6, width: 6, height: 2, locked: false, props: { borderColor: '#b66c2e', borderWidth: 2 } },
        { id: 'content-table', type: 'table', x: 2, y: 14, width: 20, height: 3, locked: false, props: { rows: [['字段', '导出'], ['fillColor', 'solidFill']] } },
      ],
    },
  ],
};

describe('OutcomePptxService — B 方案字段 round-trip', () => {
  it('导出→导入保留主题、元素样式与布局，样本可供实机打开', async () => {
    const service = new OutcomePptxService();
    const exportPath = path.join(tmpDir, 'bfield-sample.pptx');
    const exported = await service.exportFile(exportPath, bFieldDocument);
    expect(exported.bytes.byteLength).toBeGreaterThan(0);
    // 表格元素按设计诚实降级为占位形状；除此之外不允许任何导出警告。
    const allowedPlaceholder = (code: string) => code === 'unsupported_shape';
    expect(exported.warnings.filter((warning) => !allowedPlaceholder(warning.code))).toEqual([]);

    // 样本复制到工作区 test-results，供 PowerPoint/WPS 实机打开验证。
    const sampleDir = path.resolve(process.cwd(), 'test-results');
    mkdirSync(sampleDir, { recursive: true });
    copyFileSync(exportPath, path.join(sampleDir, 'pptx-bfield-sample.pptx'));

    const imported = await service.importFile(exportPath);
    expect(imported.warnings.filter((warning) => !allowedPlaceholder(warning.code))).toEqual([]);

    const document = PptDocumentSchema.parse(imported.document);
    expect(document.ratio).toBe('16:9');

    // 主题五要素 + 双字体 round-trip。
    expect(String(document.theme.primary).toLowerCase()).toBe('#236c91');
    expect(String(document.theme.accent).toLowerCase()).toBe('#b66c2e');
    expect(String(document.theme.surface).toLowerCase()).toBe('#fdf6ec');
    expect(String(document.theme.text).toLowerCase()).toBe('#183b59');
    expect(document.theme.titleFont).toBe('Source Han Serif SC');
    expect(document.theme.bodyFont).toBe('Source Han Sans SC');

    expect(document.pages).toHaveLength(2);
    // 导入侧按 ppt-{page}-element-{n} 重新编号（外部 PPTX 无模型 ID 概念），
    // 因此按 B 方案特征值定位元素而不是原始 ID。
    const allElements = document.pages.flatMap((page) => page.elements);
    const withBorderWidth = (width: number) => allElements.find((element) => Math.abs(Number(element.props.borderWidth) - width) < 0.01);

    // 文本元素：字号、字体、文字颜色。
    const title = allElements.find((element) => element.props.fontSize === 32);
    expect(title?.props.text).toBe('B 方案字段实证封面');
    expect(title?.props.fontFamily).toBe('Source Han Serif SC');
    expect(String(title?.props.textColor).toLowerCase()).toBe('#236c91');

    // 矩形：填充色、边框色、边框宽 2.5 唯一。
    const rect = withBorderWidth(2.5);
    expect(String(rect?.props.fillColor).toLowerCase()).toBe('#236c91');
    expect(String(rect?.props.borderColor).toLowerCase()).toBe('#b66c2e');

    // 圆角矩形与椭圆的 B 字段。
    expect(String(withBorderWidth(1)?.props.fillColor).toLowerCase()).toBe('#b66c2e');
    expect(withBorderWidth(3)?.props.borderWidth).toBeCloseTo(3, 3);

    // 线与箭头：边框色与宽度。
    expect(String(withBorderWidth(1.5)?.props.borderColor).toLowerCase()).toBe('#236c91');
    expect(String(withBorderWidth(2)?.props.borderColor).toLowerCase()).toBe('#b66c2e');

    // 布局坐标在 32×18 Grid 上闭环。
    expect(title?.x).toBe(4);
    expect(title?.y).toBe(3);
    expect(rect?.width).toBe(28);
    expect(rect?.height).toBe(4);
  });
});
