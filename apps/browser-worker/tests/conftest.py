from __future__ import annotations

import glob
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

import pytest

from tests.fixture_site import FixtureSite

ACCOUNT = "11155111:0x1111111111111111111111111111111111111111"
WORKER_ROOT = Path(__file__).resolve().parents[1]


def chromium_path() -> str | None:
    """A test Chromium only (Playwright's cache); never the user's installed browser."""
    explicit = os.environ.get("HUMANOS_BROWSER_CHROMIUM")
    if explicit and os.path.isfile(explicit):
        return explicit
    patterns = [
        "~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "~/Library/Caches/ms-playwright/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        "~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome",
    ]
    for pattern in patterns:
        found = sorted(glob.glob(os.path.expanduser(pattern)))
        if found:
            return found[-1]
    return None


CHROMIUM = chromium_path()
needs_browser = pytest.mark.skipif(CHROMIUM is None, reason="no Playwright test Chromium installed")


@pytest.fixture
def site():
    with FixtureSite() as fixture:
        yield fixture


def ledger(site: FixtureSite) -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{site.port}/__control/ledger", timeout=5) as response:
        return json.loads(response.read())


class WorkerProcess:
    """Drives the real worker entry point over its stdin/stdout protocol."""

    def __init__(self, env: dict[str, str], session: str = "bus-test", run: str = "run-1", account: str = ACCOUNT) -> None:
        self.proc = subprocess.Popen([sys.executable, "-m", "humanos_browser.worker"], cwd=WORKER_ROOT, env=env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.scope = {"accountId": account, "runId": run, "sessionId": session}
        self.action = 0
        self.revision = 0

    def send(self, command: str, payload: dict | None = None, *, revision: int | None = None, action: int | None = None, **scope) -> dict:
        self.action = action if action is not None else self.action + 1
        message = {"protocolVersion": 1, **{**self.scope, **scope}, "actionId": self.action,
                   "observationRevision": self.revision if revision is None else revision,
                   "command": command, "payload": payload or {}}
        assert self.proc.stdin and self.proc.stdout
        self.proc.stdin.write((json.dumps(message) + "\n").encode())
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            return {"status": "exited", "code": self.proc.wait(timeout=30)}
        reply = json.loads(line)
        self.revision = reply["observationRevision"]
        return reply

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                self.proc.stdin.close()  # type: ignore[union-attr]
                self.proc.wait(timeout=30)
            except Exception:
                self.proc.kill()
        for stream in (self.proc.stdout, self.proc.stderr):
            if stream:
                stream.close()


@pytest.fixture
def worker_env(tmp_path, site):
    # Chromium needs an existing HOME; an isolated empty one keeps the user's own out of reach.
    (tmp_path / "home").mkdir()
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(tmp_path / "home"),
        "HUMANOS_BROWSER_PROFILE_ROOT": str(tmp_path / "profiles"),
        "HUMANOS_BROWSER_CHROMIUM": CHROMIUM or "",
        "HUMANOS_BROWSER_FIXTURE_ORIGIN": site.origin,
        "PYTHONPATH": str(WORKER_ROOT),
    }
    return env


@pytest.fixture
def worker(worker_env):
    process = WorkerProcess(worker_env)
    yield process
    process.close()
