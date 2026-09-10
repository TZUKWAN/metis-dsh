/**
 * Task 3 test — deprecated/dead IPC surface report (DoD item 11).
 *
 * Asserts the Dead Surface Report exists, is consistent with the live preload
 * API snapshot (nothing reported dead has silently vanished, nothing live is
 * misreported), and that the autonomous deprecated set matches the scan.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPORT = path.join(__dirname, '..', '..', 'docs', 'reports', 'task3-dead-surface.json');
const SNAPSHOT = path.join(__dirname, 'fixtures', 'metis-api-snapshot.json');

describe('dead surface report (item 11)', () => {
  it('exists and covers every zero-reference method exactly', () => {
    expect(fs.existsSync(REPORT)).toBe(true);
    const report = JSON.parse(fs.readFileSync(REPORT, 'utf8')) as {
      deprecatedNow: { methods: string[] };
      testOnlySurface: { methods: string[] };
      deadCandidates: { methods: string[] };
    };
    const snapshot = new Set(JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) as string[]);
    const reported = [
      ...report.deprecatedNow.methods,
      ...report.testOnlySurface.methods,
      ...report.deadCandidates.methods,
    ].sort();
    for (const name of reported) {
      // everything reported must still exist in the live API surface
      expect(snapshot.has(name), `reported dead but live: ${name}`).toBe(true);
    }
  });

  it('marks the zero-reference autonomous surface deprecated without deleting it', () => {
    const report = JSON.parse(fs.readFileSync(REPORT, 'utf8')) as {
      deprecatedNow: { methods: string[] };
      policy: string;
    };
    // autonomousStart is NOT in this list on purpose: ChatPage.tsx calls it.
    expect(report.deprecatedNow.methods).toContain('autonomousControl');
    expect(report.deprecatedNow.methods).toContain('autonomousResumeSession');
    expect(report.deprecatedNow.methods).toContain('onAutonomousProgress');
    expect(report.deprecatedNow.methods).not.toContain('autonomousStart');
    expect(report.policy).toMatch(/No code deleted/i);
  });
});
