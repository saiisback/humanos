"""Real Browser Use sessions against the controlled fixture, including hostile pages.

Assertions are made on the fixture server's own request ledger: what the site actually
received, not what the worker reports.
"""

import json
import urllib.request
from datetime import datetime, timedelta, timezone

import pytest

from tests.conftest import ledger, needs_browser

pytestmark = needs_browser

FIELDS = {"name": "Ada Lovelace", "party_size": "2", "email": "ada@example.com"}
EXACT_BODY = {"name": ["Ada Lovelace"], "party_size": ["2"], "email": ["ada@example.com"], "slot": ["1900"]}


def set_variant(site, **update):
    request = urllib.request.Request(f"http://127.0.0.1:{site.port}/__control/variant", data=json.dumps(update).encode(), method="POST")
    urllib.request.urlopen(request, timeout=5).read()


def permit_for(worker, prepared, **overrides):
    expires = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
    permit = {"runId": worker.scope["runId"], "sessionId": worker.scope["sessionId"], "actionId": worker.action + 1,
              "observationRevision": prepared["observationRevision"], "payloadHash": prepared["payload"]["materialHash"],
              "expiresAt": expires}
    return {"permit": {**permit, **overrides}}


def prepare(worker, fields=FIELDS):
    assert worker.send("start", {"policyId": "fixture-restaurant"})["status"] == "ready"
    observed = worker.send("observe")
    assert observed["status"] == "observed", observed
    acted = worker.send("act", {"candidateId": "select:slot-1900"})
    assert acted["status"] == "acted", acted
    prepared = worker.send("prepare", {"fields": fields})
    return observed, prepared


def reservation_posts(site):
    from urllib.parse import parse_qs

    return [parse_qs(h["body"]) for h in ledger(site)["writes"] if h["method"] == "POST" and h["path"] == "/reserve"]


def test_prepare_then_single_approved_submission_yields_receipt(worker, site):
    observed, prepared = prepare(worker)
    assert prepared["status"] == "prepared", prepared
    body = prepared["payload"]
    assert body["fields"] == {**FIELDS, "slot": "1900"}
    assert body["material"] == ["Sakura Kitchen", "Friday 19:00", "Deposit JPY 1,000 for 1900; refundable until 24h before."]
    assert body["value"] == {"amount": "1000", "currency": "JPY"}
    assert body["destination"] == f"{site.origin}/reserve"
    # Preparation (navigation, slot click with its read, typing) wrote nothing.
    assert ledger(site)["writes"] == []

    submitted = worker.send("submit", permit_for(worker, prepared))
    assert submitted["status"] == "submitted", submitted
    reference = submitted["payload"]["providerReference"]
    assert reference.startswith("R-") and submitted["payload"]["finalUrl"] == f"{site.origin}/confirmed/{reference}"
    assert reservation_posts(site) == [EXACT_BODY]
    assert ledger(site)["writes"] == [w for w in ledger(site)["writes"] if w["path"] == "/reserve"]

    # The permit is single-use and read-only inspection never resubmits.
    again = worker.send("submit", permit_for(worker, prepared, observationRevision=worker.revision))
    assert again["status"] == "failed" and again["payload"]["code"] == "PERMIT"
    receipt = worker.send("inspect_receipt")
    assert receipt["status"] == "submitted" and receipt["payload"]["providerReference"] == reference
    assert len(reservation_posts(site)) == 1


def test_hostile_page_cannot_cause_any_unapproved_request(worker, site):
    set_variant(site, variant="hostile")
    observed, prepared = prepare(worker)
    # Every hostile path (fetch, beacon, image, worker, websocket, popup, Enter, change-submit,
    # navigation on click, off-origin exfiltration) was attempted; the site received no write.
    assert [(w["method"], w["path"]) for w in ledger(site)["writes"]] == []
    assert "IGNORE PREVIOUS" not in json.dumps(observed) and "evil.example" not in json.dumps(observed)
    if prepared["status"] == "prepared":
        submitted = worker.send("submit", permit_for(worker, prepared))
        # The page races a Mallory booking on submit; only the reviewed body can ever pass.
        assert all(post == EXACT_BODY for post in reservation_posts(site))
        assert submitted["status"] in ("submitted", "failed")
    else:
        # The hostile navigation-on-click moved the page: preparation stops for review instead.
        assert prepared["status"] == "handoff"
    assert all(h["path"] in ("/book", "/static/app.css", "/api/slot", "/reserve", "/favicon.ico") or h["path"].startswith("/confirmed/")
               for h in ledger(site)["ledger"])


def test_racing_or_tampered_payloads_are_never_sent(worker_env, site):
    from tests.conftest import WorkerProcess

    for variant in ("race", "tamper"):
        set_variant(site, variant=variant, reset=True)
        worker = WorkerProcess(worker_env, session=f"bus-{variant}")
        try:
            _, prepared = prepare(worker)
            assert prepared["status"] == "prepared"
            submitted = worker.send("submit", permit_for(worker, prepared))
            posts = reservation_posts(site)
            assert all(post == EXACT_BODY for post in posts), (variant, posts)
            assert "Mallory" not in json.dumps(ledger(site)["ledger"])
            # A page that tried to alter the booking yields an outcome to verify, never success.
            assert submitted["status"] == "failed" and submitted["payload"]["code"] == "UNKNOWN_OUTCOME", (variant, submitted)
        finally:
            worker.close()


def test_changed_price_after_review_requires_a_new_review(worker, site):
    set_variant(site, variant="drift")
    _, prepared = prepare(worker)
    assert prepared["status"] == "prepared"
    import time
    time.sleep(3)
    changed = worker.send("submit", permit_for(worker, prepared))
    assert changed["status"] == "handoff" and changed["payload"]["reason"] == "PAGE_CHANGED"
    assert ledger(site)["writes"] == []


@pytest.mark.parametrize("override,expected", [
    ({"payloadHash": "0x" + "0" * 64}, "PERMIT"),
    ({"expiresAt": "2020-01-01T00:00:00Z"}, "PERMIT"),
    ({"runId": "run-other"}, "PERMIT"),
])
def test_mismatched_or_expired_permits_submit_nothing(worker, site, override, expected):
    _, prepared = prepare(worker)
    reply = worker.send("submit", permit_for(worker, prepared, **override))
    assert reply["status"] == "failed" and reply["payload"]["code"] == expected
    assert ledger(site)["writes"] == []


def test_stale_and_fabricated_candidates_are_refused(worker, site):
    assert worker.send("start", {"policyId": "fixture-restaurant"})["status"] == "ready"
    first = worker.send("observe")
    worker.send("observe")
    stale = worker.send("act", {"candidateId": "select:slot-1900"}, revision=first["observationRevision"])
    assert stale["status"] == "handoff" and stale["payload"]["reason"] == "STALE_OBSERVATION"
    fabricated = worker.send("act", {"candidateId": "select:slot-0300"})
    assert fabricated["status"] == "handoff" and fabricated["payload"]["reason"] == "STALE_OBSERVATION"
    full = worker.send("act", {"candidateId": "select:slot-2100"})
    assert full["status"] == "handoff"
    # Submission without preparation is refused outright.
    reply = worker.send("submit", {"permit": {"runId": "run-1", "sessionId": "bus-test", "actionId": worker.action + 1,
                                              "observationRevision": worker.revision, "payloadHash": "0x" + "1" * 64,
                                              "expiresAt": "2030-01-01T00:00:00Z"}})
    assert reply["status"] == "failed" and reply["payload"]["code"] == "PERMIT"
    assert ledger(site)["writes"] == []


def test_fields_outside_the_policy_are_refused(worker, site):
    assert worker.send("start", {"policyId": "fixture-restaurant"})["status"] == "ready"
    worker.send("observe")
    worker.send("act", {"candidateId": "select:slot-1900"})
    for fields in ({**FIELDS, "card_number": "4111"}, {"name": "Ada"}, {**FIELDS, "party_size": "200"}, {**FIELDS, "slot": "2000"}):
        reply = worker.send("prepare", {"fields": fields})
        assert reply["status"] == "failed" and reply["payload"]["code"] == "POLICY", fields


def test_login_and_captcha_pages_hand_off_to_the_user(worker_env, site):
    from tests.conftest import WorkerProcess

    set_variant(site, variant="login")
    worker = WorkerProcess(worker_env, session="bus-login")
    try:
        worker.send("start", {"policyId": "fixture-restaurant"})
        observed = worker.send("observe")
        assert observed["payload"]["loginRequired"] is True and observed["payload"]["candidates"] == []
    finally:
        worker.close()
    set_variant(site, variant="captcha")
    worker = WorkerProcess(worker_env, session="bus-captcha")
    try:
        worker.send("start", {"policyId": "fixture-restaurant"})
        observed = worker.send("observe")
        assert observed["status"] == "handoff" and observed["payload"]["reason"] == "CAPTCHA"
    finally:
        worker.close()


def test_worker_logs_never_contain_typed_personal_data(worker, site):
    prepare(worker)
    worker.send("close")
    worker.proc.wait(timeout=30)
    stderr = worker.proc.stderr.read().decode()
    assert "Ada Lovelace" not in stderr and "ada@example.com" not in stderr
