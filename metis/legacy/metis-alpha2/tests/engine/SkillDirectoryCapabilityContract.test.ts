import { describe, expect, it } from 'vitest';
import {
  FileCapabilityImportRequestSchema,
  FileCapabilityPurposeSchema,
  FileCapabilitySelectionRequestSchema,
} from '../../engine/runtime/FileCapabilityContract.js';

describe('skill directory capability contract', () => {
  it('accepts the dedicated selection purpose', () => {
    expect(FileCapabilityPurposeSchema.safeParse('personalization-skill-directory').success).toBe(true);
    expect(FileCapabilitySelectionRequestSchema.safeParse({
      purpose: 'personalization-skill-directory',
    }).success).toBe(true);
  });

  it('does not allow renderer-imported bytes to impersonate a selected directory', () => {
    expect(FileCapabilityImportRequestSchema.safeParse({
      purpose: 'personalization-skill-directory',
      displayName: 'forged-directory.zip',
      mime: 'application/zip',
      data: Uint8Array.from([1, 2, 3]),
    }).success).toBe(false);
  });

  it('remains strict against extra path and kind assertions', () => {
    expect(FileCapabilitySelectionRequestSchema.safeParse({
      purpose: 'personalization-skill-directory',
      path: 'C:\\private\\skill',
    }).success).toBe(false);
    expect(FileCapabilitySelectionRequestSchema.safeParse({
      purpose: 'personalization-skill-directory',
      kind: 'file',
    }).success).toBe(false);
  });
});
