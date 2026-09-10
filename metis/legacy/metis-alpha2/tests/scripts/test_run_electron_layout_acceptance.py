import importlib.util
import pathlib
import tempfile
import unittest
from unittest import mock


SCRIPT_PATH = (
    pathlib.Path(__file__).resolve().parents[2]
    / 'scripts'
    / 'run-electron-layout-acceptance.py'
)
SPEC = importlib.util.spec_from_file_location(
    'run_electron_layout_acceptance',
    SCRIPT_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f'Could not load launcher module: {SCRIPT_PATH}')
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


def clean_channel() -> dict:
    return {
        'sha256': 'a' * 64,
        'utf8Bytes': 1,
        'forbiddenMarkerCount': 0,
    }


def clean_mode(mode: str) -> dict:
    return {
        'passed': True,
        'mode': mode,
        'documentOuterHTML': clean_channel(),
        'messageOuterHTML': clean_channel(),
        'attributes': clean_channel(),
        'accessibilityFullTree': clean_channel(),
        'console': {'eventCount': 0, **clean_channel()},
        'network': {
            'requestCount': 0,
            'remoteRequestCount': 0,
            'fixtureRemoteRequestCount': 0,
            'urlSet': clean_channel(),
        },
        'frames': {
            'frameNavigationCount': 1 if mode == 'normal' else 0,
            'unexpectedFrameNavigationCount': 0,
            'urlSet': clean_channel(),
        },
        'targets': {
            'newTargetCount': 0,
            'targetInfoSet': clean_channel(),
        },
        'title': clean_channel(),
        'location': clean_channel(),
        'windowPolicy': {
            'titleCaptured': True,
            'locationMatchesExpectedEntry': True,
        },
        'domPolicy': {
            'cleanLinkCount': 1,
            'unsafeHrefCount': 0,
            'imgCount': 0,
            'srcCount': 0,
            'dangerousElementCount': 0,
            'blockedLinkCount': 5,
            'blockedImageCount': 1,
        },
    }


def clean_interaction(name: str) -> dict:
    return {
        'name': name,
        'passed': True,
        'locationUnchanged': True,
        'network': {
            'remoteRequestCount': 0,
            'urlSet': clean_channel(),
        },
        'frames': {
            'frameNavigationCount': 0,
            'urlSet': clean_channel(),
        },
        'targets': {'newTargetCount': 0},
        'console': {'forbiddenMarkerCount': 0},
    }


def clean_safe_markdown_security() -> dict:
    interactions = [
        clean_interaction('middle-click'),
        clean_interaction('control-click'),
        clean_interaction('shift-click'),
    ]
    return {
        'passed': True,
        'ingress': {
            'productionPathVerified': True,
            'role': 'user',
            'modelCompletionFabricated': False,
            'rowIdPositive': True,
            'exactPersisted': True,
            'fixture': {
                'sha256': 'c' * 64,
                'utf8Bytes': 100,
                'forbiddenMarkerCount': 10,
            },
        },
        'normal': clean_mode('normal'),
        'diagnostic': clean_mode('diagnostic'),
        'interactions': {
            'passed': True,
            'normal': interactions,
            'diagnostic': [dict(item) for item in interactions],
        },
        'cleanup': {
            'sessionDeleted': True,
            'normalRestored': True,
        },
        'evidence': {
            'file': 'safe-markdown-security.json',
            'sha256': 'b' * 64,
        },
    }


def surface(name: str, required_test_id: str | None = None) -> dict:
    required = [{'selector': f'[data-testid="{required_test_id}"]', 'count': 1, 'visible': True}] if required_test_id else [{'selector': '.surface-root', 'count': 1, 'visible': True}]
    return {
        'name': name,
        'navCount': 1,
        'navActive': True,
        'rootCount': 1,
        'rootVisible': True,
        'required': required,
        'requiredTestId': required_test_id,
        'requiredTestIdCount': 1 if required_test_id else None,
        'activeSceneTab': {'pressed': 'true'} if name == 'scenes' else None,
    }


def complete_report() -> dict:
    return {
        'status': 'passed',
        'acceptance': 'current-product-entry-dom-contract',
        'scope': {
            'surfaceDomContract': True,
            'historicalFailureReportsPreserved': True,
            'rendererResponsiveMatrix': False,
            'windowsNativeWindowMatrix': False,
            'safeMarkdownSecurity': False,
            'pixelRegression': False,
        },
        'environment': {'profileVerified': True},
        'surfaces': [
            surface('converse', 'collab-page'),
            surface('projects', 'projects-page'),
            surface('outcomes'),
            surface('scenes', 'scenario-workbench'),
        ],
    }


class RetryClassificationTests(unittest.TestCase):
    def test_retries_only_a_broken_cdp_timeout(self) -> None:
        report = {
            'status': 'failed',
            'error': 'TimeoutError: CDP call timed out',
            'cdpConnectionBroken': True,
            'lastCdpOperation': {'status': 'timeout'},
        }
        self.assertTrue(launcher.is_retryable_cdp_timeout(1, report))

    def test_does_not_retry_assertion_or_incomplete_timeout_evidence(self) -> None:
        self.assertFalse(launcher.is_retryable_cdp_timeout(1, {
            'status': 'failed',
            'error': 'AssertionError: layout mismatch',
            'cdpConnectionBroken': False,
            'lastCdpOperation': {'status': 'completed'},
        }))
        self.assertFalse(launcher.is_retryable_cdp_timeout(1, {
            'status': 'failed',
            'error': 'TimeoutError: wait failed',
            'cdpConnectionBroken': False,
            'lastCdpOperation': {'status': 'timeout'},
        }))
        self.assertFalse(launcher.is_retryable_cdp_timeout(1, {
            'status': 'failed',
            'error': 'TimeoutError: wait failed',
            'cdpConnectionBroken': True,
            'lastCdpOperation': {'status': 'completed'},
        }))


class CompletePassTests(unittest.TestCase):
    def test_accepts_only_the_current_surface_contract(self) -> None:
        report = complete_report()
        self.assertTrue(launcher.is_complete_acceptance_pass(0, report))

        mutations = (
            lambda value: value.update(status='failed'),
            lambda value: value['scope'].update(surfaceDomContract=False),
            lambda value: value['scope'].update(historicalFailureReportsPreserved=False),
            lambda value: value['scope'].update(rendererResponsiveMatrix=True),
            lambda value: value['environment'].update(profileVerified=False),
            lambda value: value['surfaces'].pop(),
            lambda value: value['surfaces'][1].update(requiredTestId='stale-project-shell'),
            lambda value: value['surfaces'][1].update(requiredTestIdCount=0),
            lambda value: value['surfaces'][3].update(activeSceneTab={'pressed': 'false'}),
            lambda value: value['surfaces'][0]['required'][0].update(visible=False),
        )
        for mutation in mutations:
            candidate = complete_report()
            mutation(candidate)
            self.assertFalse(launcher.is_complete_acceptance_pass(0, candidate))

    def test_zero_return_code_cannot_rescue_missing_or_incomplete_report(self) -> None:
        self.assertFalse(launcher.is_complete_acceptance_pass(0, None))
        self.assertEqual(
            launcher.classify_acceptance_failure(0, None),
            'missing_or_invalid_report',
        )
        incomplete = complete_report()
        incomplete['surfaces'][2]['rootCount'] = 0
        self.assertFalse(launcher.is_complete_acceptance_pass(0, incomplete))

    def test_current_contract_does_not_require_historical_visual_matrices(self) -> None:
        report = complete_report()
        report['legacyEvidence'] = {
            'viewports': 5,
            'boundaryShellWidths': 6,
            'nativeWindowMatrix': 3,
            'safeMarkdownSecurity': 'historical-only',
        }
        self.assertTrue(launcher.is_complete_acceptance_pass(0, report))


class HistoricalSecurityHelperTests(unittest.TestCase):
    def test_safe_markdown_helper_remains_available_for_historical_reports(self) -> None:
        security = clean_safe_markdown_security()
        self.assertTrue(launcher.is_safe_markdown_security_pass(security))
        security['ingress']['modelCompletionFabricated'] = True
        self.assertFalse(launcher.is_safe_markdown_security_pass(security))


class EnvironmentPolicyTests(unittest.TestCase):
    def test_child_environment_excludes_credential_like_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = pathlib.Path(directory) / 'profile'
            with mock.patch.dict(
                launcher.os.environ,
                {
                    'Path': 'C:\\Windows\\System32',
                    'SystemRoot': 'C:\\Windows',
                    'METIS_TEST_API_KEY': 'not-read-by-launcher',
                    'AUTHORIZATION': 'not-read-by-launcher',
                },
                clear=True,
            ):
                environment, policy = launcher.build_acceptance_environment(
                    profile,
                )

        self.assertEqual(policy['parentCredentialLikeVariableCount'], 2)
        self.assertEqual(policy['childCredentialLikeVariableCount'], 0)
        self.assertFalse(policy['credentialValuesReadByLauncher'])
        self.assertFalse(policy['normalUserEnvironmentInherited'])
        self.assertFalse(any(
            launcher.is_credential_environment_name(name)
            for name in environment
        ))
        self.assertEqual(environment['USERPROFILE'], str(profile))


if __name__ == '__main__':
    unittest.main()
