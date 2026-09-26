import pytest

from humanos_browser.policy import (
    FieldSpec,
    NetworkGuard,
    PolicyError,
    SitePolicy,
    SubmitContract,
    exact_form_body,
    host_resolver_rules,
    is_public_address,
)
from humanos_browser.sites.fixture import fixture_policy

ORIGIN = "http://fixture.humanos.test:8123"
FIELDS = {"name": "Ada", "party_size": "2", "email": "ada@example.com", "slot": "1900"}
BODY = "name=Ada&party_size=2&email=ada%40example.com&slot=1900"
FORM = "application/x-www-form-urlencoded"


def guard(phase="closed"):
    g = NetworkGuard(fixture_policy(ORIGIN))
    g.phase = phase
    return g


def production(**overrides):
    base = dict(id="real-site", label="Real", origin="https://book.example.com", entry_path="/book",
                fields=(FieldSpec("name", "name", "#name", 80),), submit_selector="#go",
                submit=SubmitContract("POST", "/reserve"), success_path_prefix="/done/",
                reference_selector="#ref", reference_pattern=r"[A-Z0-9]{6}")
    return SitePolicy(**{**base, **overrides})


def test_policies_reject_unsafe_origins_selectors_and_paths():
    for origin in ("http://book.example.com", "https://user:pw@book.example.com", "https://localhost",
                   "file:///etc/passwd", "javascript:alert(1)", "https://book.example.com/path"):
        with pytest.raises(PolicyError):
            production(origin=origin)
    for selector in ("#x >> text=Book", "script", "xpath=//a", "a:has(b)", "#x;alert(1)"):
        with pytest.raises(PolicyError):
            production(submit_selector=selector)
    for path in ("book", "//evil.example.com/x", "/a?b=c", "/../etc"):
        with pytest.raises(PolicyError):
            production(entry_path=path)
    # Plain http only for the loopback-pinned fixture host.
    with pytest.raises(PolicyError):
        fixture_policy("http://book.example.com:80")


def test_private_and_special_addresses_are_never_destinations():
    for address in ("127.0.0.1", "10.1.2.3", "192.168.0.10", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1", "0.0.0.0", "224.0.0.1", "not-an-ip"):
        assert not is_public_address(address), address
    assert is_public_address("93.184.216.34")
    with pytest.raises(PolicyError):
        host_resolver_rules(production(), resolve=lambda host: ["10.0.0.5"])
    with pytest.raises(PolicyError):
        host_resolver_rules(production(), resolve=lambda host: ["93.184.216.34", "127.0.0.1"])
    rules = host_resolver_rules(production(), resolve=lambda host: ["93.184.216.34"])
    assert rules == "MAP book.example.com 93.184.216.34,MAP * ~NOTFOUND"
    with pytest.raises(PolicyError):
        host_resolver_rules(production(), loopback_fixture=True)


def test_closed_phase_blocks_everything_including_reads():
    g = guard()
    assert not g.decide("GET", f"{ORIGIN}/book").allow
    assert not g.decide("POST", f"{ORIGIN}/reserve", FORM, BODY).allow


def test_loading_allows_only_static_reads_on_the_policy_origin():
    g = guard("loading")
    assert g.decide("GET", f"{ORIGIN}/book").allow
    assert g.decide("GET", f"{ORIGIN}/static/app.css").allow
    for method, url in (("GET", f"{ORIGIN}/book?x=1"), ("GET", f"{ORIGIN}/reserve"), ("POST", f"{ORIGIN}/book"),
                        ("GET", "http://evil.example.net/steal"), ("GET", "http://fixture.humanos.test:9999/book"),
                        ("GET", "http://user:pw@fixture.humanos.test:8123/book"), ("GET", "file:///etc/passwd"),
                        ("GET", "data:text/html,hi"), ("GET", f"{ORIGIN}/api/slot?time=1900")):
        assert not g.decide(method, url).allow, (method, url)
    # Blocked requests are recorded without query strings or bodies.
    assert all("?" not in path and "steal" not in path for _, path, _ in g.blocked)


def test_interacting_allows_exact_preparation_reads_only():
    g = guard("interacting")
    assert g.decide("GET", f"{ORIGIN}/api/slot?time=1900").allow
    for url in (f"{ORIGIN}/api/slot", f"{ORIGIN}/api/slot?time=1900&time=2000", f"{ORIGIN}/api/slot?time=1&d=x"):
        assert not g.decide("GET", url).allow, url
    assert not g.decide("POST", f"{ORIGIN}/api/slot?time=1900").allow
    assert not g.decide("POST", f"{ORIGIN}/reserve", FORM, BODY).allow


def test_armed_permits_exactly_one_reviewed_submission():
    g = guard()
    g.arm(FIELDS)
    for content_type, body in ((FORM, "name=Mallory&party_size=8&email=ada%40example.com&slot=1900"),
                               (FORM, BODY + "&extra=1"), (FORM, BODY + "&name=Ada"), ("application/json", BODY),
                               (FORM + "; charset=utf-8", BODY), (FORM, None)):
        assert not g.decide("POST", f"{ORIGIN}/reserve", content_type, body).allow
    assert g.tampered
    g = guard()
    g.arm(FIELDS)
    assert not g.decide("POST", f"{ORIGIN}/reserve?x=1", FORM, BODY).allow
    assert not g.decide("PUT", f"{ORIGIN}/reserve", FORM, BODY).allow
    assert not g.decide("POST", f"{ORIGIN}/autosave", FORM, BODY).allow
    g = guard()
    g.arm(FIELDS)
    assert g.decide("POST", f"{ORIGIN}/reserve", FORM, "slot=1900&email=ada%40example.com&party_size=2&name=Ada").allow
    assert g.submission_sent and g.phase == "submitted"
    # One-shot: the same exact request can never pass twice.
    assert not g.decide("POST", f"{ORIGIN}/reserve", FORM, BODY).allow
    assert g.decide("GET", f"{ORIGIN}/confirmed/R-ABC123").allow
    assert not g.decide("GET", f"{ORIGIN}/cancel").allow


def test_exact_form_body_is_strict():
    assert exact_form_body(FORM, BODY, FIELDS)
    assert not exact_form_body(FORM, "", FIELDS)
    assert not exact_form_body(FORM, "name=Ada&name=Ada&party_size=2&email=ada%40example.com", FIELDS)
    assert not exact_form_body(FORM, "garbage;;;", FIELDS)
