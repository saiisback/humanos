"""Worker side of the versioned runner <-> Browser Use protocol.

Mirrors ``packages/schemas/src/browser-worker.ts``. Validation is explicit and
strict: unknown keys, commands or shapes are protocol errors, so no script, URL,
selector or path can travel in a command.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

PROTOCOL_VERSION = 1
MAX_MESSAGE_BYTES = 256 * 1024
MAX_SEQUENCE = 2**31 - 1

_SCOPE_ID = re.compile(r"^[A-Za-z0-9:_.-]{1,128}$")
_POLICY_ID = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
_CANDIDATE_ID = re.compile(r"^(navigate|extract|fill|select|submit):[A-Za-z0-9_-]{1,64}$")
_FIELD_NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_HEX = re.compile(r"^0x[0-9a-f]{64}$")
_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$")
_ORIGIN = re.compile(r"^https?://[a-z0-9.-]+(:\d{1,5})?$")
_ENVELOPE = ("protocolVersion", "accountId", "runId", "sessionId", "actionId", "observationRevision")
COMMANDS = ("start", "observe", "act", "prepare", "submit", "inspect_receipt", "close")
HANDOFF_REASONS = ("LOGIN_REQUIRED", "CAPTCHA", "UNSUPPORTED_EFFECT", "POLICY_BLOCKED", "STALE_OBSERVATION",
                   "PAGE_CHANGED", "UNAVAILABLE_SLOT", "TIMEOUT", "PROFILE_BUSY")
# Commands that act on the page must name the revision they were chosen against.
_REVISION_BOUND = ("act", "prepare", "submit")


class ProtocolError(Exception):
    """A message that must be refused without acting on it."""


def _fail(code: str) -> None:
    raise ProtocolError(code)


def _reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out or key in ("__proto__", "constructor", "prototype"):
            _fail("PROTOCOL")
        out[key] = value
    return out


def _decode(raw: str) -> dict[str, Any]:
    if len(raw.encode("utf-8")) > MAX_MESSAGE_BYTES:
        _fail("MESSAGE_TOO_LARGE")
    if "\n" in raw:
        _fail("FRAMING")
    try:
        value = json.loads(raw, object_pairs_hook=_reject_duplicates)
    except ProtocolError:
        raise
    except (ValueError, RecursionError):
        _fail("PROTOCOL")
    if not isinstance(value, dict):
        _fail("PROTOCOL")
    return value


def _exact_keys(value: Any, keys: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != set(keys):
        _fail("PROTOCOL")
    return value


def _string(value: Any, pattern: re.Pattern[str] | None = None, max_length: int = 500) -> str:
    if not isinstance(value, str) or len(value) > max_length or (pattern is not None and not pattern.match(value)):
        _fail("PROTOCOL")
    return value


def _int(value: Any, minimum: int) -> int:
    # bool is an int subclass in Python; JSON true must not pass as 1.
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= MAX_SEQUENCE:
        _fail("PROTOCOL")
    return value


def _fields(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or len(value) > 32:
        _fail("PROTOCOL")
    for key, item in value.items():
        _string(key, _FIELD_NAME, 64)
        _string(item, None, 2000)
    return value


def _envelope(value: dict[str, Any]) -> None:
    if value.get("protocolVersion") != PROTOCOL_VERSION or isinstance(value.get("protocolVersion"), bool):
        _fail("PROTOCOL")
    for key in ("accountId", "runId", "sessionId"):
        _string(value.get(key), _SCOPE_ID, 128)
    _int(value.get("actionId"), 1)
    _int(value.get("observationRevision"), 0)


def _permit(value: Any) -> None:
    permit = _exact_keys(value, ("runId", "sessionId", "actionId", "observationRevision", "payloadHash", "expiresAt"))
    _string(permit["runId"], _SCOPE_ID, 128)
    _string(permit["sessionId"], _SCOPE_ID, 128)
    _int(permit["actionId"], 1)
    _int(permit["observationRevision"], 0)
    _string(permit["payloadHash"], _HEX, 66)
    _string(permit["expiresAt"], _TIMESTAMP, 40)


def validate_command(value: Any) -> dict[str, Any]:
    command = _exact_keys(value, (*_ENVELOPE, "command", "payload"))
    _envelope(command)
    name, payload = command["command"], command["payload"]
    if name not in COMMANDS:
        _fail("PROTOCOL")
    if name == "start":
        _string(_exact_keys(payload, ("policyId",))["policyId"], _POLICY_ID, 64)
    elif name == "act":
        _string(_exact_keys(payload, ("candidateId",))["candidateId"], _CANDIDATE_ID, 80)
    elif name == "prepare":
        _fields(_exact_keys(payload, ("fields",))["fields"])
    elif name == "submit":
        _permit(_exact_keys(payload, ("permit",))["permit"])
    else:
        _exact_keys(payload, ())
    return command


def parse_command(raw: str) -> dict[str, Any]:
    return validate_command(_decode(raw))


def _validate_result_payload(status: str, payload: Any) -> None:
    if status == "ready":
        body = _exact_keys(payload, ("runtime", "policyId", "origin", "profile"))
        runtime = _exact_keys(body["runtime"], ("name", "version"))
        if runtime["name"] != "browser-use" or body["profile"] != "dedicated":
            _fail("PROTOCOL")
        _string(runtime["version"], re.compile(r"^\d+\.\d+\.\d+$"), 32)
        _string(body["policyId"], _POLICY_ID, 64)
        _string(body["origin"], _ORIGIN, 256)
    elif status == "observed":
        body = _exact_keys(payload, ("origin", "path", "title", "loginRequired", "facts", "candidates"))
        _string(body["origin"], _ORIGIN, 256)
        _string(body["path"], None, 512)
        _string(body["title"], None, 200)
        if not isinstance(body["loginRequired"], bool) or not isinstance(body["facts"], list) or len(body["facts"]) > 32:
            _fail("PROTOCOL")
        for fact in body["facts"]:
            fact = _exact_keys(fact, ("label", "text"))
            _string(fact["label"], None, 64)
            _string(fact["text"])
        if not isinstance(body["candidates"], list) or len(body["candidates"]) > 64:
            _fail("PROTOCOL")
        for candidate in body["candidates"]:
            candidate = _exact_keys(candidate, ("id", "kind", "label", "targetId", "policyId", "observationRevision"))
            _string(candidate["id"], _CANDIDATE_ID, 80)
            if candidate["kind"] not in ("navigate", "extract", "fill", "select", "submit"):
                _fail("PROTOCOL")
            _string(candidate["label"], None, 200)
            _string(candidate["targetId"], re.compile(r"^[A-Za-z0-9_-]{1,64}$"), 64)
            _string(candidate["policyId"], _POLICY_ID, 64)
            _int(candidate["observationRevision"], 0)
    elif status == "prepared":
        body = _exact_keys(payload, ("destination", "fields", "material", "value", "materialHash"))
        _string(body["destination"], None, 512)
        _fields(body["fields"])
        if not isinstance(body["material"], list) or len(body["material"]) > 16:
            _fail("PROTOCOL")
        for item in body["material"]:
            _string(item)
        if body["value"] is not None:
            value = _exact_keys(body["value"], ("amount", "currency"))
            _string(value["amount"], re.compile(r"^\d+(\.\d{1,18})?$"), 64)
            _string(value["currency"], re.compile(r"^[A-Z]{3}$"), 3)
        _string(body["materialHash"], _HEX, 66)
    elif status == "submitted":
        body = _exact_keys(payload, ("providerReference", "finalUrl", "successEvidence"))
        if not body["providerReference"]:
            _fail("PROTOCOL")
        _string(body["providerReference"], None, 128)
        _string(body["finalUrl"], None, 512)
        _string(body["successEvidence"])
    elif status == "handoff":
        body = _exact_keys(payload, ("reason", "message"))
        if body["reason"] not in HANDOFF_REASONS:
            _fail("PROTOCOL")
        _string(body["message"])
    elif status == "unavailable":
        body = _exact_keys(payload, ("reason", "message"))
        if body["reason"] not in ("RUNTIME_MISSING", "INCOMPATIBLE_RUNTIME", "POLICY_UNKNOWN", "NO_RECEIPT"):
            _fail("PROTOCOL")
        _string(body["message"])
    elif status == "failed":
        body = _exact_keys(payload, ("code", "message"))
        if body["code"] not in ("PROTOCOL", "POLICY", "BROWSER", "UNKNOWN_OUTCOME", "PERMIT"):
            _fail("PROTOCOL")
        _string(body["message"])
    elif status in ("acted", "closed"):
        _exact_keys(payload, ())
    else:
        _fail("PROTOCOL")


def result(command: dict[str, Any], revision: int, status: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Builds a reply bound to the command's scope; invalid replies are never emitted."""
    _validate_result_payload(status, payload)
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "accountId": command["accountId"],
        "runId": command["runId"],
        "sessionId": command["sessionId"],
        "actionId": command["actionId"],
        "observationRevision": _int(revision, 0),
        "status": status,
        "payload": payload,
    }


def encode(message: dict[str, Any]) -> str:
    # Same framing as JSON.stringify: no spaces, non-ASCII kept as UTF-8, key order preserved.
    text = json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(text.encode("utf-8")) > MAX_MESSAGE_BYTES:
        _fail("MESSAGE_TOO_LARGE")
    return text + "\n"


def canonical_hash(value: Any) -> str:
    """HumanOS canonical JSON v1 (sorted keys) digested with SHA-256, as hashCanonical in TS."""
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)
    return "0x" + hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass
class SessionScope:
    """The single account/run/session a worker process serves after ``start``."""

    account_id: str
    run_id: str
    session_id: str
    last_action: int
    revision: int = 0

    @classmethod
    def from_start(cls, command: dict[str, Any]) -> "SessionScope":
        if command["command"] != "start":
            _fail("NOT_STARTED")
        return cls(command["accountId"], command["runId"], command["sessionId"], command["actionId"])

    def admit(self, command: dict[str, Any]) -> None:
        if (command["accountId"], command["runId"], command["sessionId"]) != (self.account_id, self.run_id, self.session_id):
            _fail("SCOPE_MISMATCH")
        if command["actionId"] <= self.last_action:
            _fail("REPLAYED_ACTION")
        if command["command"] == "start":
            _fail("ALREADY_STARTED")
        if command["command"] in _REVISION_BOUND and command["observationRevision"] != self.revision:
            # Consume the id anyway: a stale command can never be re-sent later.
            self.last_action = command["actionId"]
            _fail("STALE_OBSERVATION")
        self.last_action = command["actionId"]
