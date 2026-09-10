#!/usr/bin/env python3
"""
任务4 第十七节 —— GUI 多视口验收驱动。

通过 CDP 驱动真实构建的 Electron 渲染层：
- 在 5 个视口（1280x800 / 1366x768 / 1440x900 / 1600x900 / 1920x1080）下
  逐页打开 Projects / Outcomes / Submission / Scenario(个人化中心) / Settings / Topic；
- 每页记录：内容视口实际尺寸、页面级横向滚动（scrollWidth > clientWidth）、
  top-bar 导航按钮可达性，并保存整页截图作为证据。

只读验收：只做导航点击与截图，不创建、不删除、不修改任何研究数据。
"""

from __future__ import annotations

import argparse
import base64
import http.client
import json
import pathlib
import subprocess
import sys
import time
import urllib.request

import websocket

PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
ELECTRON_EXE = PROJECT_ROOT / "node_modules" / "electron" / "dist" / "electron.exe"

VIEWPORTS = [
    (1280, 800),
    (1366, 768),
    (1440, 900),
    (1600, 900),
    (1920, 1080),
]

# 顶层导航 data-nav-id（App.tsx topbar 渲染）。
SURFACES = [
    ("projects", "projects"),
    ("outcomes", "outcomes"),
    ("submissions", "submissions"),
    ("personalization", "personalization"),
    ("settings", "settings"),
    ("topics", "topics"),
]


def wait_for_cdp(port: int, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception:
            time.sleep(0.5)
    raise TimeoutError(f"CDP port {port} did not come up")


def find_page_target(port: int, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2) as response:
                targets = json.loads(response.read().decode("utf-8"))
            pages = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
            if pages:
                return pages[0]
        except Exception:
            pass
        time.sleep(0.5)
    raise TimeoutError("no METIS renderer page target on CDP")


class CDP:
    def __init__(self, target: dict, port: int):
        self._id = 0
        self.socket = websocket.create_connection(
            target["webSocketDebuggerUrl"], origin=f"http://127.0.0.1:{port}", timeout=20,
        )

    def send(self, method: str, params: dict | None = None) -> dict:
        self._id += 1
        message_id = self._id
        self.socket.send(json.dumps({"id": message_id, "method": method, "params": params or {}}))
        deadline = time.time() + 20
        while time.time() < deadline:
            raw = self.socket.recv()
            message = json.loads(raw)
            if message.get("id") == message_id:
                if "error" in message:
                    raise RuntimeError(f"{method} failed: {message['error']}")
                return message.get("result", {})
        raise TimeoutError(f"CDP {method} timed out")

    def evaluate(self, expression: str) -> dict:
        result = self.send("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": True,
        })
        return result.get("result", {}).get("value")

    def screenshot(self, path: pathlib.Path) -> None:
        data = self.send("Page.captureScreenshot", {"format": "png"})
        path.write_bytes(base64.b64decode(data["data"]))


def try_real_window_resize(port: int, width: int, height: int) -> bool:
    """Electron 主窗口 windowId 恒为 1：直接设外框尺寸。成功返回 True。"""
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=5) as response:
        version = json.loads(response.read().decode("utf-8"))
    ws_url = version["webSocketDebuggerUrl"]
    browser = websocket.create_connection(ws_url, origin=f"http://127.0.0.1:{port}", timeout=20)

    class _Caller:
        n = 0

        def call(self, method: str, params: dict) -> dict:
            _Caller.n += 1
            request_id = _Caller.n
            browser.send(json.dumps({"id": request_id, "method": method, "params": params}))
            while True:
                message = json.loads(browser.recv())
                if message.get("id") == request_id:
                    if "error" in message:
                        raise RuntimeError(f"{method} failed: {message['error']}")
                    return message.get("result", {})

    caller = _Caller()
    try:
        caller.call("Browser.setWindowBounds", {
            "windowId": 1,
            "bounds": {"width": width, "height": height, "windowState": "normal"},
        })
        return True
    except RuntimeError as error:
        print(f"[viewport-qa] real window resize unavailable ({error}); falling back to device-metrics emulation")
        return False
    finally:
        browser.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9223)
    parser.add_argument("--output-dir", default="logs/viewport-qa")
    args = parser.parse_args()

    out_dir = PROJECT_ROOT / args.output_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    summary_path = out_dir / "viewport-qa-summary.json"

    # 一次性 profile：避免与应用的单实例锁、真实用户数据发生任何交集；
    # 空数据起步恰好覆盖任务要求的"首次进入/空状态"验收分支。
    profile_dir = out_dir / "profile"
    profile_dir.mkdir(parents=True, exist_ok=True)

    env_note = "electron renderer driven over CDP; read-only navigation only"
    print(f"[viewport-qa] {env_note}")

    process = subprocess.Popen(
        [
            str(ELECTRON_EXE), str(PROJECT_ROOT),
            f"--remote-debugging-port={args.port}",
            f"--remote-allow-origins=http://127.0.0.1:{args.port}",
            f"--user-data-dir={profile_dir}",
            "--disable-gpu",
        ],
        cwd=str(PROJECT_ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    results: list[dict] = []
    try:
        version = wait_for_cdp(args.port)
        print(f"[viewport-qa] CDP up: {version.get('Browser')}")
        target = find_page_target(args.port)
        cdp = CDP(target, args.port)
        cdp.send("Page.enable")
        cdp.send("Runtime.enable")

        # 等待应用水合完成（App 在 isHydrated 前只渲染 loading）。
        deadline = time.time() + 120
        hydrated = False
        while time.time() < deadline:
            value = cdp.evaluate("document.querySelector('.topbar-nav') !== null")
            if value is True:
                hydrated = True
                break
            time.sleep(1)
        if not hydrated:
            raise TimeoutError("app topbar never appeared (hydration or startup blocked)")
        print("[viewport-qa] app hydrated")

        for (width, height) in VIEWPORTS:
            viewport_dir = out_dir / f"{width}x{height}"
            viewport_dir.mkdir(parents=True, exist_ok=True)
            real_resize = try_real_window_resize(args.port, width, height)
            if not real_resize:
                # 与 Chrome DevTools 设备模式同机制：布局视口精确等于目标尺寸。
                cdp.send("Emulation.setDeviceMetricsOverride", {
                    "width": width, "height": height, "deviceScaleFactor": 1, "mobile": False,
                })
            time.sleep(2.5)  # 原生窗口重排 + React 自适应布局
            inner = cdp.evaluate("({w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio})")
            print(f"[viewport-qa] {width}x{height} realResize={real_resize} -> content {inner}")

            for nav_id, page_name in SURFACES:
                clicked = cdp.evaluate(f"""
                    (() => {{
                        const button = document.querySelector(`[data-nav-id="{nav_id}"]`);
                        if (!button) return 'missing';
                        button.click();
                        return 'clicked';
                    }})()
                """)
                time.sleep(2.0)  # lazy chunk 加载 + 渲染
                checks = cdp.evaluate("""
                    (() => {
                        const doc = document.documentElement;
                        const main = document.querySelector('.main-content');
                        const scrollable = main ?? doc;
                        return {
                            innerWidth: window.innerWidth,
                            innerHeight: window.innerHeight,
                            pageHorizontalScroll: scrollable.scrollWidth > scrollable.clientWidth + 1,
                            bodyBlank: document.body.innerText.trim().length === 0,
                        };
                    })()
                """)
                screenshot_path = viewport_dir / f"{page_name}.png"
                cdp.screenshot(screenshot_path)
                record = {
                    "viewport": f"{width}x{height}",
                    "page": page_name,
                    "navClick": clicked,
                    **(checks or {}),
                    "screenshot": str(screenshot_path.relative_to(PROJECT_ROOT)),
                }
                results.append(record)
                status = "HSCROLL!" if record.get("pageHorizontalScroll") else "ok"
                print(f"[viewport-qa]   {page_name:<16} {status} blank={record.get('bodyBlank')} shot={screenshot_path.name}")

        cdp.socket.close()
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()

    summary_path.write_text(json.dumps({
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "driver": "scripts/electron-viewport-qa.py",
        "mode": "read-only navigation + screenshots; window sized via Browser.setWindowBounds, fallback Emulation.setDeviceMetricsOverride",
        "results": results,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    hscroll_pages = [r for r in results if r.get("pageHorizontalScroll")]
    print(f"[viewport-qa] summary written: {summary_path}")
    print(f"[viewport-qa] pages with page-level horizontal scroll: {len(hscroll_pages)}")
    for record in hscroll_pages:
        print(f"  - {record['viewport']} {record['page']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
