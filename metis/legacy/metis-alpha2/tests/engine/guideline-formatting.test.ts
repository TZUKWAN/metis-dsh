import { describe, expect, it } from 'vitest';
import { parseGuidelineFormatting } from '../../engine/outcomes/GuidelineFormatting.js';

describe('parseGuidelineFormatting', () => {
  it('parses body font, size, line spacing and first-line indent', () => {
    const result = parseGuidelineFormatting('正文用宋体小四，1.5倍行距，首行缩进2字符。');
    expect(result.config.body).toMatchObject({
      fontFamily: '宋体',
      fontSizePt: 12,
      lineSpacing: 1.5,
      firstLineIndentChars: 2,
    });
    expect(result.matched.length).toBeGreaterThanOrEqual(1);
    expect(result.unclear).toEqual([]);
  });

  it('parses numbered headings into the heading slots', () => {
    const result = parseGuidelineFormatting('一级标题黑体三号居中。二级标题楷体四号。');
    expect(result.config.headings?.[1]).toMatchObject({ fontFamily: '黑体', fontSizePt: 16, align: 'center' });
    expect(result.config.headings?.[2]).toMatchObject({ fontFamily: '楷体', fontSizePt: 14 });
  });

  it('parses page margins from combined and per-side forms', () => {
    const combined = parseGuidelineFormatting('页边距上下2.5cm，左右3.0cm');
    expect(combined.config.page).toMatchObject({ marginTopCm: 2.5, marginBottomCm: 2.5, marginLeftCm: 3, marginRightCm: 3 });

    const perSide = parseGuidelineFormatting('上边距2.54厘米，下边距2.54厘米，左边距3.17厘米，右边距3.17厘米');
    expect(perSide.config.page).toMatchObject({ marginTopCm: 2.54, marginRightCm: 3.17 });
  });

  it('does not misapply reference/caption rules to the body', () => {
    const result = parseGuidelineFormatting('参考文献用宋体五号。图题居中。正文两端对齐。');
    expect(result.config.body).toMatchObject({ align: 'justify' });
    expect(result.config.body?.fontSizePt).toBeUndefined();
  });

  it('reports fixed-point spacing and unmappable sentences as unclear', () => {
    const result = parseGuidelineFormatting('正文行距采用固定值20磅。正文行距为1.5倍。');
    expect(result.unclear.some((item) => item.includes('固定值'))).toBe(true);
    expect(result.config.body?.lineSpacing).toBe(1.5);
  });

  it('supports point-value sizes and explicit alignment words', () => {
    const result = parseGuidelineFormatting('正文宋体12磅，两端对齐。');
    expect(result.config.body).toMatchObject({ fontFamily: '宋体', fontSizePt: 12, align: 'justify' });
  });

  it('returns an empty config for text without formatting rules', () => {
    const result = parseGuidelineFormatting('本刊为月刊，接受第一作者为副高以上职称的投稿。');
    expect(Object.keys(result.config)).toEqual([]);
    expect(result.matched).toEqual([]);
  });
});
