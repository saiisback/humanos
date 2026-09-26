"""Private, immutable transport envelope for the inspected TableCheck dinner form.

This validator is not authorization to dispatch. The creation/receipt contract is
not yet verified; production submission remains disabled. Never send the pairs,
CSRF token, or this object's serialization to the model or API.
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from urllib.parse import parse_qsl

from ..protocol import canonical_hash

DESTINATION = "https://www.tablecheck.com/en/shops/brooklynparlor-shinjuku/reserve/create"
OFFER = "66c4d4411c588898fe3bb84b"


class FormError(ValueError):
    """Fixed codes only: never include a token or guest data in an exception."""


@dataclass(frozen=True)
class TableCheckContract:
    method: str = "POST"
    destination: str = DESTINATION


@dataclass(frozen=True)
class PreparedForm:
    pairs: tuple[tuple[str, str], ...] = field(repr=False)
    method: str
    destination: str
    semantic_hash: str
    transport_hash: str


def validate_tablecheck_form(pairs, reviewed: dict, contract: TableCheckContract) -> PreparedForm:
    if contract.method != "POST" or contract.destination != DESTINATION:
        raise FormError("UNINSPECTED_DESTINATION")
    keys = {"epoch", "adults", "children", "babies", "first_name", "last_name", "phone", "email", "allergies", "offer_id", "terms"}
    if set(reviewed) != keys or reviewed["offer_id"] != OFFER:
        raise FormError("REVIEW_FIELDS")
    for key in keys - {"terms"}:
        value = reviewed[key]
        if not isinstance(value, str) or not value or len(value) > 200 or re.search(r"[\x00-\x1f\x7f]", value):
            raise FormError("REVIEW_FIELDS")
    if not re.fullmatch(r"[1-9]\d{9}", reviewed["epoch"]) or not re.fullmatch(r"[1-5]", reviewed["adults"]) \
            or any(not re.fullmatch(r"[0-5]", reviewed[k]) for k in ("children", "babies")) \
            or sum(int(reviewed[k]) for k in ("adults", "children", "babies")) >= 6:
        raise FormError("REVIEW_FIELDS")
    if not re.fullmatch(r"\+[1-9]\d{7,14}", reviewed["phone"]) or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", reviewed["email"]):
        raise FormError("REVIEW_FIELDS")
    terms = reviewed["terms"]
    if not isinstance(terms, (tuple, list)) or not 1 <= len(terms) <= 16 \
            or any(not isinstance(t, str) or not t.strip() for t in terms) \
            or sum(len(t) for t in terms) > 20000:
        raise FormError("MISSING_OR_OVERSIZED_TERMS")
    if not isinstance(pairs, (tuple, list)) or not 1 <= len(pairs) <= 64:
        raise FormError("FORM_FIELDS")
    values: dict[str, list[str]] = defaultdict(list)
    frozen = []
    for item in pairs:
        if not isinstance(item, (tuple, list)) or len(item) != 2 or any(not isinstance(v, str) for v in item):
            raise FormError("FORM_FIELDS")
        key, value = item
        if len(key) > 128 or len(value) > 4096:
            raise FormError("FORM_FIELDS")
        values[key].append(value)
        frozen.append((key, value))
    expected = {
        "return_to_shop": ["brooklynparlor-shinjuku"], "reservation[shop_id]": ["brooklynparlor-shinjuku"],
        "reservation_confirm_shop_note": ["true", "true"],
        "reservation[start_at_epoch]": [reviewed["epoch"]],
        "reservation[num_people_adult]": [reviewed["adults"]],
        "reservation[num_people_child]": [reviewed["children"]], "reservation[num_people_baby]": [reviewed["babies"]],
        "reservation[orders_attributes][2][menu_item_id]": [OFFER],
        "reservation[orders_attributes][2][is_group_order]": ["true"],
        "reservation[enquete_drafts_attributes][0][question_id]": ["62467bb16898cb1c241f0bb3"],
        "reservation[enquete_drafts_attributes][0][menu_item_id]": [""],
        "reservation[enquete_drafts_attributes][0][text]": [reviewed["allergies"]],
        "reservation[customer][is_single_name]": ["false"],
        "reservation[customer][preferred_text_provider]": ["none"],
        "reservation[customer][create_account]": ["0"], "reservation[customer][allow_marketing]": ["0"],
        **{f"reservation[customer][{k}]": [reviewed[k]] for k in ("first_name", "last_name", "phone", "email")},
    }
    tokens = values.pop("authenticity_token", [])
    if len(tokens) != 1 or not tokens[0].strip() or re.search(r"[\x00-\x20\x7f]", tokens[0]):
        raise FormError("SESSION_TOKEN")
    if dict(values) != expected:
        raise FormError("FORM_MISMATCH")
    semantic_hash = canonical_hash({**reviewed, "terms": list(terms), "destination": contract.destination})
    transport_hash = canonical_hash({"method": contract.method, "destination": contract.destination, "pairs": frozen})
    return PreparedForm(tuple(frozen), contract.method, contract.destination, semantic_hash, transport_hash)


def matches_prepared_form(content_type: str | None, body: str | None, prepared: PreparedForm) -> bool:
    if content_type != "application/x-www-form-urlencoded" or not isinstance(body, str) or len(body) > 65536:
        return False
    if re.search(r"%(?![0-9a-fA-F]{2})", body):
        return False
    try:
        pairs = tuple(parse_qsl(body, keep_blank_values=True, strict_parsing=True, max_num_fields=64, errors="strict"))
    except (ValueError, UnicodeError):
        return False
    return pairs == prepared.pairs
