/**
 * Tests for navConfig (O11): workspace orientation tooltips.
 */

import { describe, it, expect } from 'vitest';
import {
  getTopLevelNav,
  getPrimaryWorkspaceNav,
  getPrimaryResearchNav,
  getPreferenceNav,
} from '../../src/shell/navConfig.js';

describe('navConfig descriptionKey tooltips (O11)', () => {
  it('every top-level entry has a descriptionKey for hover orientation', () => {
    for (const entry of getTopLevelNav()) {
      expect(entry.descriptionKey, `${entry.id} missing descriptionKey`).toBeTruthy();
    }
  });

  it('every primary workspace entry has a descriptionKey', () => {
    for (const entry of getPrimaryWorkspaceNav()) {
      expect(entry.descriptionKey, `${entry.id} missing descriptionKey`).toBeTruthy();
    }
  });

  it('every primary research entry has a descriptionKey', () => {
    for (const entry of getPrimaryResearchNav()) {
      expect(entry.descriptionKey, `${entry.id} missing descriptionKey`).toBeTruthy();
    }
  });

  it('the preference entry has a descriptionKey', () => {
    for (const entry of getPreferenceNav()) {
      expect(entry.descriptionKey, `${entry.id} missing descriptionKey`).toBeTruthy();
    }
  });

  it('descriptionKey is distinct from labelKey (not a redundant tooltip)', () => {
    const all = [
      ...getTopLevelNav(),
      ...getPrimaryWorkspaceNav(),
      ...getPrimaryResearchNav(),
      ...getPreferenceNav(),
    ];
    for (const entry of all) {
      expect(entry.descriptionKey, `${entry.id} tooltip equals label`).not.toBe(entry.labelKey);
    }
  });
});
