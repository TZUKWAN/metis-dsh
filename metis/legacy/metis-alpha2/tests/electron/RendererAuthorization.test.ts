import { describe, expect, it } from 'vitest';
import { isAuthorizedRendererMainFrame } from '../../electron/RendererAuthorization.js';

const base = {
  senderWindowMatches: true,
  senderFrameMatches: true,
  senderFrameUrl: 'file:///C:/app/dist/index.html',
  expectedEntryUrl: 'file:///C:/app/dist/index.html',
};

describe('privileged renderer main-frame authorization', () => {
  it('allows only the expected main window main frame', () => {
    expect(isAuthorizedRendererMainFrame(base)).toBe(true);
  });

  it('allows a client-side hash without broadening the document entry', () => {
    expect(isAuthorizedRendererMainFrame({
      ...base,
      senderFrameUrl: 'file:///C:/app/dist/index.html#/chat',
    })).toBe(true);
  });

  it.each([
    { senderWindowMatches: false },
    { senderFrameMatches: false },
    { senderFrameUrl: 'file:///C:/app/dist/other.html' },
    { senderFrameUrl: 'file:///C:/app/dist/index.html?unexpected=1' },
    { senderFrameUrl: 'https://attacker.test/index.html' },
    { senderFrameUrl: 'javascript:alert(1)' },
    { senderFrameUrl: 'not a url' },
    { expectedEntryUrl: 'not a url' },
  ])('rejects unauthorized context %#', (patch) => {
    expect(isAuthorizedRendererMainFrame({ ...base, ...patch })).toBe(false);
  });

  it('supports an exact Vite development entry while rejecting another port', () => {
    expect(isAuthorizedRendererMainFrame({
      ...base,
      senderFrameUrl: 'http://127.0.0.1:5173/#/chat',
      expectedEntryUrl: 'http://127.0.0.1:5173/',
    })).toBe(true);
    expect(isAuthorizedRendererMainFrame({
      ...base,
      senderFrameUrl: 'http://127.0.0.1:5174/',
      expectedEntryUrl: 'http://127.0.0.1:5173/',
    })).toBe(false);
  });
});
