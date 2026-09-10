import { describe, expect, it } from 'vitest';
import { parseBingCnResults } from '../../engine/tools/builtin/web-tools.js';

// 回归：web_search 主源 DDG 在境内不可达，cn.bing.com 免费兜底必须能解析结果页。
describe('Bing CN fallback parsing', () => {
  const fixture = [
    '<ol id="b_results">',
    '<li class="b_algo"><h2><a href="https://www.chinapostdoctor.org.cn/" target="_blank">中国博士后科学基金会 <strong>基金</strong>申报</a></h2>',
    '<p>申报条件与流程说明&nbsp;——含<strong>资助标准</strong>。</p><div class="b_attrib">example.com</div></li>',
    '<li class="b_algo"><h2><a href="https://example2.org/">第二条</a></h2><p class="b_lineclamp">另一条摘要。</p></li>',
    '</ol>',
  ].join('');

  it('parses b_algo items into title/url/snippet and strips tags/entities', () => {
    const results = parseBingCnResults(fixture, 10);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ url: 'https://www.chinapostdoctor.org.cn/', title: '中国博士后科学基金会 基金申报' });
    expect(results[0].snippet).toContain('申报条件与流程说明');
    expect(results[1].title).toBe('第二条');
  });

  it('respects maxResults', () => {
    expect(parseBingCnResults(fixture, 1)).toHaveLength(1);
  });

  it('returns empty array for pages without b_algo items', () => {
    expect(parseBingCnResults('<html><body>captcha</body></html>', 10)).toEqual([]);
  });
});
