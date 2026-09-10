/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeMarkdown, sanitizeMarkdownUrl } from '../../src/presentation/SafeMarkdown.js';

describe('SafeMarkdown presentation boundary', () => {
  const originalMetis = window.metis;

  afterEach(() => {
    window.metis = originalMetis;
  });

  it('blocks metadata-bearing HTTPS destinations without exposing or silently rewriting them', () => {
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    window.metis = { openExternal } as unknown as typeof window.metis;

    const raw = 'https://researcher:password@example.test/private/path?token=url-secret&view=full#private-fragment';
    const { container } = render(
      <SafeMarkdown content={`[${raw}](${raw})`} uiMode="normal" locale="en" />,
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(container.querySelector('[href]')).toBeNull();
    expect(container.textContent).toContain('External link blocked');
    const observable = `${container.textContent ?? ''}\n${container.innerHTML}`;
    for (const marker of ['researcher', 'password', 'url-secret', 'view=full', 'private-fragment']) {
      expect(observable).not.toContain(marker);
    }

    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens only a clean canonical HTTPS destination through the preload API', () => {
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    window.metis = { openExternal } as unknown as typeof window.metis;
    const { container } = render(
      <SafeMarkdown content={'[source](https://例子.测试/paper)'} uiMode="normal" locale="en" />,
    );

    const link = screen.getByRole('link');
    expect(link.textContent).toBe('source');
    expect(link.getAttribute('href')).toBe('https://xn--fsqu00a.xn--0zwm56d/paper');
    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://xn--fsqu00a.xn--0zwm56d/paper');
    expect(container.innerHTML).not.toContain('例子');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,secret',
    'file:///C:/Users/researcher/private.pdf',
    'http://example.test/insecure',
    '/relative/private-path',
  ])('does not expose or open blocked destination %s', (destination) => {
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    window.metis = { openExternal } as unknown as typeof window.metis;
    const { container } = render(
      <SafeMarkdown content={`[blocked link](${destination})`} uiMode="normal" locale="en" />,
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(container.querySelector('[href]')).toBeNull();
    fireEvent.click(screen.getByText('External link blocked'));
    expect(openExternal).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toContain(destination);
  });

  it('never creates an image request and scrubs the alternative text', () => {
    const { container } = render(
      <SafeMarkdown
        content={'![Authorization: Bearer image-secret-123456789](https://tracker.test/pixel.png?token=image-query-secret)'}
        uiMode="diagnostic"
        locale="en"
      />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[src]')).toBeNull();
    expect(container.textContent).toContain('[REDACTED]');
    expect(container.innerHTML).not.toContain('image-secret-123456789');
    expect(container.innerHTML).not.toContain('image-query-secret');
    expect(container.innerHTML).not.toContain('tracker.test');
  });

  it('uses a fixed neutral image label in normal mode and never exposes raw alt text through ARIA', () => {
    const { container } = render(
      <SafeMarkdown
        content={'![C:\\Users\\researcher\\private-study.png](https://tracker.test/pixel.png)'}
        uiMode="normal"
        locale="en"
      />,
    );

    const replacement = screen.getByRole('img');
    expect(replacement.getAttribute('aria-label')).toBe('Remote image blocked');
    expect(replacement.textContent).toBe('Image blocked');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[src]')).toBeNull();
    expect(container.innerHTML).not.toContain('researcher');
    expect(container.innerHTML).not.toContain('private-study');
    expect(container.innerHTML).not.toContain('tracker.test');
  });

  it('removes local absolute paths from every normal-mode observable channel', () => {
    const raw = [
      'Windows C:\\Users\\researcher\\private\\notes.md',
      'UNC \\\\private-server\\secret-share\\dataset.csv',
      'POSIX /home/researcher/private/analysis.R',
      'File file:///C:/Users/researcher/private/source.pdf',
    ].join('\n\n');
    const { container } = render(
      <SafeMarkdown content={raw} uiMode="normal" locale="en" />,
    );

    const observable = `${container.textContent ?? ''}\n${container.innerHTML}`;
    expect(observable).toContain('[Local path hidden]');
    for (const marker of [
      'C:\\Users',
      'private-server',
      'secret-share',
      '/home/researcher',
      'file://',
      'source.pdf',
    ]) {
      expect(observable).not.toContain(marker);
    }
  });

  it('removes UNC host and share names after diagnostic Markdown parsing', () => {
    const { container } = render(
      <SafeMarkdown
        content={'UNC \\\\private-server\\secret-share\\dataset.csv'}
        uiMode="diagnostic"
        locale="en"
      />,
    );

    const observable = `${container.textContent ?? ''}\n${container.innerHTML}`;
    expect(observable).toContain('\\\\[HOST]\\[SHARE]');
    expect(observable).not.toContain('private-server');
    expect(observable).not.toContain('secret-share');
  });

  it('cancels auxiliary-click and context-menu navigation paths', () => {
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    window.metis = { openExternal } as unknown as typeof window.metis;
    render(
      <SafeMarkdown content={'[source](https://example.test/paper)'} uiMode="normal" locale="en" />,
    );

    const link = screen.getByRole('link');
    const auxiliaryClick = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    expect(link.dispatchEvent(auxiliaryClick)).toBe(false);
    expect(link.dispatchEvent(contextMenu)).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('drops raw HTML and never preserves Markdown title metadata', () => {
    const { container } = render(
      <SafeMarkdown
        content={'<img src="https://tracker.test/pixel?token=html-secret" aria-label="private-alt">\n\n[safe](https://example.test/paper "Authorization: Bearer title-secret-123456789")'}
        uiMode="normal"
        locale="en"
      />,
    );

    const link = screen.getByRole('link');
    expect(link.getAttribute('title')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[src]')).toBeNull();
    expect(container.querySelector('[data-secret]')).toBeNull();
    const observable = `${container.textContent ?? ''}\n${container.innerHTML}`;
    for (const marker of ['tracker.test', 'html-secret', 'private-alt', 'title-secret-123456789']) {
      expect(observable).not.toContain(marker);
    }
  });

  it('scrubs secret-bearing plain text in both normal and diagnostic modes', () => {
    for (const uiMode of ['normal', 'diagnostic'] as const) {
      const { container, unmount } = render(
        <SafeMarkdown
          content={'Authorization: Bearer plain-secret-123456789\n\napi_key=assignment-secret-123456789'}
          uiMode={uiMode}
          locale="en"
        />,
      );
      expect(container.textContent).toContain('[REDACTED]');
      expect(container.innerHTML).not.toContain('plain-secret-123456789');
      expect(container.innerHTML).not.toContain('assignment-secret-123456789');
      unmount();
    }
  });

  it('normalizes clean Unicode hosts but rejects query and fragment metadata', () => {
    expect(sanitizeMarkdownUrl('https://例子.测试/path')).toBe('https://xn--fsqu00a.xn--0zwm56d/path');
    expect(sanitizeMarkdownUrl('https://例子.测试/path?token%3Dencoded-secret#fragment')).toBeNull();
  });
});
