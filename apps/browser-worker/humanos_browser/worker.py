"""Scoped Browser Use worker: newline-framed JSON on stdin/stdout, no network listener.

Launched by the HumanOS runner as a child process with a scrubbed environment. It
serves exactly one account/run/session, started by the first ``start`` command.
Stdout carries protocol frames only; library output is redirected to stderr.
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from typing import Any

from .protocol import MAX_MESSAGE_BYTES, ProtocolError, SessionScope, encode, parse_command, result

_SAFE_ENV = {
    "ANONYMIZED_TELEMETRY": "false",
    "BROWSER_USE_CLOUD_SYNC": "false",
    "BROWSER_USE_DISABLE_EXTENSIONS": "1",
    "BROWSER_USE_LOGGING_LEVEL": "error",
    "BROWSER_USE_SETUP_LOGGING": "false",
}
COMMAND_TIMEOUT = 25.0


class Config:
    def __init__(self, env: dict[str, str]) -> None:
        self.profile_root = env.get("HUMANOS_BROWSER_PROFILE_ROOT", "").strip()
        self.chromium = env.get("HUMANOS_BROWSER_CHROMIUM", "").strip()
        self.headless = env.get("HUMANOS_BROWSER_HEADLESS", "true").strip().lower() != "false"
        # Test-only controlled site; production policies come from source (policy.production_policies).
        self.fixture_origin = env.get("HUMANOS_BROWSER_FIXTURE_ORIGIN", "").strip()


def _registry(config: Config):
    from .policy import production_policies

    registry = production_policies()
    if config.fixture_origin:
        from .sites.fixture import fixture_policy

        registry.register(fixture_policy(config.fixture_origin))
    return registry


class Worker:
    def __init__(self, config: Config, out) -> None:
        self.config = config
        self.out = out
        self.scope: SessionScope | None = None
        self.browser = None
        self.actions = None
        self.lease = None
        self.policy = None

    def emit(self, message: dict[str, Any]) -> None:
        self.out.write(encode(message).encode("utf-8"))
        self.out.flush()

    async def handle(self, command: dict[str, Any]) -> dict[str, Any]:
        from .actions import Failure, Handoff

        name = command["command"]
        if self.scope is None:
            if name != "start":
                raise ProtocolError("NOT_STARTED")
            self.scope = SessionScope.from_start(command)
            return await self._start(command)
        scope = self.scope
        try:
            scope.admit(command)
        except ProtocolError as error:
            if str(error) != "STALE_OBSERVATION":
                raise
            # A normal race with a changing page: in scope, so answer, but never act.
            return result(command, scope.revision, "handoff", {"reason": "STALE_OBSERVATION", "message": "The page changed since it was observed. Observe again."})
        try:
            if name == "observe":
                scope.revision += 1
                payload = await asyncio.wait_for(self.actions.observe(scope.revision), COMMAND_TIMEOUT)
                return result(command, scope.revision, "observed", payload)
            if name == "act":
                await asyncio.wait_for(self.actions.act(command["payload"]["candidateId"]), COMMAND_TIMEOUT)
                scope.revision += 1
                return result(command, scope.revision, "acted", {})
            if name == "prepare":
                scope.revision += 1
                prepared = await asyncio.wait_for(self.actions.prepare(command["payload"]["fields"], scope.revision), COMMAND_TIMEOUT)
                return result(command, scope.revision, "prepared", {
                    "destination": prepared.destination, "fields": prepared.fields, "material": prepared.material,
                    "value": prepared.value, "materialHash": prepared.material_hash})
            if name == "submit":
                receipt = await asyncio.wait_for(self.actions.submit(command, scope.revision), COMMAND_TIMEOUT)
                return result(command, scope.revision, "submitted", receipt)
            if name == "inspect_receipt":
                receipt = await asyncio.wait_for(self.actions.inspect_receipt(), COMMAND_TIMEOUT)
                if receipt is None:
                    return result(command, scope.revision, "unavailable", {"reason": "NO_RECEIPT", "message": "No booking confirmation is visible."})
                return result(command, scope.revision, "submitted", receipt)
            if name == "close":
                await self.shutdown()
                return result(command, scope.revision, "closed", {})
        except Handoff as handoff:
            return result(command, scope.revision, "handoff", {"reason": handoff.reason, "message": handoff.message})
        except Failure as failure:
            return result(command, scope.revision, "failed", {"code": failure.code, "message": failure.message})
        except asyncio.TimeoutError:
            if name == "submit":
                sent = bool(self.browser and self.browser.guard.submission_sent)
                return result(command, scope.revision, "failed", {
                    "code": "UNKNOWN_OUTCOME" if sent else "BROWSER",
                    "message": "The booking outcome must be checked." if sent else "The booking request was not sent."})
            return result(command, scope.revision, "handoff", {"reason": "TIMEOUT", "message": "The page did not respond in time."})
        except ProtocolError:
            raise
        except Exception as error:
            code = "UNKNOWN_OUTCOME" if name == "submit" and self.browser and self.browser.guard.submission_sent else "BROWSER"
            print(f"worker: {name} failed: {type(error).__name__}", file=sys.stderr)
            return result(command, scope.revision, "failed", {"code": code, "message": "The browser operation failed."})
        raise ProtocolError("PROTOCOL")

    async def _start(self, command: dict[str, Any]) -> dict[str, Any]:
        from .actions import BookingActions
        from .policy import PolicyError, host_resolver_rules
        from .session import GuardedSession, ProfileError, ProfileManager, browser_use_version

        policy = _registry(self.config).get(command["payload"]["policyId"])
        if policy is None:
            return result(command, 0, "unavailable", {"reason": "POLICY_UNKNOWN", "message": "No inspected site policy is installed for this site."})
        if not self.config.profile_root or not self.config.chromium or not os.path.isfile(self.config.chromium):
            return result(command, 0, "unavailable", {"reason": "RUNTIME_MISSING", "message": "The HumanOS browser runtime is not configured."})
        try:
            version = browser_use_version()
        except Exception:
            return result(command, 0, "unavailable", {"reason": "RUNTIME_MISSING", "message": "Browser Use is not installed for the worker."})
        if version != "0.13.10":
            return result(command, 0, "unavailable", {"reason": "INCOMPATIBLE_RUNTIME", "message": f"Browser Use {version} is not the verified release."})
        loopback = bool(self.config.fixture_origin) and policy.allow_http
        try:
            rules = host_resolver_rules(policy, loopback_fixture=loopback)
            self.lease = ProfileManager(self.config.profile_root).acquire(command["accountId"])
        except ProfileError as error:
            reason = "PROFILE_BUSY" if error.code == "PROFILE_BUSY" else "POLICY_BLOCKED"
            return result(command, 0, "handoff", {"reason": reason, "message": "The dedicated HumanOS browser profile is unavailable."})
        except PolicyError:
            return result(command, 0, "handoff", {"reason": "POLICY_BLOCKED", "message": "The site address is not a safe public destination."})
        self.policy = policy
        self.browser = GuardedSession(policy, self.lease.path, self.config.chromium, rules, headless=self.config.headless,
                                      loopback_fixture=loopback)
        stage = "launch"
        try:
            await asyncio.wait_for(self.browser.start(), 30)
            stage = "open"
            if policy.id == "tablecheck-brooklyn-parlor":
                from .sites.tablecheck import TableCheckActions
                self.actions = TableCheckActions(self.browser, policy)
            else:
                self.actions = BookingActions(self.browser, policy)
            await asyncio.wait_for(self.actions.open(), COMMAND_TIMEOUT)
        except Exception as error:
            print(f"worker: start failed at {stage}: {type(error).__name__}", file=sys.stderr)
            await self.shutdown()
            return result(command, 0, "failed", {"code": "BROWSER", "message": "The HumanOS browser could not open the site."})
        return result(command, 0, "ready", {"runtime": {"name": "browser-use", "version": version},
                                            "policyId": policy.id, "origin": policy.origin, "profile": "dedicated"})

    async def shutdown(self) -> None:
        if self.browser is not None:
            await self.browser.close()
            self.browser = None
        if self.lease is not None:
            self.lease.release()
            self.lease = None


async def serve(reader: asyncio.StreamReader, worker: Worker) -> int:
    try:
        while True:
            try:
                raw = await reader.readuntil(b"\n")
            except asyncio.IncompleteReadError:
                return 0  # runner closed the pipe
            except asyncio.LimitOverrunError:
                print("worker: oversized frame", file=sys.stderr)
                return 2
            try:
                command = parse_command(raw[:-1].decode("utf-8"))
                reply = await worker.handle(command)
            except (ProtocolError, UnicodeDecodeError) as error:
                # A message we cannot bind to the session is never answered or acted on.
                print(f"worker: protocol violation {error}", file=sys.stderr)
                return 2
            worker.emit(reply)
            if command["command"] == "close":
                return 0
    finally:
        await worker.shutdown()


def main() -> int:
    env = dict(os.environ)
    config = Config(env)
    # Keep protocol frames on a private descriptor; anything printed by libraries goes to stderr.
    protocol_fd = os.dup(1)
    os.dup2(2, 1)
    out = os.fdopen(protocol_fd, "wb", buffering=0)
    os.environ.update(_SAFE_ENV)
    if config.profile_root:
        os.environ["BROWSER_USE_CONFIG_DIR"] = os.path.join(config.profile_root, ".browser-use-config")
    else:
        os.environ["BROWSER_USE_CONFIG_DIR"] = tempfile.mkdtemp(prefix="humanos-bu-")

    async def run() -> int:
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader(limit=MAX_MESSAGE_BYTES + 2)
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
        return await serve(reader, Worker(config, out))

    return asyncio.run(run())


if __name__ == "__main__":
    sys.exit(main())
