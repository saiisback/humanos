"""Inspected Brooklyn Parlor availability. No production submission or guest upload."""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlsplit

from ..policy import FieldSpec, PolicyError, ReadRule, SitePolicy
from .tablecheck_form import OFFER

ORIGIN = "https://www.tablecheck.com"
BASE = "/en/shops/brooklynparlor-shinjuku"
AVAILABILITY_PATH = BASE + "/available"
QUERY_KEYS = frozenset(("reservation[start_at_epoch]", "reservation[num_people_adult]", "reservation[num_people_child]",
                        "reservation[num_people_baby]", "reservation[orders_attributes][0][menu_item_id]",
                        "reservation[orders_attributes][0][is_group_order]"))


def tablecheck_policy() -> SitePolicy:
    return SitePolicy(id="tablecheck-brooklyn-parlor", label="Brooklyn Parlor · availability only", origin=ORIGIN,
        entry_path=BASE + "/reserve", fields=(
            FieldSpec("date", "Date", "#reservation_start_date", 10), FieldSpec("time", "Time", "#reservation_start_at_epoch", 5),
            FieldSpec("timezone", "Timezone", "#shop-data", 32), FieldSpec("adults", "Adults", "#reservation_num_people_adult", 1),
            FieldSpec("children", "Children", "#reservation_num_people_child", 1), FieldSpec("offer_id", "Offer", "#new_reservation", 24),
        ), submit=None, submit_selector="", success_path_prefix="", reference_selector="", reference_pattern="",
        preparation_reads=(ReadRule(AVAILABILITY_PATH, QUERY_KEYS, bound_values_required=True),))


def availability_query(fields: dict[str, str], now: datetime | None = None) -> tuple[tuple[str, str], ...]:
    if set(fields) != {"date", "time", "timezone", "adults", "children", "offer_id"} or any(not isinstance(v, str) for v in fields.values()):
        raise PolicyError("INVALID_AVAILABILITY_FIELDS")
    if fields["timezone"] != "Asia/Tokyo" or fields["offer_id"] != OFFER or not re.fullmatch(r"[1-5]", fields["adults"]) \
            or not re.fullmatch(r"[0-5]", fields["children"]) or int(fields["adults"]) + int(fields["children"]) >= 6 \
            or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", fields["date"]) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", fields["time"]):
        raise PolicyError("INVALID_AVAILABILITY_FIELDS")
    japan = timezone(timedelta(hours=9))
    try:
        requested = datetime.fromisoformat(fields["date"] + "T" + fields["time"] + ":00+09:00")
    except ValueError as error:
        raise PolicyError("INVALID_AVAILABILITY_FIELDS") from error
    if requested.date() <= (now or datetime.now(japan)).astimezone(japan).date():
        raise PolicyError("SAME_DAY_OR_PAST")
    return (("reservation[start_at_epoch]", str(int(requested.timestamp()))),
            ("reservation[num_people_adult]", fields["adults"]), ("reservation[num_people_child]", fields["children"]),
            ("reservation[num_people_baby]", "0"), ("reservation[orders_attributes][0][menu_item_id]", OFFER),
            ("reservation[orders_attributes][0][is_group_order]", "1"))


def availability_message(raw: str, fields: dict[str, str]) -> str:
    if len(raw) > 65536:
        raise PolicyError("UNRECOGNIZED_AVAILABILITY")
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError) as error:
        raise PolicyError("UNRECOGNIZED_AVAILABILITY") from error
    if not isinstance(data, dict) or data.get("status") not in {"success", "failure", "same_day", "other_day", "reservation_request", "closed", "invalid"}:
        raise PolicyError("UNRECOGNIZED_AVAILABILITY")
    slot = f"Brooklyn Parlor Shinjuku · {fields['date']} {fields['time']} Japan time · {fields['adults']} adults, {fields['children']} children"
    if data["status"] == "success":
        return f"{slot}: available when checked. Not booked. TableCheck final submission and receipt verification are not enabled yet. No guest contact details were sent."
    return f"{slot}: this exact slot could not be verified as available. Not booked; no different time or offer was selected."


class TableCheckActions:
    """Finite read-only preparation; it deliberately never yields a Prepared permit target."""
    def __init__(self, browser, policy: SitePolicy):
        self.browser, self.policy = browser, policy

    async def open(self):
        await self.browser.navigate(self.policy.entry_path)

    async def observe(self, revision):
        return {"origin": self.policy.origin, "path": self.policy.entry_path, "title": self.policy.label,
                "loginRequired": False, "facts": [], "candidates": []}

    async def act(self, candidate_id):
        from ..actions import Handoff
        raise Handoff("UNSUPPORTED_EFFECT", "This integration checks only the exact requested availability; it does not select alternatives.")

    async def prepare(self, fields, revision):
        from ..actions import Handoff, Failure
        try:
            query = availability_query(fields)
        except PolicyError:
            raise Failure("POLICY", "Check the restaurant date, Japan time, party size and table-only offer.") from None
        self.browser.guard.bind_preparation_read(AVAILABILITY_PATH, query)
        self.browser.guard.phase = "interacting"
        try:
            await self.browser.page.goto(self.policy.origin + AVAILABILITY_PATH + "?" + urlencode(query))
            await self.browser.wait_ready()
        finally:
            self.browser.guard.phase = "closed"
        location = urlsplit(await self.browser.page.get_url())
        if f"{location.scheme}://{location.netloc}" != self.policy.origin or location.path != AVAILABILITY_PATH:
            raise Handoff("POLICY_BLOCKED", "TableCheck left the inspected availability endpoint. Nothing was booked.")
        raw = await self.browser.page.evaluate("() => document.body.innerText")
        try:
            message = availability_message(raw, fields)
        except PolicyError:
            raise Handoff("PAGE_CHANGED", "TableCheck did not return a recognized availability result. Nothing was booked.") from None
        raise Handoff("UNSUPPORTED_EFFECT", message)

    async def submit(self, command, revision):
        from ..actions import Failure
        raise Failure("POLICY", "TableCheck automatic submission is not enabled. Nothing was booked.")

    async def inspect_receipt(self):
        return None
