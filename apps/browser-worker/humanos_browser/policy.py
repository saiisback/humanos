"""Server-authored site policies and the single network effect boundary.

Everything a page or model can influence is data. Origins, paths, selectors, typed
fields, the final request contract and receipt extraction come only from policies
defined in source. Every browser request (navigation, redirect hop, subresource,
fetch/XHR, beacon, worker, popup, form post) is decided by ``NetworkGuard.decide``,
which fails closed: anything not explicitly allowed for the current phase is blocked.
"""

from __future__ import annotations

import ipaddress
import re
import socket
from dataclasses import dataclass, field
from typing import Callable, Literal
from urllib.parse import parse_qsl, urlsplit

_PATH = re.compile(r"^/[A-Za-z0-9/_\-.]{0,200}$")
_SELECTOR = re.compile(r"^[A-Za-z0-9#._\-\[\]=\"' >]{1,200}$")
_ID = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
_FIELD = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class PolicyError(Exception):
    pass


def _check_selector(selector: str) -> str:
    if not _SELECTOR.match(selector) or ">>" in selector or re.search("script", selector, re.I) or re.match(r"^[a-z-]+=", selector, re.I):
        raise PolicyError("INVALID_SELECTOR")
    return selector


def _check_path(path: str) -> str:
    if not _PATH.match(path) or "//" in path:
        raise PolicyError("INVALID_PATH")
    return path


@dataclass(frozen=True)
class FieldSpec:
    name: str
    label: str
    selector: str
    max_length: int
    pattern: str | None = None
    # Derived fields are read back from page state (e.g. the selected slot), never typed.
    derived: bool = False


@dataclass(frozen=True)
class ReadRule:
    """A GET request allowed while preparing: exact path and an exact set of query keys."""

    path: str
    query_keys: frozenset[str] = frozenset()


@dataclass(frozen=True)
class SubmitContract:
    method: Literal["POST", "PUT", "PATCH"]
    path: str
    content_type: Literal["application/x-www-form-urlencoded"] = "application/x-www-form-urlencoded"


@dataclass(frozen=True)
class SitePolicy:
    id: str
    label: str
    origin: str
    entry_path: str
    fields: tuple[FieldSpec, ...]
    submit_selector: str
    submit: SubmitContract
    success_path_prefix: str
    reference_selector: str
    reference_pattern: str
    # Static resources the entry page may load (no query string).
    read_paths: tuple[str, ...] = ()
    # Read-only requests the page may make while a candidate is being selected.
    preparation_reads: tuple[ReadRule, ...] = ()
    # Candidate targets: elements matching this selector, identified by ``candidate_attribute``.
    select_selector: str | None = None
    candidate_attribute: str = "data-candidate"
    material_selectors: tuple[str, ...] = ()
    value_selector: str | None = None
    currency: str | None = None
    login_selector: str | None = None
    captcha_selector: str | None = None
    # Fixture policies only: plain http to a name pinned to loopback by the test harness.
    allow_http: bool = False

    def __post_init__(self) -> None:
        if not _ID.match(self.id) or not self.label.strip():
            raise PolicyError("INVALID_POLICY")
        parts = urlsplit(self.origin)
        if parts.scheme not in (("http", "https") if self.allow_http else ("https",)) or f"{parts.scheme}://{parts.netloc}" != self.origin \
                or parts.username or parts.password or not parts.hostname or "." not in parts.hostname:
            raise PolicyError("INVALID_ORIGIN")
        for path in (self.entry_path, self.success_path_prefix, self.submit.path, *self.read_paths, *(r.path for r in self.preparation_reads)):
            _check_path(path)
        if not self.fields or len({f.name for f in self.fields}) != len(self.fields):
            raise PolicyError("INVALID_FIELDS")
        for spec in self.fields:
            if not _FIELD.match(spec.name) or not 1 <= spec.max_length <= 2000:
                raise PolicyError("INVALID_FIELDS")
            _check_selector(spec.selector)
        for selector in (self.submit_selector, self.reference_selector, *self.material_selectors,
                         *(s for s in (self.select_selector, self.value_selector, self.login_selector, self.captcha_selector) if s)):
            _check_selector(selector)
        if self.submit.method not in ("POST", "PUT", "PATCH") or self.submit.content_type != "application/x-www-form-urlencoded":
            raise PolicyError("INVALID_SUBMIT")
        if self.value_selector and not (self.currency and re.match(r"^[A-Z]{3}$", self.currency)):
            raise PolicyError("INVALID_VALUE")
        re.compile(self.reference_pattern)

    @property
    def hostname(self) -> str:
        return urlsplit(self.origin).hostname or ""

    @property
    def destination(self) -> str:
        return f"{self.origin}{self.submit.path}"


class PolicyRegistry:
    def __init__(self) -> None:
        self._policies: dict[str, SitePolicy] = {}

    def register(self, policy: SitePolicy) -> None:
        if policy.id in self._policies:
            raise PolicyError("DUPLICATE_POLICY")
        self._policies[policy.id] = policy

    def get(self, policy_id: str) -> SitePolicy | None:
        return self._policies.get(policy_id)

    def ids(self) -> list[str]:
        return sorted(self._policies)


def production_policies() -> PolicyRegistry:
    """Intentionally empty until the user selects and the team inspects a real site (plan task 6)."""
    return PolicyRegistry()


# ---------------------------------------------------------------------------
# Destination safety

def is_public_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def host_resolver_rules(policy: SitePolicy, resolve: Callable[[str], list[str]] | None = None,
                        loopback_fixture: bool = False) -> str:
    """Pin the policy host to one checked address and make every other name unresolvable.

    This defeats DNS rebinding and keeps popups/workers off unlisted hosts even before
    the request gate runs. ``loopback_fixture`` exists only for the controlled test site.
    """
    if loopback_fixture:
        if not policy.allow_http:
            raise PolicyError("FIXTURE_ONLY")
        return f"MAP {policy.hostname} 127.0.0.1,MAP * ~NOTFOUND"
    resolver = resolve or (lambda host: [info[4][0] for info in socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)])
    try:
        addresses = resolver(policy.hostname)
    except OSError as error:
        raise PolicyError("UNSAFE_DESTINATION") from error
    if not addresses or not all(is_public_address(a) for a in addresses):
        raise PolicyError("UNSAFE_DESTINATION")
    pinned = addresses[0]
    target = f"[{pinned}]" if ":" in pinned else pinned
    return f"MAP {policy.hostname} {target},MAP * ~NOTFOUND"


# ---------------------------------------------------------------------------
# The request gate

Phase = Literal["closed", "loading", "interacting", "armed", "submitted"]


@dataclass
class Decision:
    allow: bool
    reason: str


@dataclass
class _Armed:
    fields: dict[str, str]
    sent: bool = False


def exact_form_body(content_type: str | None, body: str | None, fields: dict[str, str]) -> bool:
    """True only for exactly the reviewed fields, each once, and nothing else."""
    if (content_type or "").strip().lower() != "application/x-www-form-urlencoded" or body is None:
        return False
    try:
        params = parse_qsl(body, keep_blank_values=True, strict_parsing=bool(body), max_num_fields=64)
    except ValueError:
        return False
    names = [name for name, _ in params]
    return len(params) == len(fields) and len(set(names)) == len(names) and all(fields.get(k) == v for k, v in params)


@dataclass
class NetworkGuard:
    """Phased, fail-closed request gate for one browser session.

    closed      -> nothing
    loading     -> GET/HEAD of the entry path or listed static paths, no query
    interacting -> additionally the policy's read-only preparation GETs
    armed       -> exactly one request matching the reviewed submit contract and body
    submitted   -> GET of the success path (and static paths)
    """

    policy: SitePolicy
    phase: Phase = "closed"
    blocked: list[tuple[str, str, str]] = field(default_factory=list)
    tampered: bool = False
    _armed: _Armed | None = None

    def arm(self, fields: dict[str, str]) -> None:
        self._armed = _Armed(dict(fields))
        self.phase = "armed"

    @property
    def submission_sent(self) -> bool:
        return bool(self._armed and self._armed.sent)

    def disarm(self) -> None:
        if self.phase == "armed":
            self.phase = "closed"

    def _block(self, method: str, path: str, reason: str) -> Decision:
        # Record method/path only; query strings and bodies may carry typed personal data.
        self.blocked.append((method, path, reason))
        return Decision(False, reason)

    def decide(self, method: str, url: str, content_type: str | None = None, body: str | None = None) -> Decision:
        method = method.upper()
        try:
            parts = urlsplit(url)
        except ValueError:
            return self._block(method, "?", "MALFORMED_URL")
        origin = f"{parts.scheme}://{parts.netloc}"
        path = parts.path or "/"
        if parts.username or parts.password or origin != self.policy.origin:
            return self._block(method, "(off-origin)", "ORIGIN")
        read = method in ("GET", "HEAD")
        static = read and not parts.query and (path == self.policy.entry_path or path in self.policy.read_paths)
        if self.phase in ("loading", "interacting") and static:
            return Decision(True, "STATIC")
        if self.phase == "interacting" and read and self._preparation_read(path, parts.query):
            return Decision(True, "PREPARATION_READ")
        if self.phase == "armed" and self._armed and not self._armed.sent and method == self.policy.submit.method \
                and path == self.policy.submit.path:
            if not parts.query and exact_form_body(content_type, body, self._armed.fields):
                self._armed.sent = True
                self.phase = "submitted"
                return Decision(True, "SUBMIT")
            self.tampered = True
            return self._block(method, path, "SUBMIT_MISMATCH")
        if self.phase == "submitted" and read and (path.startswith(self.policy.success_path_prefix) or static):
            return Decision(True, "RECEIPT")
        return self._block(method, path, "NOT_ALLOWED_IN_" + self.phase.upper())

    def _preparation_read(self, path: str, query: str) -> bool:
        try:
            keys = [k for k, _ in parse_qsl(query, keep_blank_values=True, strict_parsing=bool(query), max_num_fields=16)]
        except ValueError:
            return False
        return any(rule.path == path and len(set(keys)) == len(keys) and set(keys) == set(rule.query_keys)
                   for rule in self.policy.preparation_reads)
