import json
from pathlib import Path

import pytest

from humanos_browser.protocol import (
    MAX_MESSAGE_BYTES,
    ProtocolError,
    SessionScope,
    canonical_hash,
    encode,
    parse_command,
    result,
)

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "protocol-vectors.json").read_text())
SCOPE = VECTORS["scope"]


def line(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


@pytest.mark.parametrize("command", VECTORS["validCommands"], ids=lambda c: c["command"])
def test_valid_commands_round_trip_with_typescript_encoding(command):
    parsed = parse_command(line(command))
    assert parsed == command
    # Identical framing to encodeBrowserWorkerMessage in @humanos/schemas.
    assert encode(parsed) == line(command) + "\n"


@pytest.mark.parametrize("entry", VECTORS["invalidCommands"], ids=lambda e: e["why"])
def test_invalid_commands_are_rejected(entry):
    with pytest.raises(ProtocolError):
        parse_command(line(entry["value"]))


def test_oversized_and_malformed_frames():
    big = dict(VECTORS["validCommands"][3])
    big["payload"] = {"fields": {"name": "x" * MAX_MESSAGE_BYTES}}
    with pytest.raises(ProtocolError, match="MESSAGE_TOO_LARGE"):
        parse_command(line(big))
    with pytest.raises(ProtocolError):
        parse_command("{not json")
    with pytest.raises(ProtocolError):
        parse_command("[]")
    # Duplicate keys could make the two sides disagree about the payload.
    with pytest.raises(ProtocolError):
        parse_command('{"protocolVersion":1,"protocolVersion":1}')


def _cmd(action_id, revision, command="observe", payload=None, **overrides):
    return {"protocolVersion": 1, **SCOPE, "actionId": action_id, "observationRevision": revision,
            "command": command, "payload": {} if payload is None else payload, **overrides}


def test_session_scope_rejects_cross_scope_repeats_and_stale_revisions():
    scope = SessionScope.from_start(parse_command(line(VECTORS["validCommands"][0])))
    scope.admit(_cmd(2, 0))
    with pytest.raises(ProtocolError, match="REPLAYED_ACTION"):
        scope.admit(_cmd(2, 0))
    with pytest.raises(ProtocolError, match="REPLAYED_ACTION"):
        scope.admit(_cmd(1, 0))
    for field, value in (("accountId", "11155111:0x2222222222222222222222222222222222222222"), ("runId", "run-2"), ("sessionId", "bus-other")):
        with pytest.raises(ProtocolError, match="SCOPE_MISMATCH"):
            scope.admit(_cmd(3, 0, **{field: value}))
    scope.revision = 4
    with pytest.raises(ProtocolError, match="STALE_OBSERVATION"):
        scope.admit(_cmd(5, 3, "act", {"candidateId": "select:slot-1900"}))
    # Observation and read-only commands may always refresh a stale view.
    scope.admit(_cmd(6, 3, "observe"))
    scope.admit(_cmd(7, 4, "act", {"candidateId": "select:slot-1900"}))


def test_result_envelopes_echo_scope_and_validate():
    command = parse_command(line(VECTORS["validCommands"][6]))
    out = result(command, 4, "closed", {})
    assert out == VECTORS["validResults"][4]
    with pytest.raises(ProtocolError):
        result(command, 4, "closed", {"script": "x"})


def test_canonical_hash_matches_typescript():
    assert canonical_hash(VECTORS["canonicalHash"]["value"]) == VECTORS["canonicalHash"]["sha256"]
