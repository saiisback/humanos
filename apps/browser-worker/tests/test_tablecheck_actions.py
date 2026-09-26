"""Real Chromium/Browser Use, a local provider-shaped fixture, and a server write ledger."""
import asyncio
import io
import json
import threading
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from humanos_browser.policy import PolicyRegistry
from humanos_browser.worker import Config, Worker
from humanos_browser.sites.tablecheck import tablecheck_policy, AVAILABILITY_PATH
from tests.conftest import CHROMIUM, needs_browser


@needs_browser
def test_worker_checks_exact_availability_but_never_exposes_a_dispatchable_preview(tmp_path, monkeypatch):
    reads, writes = [], []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_GET(self):
            reads.append(self.path)
            self.send_response(200)
            is_availability = self.path.startswith(AVAILABILITY_PATH + "?")
            self.send_header("Content-Type", "application/json" if is_availability else "text/html")
            self.end_headers()
            self.wfile.write(b'{"status":"success","data":["6698d2b70ec52f99baad3ac0"]}' if is_availability else
                             b'<html><body>Controlled restaurant fixture<script>fetch("/unapproved",{method:"POST",body:"x=1"})</script></body></html>')
        def do_POST(self):
            writes.append(self.path)
            self.send_response(200)
            self.end_headers()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f"http://fixture.humanos.test:{server.server_port}"
    policy = replace(tablecheck_policy(), origin=origin, allow_http=True)
    registry = PolicyRegistry()
    registry.register(policy)
    monkeypatch.setattr("humanos_browser.worker._registry", lambda _: registry)
    async def scenario():
        worker = Worker(Config({"HUMANOS_BROWSER_PROFILE_ROOT": str(tmp_path / "profiles"), "HUMANOS_BROWSER_CHROMIUM": CHROMIUM,
                                "HUMANOS_BROWSER_FIXTURE_ORIGIN": origin}), io.BytesIO())
        envelope = {"protocolVersion": 1, "accountId": "tablecheck-test", "runId": "run-tablecheck", "sessionId": "session-tablecheck"}
        async def command(action, name, payload, revision=0):
            return await worker.handle({**envelope, "actionId": action, "observationRevision": revision, "command": name, "payload": payload})
        try:
            started = await command(1, "start", {"policyId": policy.id})
            assert started["status"] == "ready", started
            prepared = await command(2, "prepare", {"fields": {"date": "2099-09-28", "time": "19:00", "timezone": "Asia/Tokyo",
                "adults": "2", "children": "0", "offer_id": "66c4d4411c588898fe3bb84b"}})
            assert prepared["status"] == "handoff", prepared
            assert "available when checked" in prepared["payload"]["message"]
            assert "Not booked" in prepared["payload"]["message"]
            assert "materialHash" not in json.dumps(prepared)
            submitted = await command(3, "submit", {"permit": {"runId": "run-tablecheck", "sessionId": "session-tablecheck",
                "actionId": 3, "observationRevision": 1, "payloadHash": "0x" + "1" * 64, "expiresAt": "2099-01-01T00:00:00Z"}}, revision=1)
            assert submitted["status"] == "failed"
            assert writes == []
            assert sum(path.startswith(AVAILABILITY_PATH + "?") for path in reads) == 1
            assert all("email" not in path and "phone" not in path for path in reads)
        finally:
            await worker.shutdown()
    try:
        asyncio.run(scenario())
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
