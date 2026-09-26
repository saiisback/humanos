"""Bounded browser operations over Browser Use actor pages.

Only these operations exist. Selectors, paths and field names come from the site
policy; the runner may name only a candidate id observed at the current revision, a
set of policy fields, or a single-use submission permit. Page text is untrusted data
returned to the runner, never interpreted as instructions here.
"""

from __future__ import annotations

import asyncio
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

from .policy import SitePolicy
from .protocol import canonical_hash
from .session import GuardedSession

_CANDIDATE_TARGET = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_CONTROL = re.compile(r"[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏ -‮⁠-⁤﻿]")


class Handoff(Exception):
    def __init__(self, reason: str, message: str) -> None:
        super().__init__(reason)
        self.reason = reason
        self.message = message


class Failure(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(code)
        self.code = code
        self.message = message


def sanitize(text: str, limit: int = 500) -> str:
    """Normalized, single-spaced, control/bidi-free text, bounded for model context."""
    text = unicodedata.normalize("NFC", text or "")
    text = _CONTROL.sub("", text).replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def parse_amount(text: str) -> str:
    match = re.search(r"(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,18})?", text)
    if not match:
        raise Handoff("PAGE_CHANGED", "The price could not be read from the page.")
    return match.group(1).replace(",", "") + (match.group(2) or "")


@dataclass
class Prepared:
    revision: int
    destination: str
    fields: dict[str, str]
    material: list[str]
    value: dict[str, str] | None
    material_hash: str


class BookingActions:
    def __init__(self, browser: GuardedSession, policy: SitePolicy, settle_seconds: float = 0.8) -> None:
        self.browser = browser
        self.policy = policy
        self.settle = settle_seconds
        self.prepared: Prepared | None = None
        self.permit_used = False
        self.candidates: dict[str, dict[str, Any]] = {}

    # -- reading ------------------------------------------------------------------

    async def _elements(self, selector: str):
        return await self.browser.page.get_elements_by_css_selector(selector)

    async def _text(self, selector: str, *, complete: bool = False) -> str | None:
        elements = await self._elements(selector)
        if not elements:
            return None
        raw = await elements[0].evaluate("() => this.innerText || this.textContent || ''")
        # Model observations may be shortened, but authorization evidence must
        # never discard the tail of a venue, price, or cancellation condition.
        text = sanitize(raw, 501 if complete else 500)
        if complete and len(text) > 500:
            raise Handoff("PAGE_CHANGED", "Booking details exceed the supported review size. Review them directly on the site; nothing was submitted.")
        return text

    async def _value(self, selector: str) -> str | None:
        elements = await self._elements(selector)
        if len(elements) != 1:
            return None
        return await elements[0].evaluate("() => typeof this.value === 'string' ? this.value : ''")

    async def _location(self) -> tuple[str, str]:
        parts = urlsplit(await self.browser.page.get_url())
        return f"{parts.scheme}://{parts.netloc}", parts.path or "/"

    async def _assert_on_policy_origin(self) -> str:
        origin, path = await self._location()
        if origin != self.policy.origin:
            raise Handoff("POLICY_BLOCKED", "The page left the approved site.")
        return path

    async def open(self) -> None:
        await self.browser.navigate(self.policy.entry_path)

    async def observe(self, revision: int) -> dict[str, Any]:
        path = await self._assert_on_policy_origin()
        if self.policy.captcha_selector and await self._elements(self.policy.captcha_selector):
            raise Handoff("CAPTCHA", "Complete the CAPTCHA in the HumanOS browser window.")
        login = bool(self.policy.login_selector and await self._elements(self.policy.login_selector))
        facts: list[dict[str, str]] = []
        for index, selector in enumerate(self.policy.material_selectors[:16]):
            text = await self._text(selector)
            if text:
                facts.append({"label": f"material-{index + 1}", "text": text})
        if self.policy.value_selector:
            text = await self._text(self.policy.value_selector)
            if text:
                facts.append({"label": "price", "text": text})
        candidates: list[dict[str, Any]] = []
        if self.policy.select_selector and not login:
            for element in (await self._elements(self.policy.select_selector))[:64]:
                target = await element.get_attribute(self.policy.candidate_attribute)
                if not target or not _CANDIDATE_TARGET.match(target):
                    continue  # the page cannot mint arbitrary candidate ids
                disabled = await element.evaluate("() => !!this.disabled || this.getAttribute('aria-disabled') === 'true'")
                if disabled == "True" or disabled == "true":
                    continue
                label = sanitize(await element.evaluate("() => this.innerText || this.textContent || ''"), 200)
                candidates.append({"id": f"select:{target}", "kind": "select", "label": label, "targetId": target,
                                   "policyId": self.policy.id, "observationRevision": revision})
        self.candidates = {c["id"]: c for c in candidates}
        return {"origin": self.policy.origin, "path": path, "title": sanitize(await self.browser.page.get_title(), 200),
                "loginRequired": login, "facts": facts, "candidates": candidates}

    # -- interacting -------------------------------------------------------------

    async def act(self, candidate_id: str) -> None:
        candidate = self.candidates.get(candidate_id)
        if candidate is None or candidate["kind"] != "select" or not self.policy.select_selector:
            raise Handoff("STALE_OBSERVATION", "That choice is not on the current page. Observe again.")
        target = candidate["targetId"]
        # target is validated against _CANDIDATE_TARGET, so it cannot break out of the attribute.
        selector = f'{self.policy.select_selector}[{self.policy.candidate_attribute}="{target}"]'
        elements = await self._elements(selector)
        if len(elements) != 1:
            raise Handoff("PAGE_CHANGED", "The chosen option changed on the page.")
        self.prepared = None  # any interaction invalidates earlier preparation
        self.browser.guard.phase = "interacting"
        try:
            await elements[0].click()
            await asyncio.sleep(self.settle)
        finally:
            self.browser.guard.phase = "closed"
        await self._assert_on_policy_origin()

    def _validate_fields(self, fields: dict[str, str]) -> None:
        typed = {spec.name: spec for spec in self.policy.fields if not spec.derived}
        if set(fields) != set(typed):
            raise Failure("POLICY", "Provide exactly the reservation fields this site requires.")
        for name, value in fields.items():
            spec = typed[name]
            if not value.strip() or len(value) > spec.max_length or (spec.pattern and not re.fullmatch(spec.pattern, value)):
                raise Failure("POLICY", f"The {spec.label} value is not accepted by this site.")

    async def _capture(self, revision: int) -> Prepared:
        path = await self._assert_on_policy_origin()
        values: dict[str, str] = {}
        for spec in self.policy.fields:
            value = await self._value(spec.selector)
            if value is None:
                raise Handoff("PAGE_CHANGED", f"The {spec.label} field is missing from the page.")
            if spec.derived and (not value or len(value) > spec.max_length or (spec.pattern and not re.fullmatch(spec.pattern, value))):
                raise Handoff("UNAVAILABLE_SLOT", f"Choose a {spec.label} first.")
            values[spec.name] = value
        material: list[str] = []
        for selector in self.policy.material_selectors[:16]:
            text = await self._text(selector, complete=True)
            if text is None:
                raise Handoff("PAGE_CHANGED", "Booking details are missing from the page.")
            material.append(text)
        value = None
        if self.policy.value_selector:
            text = await self._text(self.policy.value_selector, complete=True)
            if text is None:
                raise Handoff("PAGE_CHANGED", "The price is missing from the page.")
            value = {"amount": parse_amount(text), "currency": self.policy.currency or ""}
        digest = canonical_hash({"policyId": self.policy.id, "origin": self.policy.origin, "path": path,
                                 "destination": self.policy.destination, "fields": values, "material": material, "value": value})
        return Prepared(revision, self.policy.destination, values, material, value, digest)

    async def prepare(self, fields: dict[str, str], revision: int) -> Prepared:
        self._validate_fields(fields)
        await self._assert_on_policy_origin()
        # Typing can trigger page scripts: the gate stays closed, so nothing typed can leave.
        self.browser.guard.phase = "closed"
        for spec in self.policy.fields:
            if spec.derived:
                continue
            elements = await self._elements(spec.selector)
            if len(elements) != 1:
                raise Handoff("PAGE_CHANGED", f"The {spec.label} field is missing from the page.")
            await elements[0].fill(fields[spec.name])
            if await self._value(spec.selector) != fields[spec.name]:
                raise Handoff("PAGE_CHANGED", f"The site did not accept the {spec.label} exactly as entered.")
        self.prepared = await self._capture(revision)
        return self.prepared

    # -- the single approved write -------------------------------------------------

    async def submit(self, command: dict[str, Any], revision: int, now: datetime | None = None) -> dict[str, str]:
        permit = command["payload"]["permit"]
        if self.permit_used:
            raise Failure("PERMIT", "This browser session already used its submission permit.")
        # The permit is consumed by the first attempt, whatever happens next.
        self.permit_used = True
        if (permit["runId"], permit["sessionId"], permit["actionId"], permit["observationRevision"]) != \
                (command["runId"], command["sessionId"], command["actionId"], revision):
            raise Failure("PERMIT", "The submission permit is not for this exact browser state.")
        expires = datetime.fromisoformat(permit["expiresAt"].replace("Z", "+00:00"))
        if expires <= (now or datetime.now(timezone.utc)):
            raise Failure("PERMIT", "The approval expired. Review the booking again.")
        prepared = self.prepared
        if prepared is None or prepared.revision != revision or prepared.material_hash != permit["payloadHash"]:
            raise Failure("PERMIT", "The approved booking does not match the prepared page.")
        current = await self._capture(revision)
        if current.material_hash != prepared.material_hash:
            raise Handoff("PAGE_CHANGED", "Availability, price or terms changed after review. Review again.")
        buttons = await self._elements(self.policy.submit_selector)
        if len(buttons) != 1:
            raise Handoff("PAGE_CHANGED", "The booking button changed on the page.")
        guard = self.browser.guard
        guard.arm(prepared.fields)
        try:
            await buttons[0].click()
            for _ in range(100):
                if guard.submission_sent or guard.tampered:
                    break
                await asyncio.sleep(0.1)
        finally:
            guard.disarm()
        if guard.tampered:
            raise Failure("UNKNOWN_OUTCOME", "The page tried to send different booking data; the outcome must be checked.")
        if not guard.submission_sent:
            # The gate never let the request out, so the site received nothing.
            raise Failure("BROWSER", "The booking request was not sent. Nothing was submitted.")
        receipt = await self._await_receipt()
        if receipt is None:
            raise Failure("UNKNOWN_OUTCOME", "The booking was sent but no confirmation was observed.")
        return receipt

    async def _await_receipt(self, timeout: float = 15.0) -> dict[str, str] | None:
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            receipt = await self.inspect_receipt()
            if receipt:
                return receipt
            await asyncio.sleep(0.2)
        return None

    async def inspect_receipt(self) -> dict[str, str] | None:
        """Read-only: reads the current page. Never navigates, clicks or resubmits."""
        try:
            origin, path = await self._location()
            if origin != self.policy.origin or not path.startswith(self.policy.success_path_prefix):
                return None
            reference = await self._text(self.policy.reference_selector)
        except Exception:
            return None
        if not reference or not re.fullmatch(self.policy.reference_pattern, reference):
            return None
        return {"providerReference": reference, "finalUrl": f"{origin}{path}",
                "successEvidence": sanitize(f"{self.policy.label}: reference {reference}")}
