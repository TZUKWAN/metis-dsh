/**
 * StreamingMarkdown — dsh-style incremental rendering contract:
 * frozen blocks never re-render on append, non-append updates reset,
 * open code fences stream safely, and the settled render degrades to a
 * single full-document SafeMarkdown pass.
 *
 * @vitest-environment jsdom
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamingMarkdown, splitMarkdownBlocks } from '../../src/presentation/StreamingMarkdown';

// Render-count spy: records every SafeMarkdown render's content in order.
const { renderLog } = vi.hoisted(() => ({ renderLog: [] as string[] }));

vi.mock('../../src/presentation/SafeMarkdown', () => ({
  SafeMarkdown: (props: { content: string }) => {
    renderLog.push(props.content);
    return <div data-testid="safe-markdown">{props.content}</div>;
  },
}));

afterEach(() => {
  cleanup();
  renderLog.length = 0;
});

describe('splitMarkdownBlocks', () => {
  it('splits top-level blocks with absolute source offsets', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const blocks = splitMarkdownBlocks(text);
    expect(blocks).toHaveLength(3);
    expect(text.slice(blocks[0]!.start, blocks[0]!.end)).toBe('First paragraph.');
    expect(text.slice(blocks[1]!.start, blocks[1]!.end)).toBe('Second paragraph.');
    expect(text.slice(blocks[2]!.start, blocks[2]!.end)).toBe('Third paragraph.');
  });

  it('keeps a fenced code block with blank lines atomic', () => {
    const text = 'Intro.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro.';
    const blocks = splitMarkdownBlocks(text);
    expect(blocks).toHaveLength(3);
    expect(text.slice(blocks[1]!.start, blocks[1]!.end)).toContain('const a = 1;');
    expect(text.slice(blocks[1]!.start, blocks[1]!.end)).toContain('const b = 2;');
  });

  it('treats an unclosed (streaming) fence as one growing block', () => {
    const text = 'Intro.\n\n```py\nprint("hi")';
    const blocks = splitMarkdownBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(text.slice(blocks[1]!.start)).toBe('```py\nprint("hi")');
  });

  it('returns a single whole-document block for empty or unparseable input shapes', () => {
    expect(splitMarkdownBlocks('')).toHaveLength(0);
    expect(splitMarkdownBlocks('plain text')).toEqual([{ start: 0, end: 10 }]);
  });
});

describe('StreamingMarkdown incremental rendering', () => {
  it('does not re-render frozen blocks when new blocks are appended', () => {
    const initial = 'Block one.\n\nBlock two.\n\nBlock three.\n\nBlock four.';
    const { rerender } = render(<StreamingMarkdown text={initial} streaming locale="en" />);
    expect(renderLog).toEqual(['Block one.', 'Block two.', 'Block three.', 'Block four.']);

    renderLog.length = 0;
    rerender(<StreamingMarkdown text={`${initial}\n\nBlock five.`} streaming locale="en" />);
    // Only the brand-new block renders; all earlier blocks stay frozen.
    expect(renderLog).toEqual(['Block five.']);
  });

  it('re-renders only the growing tail block while tokens append', () => {
    const initial = 'Block one.\n\nBlock two.\n\nTail starts';
    const { rerender } = render(<StreamingMarkdown text={initial} streaming locale="en" />);
    renderLog.length = 0;

    rerender(<StreamingMarkdown text={`${initial} and grows`} streaming locale="en" />);
    expect(renderLog).toEqual(['Tail starts and grows']);
  });

  it('re-renders changed blocks when the update is not append-only', () => {
    const initial = 'Alpha.\n\nBeta.';
    const { rerender } = render(<StreamingMarkdown text={initial} streaming locale="en" />);
    renderLog.length = 0;

    // Non-append reset: the whole document changed.
    rerender(<StreamingMarkdown text={'Gamma.\n\nDelta.'} streaming locale="en" />);
    expect(renderLog).toEqual(['Gamma.', 'Delta.']);
  });

  it('streams an open code fence without breaking earlier blocks', () => {
    const initial = 'Here is code:\n\n```js\nconst a = 1;';
    const { rerender, getByText } = render(
      <StreamingMarkdown text={initial} streaming locale="en" />,
    );
    expect(getByText('Here is code:')).toBeDefined();

    renderLog.length = 0;
    rerender(<StreamingMarkdown text={`${initial}\nconst b = 2;`} streaming locale="en" />);
    // The intro paragraph stays frozen; only the growing fence re-renders.
    expect(renderLog).toEqual(['```js\nconst a = 1;\nconst b = 2;']);
  });

  it('renders the streaming caret only while streaming', () => {
    const { queryByTestId, rerender } = render(
      <StreamingMarkdown text="Live." streaming locale="en" />,
    );
    expect(queryByTestId('streaming-caret')).not.toBeNull();
    renderLog.length = 0;
    rerender(<StreamingMarkdown text="Live." streaming={false} locale="en" />);
    expect(queryByTestId('streaming-caret')).toBeNull();
  });

  it('settled render is a single full-document SafeMarkdown pass', () => {
    renderLog.length = 0;
    const text = 'Part one.\n\nPart two.';
    const { getAllByTestId } = render(
      <StreamingMarkdown text={text} streaming={false} locale="en" />,
    );
    expect(getAllByTestId('safe-markdown')).toHaveLength(1);
    expect(renderLog).toEqual([text]);
  });

  it('applies the shared source transform before splitting', () => {
    const transform = (value: string) => value.replace(/dois/ig, 'LINKS');
    const { getByText } = render(
      <StreamingMarkdown text="see dois here" streaming locale="en" transform={transform} />,
    );
    expect(getByText('see LINKS here')).toBeDefined();
  });
});
