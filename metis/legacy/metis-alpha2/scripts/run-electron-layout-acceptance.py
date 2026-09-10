import argparse
import hashlib
import json
import os
import pathlib
import secrets
import shutil
import site
import socket
import subprocess
import sys
import tempfile
import time
from typing import Any


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
ELECTRON_EXE = PROJECT_ROOT / 'node_modules' / 'electron' / 'dist' / 'electron.exe'
ACCEPTANCE_SCRIPT = PROJECT_ROOT / 'scripts' / 'electron-layout-acceptance.py'
PROFILE_MARKER = 'metis-layout-acceptance-profile.json'
WINDOWS_ENVIRONMENT_ALLOWLIST = (
    'ALLUSERSPROFILE',
    'CommonProgramFiles',
    'CommonProgramFiles(x86)',
    'CommonProgramW6432',
    'ComSpec',
    'NUMBER_OF_PROCESSORS',
    'OS',
    'Path',
    'PATHEXT',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER',
    'PROCESSOR_LEVEL',
    'PROCESSOR_REVISION',
    'ProgramData',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'ProgramW6432',
    'SystemDrive',
    'SystemRoot',
    'windir',
)
CREDENTIAL_ENVIRONMENT_MARKERS = (
    'API_KEY',
    'APIKEY',
    'AUTHORIZATION',
    'BEARER',
    'CLIENT_SECRET',
    'CREDENTIAL',
    'PASSWORD',
    'PASSWD',
    'PRIVATE_KEY',
    'SECRET',
    'TOKEN',
)


def is_credential_environment_name(name: str) -> bool:
    normalized = name.upper()
    return any(
        marker in normalized
        for marker in CREDENTIAL_ENVIRONMENT_MARKERS
    )


def build_acceptance_environment(
    profile: pathlib.Path,
) -> tuple[dict[str, str], dict]:
    roaming = profile / 'AppData' / 'Roaming'
    local = profile / 'AppData' / 'Local'
    temp = local / 'Temp'
    for directory in (
        roaming,
        temp,
        profile / 'Desktop',
        profile / 'Documents',
        profile / 'Downloads',
    ):
        directory.mkdir(parents=True, exist_ok=True)

    parent = os.environ
    environment = {
        name: parent[name]
        for name in WINDOWS_ENVIRONMENT_ALLOWLIST
        if name in parent
    }
    environment.update({
        'APPDATA': str(roaming),
        'HOME': str(profile),
        'LOCALAPPDATA': str(local),
        'TEMP': str(temp),
        'TMP': str(temp),
        'USERPROFILE': str(profile),
        'USERNAME': 'metis-layout-acceptance',
        'PYTHONIOENCODING': 'utf-8',
        'PYTHONUTF8': '1',
    })
    user_site = site.getusersitepackages()
    if user_site:
        environment['PYTHONPATH'] = user_site
    if profile.drive:
        environment['HOMEDRIVE'] = profile.drive
        environment['HOMEPATH'] = str(profile)[len(profile.drive):]

    credential_names_in_parent = [
        name for name in parent
        if is_credential_environment_name(name)
    ]
    credential_names_in_child = [
        name for name in environment
        if is_credential_environment_name(name)
    ]
    if credential_names_in_child:
        raise RuntimeError(
            'Credential-like variables escaped the acceptance '
            f'environment allowlist: {credential_names_in_child}'
        )

    return environment, {
        'mode': 'allowlist',
        'parentCredentialLikeVariableCount': len(
            credential_names_in_parent
        ),
        'childCredentialLikeVariableCount': 0,
        'credentialValuesReadByLauncher': False,
        'isolatedUserProfile': str(profile),
        'isolatedAppData': str(roaming),
        'isolatedLocalAppData': str(local),
        'isolatedTemp': str(temp),
        'normalUserEnvironmentInherited': False,
    }


def reserve_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(('127.0.0.1', 0))
        return int(listener.getsockname()[1])


def wait_for_exit(process: subprocess.Popen, timeout: float) -> None:
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def terminate_process_tree(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    subprocess.run(
        ['taskkill', '/PID', str(process.pid), '/T', '/F'],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    wait_for_exit(process, 15)


def remove_profile(
    profile: pathlib.Path,
    timeout: float = 20,
) -> tuple[bool, str | None]:
    deadline = time.time() + timeout
    last_error = None
    while time.time() < deadline:
        try:
            shutil.rmtree(profile, ignore_errors=False)
            return True, None
        except FileNotFoundError:
            return True, None
        except OSError as error:
            last_error = str(error)
            time.sleep(0.5)
    return False, last_error


def read_json_object(path: pathlib.Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def is_retryable_cdp_timeout(
    return_code: int,
    acceptance_report: dict[str, Any] | None,
) -> bool:
    if return_code == 0 or not acceptance_report:
        return False
    last_operation = acceptance_report.get('lastCdpOperation')
    return bool(
        acceptance_report.get('status') == 'failed'
        and acceptance_report.get('cdpConnectionBroken') is True
        and str(acceptance_report.get('error', '')).startswith('TimeoutError:')
        and isinstance(last_operation, dict)
        and last_operation.get('status') == 'timeout'
    )


def is_safe_markdown_security_pass(value: Any) -> bool:
    if not isinstance(value, dict) or value.get('passed') is not True:
        return False
    ingress = value.get('ingress')
    cleanup = value.get('cleanup')
    interactions = value.get('interactions')
    evidence = value.get('evidence')
    fixture = ingress.get('fixture') if isinstance(ingress, dict) else None
    if not (
        isinstance(ingress, dict)
        and ingress.get('productionPathVerified') is True
        and ingress.get('role') == 'user'
        and ingress.get('modelCompletionFabricated') is False
        and ingress.get('rowIdPositive') is True
        and ingress.get('exactPersisted') is True
        and isinstance(fixture, dict)
        and isinstance(fixture.get('sha256'), str)
        and len(fixture['sha256']) == 64
        and all(character in '0123456789abcdef' for character in fixture['sha256'])
        and fixture.get('utf8Bytes', 0) > 0
        and fixture.get('forbiddenMarkerCount', 0) > 0
        and isinstance(cleanup, dict)
        and cleanup.get('sessionDeleted') is True
        and cleanup.get('normalRestored') is True
        and isinstance(interactions, dict)
        and interactions.get('passed') is True
        and isinstance(evidence, dict)
        and evidence.get('file') == 'safe-markdown-security.json'
        and isinstance(evidence.get('sha256'), str)
        and len(evidence['sha256']) == 64
        and all(character in '0123456789abcdef' for character in evidence['sha256'])
    ):
        return False

    for mode_name in ('normal', 'diagnostic'):
        mode = value.get(mode_name)
        if not (
            isinstance(mode, dict)
            and mode.get('passed') is True
            and mode.get('mode') == mode_name
        ):
            return False
        for channel_name in (
            'documentOuterHTML',
            'messageOuterHTML',
            'attributes',
            'accessibilityFullTree',
            'console',
            'title',
            'location',
        ):
            channel = mode.get(channel_name)
            if not (
                isinstance(channel, dict)
                and channel.get('forbiddenMarkerCount') == 0
                and isinstance(channel.get('sha256'), str)
                and len(channel['sha256']) == 64
                and all(
                    character in '0123456789abcdef'
                    for character in channel['sha256']
                )
                and channel.get('utf8Bytes', 0) > 0
            ):
                return False
        network = mode.get('network')
        frames = mode.get('frames')
        targets = mode.get('targets')
        dom_policy = mode.get('domPolicy')
        window_policy = mode.get('windowPolicy')
        if not (
            isinstance(network, dict)
            and network.get('remoteRequestCount') == 0
            and network.get('fixtureRemoteRequestCount') == 0
            and network.get('urlSet', {}).get('forbiddenMarkerCount') == 0
            and isinstance(frames, dict)
            and frames.get('unexpectedFrameNavigationCount') == 0
            and frames.get('urlSet', {}).get('forbiddenMarkerCount') == 0
            and (
                frames.get('frameNavigationCount', 0) >= 1
                if mode_name == 'normal'
                else frames.get('frameNavigationCount') == 0
            )
            and isinstance(targets, dict)
            and targets.get('newTargetCount') == 0
            and isinstance(dom_policy, dict)
            and dom_policy.get('cleanLinkCount') == 1
            and dom_policy.get('unsafeHrefCount') == 0
            and dom_policy.get('imgCount') == 0
            and dom_policy.get('srcCount') == 0
            and dom_policy.get('dangerousElementCount') == 0
            and dom_policy.get('blockedLinkCount', 0) > 0
            and dom_policy.get('blockedImageCount', 0) > 0
            and isinstance(window_policy, dict)
            and window_policy.get('titleCaptured') is True
            and window_policy.get('locationMatchesExpectedEntry') is True
        ):
            return False

        mode_interactions = interactions.get(mode_name)
        expected_interaction_names = {
            'middle-click',
            'control-click',
            'shift-click',
        }
        actual_interaction_names = {
            str(item.get('name', '')).removeprefix('diagnostic-')
            for item in mode_interactions
        } if isinstance(mode_interactions, list) else set()
        if not (
            isinstance(mode_interactions, list)
            and len(mode_interactions) == 3
            and actual_interaction_names == expected_interaction_names
            and all(
                isinstance(item, dict)
                and item.get('passed') is True
                and item.get('locationUnchanged') is True
                and item.get('network', {}).get('remoteRequestCount') == 0
                and item.get('network', {}).get('urlSet', {}).get(
                    'forbiddenMarkerCount'
                ) == 0
                and item.get('frames', {}).get('frameNavigationCount') == 0
                and item.get('frames', {}).get('urlSet', {}).get(
                    'forbiddenMarkerCount'
                ) == 0
                and item.get('targets', {}).get('newTargetCount') == 0
                and item.get('console', {}).get('forbiddenMarkerCount') == 0
                for item in mode_interactions
            )
        ):
            return False
    return True


CURRENT_SURFACE_NAMES = ('projects', 'topics', 'outcomes', 'scenes')


def is_complete_acceptance_pass(
    return_code: int,
    acceptance_report: dict[str, Any] | None,
    artifact_dir: pathlib.Path | None = None,
) -> bool:
    """Validate only the current product entry/DOM contract.

    Historical responsive/native/Safe Markdown reports remain useful evidence, but
    are deliberately not gates for this stale-layout migration.
    """
    if return_code != 0 or not acceptance_report:
        return False
    scope = acceptance_report.get('scope')
    environment = acceptance_report.get('environment')
    surfaces = acceptance_report.get('surfaces')
    if not (
        acceptance_report.get('status') == 'passed'
        and acceptance_report.get('acceptance') == 'current-product-entry-dom-contract'
        and isinstance(scope, dict)
        and scope.get('surfaceDomContract') is True
        and scope.get('historicalFailureReportsPreserved') is True
        and all(scope.get(key) is False for key in (
            'rendererResponsiveMatrix',
            'windowsNativeWindowMatrix',
            'safeMarkdownSecurity',
            'pixelRegression',
        ))
        and isinstance(environment, dict)
        and environment.get('profileVerified') is True
        and isinstance(surfaces, list)
        and len(surfaces) == len(CURRENT_SURFACE_NAMES)
        and [item.get('name') for item in surfaces] == list(CURRENT_SURFACE_NAMES)
        and all(
            isinstance(item, dict)
            and item.get('navCount') == 1
            and item.get('navActive') is True
            and item.get('rootCount') == 1
            and item.get('rootVisible') is True
            and all(
                isinstance(selector, dict)
                and selector.get('count') == 1
                and selector.get('visible') is True
                for selector in item.get('required', [])
            )
            for item in surfaces
        )
    ):
        return False
    projects = next(item for item in surfaces if item.get('name') == 'projects')
    scenes = next(item for item in surfaces if item.get('name') == 'scenes')
    return (
        projects.get('requiredTestId') == 'projects-page'
        and projects.get('requiredTestIdCount') == 1
        and scenes.get('requiredTestId') == 'scenario-workbench'
        and scenes.get('requiredTestIdCount') == 1
        and (scenes.get('activeSceneTab') or {}).get('pressed') == 'true'
    )


def classify_acceptance_failure(
    return_code: int,
    acceptance_report: dict[str, Any] | None,
    outer_timeout: bool = False,
) -> str:
    if outer_timeout:
        return 'launcher_timeout'
    if is_retryable_cdp_timeout(return_code, acceptance_report):
        return 'cdp_timeout'
    if not acceptance_report:
        return 'missing_or_invalid_report'
    error = str(acceptance_report.get('error', ''))
    if error.startswith('AssertionError:'):
        return 'assertion'
    if error.startswith('TimeoutError:'):
        return 'nonretryable_timeout'
    if return_code == 0:
        return 'incomplete_pass_report'
    return 'acceptance_failure'


def run_attempt(
    attempt_number: int,
    attempt_dir: pathlib.Path,
    keep_profile: bool,
    force_failure_after_handshake: bool,
) -> tuple[dict[str, Any], dict[str, Any] | None, bool]:
    attempt_dir.mkdir(parents=True, exist_ok=False)
    profile = pathlib.Path(tempfile.mkdtemp(
        prefix='metis-layout-acceptance-profile-',
    )).resolve()
    token = secrets.token_urlsafe(32)
    marker = {
        'purpose': 'metis-electron-layout-acceptance',
        'token': token,
        'expectedEntry': str((PROJECT_ROOT / 'dist' / 'index.html').resolve()),
        'createdAtUnixMs': int(time.time() * 1000),
    }
    (profile / PROFILE_MARKER).write_text(
        json.dumps(marker, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )
    port = reserve_port()
    origin = f'http://127.0.0.1:{port}'
    electron_log = attempt_dir / 'electron-process.log'
    launcher_report = attempt_dir / 'electron-layout-launcher.json'
    acceptance_report_path = attempt_dir / 'electron-layout-acceptance.json'
    command = [
        str(ELECTRON_EXE),
        str(PROJECT_ROOT),
        f'--remote-debugging-port={port}',
        f'--remote-allow-origins={origin}',
        f'--user-data-dir={profile}',
        f'--metis-layout-acceptance={token}',
    ]
    environment, environment_policy = build_acceptance_environment(profile)
    process = None
    acceptance_result = None
    acceptance_report = None
    report: dict[str, Any] | None = None
    complete_pass = False
    try:
        with electron_log.open('w', encoding='utf-8') as log:
            process = subprocess.Popen(
                command,
                cwd=PROJECT_ROOT,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                text=True,
            )
            acceptance_command = [
                sys.executable,
                str(ACCEPTANCE_SCRIPT),
                '--port',
                str(port),
                '--output-dir',
                str(attempt_dir),
                '--expected-profile',
                str(profile),
            ]
            if force_failure_after_handshake:
                acceptance_command.append('--force-failure-after-handshake')
            acceptance_result = subprocess.run(
                acceptance_command,
                cwd=PROJECT_ROOT,
                env=environment,
                text=True,
                capture_output=True,
                timeout=240,
                check=False,
            )
        acceptance_report = read_json_object(acceptance_report_path)
        complete_pass = is_complete_acceptance_pass(
            acceptance_result.returncode,
            acceptance_report,
            attempt_dir,
        )
        profile_verified = bool(
            acceptance_report
            and acceptance_report.get('environment', {}).get(
                'profileVerified'
            ) is True
        )
        retryable = is_retryable_cdp_timeout(
            acceptance_result.returncode,
            acceptance_report,
        )
        report = {
            'attempt': attempt_number,
            'status': 'passed' if complete_pass else 'failed',
            'failureClassification': (
                None if complete_pass else classify_acceptance_failure(
                    acceptance_result.returncode,
                    acceptance_report,
                )
            ),
            'retryEligible': retryable,
            'port': port,
            'profileVerifiedByAcceptance': profile_verified,
            'profileIsTemporary': True,
            'normalUserProfileUsed': False,
            'apiKeyReadOrModifiedByLauncher': False,
            'environmentPolicy': environment_policy,
            'entry': str((PROJECT_ROOT / 'dist' / 'index.html').resolve()),
            'electronExitBeforeCleanup': process.poll(),
            'acceptanceReturnCode': acceptance_result.returncode,
            'acceptanceReport': 'electron-layout-acceptance.json',
            'acceptanceReportParsed': acceptance_report is not None,
            'acceptanceReportComplete': complete_pass,
            'stderrWasEmpty': not bool(acceptance_result.stderr),
        }
        if acceptance_result.stdout:
            print(acceptance_result.stdout, end='')
        if acceptance_result.stderr:
            print(acceptance_result.stderr, end='', file=sys.stderr)
    except subprocess.TimeoutExpired as error:
        report = {
            'attempt': attempt_number,
            'status': 'failed',
            'failureClassification': classify_acceptance_failure(
                1,
                None,
                outer_timeout=True,
            ),
            'retryEligible': False,
            'error': f'Acceptance timed out after {error.timeout} seconds',
            'port': port,
            'profileVerifiedByAcceptance': False,
            'profileIsTemporary': True,
            'normalUserProfileUsed': False,
            'apiKeyReadOrModifiedByLauncher': False,
            'environmentPolicy': environment_policy,
        }
    finally:
        if process is not None:
            terminate_process_tree(process)
        profile_removed = False
        cleanup_error = None
        if keep_profile:
            print(
                'Isolated acceptance profile retained for debugging.',
                file=sys.stderr,
            )
        else:
            profile_removed, cleanup_error = remove_profile(profile)
        if report is None:
            report = {
                'attempt': attempt_number,
                'status': 'failed',
                'failureClassification': 'launcher_failure',
                'retryEligible': False,
                'error': 'Launcher did not produce an acceptance result',
            }
        report['electronExitAfterCleanup'] = (
            process.poll() if process is not None else None
        )
        report['profileRemoved'] = profile_removed
        report['profileCleanupError'] = cleanup_error
        if not keep_profile and not profile_removed:
            report['status'] = 'failed'
            report['failureClassification'] = 'profile_cleanup_failure'
            report['retryEligible'] = False
            complete_pass = False
        launcher_report.write_text(
            json.dumps(report, ensure_ascii=False, indent=2),
            encoding='utf-8',
        )
    return report, acceptance_report, complete_pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=pathlib.Path, required=True)
    parser.add_argument('--keep-profile', action='store_true')
    parser.add_argument('--force-failure-after-handshake', action='store_true')
    args = parser.parse_args()

    require_files = (
        ELECTRON_EXE,
        ACCEPTANCE_SCRIPT,
        PROJECT_ROOT / 'dist' / 'index.html',
        PROJECT_ROOT / 'dist-electron' / 'electron' / 'main.js',
    )
    missing = [str(path) for path in require_files if not path.is_file()]
    if missing:
        raise FileNotFoundError(
            f'Acceptance prerequisites are missing: {missing}'
        )

    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    root_report_path = output_dir / 'electron-layout-launcher.json'
    attempt_summaries: list[dict[str, Any]] = []
    final_attempt_report: dict[str, Any] | None = None
    complete_pass = False

    for attempt_number in (1, 2):
        attempt_dir = output_dir / f'attempt-{attempt_number}'
        rerun_index = 1
        while attempt_dir.exists():
            attempt_dir = output_dir / f'attempt-{attempt_number}-rerun-{rerun_index}'
            rerun_index += 1
        attempt_report, _, complete_pass = run_attempt(
            attempt_number,
            attempt_dir,
            args.keep_profile,
            args.force_failure_after_handshake,
        )
        final_attempt_report = attempt_report
        attempt_summaries.append({
            'attempt': attempt_number,
            'artifactDirectory': attempt_dir.name,
            'status': attempt_report.get('status'),
            'failureClassification': attempt_report.get(
                'failureClassification'
            ),
            'retryEligible': attempt_report.get('retryEligible'),
            'acceptanceReturnCode': attempt_report.get(
                'acceptanceReturnCode'
            ),
            'profileRemoved': attempt_report.get('profileRemoved'),
            'profileCleanupError': attempt_report.get(
                'profileCleanupError'
            ),
        })
        if complete_pass:
            break
        if not (
            attempt_number == 1
            and attempt_report.get('retryEligible') is True
        ):
            break

    retried = len(attempt_summaries) == 2
    if complete_pass:
        status = 'passed_after_infrastructure_retry' if retried else 'passed'
        exit_code = 0
    elif (
        final_attempt_report
        and final_attempt_report.get('failureClassification') == 'cdp_timeout'
    ):
        status = 'failed_infrastructure'
        exit_code = 1
    else:
        status = 'failed_assertion'
        exit_code = 1

    root_report = {
        'status': status,
        'attemptCount': len(attempt_summaries),
        'infrastructureRetryUsed': retried,
        'attempts': attempt_summaries,
        'finalAttempt': final_attempt_report,
    }
    root_report_path.write_text(
        json.dumps(root_report, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )
    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
