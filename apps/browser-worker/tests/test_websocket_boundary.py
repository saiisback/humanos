"""WebSocket upgrades must never escape, including to otherwise permitted HTTP URLs."""

import subprocess
import time

import pytest

from tests.conftest import WorkerProcess, needs_browser
from tests.fixture_site import FixtureSite, make_handler


PROBES = """<script>
const frame = document.createElement('iframe');
document.body.appendChild(frame);
const blocked = [];
for (const doc of [document, frame.contentDocument]) {
  doc.addEventListener('securitypolicyviolation', e => {
    if (e.effectiveDirective === 'connect-src') blocked.push(e.blockedURI);
  });
}
const attempts = [WebSocket, frame.contentWindow.WebSocket].flatMap(Socket =>
  ['/api/slot?time=1900', '/reserve'].map(path => new Promise(resolve => {
    const socket = new Socket('ws://' + location.host + path);
    socket.onopen = () => { socket.send('unapproved booking'); socket.close(); resolve(); };
    socket.onerror = () => resolve();
  })));
Promise.all(attempts).then(() => setTimeout(() => {
  document.title = '4 WebSocket probes finished; CSP blocks: ' + blocked.length;
}, 0));
</script>"""


@pytest.fixture
def site():
    # Extend the controlled server only in this test. Count upgrade handshakes even
    # at /api/slot, which the shared fixture's write ledger classifies as a read.
    fixture = FixtureSite()
    fixture.upgrades = []
    base = make_handler(fixture.state)

    class Handler(base):
        def _send(self, code, body, ctype="text/html; charset=utf-8", headers=None):
            if '<form id="reserve-form"' in body:
                body = body.replace("</body>", PROBES + "</body>")
            return super()._send(code, body, ctype, headers)

        def do_GET(self):
            if self.headers.get("upgrade", "").lower() == "websocket":
                fixture.upgrades.append(self.path)
            return super().do_GET()

    fixture.server.RequestHandlerClass = Handler
    with fixture:
        yield fixture


def finish_probes(worker):
    assert worker.send("start", {"policyId": "fixture-restaurant"})["status"] == "ready"
    deadline = time.monotonic() + 5
    while True:
        observed = worker.send("observe")
        assert observed["status"] == "observed", observed
        if observed["payload"]["title"].startswith("4 WebSocket probes finished;"):
            return observed["payload"]["title"]
        assert time.monotonic() < deadline, "The page did not finish all four real WebSocket attempts"
        time.sleep(0.1)


@needs_browser
def test_allowed_http_paths_reject_websocket_upgrades_before_preparation(worker, site):
    assert finish_probes(worker) == "4 WebSocket probes finished; CSP blocks: 4"
    assert site.upgrades == [], "WebSocket handshakes bypassed the browser request boundary"

    # Blocking sockets must preserve the inspected HTTP preparation fetch and form.
    assert worker.send("act", {"candidateId": "select:slot-1900"})["status"] == "acted"
    prepared = worker.send("prepare", {"fields": {"name": "Ada", "party_size": "2", "email": "ada@example.com"}})
    assert prepared["status"] == "prepared", prepared
    assert prepared["payload"]["value"] == {"amount": "1000", "currency": "JPY"}
    assert prepared["payload"]["fields"]["slot"] == "1900"
    assert site.state.writes() == []
    assert site.upgrades == []


@needs_browser
def test_positive_control_receives_upgrades_when_document_csp_is_relaxed(worker_env, site, monkeypatch):
    # A real-browser mutation control: weakening only the injected CSP must let
    # actual handshakes reach this same server. Otherwise a zero ledger could be
    # explained by a broken probe, networking, or the fixture itself.
    popen = subprocess.Popen
    startup = (
        "from humanos_browser.session import GuardedSession; "
        "GuardedSession.content_security_policy = property(lambda self: "
        "\"connect-src *; worker-src 'none'; object-src 'none'; base-uri 'none'\"); "
        "from humanos_browser.worker import main; raise SystemExit(main())"
    )

    def start_control(args, **kwargs):
        return popen([args[0], "-c", startup], **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(subprocess, "Popen", start_control)
        worker = WorkerProcess(worker_env)
    try:
        assert finish_probes(worker) == "4 WebSocket probes finished; CSP blocks: 0"
        assert sorted(site.upgrades) == ["/api/slot?time=1900", "/api/slot?time=1900", "/reserve", "/reserve"]
    finally:
        worker.close()
