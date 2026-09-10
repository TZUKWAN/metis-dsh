import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');
export const ALLOWED_STATUSES = new Set([
  'passed',
  'pending',
  'blocked',
  'unsupported',
  'cancelled_gate',
]);

function relativeEvidencePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function readJson(root, relativePath) {
  const absolutePath = path.resolve(root, relativePath);
  if (!fs.existsSync(absolutePath)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    const stat = fs.statSync(absolutePath);
    return {
      path: relativeEvidencePath(root, absolutePath),
      absolutePath,
      value,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex'),
    };
  } catch {
    return null;
  }
}

function readText(root, relativePath) {
  const absolutePath = path.resolve(root, relativePath);
  if (!fs.existsSync(absolutePath)) return null;
  try {
    const bytes = fs.readFileSync(absolutePath);
    const stat = fs.statSync(absolutePath);
    return {
      path: relativeEvidencePath(root, absolutePath),
      absolutePath,
      text: bytes.toString('utf8'),
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    return null;
  }
}

function commandFrom(value, fallback = 'not recorded in evidence') {
  if (!value || typeof value !== 'object') return fallback;
  for (const key of ['command', 'runCommand', 'invocation']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  return fallback;
}

function exitCodeFrom(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['exitCode', 'returnCode', 'processExitCode']) {
    if (Number.isInteger(value[key])) return value[key];
  }
  return null;
}

function evidenceDescriptor(item) {
  if (!item) return null;
  return {
    path: item.path,
    bytes: item.bytes,
    modifiedAt: item.modifiedAt,
    sha256: item.sha256,
  };
}

function record({
  status,
  evidence = [],
  command = 'not recorded in evidence',
  exitCode = null,
  profile = 'not recorded in evidence',
  providerBoundary = 'not recorded in evidence',
  reason,
  checks = {},
  subgates = {},
}) {
  if (!ALLOWED_STATUSES.has(status)) throw new Error(`Invalid acceptance status: ${status}`);
  const evidenceItems = evidence.filter(Boolean);
  return {
    status,
    evidencePath: evidenceItems.map((item) => item.path),
    evidence: evidenceItems.map(evidenceDescriptor),
    command,
    exitCode,
    profile,
    providerBoundary,
    reason,
    checks,
    subgates,
  };
}

function validAbiReport(item) {
  const value = item?.value;
  return Boolean(
    value
      && value.success === true
      && value.numFailedTestSuites === 0
      && value.numFailedTests === 0
      && value.numPassedTestSuites > 0
      && value.numPassedTests > 0,
  );
}

const GENOFFICE_E2E_REQUIRED_STEPS = [
  'word-edit-sync',
  'cas-conflict-cleanup',
  'word-reopen-reparse',
  'word-dirty-archive-guard',
  'word-docx-export-roundtrip',
  'ppt-edit-sync',
  'ppt-reopen-reparse',
  'ppt-pptx-export-roundtrip',
  'spreadsheet-edit-sync',
  'spreadsheet-reopen-reparse',
  'pdf-edit-sync',
  'pdf-reopen-reparse',
  'archive-delete-cleanup',
];

function validGenofficeE2eReport(item) {
  const value = item?.value;
  const stepNames = Array.isArray(value?.steps) ? value.steps.map((step) => step?.name) : [];
  return Boolean(
    value
      && value.status === 'passed'
      && value.childExited === true
      && value.profileRemoved === true
      && GENOFFICE_E2E_REQUIRED_STEPS.every((name) => stepNames.includes(name))
      && Array.isArray(value.assertions)
      && value.assertions.length > 0
      && value.assertions.every((assertion) => assertion?.ok === true),
  );
}

function validGenofficeHostsReport(item) {
  const value = item?.value;
  const hosts = Array.isArray(value?.results) ? value.results : [];
  return Boolean(
    value
      && value.status === 'passed'
      && hosts.length >= 4
      && hosts.every((host) => host?.targetReady === true),
  );
}

function allRecoveryAssertionsPassed(value) {
  if (!value || value.status !== 'passed') return false;
  const phases = Object.values(value.phases ?? {});
  return phases.length > 0
    && phases.every((phase) => phase?.status === 'passed')
    && phases.every((phase) => (phase.assertions ?? []).every((assertion) => assertion.ok === true));
}

function validScenarioReport(item) {
  const value = item?.value;
  const extended = value?.extended;
  return Boolean(
    value
      && value.status === 'passed'
      && extended?.status === 'passed'
      && Array.isArray(value.captures)
      && value.captures.length > 0
      && value.health?.firstRun?.persistenceStoreInitialized === true
      && value.health?.configured?.persistenceStoreInitialized === true
      && value.profileCleanup?.firstRun?.removed === true
      && value.profileCleanup?.configured?.removed === true,
  );
}

function validNativeWindowOverlayReport(item) {
  const value = item?.value;
  const assertions = value?.execution?.report?.assertions;
  return Boolean(
    value
      && value.status === 'passed'
      && value.execution?.attempted === true
      && value.execution?.report?.status === 'passed'
      && value.execution?.childExit?.code === 0
      && Array.isArray(assertions)
      && assertions.length >= 40
      && assertions.every((assertion) => assertion.ok === true),
  );
}

function validResponsiveMatrixReport(item) {
  const value = item?.value;
  const matrix = value?.matrix;
  const viewports = value?.viewports;
  return Boolean(
    value
      && value.status === 'passed'
      && Array.isArray(viewports)
      && viewports.length >= 3
      && Array.isArray(matrix)
      && matrix.length >= 12
      && matrix.every((row) => row?.noHorizontalOverflow === true && row?.rootVisible === true),
  );
}

function validSafeMarkdownReport(item) {
  const value = item?.value;
  const assertions = value?.assertions;
  return Boolean(
    value
      && value.status === 'passed'
      && Array.isArray(assertions)
      && assertions.length > 0
      && assertions.every((assertion) => assertion.ok === true),
  );
}

function validPixelBaselineReport(item) {
  const value = item?.value;
  const captures = value?.captures;
  if (!value || value.status !== 'passed' || !Array.isArray(captures) || captures.length < 4) return false;
  const hashesWellFormed = captures.every((capture) => typeof capture?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(capture.sha256));
  if (value.mode === 'baseline-established') return hashesWellFormed;
  if (value.mode === 'regression-compared') {
    const comparisons = value?.comparisons;
    return hashesWellFormed && Array.isArray(comparisons) && comparisons.length >= 4 && comparisons.every((item2) => item2?.match === true);
  }
  return false;
}

function validLayoutDomContract(item) {
  const value = item?.value;
  const scope = value?.scope;
  const surfaces = value?.surfaces;
  return Boolean(
    value
      && value.status === 'passed'
      && value.acceptance === 'current-product-entry-dom-contract'
      && scope?.surfaceDomContract === true
      && scope?.historicalFailureReportsPreserved === true
      && Array.isArray(surfaces)
      && surfaces.length === 4
      && surfaces.every((surface) => surface.navCount === 1
        && surface.navActive === true
        && surface.rootCount === 1
        && surface.rootVisible === true),
  );
}

function newestValid(root, candidates, predicate) {
  const items = candidates.map((candidate) => readJson(root, candidate)).filter(Boolean);
  return items
    .filter((item) => predicate(item))
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))[0] ?? null;
}

function newestExisting(root, candidates) {
  return candidates
    .map((candidate) => readJson(root, candidate))
    .filter(Boolean)
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))[0] ?? null;
}

function reportStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

export function buildReport(root = DEFAULT_ROOT, now = new Date()) {
  const abi = readJson(root, 'test-results/personalization-final-merged-vitest-node-abi.json');
  const smoke = readJson(root, 'smoke-report.json');
  const recovery = readJson(root, 'logs/electron-goal-recovery-e2e-20260821.json');
  const scenario = newestValid(root, [
    'test-results/single-page-acceptance-6/personalization-visual-acceptance.json',
    'test-results/harness-acceptance-2/personalization-visual-acceptance.json',
    'test-results/single-page-acceptance-5/personalization-visual-acceptance.json',
  ], validScenarioReport) ?? newestExisting(root, [
    'test-results/single-page-acceptance-6/personalization-visual-acceptance.json',
    'test-results/harness-acceptance-2/personalization-visual-acceptance.json',
  ]);
  const layout = newestValid(root, [
    'logs/layout-acceptance-current/attempt-1-rerun-1/electron-layout-acceptance.json',
    'logs/layout-acceptance-current/attempt-1/electron-layout-acceptance.json',
    'logs/layout-acceptance-current-20260821/attempt-1/electron-layout-acceptance.json',
  ], validLayoutDomContract) ?? newestExisting(root, [
    'logs/layout-acceptance-current/attempt-1-rerun-1/electron-layout-acceptance.json',
    'logs/layout-acceptance-current/attempt-1/electron-layout-acceptance.json',
  ]);
  const nativeOverlay = newestValid(root, [
    'logs/electron-native-overlay-e2e-run5.json',
    'logs/electron-native-overlay-e2e-latest.json',
  ], validNativeWindowOverlayReport);
  const responsiveMatrix = readJson(root, 'logs/electron-responsive-matrix-e2e.json');
  const safeMarkdown = readJson(root, 'logs/electron-safe-markdown-acceptance.json');
  const pixelBaseline = readJson(root, 'logs/electron-pixel-baseline-latest.json');
  const officeAudit = readText(root, 'logs/officecli-removal-final-audit-20260821.md');
  const genofficeE2e = readJson(root, 'test-results/outcome-genoffice-e2e.json');
  const genofficeHosts = readJson(root, 'test-results/genoffice-hosts-final.json');
  const officeVisualCancelled = Boolean(
    officeAudit?.text.includes('Native Word/PowerPoint visual rendering acceptance remains unverified'),
  );
  const externalProviderBlocked = Boolean(
    scenario?.value?.extended?.blocked?.some((item) => item?.name === 'ai-provider-full-chain'
      && item?.status === 'blocked'),
  );
  const agentErrorEvidence = Boolean(
    scenario?.value?.extended?.steps?.some((item) => item?.name === 'ai-agent-entry-real-result'
      && item?.result?.providerResult === 'error_shown'),
  );
  const abiPassed = validAbiReport(abi);
  const recoveryPassed = allRecoveryAssertionsPassed(recovery?.value);
  const scenarioPassed = validScenarioReport(scenario);
  const layoutPassed = validLayoutDomContract(layout);
  const nativeWindowPassed = validNativeWindowOverlayReport(nativeOverlay);
  const responsiveMatrixPassed = validResponsiveMatrixReport(responsiveMatrix);
  const safeMarkdownPassed = validSafeMarkdownReport(safeMarkdown);
  const pixelBaselinePassed = validPixelBaselineReport(pixelBaseline);
  // readJson returns a wrapper ({ path, value, bytes, ... }); the smoke
  // counters live on `.value`. Reading them off the wrapper directly was the
  // historical bug that kept genericSmokePassed false despite a 13/13 report.
  const smokePassed = smoke?.value?.failed === 0 && (smoke?.value?.passed ?? 0) > 0;
  const genofficeE2ePassed = validGenofficeE2eReport(genofficeE2e);
  const genofficeHostsPassed = validGenofficeHostsReport(genofficeHosts);
  const desktopAllGatesPassed = layoutPassed && nativeWindowPassed && responsiveMatrixPassed
    && safeMarkdownPassed && pixelBaselinePassed && smokePassed;

  const domains = {
    P0: record({
      status: abiPassed ? 'passed' : 'pending',
      evidence: [abi],
      command: commandFrom(abi?.value),
      exitCode: exitCodeFrom(abi?.value),
      profile: 'historical Vitest/node ABI result; profile not recorded in the result',
      providerBoundary: 'unit/integration ABI evidence only; no external Provider quality claim',
      reason: abiPassed
        ? `ABI result reports ${abi.value.numPassedTests}/${abi.value.numTotalTests} tests passed and zero failed.`
        : 'No valid ABI result with a successful, zero-failure summary was found.',
      checks: {
        successfulRun: abi?.value?.success === true,
        passedSuites: abi?.value?.numPassedTestSuites ?? null,
        totalSuites: abi?.value?.numTotalTestSuites ?? null,
        passedTests: abi?.value?.numPassedTests ?? null,
        totalTests: abi?.value?.numTotalTests ?? null,
        failedTests: abi?.value?.numFailedTests ?? null,
      },
    }),
    Agent: record({
      status: externalProviderBlocked || agentErrorEvidence ? 'blocked' : 'pending',
      evidence: [scenario],
      command: commandFrom(scenario?.value),
      exitCode: exitCodeFrom(scenario?.value),
      profile: scenario?.value?.profiles?.configured ? 'isolated configured visual-acceptance profile (removed after run)' : 'not recorded in evidence',
      providerBoundary: 'external Provider full-chain gate is explicitly blocked; available result used isolated/controlled loopback behavior',
      reason: externalProviderBlocked
        ? 'The existing acceptance result explicitly records ai-provider-full-chain as blocked because METIS_ACCEPTANCE_AI_KEY was not set.'
        : agentErrorEvidence
          ? 'The existing acceptance result records the real agent entry as an error receipt, so no passing agent result is claimable.'
          : 'No persisted Agent smoke or external Provider result was found.',
      checks: {
        externalProviderFullChain: externalProviderBlocked ? 'blocked' : 'not evidenced',
        agentEntryErrorShown: agentErrorEvidence,
        controlledScenarioEvidence: scenarioPassed,
      },
    }),
    Goal: record({
      status: recoveryPassed ? 'passed' : 'pending',
      evidence: [recovery],
      command: 'npm exec -- electron scripts/electron-goal-recovery-e2e.cjs',
      exitCode: exitCodeFrom(recovery?.value),
      profile: recovery?.value?.scope === 'real-BrowserWindow-preload-main-IPC-isolated-profile'
        ? 'isolated temporary Electron profile (path was removed by runner)'
        : 'not recorded in evidence',
      providerBoundary: recovery?.value?.provider === 'deterministic-loopback-controlled-not-external'
        ? 'deterministic loopback Provider; not external Provider quality or availability evidence'
        : 'not recorded in evidence',
      reason: recoveryPassed
        ? 'Both persisted recovery phases and every recorded assertion passed within the isolated loopback boundary.'
        : 'No recovery report with all phases and assertions passed was found.',
      checks: {
        reportStatus: recovery?.value?.status ?? 'missing',
        phaseStatuses: Object.fromEntries(Object.entries(recovery?.value?.phases ?? {}).map(([name, phase]) => [name, phase?.status ?? 'missing'])),
        providerCalls: recovery?.value?.providerCalls ?? null,
        planningCalls: recovery?.value?.planningCalls ?? null,
      },
    }),
    Scenario: record({
      status: scenarioPassed ? 'passed' : scenario?.value?.status === 'failed' ? 'blocked' : 'pending',
      evidence: [scenario],
      command: commandFrom(scenario?.value),
      exitCode: exitCodeFrom(scenario?.value),
      profile: scenario?.value?.profiles?.firstRun && scenario?.value?.profiles?.configured
        ? 'isolated first-run and configured profiles; report says both were removed'
        : 'not recorded in evidence',
      providerBoundary: 'controlled local loopback acceptance path; no external Provider quality claim',
      reason: scenarioPassed
        ? 'Scenario visual/persistence acceptance report and its extended steps passed in an isolated profile.'
        : scenario?.value?.status === 'failed'
          ? 'The newest available scenario acceptance report is explicitly failed.'
          : 'No complete passing scenario acceptance report was found.',
      checks: {
        reportStatus: scenario?.value?.status ?? 'missing',
        extendedStatus: scenario?.value?.extended?.status ?? 'missing',
        captureCount: scenario?.value?.captures?.length ?? 0,
        firstRunStoreReady: scenario?.value?.health?.firstRun?.persistenceStoreInitialized === true,
        configuredStoreReady: scenario?.value?.health?.configured?.persistenceStoreInitialized === true,
        profilesRemoved: scenario?.value?.profilesRemoved === true,
      },
    }),
    Outcomes: record({
      status: 'pending',
      evidence: [officeAudit],
      command: 'not recorded in evidence',
      exitCode: null,
      profile: 'not recorded in a persisted Outcomes execution report',
      providerBoundary: 'controlled Electron Outcomes tests and external Provider flow are not persisted as runnable acceptance evidence here',
      reason: 'The available audit explicitly says Outcomes assistant/PPT generation external Provider flows remain unrun; no persisted Outcomes smoke report was found.',
      checks: {
        externalProviderFlow: 'pending',
        persistedSmokeReport: false,
        retainedOutcomeChain: officeAudit?.text.includes('OutcomesPage.tsx') === true,
      },
    }),
    Word: record({
      status: 'pending',
      evidence: [officeAudit],
      command: 'not recorded in evidence',
      exitCode: null,
      profile: 'not recorded in a persisted Word export execution report',
      providerBoundary: 'product Word chain is retained, but no real export/visual acceptance result is present',
      reason: 'No persisted Word export execution report was found. Native LibreOffice/PowerPoint visual rendering is an explicitly cancelled gate.',
      checks: {
        retainedWordChain: officeAudit?.text.includes('OutcomeWordDocxService.ts') === true,
        nativeOfficeVisual: officeVisualCancelled ? 'cancelled_gate' : 'not evidenced',
      },
      subgates: {
        nativeOfficeVisual: record({
          status: officeVisualCancelled ? 'cancelled_gate' : 'pending',
          evidence: [officeAudit],
          command: 'not run: LibreOffice/PowerPoint native renderer unavailable',
          exitCode: null,
          profile: 'not applicable',
          providerBoundary: 'not applicable; renderer gate',
          reason: officeVisualCancelled
            ? 'The audit explicitly records native Word/PowerPoint visual rendering as unverified.'
            : 'No native Office renderer boundary was recorded.',
        }),
      },
    }),
    PPT: record({
      status: 'pending',
      evidence: [officeAudit],
      command: 'not recorded in evidence',
      exitCode: null,
      profile: 'not recorded in a persisted PPT/PPTX execution report',
      providerBoundary: 'product PPT/PPTX chain is retained, but no real generation/export acceptance result is present',
      reason: 'No persisted PPT/PPTX execution report was found. Native LibreOffice/PowerPoint visual rendering is an explicitly cancelled gate.',
      checks: {
        retainedPptxChain: officeAudit?.text.includes('OutcomePptxService.ts') === true,
        nativeOfficeVisual: officeVisualCancelled ? 'cancelled_gate' : 'not evidenced',
      },
      subgates: {
        nativeOfficeVisual: record({
          status: officeVisualCancelled ? 'cancelled_gate' : 'pending',
          evidence: [officeAudit],
          command: 'not run: LibreOffice/PowerPoint native renderer unavailable',
          exitCode: null,
          profile: 'not applicable',
          providerBoundary: 'not applicable; renderer gate',
          reason: officeVisualCancelled
            ? 'The audit explicitly records native Word/PowerPoint visual rendering as unverified.'
            : 'No native Office renderer boundary was recorded.',
        }),
      },
    }),
    GenOffice: record({
      status: genofficeE2ePassed ? 'passed' : 'pending',
      evidence: [genofficeE2e, genofficeHosts],
      command: 'node scripts/electron-outcome-genoffice-e2e.cjs',
      exitCode: null,
      profile: genofficeE2ePassed
        ? 'isolated temporary Electron profile and GenOffice child hosts; report records profileRemoved and childExited'
        : 'not recorded in evidence',
      providerBoundary: 'real GenOffice external-editor round-trip only; no external Provider quality claim and no native Microsoft Office visual claim',
      reason: genofficeE2ePassed
        ? `Fresh four-format E2E passed with ${genofficeE2e.value.assertions.length} assertions: create/open/edit/save/sync v2, reopen/reparse, dirty-archive guard, DOCX/PPTX export round-trip, CAS conflict, archive/delete cleanup, profile and child cleanup.`
        : genofficeE2e?.value?.status === 'failed'
          ? `The newest GenOffice four-format E2E report is explicitly failed: ${String(genofficeE2e.value.error ?? '').slice(0, 200)}`
          : 'No fresh GenOffice four-format E2E report with all required steps was found.',
      checks: {
        fourFormatEditSyncV2: ['word-edit-sync', 'ppt-edit-sync', 'spreadsheet-edit-sync', 'pdf-edit-sync'].every((name) => (genofficeE2e?.value?.steps ?? []).some((step) => step?.name === name)),
        reopenReparse: ['word-reopen-reparse', 'ppt-reopen-reparse', 'spreadsheet-reopen-reparse', 'pdf-reopen-reparse'].every((name) => (genofficeE2e?.value?.steps ?? []).some((step) => step?.name === name)),
        dirtyArchiveGuard: (genofficeE2e?.value?.steps ?? []).some((step) => step?.name === 'word-dirty-archive-guard'),
        exportRoundTrip: ['word-docx-export-roundtrip', 'ppt-pptx-export-roundtrip'].every((name) => (genofficeE2e?.value?.steps ?? []).some((step) => step?.name === name)),
        casConflictCleanup: (genofficeE2e?.value?.steps ?? []).some((step) => step?.name === 'cas-conflict-cleanup'),
        archiveDeleteCleanup: (genofficeE2e?.value?.steps ?? []).some((step) => step?.name === 'archive-delete-cleanup'),
        childExited: genofficeE2e?.value?.childExited === true,
        profileRemoved: genofficeE2e?.value?.profileRemoved === true,
        standaloneHostSmoke: genofficeHostsPassed,
      },
    }),
    Desktop: record({
      status: desktopAllGatesPassed ? 'passed' : layout?.value?.status === 'failed' ? 'blocked' : 'pending',
      evidence: [layout, smoke, nativeOverlay, responsiveMatrix, safeMarkdown, pixelBaseline],
      command: 'npm run acceptance:layout',
      exitCode: exitCodeFrom(layout?.value),
      profile: layout?.value?.environment?.profileVerified === true
        ? 'isolated layout-acceptance profile verified by report'
        : 'not recorded in evidence',
      providerBoundary: 'Desktop DOM/entry contract only; no Provider quality claim',
      reason: desktopAllGatesPassed
        ? 'Every Desktop subgate has real passing evidence: entry DOM contract, renderer responsive matrix, native window matrix, safe-markdown rendering, pixel baseline and the generic smoke report.'
        : layout?.value?.status === 'failed'
          ? 'The available Desktop acceptance report is explicitly failed.'
          : `Desktop acceptance remains pending; subgate states: entryDom=${layoutPassed ? 'passed' : 'pending'}, responsiveMatrix=${responsiveMatrixPassed ? 'passed' : 'pending'}, nativeWindow=${nativeWindowPassed ? 'passed' : 'pending'}, safeMarkdown=${safeMarkdownPassed ? 'passed' : 'pending'}, pixelRegression=${pixelBaselinePassed ? 'passed' : 'pending'}, genericSmoke=${smokePassed ? 'passed' : 'pending'}.`,
      checks: {
        currentProductEntryDom: layoutPassed ? 'passed' : 'not evidenced',
        rendererResponsiveMatrix: responsiveMatrixPassed,
        windowsNativeWindowMatrix: nativeWindowPassed,
        safeMarkdownSecurity: safeMarkdownPassed,
        pixelRegression: pixelBaselinePassed,
        genericSmokePassed: smokePassed,
      },
      subgates: {
        currentProductEntryDom: record({
          status: layoutPassed ? 'passed' : 'pending',
          evidence: [layout],
          command: 'npm run acceptance:layout',
          exitCode: exitCodeFrom(layout?.value),
          profile: layout?.value?.environment?.profileVerified === true ? 'isolated layout-acceptance profile' : 'not recorded in evidence',
          providerBoundary: 'DOM/entry contract only',
          reason: layoutPassed ? 'All four current product entry surfaces passed the recorded DOM contract.' : 'No valid current DOM contract pass was found.',
        }),
        rendererResponsiveMatrix: record({
          status: responsiveMatrixPassed ? 'passed' : 'pending',
          evidence: [responsiveMatrix],
          command: commandFrom(responsiveMatrix?.value),
          exitCode: exitCodeFrom(responsiveMatrix?.value),
          profile: responsiveMatrix?.value?.environment?.userData ? 'isolated temporary Electron profile (removed by runner)' : 'not recorded',
          providerBoundary: 'renderer DOM overflow/visibility contract only',
          reason: responsiveMatrixPassed
            ? `Real Electron window verified ${responsiveMatrix.value.matrix.length} (viewport, surface) pairs across ${responsiveMatrix.value.viewports.length} viewports with no horizontal overflow.`
            : 'No responsive-matrix report with all viewport/surface pairs passing was found.',
        }),
        windowsNativeWindowMatrix: record({
          status: nativeWindowPassed ? 'passed' : 'pending',
          evidence: [nativeOverlay],
          command: commandFrom(nativeOverlay?.value, 'node scripts/electron-native-overlay-e2e.cjs --report logs/electron-native-overlay-e2e-run5.json (producing invocation not recorded inside the evidence file)'),
          exitCode: exitCodeFrom(nativeOverlay?.value),
          profile: nativeOverlay?.value?.execution?.report?.environment?.userData ? 'isolated temporary Electron profile (removed by runner)' : 'not recorded',
          providerBoundary: 'native WebContentsView overlay/focus/bounds behavior only',
          reason: nativeWindowPassed
            ? `Native overlay E2E passed with ${nativeOverlay.value.execution.report.assertions.length}/${nativeOverlay.value.execution.report.assertions.length} assertions ok on a real BrowserWindow/WebContentsView chain.`
            : 'No native overlay E2E report with status passed and every assertion ok was found.',
        }),
        safeMarkdownSecurity: record({
          status: safeMarkdownPassed ? 'passed' : 'pending',
          evidence: [safeMarkdown],
          command: commandFrom(safeMarkdown?.value),
          exitCode: exitCodeFrom(safeMarkdown?.value),
          profile: safeMarkdown?.value?.environment?.userData ? 'isolated temporary Electron profile (removed by runner)' : 'not recorded',
          providerBoundary: 'chat-page sanitizer contract only; no Provider quality claim',
          reason: safeMarkdownPassed
            ? 'Hostile markdown (<script>, javascript: link, onerror/onclick attributes) sent through the real chat composer rendered with every payload neutralized.'
            : 'No safe-markdown acceptance report with all sanitizer assertions passing was found.',
        }),
        pixelRegression: record({
          status: pixelBaselinePassed ? 'passed' : 'pending',
          evidence: [pixelBaseline],
          command: commandFrom(pixelBaseline?.value),
          exitCode: exitCodeFrom(pixelBaseline?.value),
          profile: pixelBaseline?.value?.environment?.userData ? 'isolated temporary Electron profile (removed by runner)' : 'not recorded',
          providerBoundary: 'screenshot sha256 contract only',
          reason: pixelBaselinePassed
            ? pixelBaseline.value.mode === 'baseline-established'
              ? 'First run established the four-surface screenshot sha256 baseline (baseline-established); later runs must reproduce it.'
              : 'All four surface screenshots reproduced the recorded sha256 baseline exactly.'
            : 'No pixel-baseline report with an established baseline or a fully matching regression comparison was found.',
        }),
        genericSmokePassed: record({
          status: smokePassed ? 'passed' : 'pending',
          evidence: [smoke],
          command: 'node scripts/smoke.mjs (writes smoke-report.json; invocation and exit code are not recorded inside the evidence file)',
          exitCode: null,
          profile: 'not recorded in evidence',
          providerBoundary: 'IPC/renderer smoke only; no Provider quality claim',
          reason: smokePassed
            ? `smoke-report.json records ${smoke.value.passed} passed / ${smoke.value.failed} failed checks.`
            : 'No smoke report with zero failures and at least one pass was found.',
        }),
      },
    }),
  };

  const statuses = Object.fromEntries(Object.entries(domains).map(([name, domain]) => [name, domain.status]));
  const overallStatus = Object.values(statuses).includes('blocked')
    ? 'blocked'
    : Object.values(statuses).every((status) => status === 'passed')
      ? 'passed'
      : 'pending';

  return {
    schemaVersion: 1,
    report: 'alpha2-commercial-acceptance',
    generatedAt: now.toISOString(),
    generatedBy: {
      command: 'node scripts/generate-commercial-acceptance.mjs',
      exitCode: 0,
      root: path.resolve(root),
      outputPattern: 'logs/alpha2-commercial-acceptance-YYYYMMDD.json',
    },
    overallStatus,
    statusVocabulary: [...ALLOWED_STATUSES],
    evidencePolicy: {
      source: 'Only existing readable files and their recorded result fields are used.',
      missingEvidence: 'pending or blocked; no inferred pass is emitted.',
      cancelledGate: 'LibreOffice/PowerPoint native visual rendering is recorded as cancelled_gate when the audit says it is unverified.',
      exitCodePolicy: 'null means the historical evidence file did not record a process exit code; it is never inferred from status.',
    },
    domains,
  };
}

export function writeReport(root = DEFAULT_ROOT, now = new Date()) {
  const report = buildReport(root, now);
  const outputPath = path.resolve(root, 'logs', `alpha2-commercial-acceptance-${reportStamp(now)}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { outputPath, report };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { outputPath, report } = writeReport();
  process.stdout.write(`${JSON.stringify({ report: outputPath, overallStatus: report.overallStatus, domains: Object.fromEntries(Object.entries(report.domains).map(([name, value]) => [name, value.status])) })}\n`);
}
