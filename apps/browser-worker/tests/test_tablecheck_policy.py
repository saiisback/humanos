from urllib.parse import urlencode

import pytest

from humanos_browser.policy import NetworkGuard, PolicyError, production_policies
from humanos_browser.sites.tablecheck import tablecheck_policy, availability_query, availability_message

FIELDS = {"date": "2099-09-28", "time": "19:00", "timezone": "Asia/Tokyo", "adults": "2", "children": "0",
          "offer_id": "66c4d4411c588898fe3bb84b"}

def test_production_support_is_preparation_only_and_cannot_be_armed():
    policy = production_policies().get("tablecheck-brooklyn-parlor")
    assert policy is not None and policy.submit is None
    guard = NetworkGuard(policy)
    with pytest.raises(PolicyError):
        guard.arm({"arbitrary": "body"})
    for phase in ("closed", "loading", "interacting", "armed", "submitted"):
        guard.phase = phase
        assert not guard.decide("POST", policy.origin + "/en/shops/brooklynparlor-shinjuku/reserve/create",
                                "application/x-www-form-urlencoded", "x=1").allow

def test_only_the_exact_bound_availability_query_is_allowed():
    policy = tablecheck_policy()
    guard = NetworkGuard(policy, phase="interacting")
    query = availability_query(FIELDS)
    path = "/en/shops/brooklynparlor-shinjuku/available"
    url = policy.origin + path + "?" + urlencode(query)
    assert not guard.decide("GET", url).allow
    guard.bind_preparation_read(path, query)
    assert guard.decide("GET", url).allow
    assert not guard.decide("GET", url + "&email=ada%40example.com").allow
    changed = tuple((key, "4" if key == "reservation[num_people_adult]" else value) for key, value in query)
    assert not guard.decide("GET", policy.origin + path + "?" + urlencode(changed)).allow
    assert not guard.decide("GET", "https://evil.example" + path + "?" + urlencode(query)).allow
    assert not guard.decide("GET", policy.origin + "/redirect?" + urlencode(query)).allow
    assert not guard.decide("GET", url + "&" + urlencode(query[:1])).allow

@pytest.mark.parametrize("changes", [{"date": "2020-01-01"}, {"time": "25:00"}, {"adults": "6"}, {"children": "5"},
                                       {"offer_id": "paid-offer"}, {"timezone": "UTC"}, {"email": "ada@example.com"}])
def test_availability_cannot_change_constraints_or_transmit_contact_data(changes):
    with pytest.raises(PolicyError):
        availability_query({**FIELDS, **changes})

def test_availability_success_is_never_a_booking_receipt():
    message = availability_message('{"status":"success","data":["6698d2b70ec52f99baad3ac0"]}', FIELDS)
    assert "available" in message.lower() and "not booked" in message.lower()
    assert "confirmed" not in message.lower()
    assert "6698d2b70ec52f99baad3ac0" not in message
    with pytest.raises(PolicyError):
        availability_message('{"status":"unknown"}', FIELDS)
