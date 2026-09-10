/**
 * HITLCore tests.
 */

import { describe, it, expect } from 'vitest';
import { ApprovalStore, WRITE_APPROVAL_RULE, DANGEROUS_COMMAND_RULE } from './HITLCore.js';

describe('ApprovalStore', () => {
  it('lists added rules', () => {
    const store = new ApprovalStore();
    store.addRule({ ...WRITE_APPROVAL_RULE });
    store.addRule({ ...DANGEROUS_COMMAND_RULE });
    const rules = store.getRules();
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.id)).toContain('require-write-approval');
  });

  it('enables and disables rules', () => {
    const store = new ApprovalStore();
    store.addRule({ ...WRITE_APPROVAL_RULE });
    expect(store.getRules()[0]?.enabled).toBe(true);

    expect(store.setRuleEnabled('require-write-approval', false)).toBe(true);
    expect(store.getRules()[0]?.enabled).toBe(false);

    expect(store.setRuleEnabled('require-write-approval', true)).toBe(true);
    expect(store.getRules()[0]?.enabled).toBe(true);
  });

  it('returns false when toggling a missing rule', () => {
    const store = new ApprovalStore();
    expect(store.setRuleEnabled('missing-rule', false)).toBe(false);
  });

  it('does not require approval when the matching rule is disabled', () => {
    const store = new ApprovalStore();
    store.addRule({ ...WRITE_APPROVAL_RULE });
    store.setRuleEnabled('require-write-approval', false);
    expect(store.checkRequired('write_file', {}, 'session-1')).toBeNull();
  });

  it('requires approval when the matching rule is enabled', () => {
    const store = new ApprovalStore();
    store.addRule({ ...WRITE_APPROVAL_RULE });
    const request = store.checkRequired('write_file', {}, 'session-1');
    expect(request).not.toBeNull();
    expect(request?.toolName).toBe('write_file');
  });
});
