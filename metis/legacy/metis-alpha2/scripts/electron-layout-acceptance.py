"""Current METIS entry/DOM contract acceptance.

This is intentionally a current-product contract, not a historical pixel or
responsive matrix. It drives the real built Electron renderer through CDP,
checks the isolated acceptance handshake, navigates every current surface, and
records only bounded summaries. Historical visual/security matrices remain
separate evidence and are not silently presented as this run.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import pathlib
import sys
import time
import urllib.parse
import urllib.request

import websocket


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
EXPECTED_ENTRY = (PROJECT_ROOT / "dist" / "index.html").resolve()
SAFE_MARKDOWN_FIXTURE = (PROJECT_ROOT / "tests" / "fixtures" / "safe-markdown-hostile.md").resolve()
SAFE_MARKDOWN_MARKER = "GOAL001_SAFE_MARKDOWN_FIXTURE"
SAFE_MARKDOWN_REMOTE_HOSTS = (
    "goal001-tracker.invalid",
    "goal001-raw-image.invalid",
    "goal001-frame.invalid",
)
SAFE_MARKDOWN_FORBIDDEN_MARKERS = (
    "GOAL001_USERINFO_SECRET",
    "GOAL001_QUERY_SECRET",
    "GOAL001_FRAGMENT_SECRET",
    "GOAL001_ENCODED_SECRET",
    "GOAL001_BARE_SECRET",
    "GOAL001_BARE_FRAGMENT_SECRET",
    "GOAL001_ALT_SECRET",
    "GOAL001_IMAGE_SECRET",
    "GOAL001_IMAGE_FRAGMENT_SECRET",
    "GOAL001_TITLE_SECRET",
    "GOAL001_JAVASCRIPT_SECRET",
    "GOAL001_DATA_SECRET",
    "GOAL001_FILE_SECRET",
    "GOAL001_RELATIVE_SECRET",
    "GOAL001_AUTH_SECRET",
    "GOAL001_PATH_SECRET",
    "GOAL001_UNC_HOST_SECRET",
    "GOAL001_UNC_SHARE_SECRET",
    "GOAL001_POSIX_SECRET",
    "GOAL001_RAW_HREF_SECRET",
    "GOAL001_RAW_TITLE_SECRET",
    "GOAL001_RAW_ARIA_SECRET",
    "GOAL001_RAW_IMAGE_SECRET",
    "GOAL001_RAW_ALT_SECRET",
    "GOAL001_ONERROR_SECRET",
    "GOAL001_IFRAME_SECRET",
)
DIAGNOSTIC_ONLY_SELECTORS = (
    '[data-testid="diagnostic-mcp-settings"]',
    '[data-testid="diagnostic-hitl-settings"]',
    '[data-testid="diagnostic-skill-controls"]',
    '[data-testid="diagnostic-terminal-toggle"]',
    ".terminal-panel",
    ".error-boundary-details",
    ".approval-queue-technical-details",
    ".approval-modal-technical-details",
)
SURFACE_ORDER = ("projects", "topics", "outcomes", "scenes")
# Task 5 (§15): responsive layout acceptance matrix. The first viewport is the
# baseline pass whose surface snapshots land in the top-level report (the
# runner validates that shape); every viewport gets full DOM-contract,
# overflow, critical-landmark-in-viewport assertions plus PNG screenshots.
VIEWPORT_MATRIX = ((1280, 800), (1366, 768), (1440, 900), (1600, 900), (1920, 1080))
SURFACE_CONTRACT = {
    "topics": {
        "navId": "topics",
        "rootSelector": ".topic-workspace",
        "requiredTestId": "topic-workspace",
        "requiredSelectors": ['[data-testid="topic-workspace"]'],
    },
    "projects": {
        "navId": "projects",
        "rootSelector": ".projects-page",
        "requiredTestId": "projects-page",
        "requiredSelectors": ['[data-testid="projects-page"]'],
    },
    "outcomes": {
        "navId": "outcomes",
        "rootSelector": ".outcomes-page, .outcomes-empty",
        "requiredTestId": None,
        "requiredSelectors": [".outcomes-page, .outcomes-empty"],
    },
    "scenes": {
        "navId": "personalization",
        "entry": "personalization",
        "rootSelector": ".scenario-workbench",
        "requiredTestId": "scenario-workbench",
        "requiredSelectors": ['[data-testid="scenario-workbench"]'],
    },
}
OUT_OF_SCOPE = {
    "rendererResponsiveMatrix": False,
    "windowsNativeWindowMatrix": False,
    "safeMarkdownSecurity": False,
    "pixelRegression": False,
}


def stable_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def forbidden_marker_count(value: object) -> int:
    text = value if isinstance(value, str) else stable_json(value)
    lowered = text.casefold()
    return sum(marker.casefold() in lowered for marker in SAFE_MARKDOWN_FORBIDDEN_MARKERS)


def summarize_captured_value(value: object) -> dict:
    text = value if isinstance(value, str) else stable_json(value)
    encoded = text.encode("utf-8")
    return {
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "utf8Bytes": len(encoded),
        "forbiddenMarkerCount": forbidden_marker_count(text),
    }


def event_params(events: list[dict], method: str) -> list[dict]:
    return [event.get("params", {}) for event in events if event.get("method") == method]


def summarize_network_events(events: list[dict]) -> dict:
    urls: list[str] = []
    remote_urls: list[str] = []
    fixture_urls: list[str] = []
    for params in event_params(events, "Network.requestWillBeSent"):
        request = params.get("request", {})
        url = str(request.get("url", ""))
        if not url:
            continue
        urls.append(url)
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme in {"http", "https", "ws", "wss"}:
            remote_urls.append(url)
        if (parsed.hostname or "").casefold() in SAFE_MARKDOWN_REMOTE_HOSTS:
            fixture_urls.append(url)
    return {
        "requestCount": len(urls),
        "remoteRequestCount": len(remote_urls),
        "fixtureRemoteRequestCount": len(fixture_urls),
        "urlSet": summarize_captured_value(sorted(set(urls))),
    }


def summarize_frame_events(events: list[dict]) -> dict:
    urls: list[str] = []
    for params in event_params(events, "Page.frameNavigated"):
        url = str(params.get("frame", {}).get("url", ""))
        if url:
            urls.append(url)
    for params in event_params(events, "Page.navigatedWithinDocument"):
        url = str(params.get("url", ""))
        if url:
            urls.append(url)
    unexpected = [url for url in urls if not url.startswith("file:") and not url.startswith("metis-app:")]
    return {
        "frameNavigationCount": len(urls),
        "unexpectedFrameNavigationCount": len(unexpected),
        "urlSet": summarize_captured_value(sorted(set(urls))),
    }


def summarize_target_events(events: list[dict]) -> dict:
    urls = [
        str(params.get("targetInfo", {}).get("url", ""))
        for params in event_params(events, "Target.targetCreated")
    ]
    urls = [url for url in urls if url]
    return {"newTargetCount": len(urls), "targetInfoSet": summarize_captured_value(sorted(set(urls)))}


def summarize_console_events(events: list[dict]) -> dict:
    messages = [str(params.get("args", "")) for params in event_params(events, "Runtime.consoleAPICalled")]
    return {"eventCount": len(messages), **summarize_captured_value(messages)}


def canonical_entry_url(value: str) -> pathlib.Path | None:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme == "metis-app" and parsed.netloc == "renderer" and parsed.path == "/index.html":
        return EXPECTED_ENTRY
    if parsed.scheme != "file":
        return None
    try:
        return pathlib.Path(urllib.request.url2pathname(parsed.path.lstrip("/"))).resolve()
    except OSError:
        return None


def is_clean_expected_entry_url(value: str) -> bool:
    parsed = urllib.parse.urlparse(value)
    return (
        parsed.scheme in {"file", "metis-app"}
        and not parsed.query
        and not parsed.fragment
        and canonical_entry_url(value) == EXPECTED_ENTRY
    )


def wait_for_target(port: int, timeout: float = 60) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2) as response:
                targets = json.load(response)
            pages = [target for target in targets if target.get("type") == "page"]
            matches = [target for target in pages if canonical_entry_url(str(target.get("url", ""))) == EXPECTED_ENTRY]
            if len(matches) == 1:
                return matches[0]
            if len(matches) > 1:
                raise RuntimeError(f"Multiple current METIS renderer targets found: {len(matches)}")
        except RuntimeError:
            raise
        except Exception:
            pass
        time.sleep(0.25)
    raise TimeoutError(f"No current METIS renderer target appeared on CDP port {port}")


class CDP:
    def __init__(self, target: dict, port: int):
        self.socket = websocket.create_connection(target["webSocketDebuggerUrl"], origin=f"http://127.0.0.1:{port}", timeout=15)
        self.next_id = 1

    def close(self) -> None:
        self.socket.close()

    def call(self, method: str, params: dict | None = None) -> dict:
        request_id = self.next_id
        self.next_id += 1
        self.socket.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        while True:
            message = json.loads(self.socket.recv())
            if message.get("id") == request_id:
                if "error" in message:
                    raise RuntimeError(message["error"])
                return message

    def evaluate(self, expression: str, await_promise: bool = False):
        result = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": await_promise})
        value = result.get("result", {}).get("result", {})
        if "exceptionDetails" in result.get("result", {}):
            raise RuntimeError(result["result"]["exceptionDetails"])
        return value.get("value")


def wait_for(cdp: CDP, expression: str, timeout: float = 30) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cdp.evaluate(f"Boolean({expression})"):
            return
        time.sleep(0.2)
    raise TimeoutError(f"Timed out waiting for {expression}")


def click_nav(cdp: CDP, nav_id: str) -> None:
    clicked = cdp.evaluate(
        f"(() => {{ const node = document.querySelector('[data-nav-id={json.dumps(nav_id)}]'); if (!node) return false; node.click(); return true; }})()"
    )
    if not clicked:
        raise AssertionError(f"Missing current navigation entry: {nav_id}")


def surface_snapshot(cdp: CDP, name: str) -> dict:
    contract = SURFACE_CONTRACT[name]
    root_selector = contract["rootSelector"]
    required_selectors = contract["requiredSelectors"]
    nav_selector = f'[data-nav-id="{contract["navId"]}"]'
    required_test_id = contract["requiredTestId"]
    required_test_id_selector = (
        f'[data-testid="{required_test_id}"]'
        if required_test_id
        else None
    )
    payload = cdp.evaluate(
        f"""(() => {{
          const root = document.querySelector({json.dumps(root_selector)});
          const required = {json.dumps(required_selectors)}.map((selector) => {{
            const node = document.querySelector(selector);
            return {{ selector, count: document.querySelectorAll(selector).length, visible: Boolean(node && (node.getClientRects().length > 0)) }};
          }});
          const active = document.querySelector('.topbar-nav__item[aria-current="page"]');
          return {{
            name: {json.dumps(name)}, navCount: document.querySelectorAll({json.dumps(nav_selector)}).length,
            navActive: Boolean(active && active.getAttribute('data-nav-id') === {json.dumps(contract["navId"])}),
            rootCount: document.querySelectorAll({json.dumps(root_selector)}).length,
            rootVisible: Boolean(root && root.getClientRects().length > 0),
            required,
            requiredTestId: {json.dumps(required_test_id)},
            requiredTestIdCount: {f'document.querySelectorAll({json.dumps(required_test_id_selector)}).length' if required_test_id_selector else 'null'},
            activeSceneTab: {{ pressed: active?.getAttribute('data-nav-id') === 'personalization' ? 'true' : null }},
          }};
        }})()"""
    )
    if not isinstance(payload, dict):
        raise AssertionError(f"Invalid surface snapshot for {name}")
    return payload


VIEWPORT_SNAPSHOT_JS = """(() => {
  const rootSelector = arguments0;
  const requiredSelector = arguments1;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const doc = document.documentElement;
  const layout = document.querySelector('.app-layout');
  // "Usable/visible" means the element intersects the viewport (long pages
  // legitimately extend below the fold); full containment would be wrong.
  const inViewport = (rect) => rect.width > 0 && rect.height > 0
    && rect.left < vw && rect.right > 0
    && rect.top < vh && rect.bottom > 0;
  const root = document.querySelector(rootSelector);
  const critical = document.querySelector(requiredSelector);
  return {
    viewport: { width: vw, height: vh },
    noHorizontalOverflow: doc.scrollWidth <= doc.clientWidth + 1,
    layoutNoOverflow: layout ? (layout.scrollWidth <= layout.clientWidth + 1) : null,
    rootInViewport: Boolean(root && inViewport(root.getBoundingClientRect())),
    criticalVisible: Boolean(critical && inViewport(critical.getBoundingClientRect())),
  };
})()"""


def viewport_snapshot(cdp: CDP, name: str) -> dict:
    contract = SURFACE_CONTRACT[name]
    payload = cdp.evaluate(
        VIEWPORT_SNAPSHOT_JS
        .replace("arguments0", json.dumps(contract["rootSelector"]))
        .replace("arguments1", json.dumps(contract["requiredSelectors"][0]))
    )
    if not isinstance(payload, dict):
        raise AssertionError(f"Invalid viewport snapshot for {name}")
    return payload


def capture_screenshot(cdp: CDP, path: pathlib.Path) -> str:
    result = cdp.call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
    payload = result.get("result", result)
    data = base64.b64decode(payload["data"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return str(path)


def run_surface_pass(cdp: CDP, screenshots_dir: pathlib.Path, viewport_tag: str, width: int, height: int) -> list:
    """One full DOM-contract pass across all surfaces at one viewport, with
    overflow/critical-landmark assertions and per-surface screenshots."""
    cdp.call("Emulation.setDeviceMetricsOverride", {
        "width": width, "height": height, "deviceScaleFactor": 0, "mobile": False,
    })
    time.sleep(0.2)
    surfaces = []
    for name in SURFACE_ORDER:
        click_nav(cdp, SURFACE_CONTRACT[name]["navId"])
        required = SURFACE_CONTRACT[name]["requiredSelectors"]
        wait_for(cdp, " || ".join(f"document.querySelector({json.dumps(selector)})" for selector in required))
        snapshot = surface_snapshot(cdp, name)
        if snapshot["navCount"] != 1 or not snapshot["navActive"] or snapshot["rootCount"] != 1 or not snapshot["rootVisible"]:
            raise AssertionError(f"Surface contract failed: {snapshot}")
        if any(item.get("count") != 1 or item.get("visible") is not True for item in snapshot["required"]):
            raise AssertionError(f"Surface required landmark failed: {snapshot}")
        if name == "scenes" and snapshot.get("activeSceneTab", {}).get("pressed") != "true":
            raise AssertionError(f"Scenario surface is not active: {snapshot}")
        metrics = viewport_snapshot(cdp, name)
        if metrics["noHorizontalOverflow"] is not True:
            raise AssertionError(f"Horizontal overflow at {viewport_tag}/{name}: {metrics}")
        if metrics["layoutNoOverflow"] is not True:
            raise AssertionError(f"App layout overflow at {viewport_tag}/{name}: {metrics}")
        if metrics["rootInViewport"] is not True:
            raise AssertionError(f"Primary workspace not usable (root out of viewport) at {viewport_tag}/{name}: {metrics}")
        if metrics["criticalVisible"] is not True:
            raise AssertionError(f"Critical control out of viewport at {viewport_tag}/{name}: {metrics}")
        shot = capture_screenshot(cdp, screenshots_dir / f"{viewport_tag}-{name}.png")
        snapshot["viewport"] = metrics
        snapshot["screenshot"] = shot
        surfaces.append(snapshot)
    return surfaces


def verify_acceptance_environment(cdp: CDP, expected_profile: pathlib.Path) -> dict:
    marker_path = expected_profile.resolve() / "metis-layout-acceptance-profile.json"
    if not marker_path.is_file():
        raise AssertionError(f"Isolated profile marker is missing: {marker_path}")
    marker = json.loads(marker_path.read_text(encoding="utf-8"))
    environment = cdp.evaluate("window.metis.acceptanceEnvironment()", await_promise=True)
    if not isinstance(environment, dict) or environment.get("enabled") is not True:
        raise AssertionError(f"Acceptance environment was not authorized: {environment}")
    if pathlib.Path(environment.get("userDataPath", "")).resolve() != expected_profile.resolve():
        raise AssertionError(f"Acceptance profile mismatch: {environment}")
    if pathlib.Path(environment.get("entryPath", "")).resolve() != EXPECTED_ENTRY:
        raise AssertionError(f"Acceptance entry mismatch: {environment}")
    expected_hash = hashlib.sha256(str(marker.get("token", "")).encode("utf-8")).hexdigest()
    if environment.get("tokenSha256") != expected_hash:
        raise AssertionError("Acceptance token digest mismatch")
    return {
        "profileVerified": True,
        "marker": {"purpose": marker.get("purpose"), "tokenSha256": expected_hash, "expectedEntry": marker.get("expectedEntry")},
        "entry": str(EXPECTED_ENTRY),
        "mainProcess": {"enabled": True, "userDataMatchesExpectedProfile": True, "entryPath": str(EXPECTED_ENTRY), "tokenSha256": expected_hash},
        "uiMode": "normal",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--output-dir", type=pathlib.Path, required=True)
    parser.add_argument("--expected-profile", type=pathlib.Path, required=True)
    parser.add_argument("--force-failure-after-handshake", action="store_true")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "status": "failed",
        "acceptance": "current-product-entry-dom-contract",
        "scope": {**OUT_OF_SCOPE, "surfaceDomContract": True, "historicalFailureReportsPreserved": True},
        "surfaces": [],
        "page": {},
    }
    cdp = None
    try:
        target = wait_for_target(args.port)
        if not is_clean_expected_entry_url(str(target.get("url", ""))):
            raise AssertionError(f"Unexpected renderer entry: {target.get('url')}")
        cdp = CDP(target, args.port)
        cdp.call("Runtime.enable")
        cdp.call("Page.enable")
        cdp.evaluate("localStorage.setItem('metis-onboarding-done', '1')")
        cdp.call("Page.reload", {"ignoreCache": True})
        wait_for(cdp, "document.title === 'metis-workbench'")
        wait_for(cdp, "document.querySelector('.app-layout')?.dataset.uiMode === 'normal'")
        report["page"] = {"title": cdp.evaluate("document.title"), "url": cdp.evaluate("location.href")}
        report["environment"] = verify_acceptance_environment(cdp, args.expected_profile)
        if args.force_failure_after_handshake:
            report["failureInjection"] = {"requested": True, "phase": "after-environment-handshake"}
            raise AssertionError("Intentional acceptance failure after environment handshake")
        screenshots_dir = args.output_dir / "screenshots"
        # Baseline pass: the first viewport populates the top-level `surfaces`
        # (the runner validates that shape), then the rest of the matrix runs.
        baseline_width, baseline_height = VIEWPORT_MATRIX[0]
        report["surfaces"] = run_surface_pass(
            cdp, screenshots_dir, f"{baseline_width}x{baseline_height}", baseline_width, baseline_height,
        )
        matrix = {}
        for width, height in VIEWPORT_MATRIX[1:]:
            tag = f"{width}x{height}"
            matrix[tag] = run_surface_pass(cdp, screenshots_dir, tag, width, height)
        cdp.call("Emulation.clearDeviceMetricsOverride")
        report["viewportMatrix"] = matrix
        report["scope"] = {
            **report["scope"],
            "rendererResponsiveMatrix": True,
            "viewportCount": len(VIEWPORT_MATRIX),
            "screenshots": len(VIEWPORT_MATRIX) * len(SURFACE_ORDER),
        }
        report["status"] = "passed"
        return_code = 0
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        return_code = 1
    finally:
        (args.output_dir / "electron-layout-acceptance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        if cdp is not None:
            cdp.close()
    print(json.dumps(report, ensure_ascii=False, indent=2), file=sys.stdout if return_code == 0 else sys.stderr)
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
