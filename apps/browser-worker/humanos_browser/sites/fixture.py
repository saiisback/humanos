"""Policy for the controlled local fixture restaurant used by tests.

This is NOT a production integration: it is registered only when the test harness
sets HUMANOS_BROWSER_FIXTURE_ORIGIN, and its host is pinned to loopback.
"""

from __future__ import annotations

from ..policy import FieldSpec, ReadRule, SitePolicy, SubmitContract

FIXTURE_HOST = "fixture.humanos.test"


def fixture_policy(origin: str) -> SitePolicy:
    return SitePolicy(
        id="fixture-restaurant",
        label="Controlled fixture restaurant (test only)",
        origin=origin,
        entry_path="/book",
        fields=(
            FieldSpec("name", "reservation name", "#name", 80),
            FieldSpec("party_size", "party size", "#party", 2, r"[1-9][0-9]?"),
            FieldSpec("email", "contact email", "#email", 120, r"[^@\s]+@[^@\s]+\.[a-z]{2,}"),
            FieldSpec("slot", "time slot", "#slot", 16, r"[0-9]{4}", derived=True),
        ),
        submit_selector="#reserve",
        submit=SubmitContract("POST", "/reserve"),
        success_path_prefix="/confirmed/",
        reference_selector="#reference",
        reference_pattern=r"R-[A-Z0-9]{6}",
        read_paths=("/static/app.css",),
        preparation_reads=(ReadRule("/api/slot", frozenset({"time"})),),
        select_selector="button.slot",
        material_selectors=("#venue", "#selected", "#terms"),
        value_selector="#total",
        currency="JPY",
        login_selector="#login-required",
        captcha_selector="#captcha",
        allow_http=origin.startswith(f"http://{FIXTURE_HOST}:"),
    )
