"""Dedicated per-account browser profiles and a guarded Browser Use session.

The profile is a HumanOS-owned directory derived from the account id beneath a
server-configured root. It is never the user's everyday browser profile, cookies are
never read or exported, and one lock allows a single active run per account.
"""

from __future__ import annotations

import asyncio
import base64
import fcntl
import hashlib
import os
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .policy import NetworkGuard, SitePolicy

MARKER = ".humanos-profile"
# Everyday browser profile locations are never acceptable profile roots.
_EVERYDAY = ("google/chrome", "google-chrome", "chromium", "bravesoftware", "microsoft edge", "microsoft/edge",
             "firefox", "mozilla", "vivaldi", "opera", "arc/user data", "safari")


class ProfileError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass
class ProfileLease:
    path: Path
    _fd: int

    def release(self) -> None:
        if self._fd >= 0:
            try:
                fcntl.flock(self._fd, fcntl.LOCK_UN)
            finally:
                os.close(self._fd)
                self._fd = -1


class ProfileManager:
    def __init__(self, root: str | os.PathLike[str]) -> None:
        resolved = Path(root).expanduser().resolve()
        lowered = str(resolved).lower().replace("\\", "/")
        if any(marker in lowered for marker in _EVERYDAY):
            raise ProfileError("EVERYDAY_PROFILE_ROOT")
        self.root = resolved

    def profile_dir(self, account_id: str) -> Path:
        # Server-derived, not request-supplied: the account id is hashed, never used as a path.
        digest = hashlib.sha256(f"humanos-browser-profile:v1:{account_id}".encode()).hexdigest()[:32]
        return self.root / digest

    def acquire(self, account_id: str) -> ProfileLease:
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = self.profile_dir(account_id)
        if path.exists():
            if path.is_symlink() or not path.is_dir() or not (path / MARKER).is_file():
                # Something else put a directory here; never adopt a foreign profile.
                raise ProfileError("FOREIGN_PROFILE")
        else:
            path.mkdir(mode=0o700)
            (path / MARKER).write_text("HumanOS dedicated browser profile. Not an everyday browser profile.\n")
        os.chmod(path, stat.S_IRWXU)
        fd = os.open(path / ".lock", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise ProfileError("PROFILE_BUSY") from None
        return ProfileLease(path, fd)


def _import_browser_use():
    # Browser Use reads its configuration at import; the worker scrubs env before this.
    from browser_use.browser.profile import BrowserProfile
    from browser_use.browser.session import BrowserSession

    return BrowserSession, BrowserProfile


def browser_use_version() -> str:
    from importlib.metadata import version

    return version("browser-use")


@dataclass
class GuardedSession:
    """One Browser Use session whose every request passes through a NetworkGuard."""

    policy: SitePolicy
    profile_dir: Path
    executable_path: str
    resolver_rules: str
    headless: bool = True
    # Controlled loopback fixture only: its pages are served from 127.0.0.1, which Chromium's
    # local-network protection would otherwise refuse once responses carry our CSP.
    loopback_fixture: bool = False
    guard: NetworkGuard = field(init=False)
    _session: Any = None
    page: Any = None
    _tasks: set[asyncio.Task[Any]] = field(default_factory=set)

    def __post_init__(self) -> None:
        self.guard = NetworkGuard(self.policy)

    async def start(self) -> None:
        BrowserSession, BrowserProfile = _import_browser_use()
        profile = BrowserProfile(
            headless=self.headless,
            executable_path=self.executable_path,
            user_data_dir=str(self.profile_dir),
            enable_default_extensions=False,
            accept_downloads=False,
            auto_download_pdfs=False,
            captcha_solver=False,
            highlight_elements=False,
            dom_highlight_elements=False,
            demo_mode=False,
            keep_alive=False,
            args=[f"--host-resolver-rules={self.resolver_rules}", "--no-proxy-server", "--disable-quic",
                  "--block-new-web-contents", "--disable-background-networking", "--disable-sync",
                  "--disable-component-update", "--no-pings",
                  # Never touch the OS keychain / password store of the user's account.
                  "--use-mock-keychain", "--password-store=basic",
                  *(["--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests"]
                    if self.loopback_fixture and self.policy.allow_http else [])],
        )
        self._session = BrowserSession(browser_profile=profile)
        await self._session.start()
        root = self._session.cdp_client
        root.register.Fetch.requestPaused(self._on_request_paused)
        # Browser-wide interception covers pages, popups, iframes and workers alike. Documents
        # are also paused at the response stage to attach the WebSocket/worker CSP below.
        await root.send.Fetch.enable({"patterns": [{"urlPattern": "*", "requestStage": "Request"},
                                                   {"urlPattern": "*", "resourceType": "Document", "requestStage": "Response"}]})
        try:
            await root.send.Browser.setDownloadBehavior({"behavior": "deny"})
        except Exception:
            pass
        self.page = await self._session.new_page()
        sid = await self.page.session_id
        await root.send.Network.setBypassServiceWorker({"bypass": True}, session_id=sid)

    @property
    def content_security_policy(self) -> str:
        # WebSockets bypass Fetch interception. Explicit http(s) scheme sources below
        # reject ws(s), unlike 'self' or '*'; preserve these explicit sources even for
        # same-origin requests. The real-browser boundary test checks permitted paths
        # from both this document and an about:blank child, with a relaxed-CSP control.
        # Blob workers are also refused and about:blank children inherit this policy.
        paths = sorted({rule.path for rule in self.policy.preparation_reads} | {self.policy.submit.path})
        sources = " ".join(f"{self.policy.origin}{path}" for path in paths) or "'none'"
        return f"connect-src {sources}; worker-src 'none'; object-src 'none'; base-uri 'none'"

    def _on_request_paused(self, event: dict[str, Any], session_id: str | None) -> None:
        # cdp_use awaits returned awaitables inside its read loop: schedule, never return one.
        task = asyncio.get_running_loop().create_task(self._decide(event, session_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _decide(self, event: dict[str, Any], session_id: str | None) -> None:
        root = self._session.cdp_client
        request_id = event["requestId"]
        if "responseStatusCode" in event or "responseErrorReason" in event:
            # Response stage (documents only): the request itself was already allowed.
            try:
                headers = [h for h in event.get("responseHeaders") or []
                           if str(h.get("name", "")).lower() != "content-security-policy-report-only"]
                headers.append({"name": "Content-Security-Policy", "value": self.content_security_policy})
                if "responseStatusCode" not in event:
                    raise ValueError("NO_RESPONSE")
                status = int(event["responseStatusCode"])
                body = ""
                if not 300 <= status < 400:
                    fetched = await root.send.Fetch.getResponseBody({"requestId": request_id}, session_id=session_id)
                    raw = fetched.get("body", "")
                    body = raw if fetched.get("base64Encoded") else base64.b64encode(raw.encode("utf-8")).decode()
                # Headers rewritten via continueResponse are not enforced as CSP; a fulfilled response is.
                await root.send.Fetch.fulfillRequest({"requestId": request_id, "responseCode": status,
                                                      "responseHeaders": headers, "body": body}, session_id=session_id)
            except Exception:
                try:
                    await root.send.Fetch.failRequest({"requestId": request_id, "errorReason": "BlockedByClient"}, session_id=session_id)
                except Exception:
                    pass
            return
        try:
            request = event["request"]
            headers = {str(k).lower(): str(v) for k, v in (request.get("headers") or {}).items()}
            body = request.get("postData")
            if request.get("hasPostData") and body is None:
                allow = False  # a body we cannot see cannot be the reviewed body
            else:
                allow = self.guard.decide(request["method"], request["url"], headers.get("content-type"), body).allow
        except Exception:
            allow = False
        try:
            if allow:
                await root.send.Fetch.continueRequest({"requestId": request_id}, session_id=session_id)
            else:
                await root.send.Fetch.failRequest({"requestId": request_id, "errorReason": "BlockedByClient"}, session_id=session_id)
        except Exception:
            pass

    async def navigate(self, path: str, timeout: float = 15.0) -> None:
        """Opens a policy path. Navigation can write, so only the static-read phase is open."""
        self.guard.phase = "loading"
        try:
            await self.page.goto(f"{self.policy.origin}{path}")
            await self.wait_ready(timeout)
        finally:
            self.guard.phase = "closed"

    async def wait_ready(self, timeout: float = 15.0) -> None:
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            try:
                state = await asyncio.wait_for(self.page.evaluate("() => document.readyState"), 3)
                if state == "complete":
                    return
            except (asyncio.TimeoutError, RuntimeError):
                pass
            if asyncio.get_running_loop().time() > deadline:
                raise asyncio.TimeoutError("PAGE_NOT_READY")
            await asyncio.sleep(0.1)

    async def close(self) -> None:
        self.guard.phase = "closed"
        if self._session is not None:
            try:
                await asyncio.wait_for(self._session.kill(), 20)
            except Exception:
                pass
            self._session = None
        for task in list(self._tasks):
            task.cancel()
