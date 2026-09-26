"""Real local-browser smoke test: start/observe/close through Browser Use itself.

Controlled fixture page only; no live accounts, sites or external writes.
"""

import asyncio
import importlib.metadata

import pytest

from tests.conftest import ACCOUNT, CHROMIUM, ledger, needs_browser

pytestmark = needs_browser


def test_worker_process_starts_observes_and_closes_through_browser_use(worker, site):
    ready = worker.send("start", {"policyId": "fixture-restaurant"})
    assert ready["status"] == "ready", ready
    assert ready["payload"]["runtime"] == {"name": "browser-use", "version": "0.13.10"}
    assert ready["payload"]["profile"] == "dedicated"
    assert ready["payload"]["origin"] == site.origin

    observed = worker.send("observe")
    assert observed["status"] == "observed", observed
    body = observed["payload"]
    assert body["title"] == "Book a table" and body["path"] == "/book" and not body["loginRequired"]
    # Disabled (full) slots are not offered; candidates are bound to this revision.
    assert [c["id"] for c in body["candidates"]] == ["select:slot-1900", "select:slot-2000"]
    assert {c["observationRevision"] for c in body["candidates"]} == {observed["observationRevision"]}

    assert worker.send("close")["status"] == "closed"
    assert worker.proc.wait(timeout=30) == 0
    # The page load reached the site through the pinned fixture host; nothing else did.
    hits = ledger(site)
    assert hits["writes"] == []
    assert {h["host"] for h in hits["ledger"]} == {f"fixture.humanos.test:{site.port}"}


def test_session_is_a_browser_use_session_not_a_replacement_driver(tmp_path, site):
    from humanos_browser.actions import BookingActions
    from humanos_browser.policy import host_resolver_rules
    from humanos_browser.session import GuardedSession, ProfileManager
    from humanos_browser.sites.fixture import fixture_policy

    async def run():
        policy = fixture_policy(site.origin)
        lease = ProfileManager(tmp_path / "profiles").acquire(ACCOUNT)
        browser = GuardedSession(policy, lease.path, CHROMIUM, host_resolver_rules(policy, loopback_fixture=True))
        try:
            await browser.start()
            assert type(browser._session).__module__ == "browser_use.browser.session"
            assert type(browser._session).__name__ == "BrowserSession"
            assert type(browser.page).__module__ == "browser_use.actor.page"
            actions = BookingActions(browser, policy)
            await actions.open()
            observed = await actions.observe(1)
            assert observed["title"] == "Book a table"
        finally:
            await browser.close()
            lease.release()

    asyncio.run(run())
    assert importlib.metadata.version("browser-use") == "0.13.10"


def test_unknown_policy_and_missing_runtime_are_unavailable_not_ready(worker_env):
    from tests.conftest import WorkerProcess

    unknown = WorkerProcess(worker_env)
    try:
        reply = unknown.send("start", {"policyId": "some-restaurant"})
        assert reply["status"] == "unavailable" and reply["payload"]["reason"] == "POLICY_UNKNOWN"
    finally:
        unknown.close()
    missing = WorkerProcess({**worker_env, "HUMANOS_BROWSER_CHROMIUM": "/nonexistent/chrome"})
    try:
        reply = missing.send("start", {"policyId": "fixture-restaurant"})
        assert reply["status"] == "unavailable" and reply["payload"]["reason"] == "RUNTIME_MISSING"
    finally:
        missing.close()


def test_protocol_violations_end_the_worker_without_a_reply(worker):
    worker.send("start", {"policyId": "fixture-restaurant"})
    # Cross-session command: never answered or acted on.
    reply = worker.send("observe", sessionId="bus-other")
    assert reply["status"] == "exited" and reply["code"] == 2
