import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createLayoutAcceptanceMetadata,
  extractLayoutAcceptanceToken,
  isExpectedLayoutAcceptanceFrame,
  nextLayoutAcceptanceContentSize,
  parseLayoutAcceptanceWindowRequest,
  requireLayoutAcceptanceEnabled,
  requireLayoutAcceptanceRequest,
} from '../../electron/LayoutAcceptance.js';

describe('layout acceptance capability', () => {
  it('extracts only a non-empty dedicated acceptance token', () => {
    expect(extractLayoutAcceptanceToken(['electron', '.'])).toBeNull();
    expect(extractLayoutAcceptanceToken([
      'electron',
      '.',
      '--metis-layout-acceptance=',
    ])).toBeNull();
    expect(extractLayoutAcceptanceToken([
      'electron',
      '.',
      '--metis-layout-acceptance=test-token',
    ])).toBe('test-token');
  });

  it('returns a disabled capability during an ordinary launch', () => {
    expect(createLayoutAcceptanceMetadata(
      null,
      'C:\\normal-profile',
      'C:\\app\\dist\\index.html',
    )).toEqual({ enabled: false });
  });

  it('exposes only a SHA-256 identity for an acceptance launch', () => {
    const metadata = createLayoutAcceptanceMetadata(
      'test-token',
      'C:\\isolated-profile',
      'C:\\app\\dist\\index.html',
    );

    expect(metadata).toEqual({
      enabled: true,
      userDataPath: 'C:\\isolated-profile',
      entryPath: 'C:\\app\\dist\\index.html',
      tokenSha256: createHash('sha256').update('test-token').digest('hex'),
    });
    expect(metadata).not.toHaveProperty('token');
  });

  it('rejects native window control unless the acceptance token is enabled', () => {
    expect(() => requireLayoutAcceptanceEnabled(null)).toThrow(
      'Layout acceptance is not enabled',
    );
    expect(() => requireLayoutAcceptanceEnabled('test-token')).not.toThrow();
  });

  it('accepts only the expected file URL as the acceptance frame', () => {
    const entry = 'C:\\app\\dist\\index.html';
    expect(isExpectedLayoutAcceptanceFrame(
      'file:///C:/app/dist/index.html',
      entry,
    )).toBe(true);
    expect(isExpectedLayoutAcceptanceFrame(
      'file:///C:/app/dist/other.html',
      entry,
    )).toBe(false);
    expect(isExpectedLayoutAcceptanceFrame(
      'https://example.com/index.html',
      entry,
    )).toBe(false);
    expect(isExpectedLayoutAcceptanceFrame('not a URL', entry)).toBe(false);
  });

  it('requires token, live control, main window, main frame, and current dist', () => {
    const valid = {
      token: 'test-token',
      controlEnabled: true,
      senderWindowMatches: true,
      senderFrameMatches: true,
      senderFrameUrl: 'file:///C:/app/dist/index.html',
      expectedEntryPath: 'C:\\app\\dist\\index.html',
    };

    expect(() => requireLayoutAcceptanceRequest(valid)).not.toThrow();
    expect(() => requireLayoutAcceptanceRequest({ ...valid, token: null })).toThrow(
      'Layout acceptance is not enabled',
    );
    expect(() => requireLayoutAcceptanceRequest({
      ...valid,
      controlEnabled: false,
    })).toThrow('no longer enabled');
    expect(() => requireLayoutAcceptanceRequest({
      ...valid,
      senderWindowMatches: false,
    })).toThrow('main window');
    expect(() => requireLayoutAcceptanceRequest({
      ...valid,
      senderFrameMatches: false,
    })).toThrow('main frame');
    expect(() => requireLayoutAcceptanceRequest({
      ...valid,
      senderFrameUrl: 'file:///C:/app/dist/stale.html',
    })).toThrow('current dist entry');
  });

  it('computes a bounded correction from native and renderer measurements', () => {
    expect(nextLayoutAcceptanceContentSize(
      { width: 1000, height: 700 },
      { width: 1000, height: 700 },
      { width: 1002, height: 702 },
      { width: 1002, height: 702 },
    )).toEqual({ width: 998, height: 698 });
    expect(nextLayoutAcceptanceContentSize(
      { width: 1000, height: 700 },
      { width: 998, height: 698 },
      { width: 1000, height: 700 },
      { width: 1000, height: 700 },
    )).toBeNull();
    expect(nextLayoutAcceptanceContentSize(
      { width: 1000, height: 700 },
      { width: 1000, height: 700 },
      { width: 1001, height: 700 },
      { width: 1002, height: 700 },
    )).toEqual({ width: 998, height: 700 });
    expect(nextLayoutAcceptanceContentSize(
      { width: 1000, height: 700 },
      { width: 998, height: 700 },
      { width: 999, height: 701 },
      { width: 1000, height: 700 },
    )).toBeNull();
  });

  it('accepts bounded integer outer and content size requests', () => {
    expect(parseLayoutAcceptanceWindowRequest({
      mode: 'outer',
      width: 1000,
      height: 700,
    })).toEqual({ mode: 'outer', width: 1000, height: 700 });
    expect(parseLayoutAcceptanceWindowRequest({
      mode: 'content',
      width: 1440,
      height: 900,
    })).toEqual({ mode: 'content', width: 1440, height: 900 });
  });

  it.each([
    null,
    { mode: 'viewport', width: 1000, height: 700 },
    { mode: 'outer', width: 999.5, height: 700 },
    { mode: 'outer', width: 639, height: 700 },
    { mode: 'outer', width: 1000, height: 2881 },
  ])('rejects an unsafe native window request: %j', (request) => {
    expect(() => parseLayoutAcceptanceWindowRequest(request)).toThrow();
  });
});
