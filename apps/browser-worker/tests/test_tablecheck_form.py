"""Transport tests use synthetic contact/token values; they never call TableCheck."""
from dataclasses import replace
from urllib.parse import urlencode

import pytest

from humanos_browser.sites.tablecheck_form import (
    TableCheckContract, FormError, validate_tablecheck_form, matches_prepared_form,
)

REVIEW = {
    "epoch": "1790589600", "adults": "2", "children": "0", "babies": "0",
    "first_name": "Ada", "last_name": "Lovelace", "phone": "+819999999999",
    "email": "ada@example.com", "allergies": "none",
    "offer_id": "66c4d4411c588898fe3bb84b",
    "terms": ("One food and one drink per guest.", "Maximum two hours when busy."),
}
PAIRS = (
    ("authenticity_token", "synthetic-session-token"),
    ("return_to_shop", "brooklynparlor-shinjuku"),
    ("reservation[shop_id]", "brooklynparlor-shinjuku"),
    ("reservation_confirm_shop_note", "true"), ("reservation_confirm_shop_note", "true"),
    ("reservation[start_at_epoch]", "1790589600"),
    ("reservation[num_people_adult]", "2"), ("reservation[num_people_child]", "0"), ("reservation[num_people_baby]", "0"),
    ("reservation[orders_attributes][2][menu_item_id]", "66c4d4411c588898fe3bb84b"),
    ("reservation[orders_attributes][2][is_group_order]", "true"),
    ("reservation[enquete_drafts_attributes][0][question_id]", "62467bb16898cb1c241f0bb3"),
    ("reservation[enquete_drafts_attributes][0][menu_item_id]", ""),
    ("reservation[enquete_drafts_attributes][0][text]", "none"),
    ("reservation[customer][is_single_name]", "false"),
    ("reservation[customer][first_name]", "Ada"), ("reservation[customer][last_name]", "Lovelace"),
    ("reservation[customer][phone]", "+819999999999"), ("reservation[customer][email]", "ada@example.com"),
    ("reservation[customer][preferred_text_provider]", "none"),
    ("reservation[customer][create_account]", "0"), ("reservation[customer][allow_marketing]", "0"),
)

def test_freezes_exact_nested_form_with_explicit_checkbox_multiplicity():
    prepared = validate_tablecheck_form(PAIRS, REVIEW, TableCheckContract())
    assert prepared.pairs == PAIRS
    assert prepared.method == "POST"
    assert prepared.destination == "https://www.tablecheck.com/en/shops/brooklynparlor-shinjuku/reserve/create"
    assert matches_prepared_form("application/x-www-form-urlencoded", urlencode(PAIRS), prepared)
    assert "synthetic-session-token" not in repr(prepared)
    assert "ada@example.com" not in repr(prepared)

@pytest.mark.parametrize("key,value", [
    ("reservation[start_at_epoch]", "1790593200"),
    ("reservation[orders_attributes][2][menu_item_id]", "paid-course"),
    ("reservation[customer][allow_marketing]", "1"),
    ("reservation[customer][create_account]", "1"),
    ("reservation[customer][preferred_text_provider]", "sms"),
    ("reservation_confirm_shop_note", "false"),
])
def test_refuses_changed_semantics_and_unrequested_opt_ins(key, value):
    pairs = tuple((k, value if k == key else v) for k, v in PAIRS)
    with pytest.raises(FormError):
        validate_tablecheck_form(pairs, REVIEW, TableCheckContract())

@pytest.mark.parametrize("extra", [
    (("reservation[customer][email]", "other@example.com"),),
    (("reservation[customer][allow_marketing]", "1"),),
    (("reservation_confirm_shop_note", "true"),),
    (("payment_token", "unknown"),),
])
def test_refuses_extra_parameters_and_unknown_duplicates(extra):
    with pytest.raises(FormError):
        validate_tablecheck_form(PAIRS + extra, REVIEW, TableCheckContract())

def test_requires_complete_terms_and_session_token():
    for terms in ((), ("",), ("x" * 20001,)):
        with pytest.raises(FormError):
            validate_tablecheck_form(PAIRS, {**REVIEW, "terms": terms}, TableCheckContract())
    with pytest.raises(FormError):
        validate_tablecheck_form(PAIRS[1:], REVIEW, TableCheckContract())

@pytest.mark.parametrize("contract", [
    replace(TableCheckContract(), method="GET"),
    replace(TableCheckContract(), destination="https://evil.example/reserve/create"),
    replace(TableCheckContract(), destination="https://www.tablecheck.com/en/shops/other/reserve/create"),
])
def test_refuses_uninspected_destination_or_method(contract):
    with pytest.raises(FormError):
        validate_tablecheck_form(PAIRS, REVIEW, contract)

def test_changed_token_changes_transport_but_not_semantic_commitment():
    old = validate_tablecheck_form(PAIRS, REVIEW, TableCheckContract())
    new_pairs = (("authenticity_token", "replacement-session-token"),) + PAIRS[1:]
    new = validate_tablecheck_form(new_pairs, REVIEW, TableCheckContract())
    assert old.semantic_hash == new.semantic_hash
    assert old.transport_hash != new.transport_hash
    assert not matches_prepared_form("application/x-www-form-urlencoded", urlencode(new_pairs), old)

def test_body_matching_rejects_reordering_extra_fields_and_wrong_encoding():
    prepared = validate_tablecheck_form(PAIRS, REVIEW, TableCheckContract())
    assert not matches_prepared_form("application/json", urlencode(PAIRS), prepared)
    assert not matches_prepared_form("application/x-www-form-urlencoded", urlencode(PAIRS[::-1]), prepared)
    assert not matches_prepared_form("application/x-www-form-urlencoded", urlencode(PAIRS) + "&unlisted=1", prepared)
    assert not matches_prepared_form("application/x-www-form-urlencoded", "%ZZ=x", prepared)

def test_changed_terms_change_semantic_commitment_even_when_transport_is_identical():
    old = validate_tablecheck_form(PAIRS, REVIEW, TableCheckContract())
    new = validate_tablecheck_form(PAIRS, {**REVIEW, "terms": ("Non-refundable deposit JPY 10000",)}, TableCheckContract())
    assert old.semantic_hash != new.semantic_hash
    assert old.transport_hash == new.transport_hash
