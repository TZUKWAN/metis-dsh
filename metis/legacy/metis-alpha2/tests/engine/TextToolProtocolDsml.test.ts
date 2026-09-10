import { describe, expect, it } from 'vitest';
import { parseDsmlToolCalls, stripTextToolMarkup } from '../../engine/tools/TextToolProtocol.js';

// 2026-08-24 刘总现场日志中的真实 DeepSeek DSML 泄漏格式。
const REAL_LEAK = [
  '名称已更新。现在添加描述。',
  '',
  '<｜｜DSML｜｜tool_calls>',
  '<｜｜DSML｜｜invoke name="scenario_apply_update">',
  '<｜｜DSML｜｜parameter name="fields" string="false">{"description": "面向在站博士后研究人员的中国博士后科学基金面上资助申报书撰写助手。"}</｜｜DSML｜｜parameter>',
  '</｜｜DSML｜｜invoke>',
  '</｜｜DSML｜｜tool_calls>',
].join('\n');

describe('parseDsmlToolCalls', () => {
  it('parses the real-world DeepSeek DSML leak with structured JSON payload', () => {
    const calls = parseDsmlToolCalls(REAL_LEAK);
    expect(calls.length).toBe(1);
    expect(calls[0]!.name).toBe('scenario_apply_update');
    const fields = calls[0]!.arguments.fields as { description: string };
    expect(fields.description).toContain('面向在站博士后研究人员');
  });

  it('keeps string="true" parameters verbatim', () => {
    const text = [
      '<｜｜DSML｜｜invoke name="web_search">',
      '<｜｜DSML｜｜parameter name="query" string="true">中国博士后科学基金 申报书 字数要求</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜parameter name="maxResults" string="false">8</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
    ].join('\n');
    const calls = parseDsmlToolCalls(text);
    expect(calls.length).toBe(1);
    expect(calls[0]!.name).toBe('web_search');
    expect(calls[0]!.arguments.query).toContain('博士后科学基金');
    expect(calls[0]!.arguments.maxResults).toBe(8);
  });

  it('parses multiple invokes in one message', () => {
    const text = [
      '<｜｜DSML｜｜invoke name="scenario_apply_update">',
      '<｜｜DSML｜｜parameter name="fields" string="false">{"name":"A场景"}</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
      '<｜｜DSML｜｜invoke name="scenario_apply_update">',
      '<｜｜DSML｜｜parameter name="fields" string="false">{"description":"这是第二个调用的描述内容，超过二十个字。"}</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜invoke>',
    ].join('\n');
    expect(parseDsmlToolCalls(text).length).toBe(2);
  });

  it('tolerates ASCII pipes and whitespace variants', () => {
    const text = '< | DSML | invoke name="t">< | DSML | parameter name="x" string="true">v< / | DSML | parameter>< / | DSML | invoke>';
    const calls = parseDsmlToolCalls(text.replace(/ \| /gu, '｜'));
    expect(calls.length).toBe(1);
  });

  it('returns empty for content without DSML or incomplete blocks', () => {
    expect(parseDsmlToolCalls('普通正文，没有工具调用。')).toEqual([]);
    expect(parseDsmlToolCalls('<｜｜DSML｜｜invoke name="x">').length).toBe(0);
  });
});

describe('stripTextToolMarkup with DSML', () => {
  it('removes DSML blocks from user-visible text', () => {
    const stripped = stripTextToolMarkup(REAL_LEAK);
    expect(stripped).not.toContain('DSML');
    expect(stripped).not.toContain('面向在站博士后研究人员');
    expect(stripped).toContain('名称已更新');
  });

  it('still strips legacy <tool_call> markup', () => {
    expect(stripTextToolMarkup('前言<tool_call>{"x":1}</tool_call>后记')).toBe('前言后记');
  });
});
