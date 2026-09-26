import os
import stat

import pytest

from humanos_browser.session import MARKER, ProfileError, ProfileManager
from tests.conftest import ACCOUNT, WorkerProcess, needs_browser

OTHER = "11155111:0x2222222222222222222222222222222222222222"


def test_profiles_are_dedicated_private_and_per_account(tmp_path):
    manager = ProfileManager(tmp_path / "profiles")
    a, b = manager.acquire(ACCOUNT), manager.acquire(OTHER)
    try:
        assert a.path != b.path and a.path.parent == b.path.parent == manager.root
        # Server-derived: the account id never appears in the path.
        assert "0x1111" not in str(a.path) and ":" not in a.path.name
        assert (a.path / MARKER).is_file()
        assert stat.S_IMODE(os.stat(a.path).st_mode) == 0o700
    finally:
        a.release()
        b.release()


def test_one_active_run_per_account_profile(tmp_path):
    manager = ProfileManager(tmp_path / "profiles")
    lease = manager.acquire(ACCOUNT)
    with pytest.raises(ProfileError, match="PROFILE_BUSY"):
        ProfileManager(tmp_path / "profiles").acquire(ACCOUNT)
    lease.release()
    manager.acquire(ACCOUNT).release()


@pytest.mark.parametrize("root", [
    "~/Library/Application Support/Google/Chrome",
    "~/.config/google-chrome",
    "~/Library/Application Support/BraveSoftware/Brave-Browser",
    "~/.config/chromium/Default",
])
def test_everyday_browser_profiles_are_refused(root):
    with pytest.raises(ProfileError, match="EVERYDAY_PROFILE_ROOT"):
        ProfileManager(root)


def test_foreign_or_symlinked_profile_directories_are_never_adopted(tmp_path):
    manager = ProfileManager(tmp_path / "profiles")
    manager.root.mkdir(parents=True)
    manager.profile_dir(ACCOUNT).mkdir()
    with pytest.raises(ProfileError, match="FOREIGN_PROFILE"):
        manager.acquire(ACCOUNT)
    elsewhere = tmp_path / "someone-elses-profile"
    elsewhere.mkdir()
    (elsewhere / MARKER).write_text("x")
    manager.profile_dir(OTHER).symlink_to(elsewhere)
    with pytest.raises(ProfileError, match="FOREIGN_PROFILE"):
        manager.acquire(OTHER)


@needs_browser
def test_concurrent_run_for_same_account_gets_a_handoff_not_a_shared_browser(worker_env):
    first = WorkerProcess(worker_env, session="bus-a", run="run-a")
    second = WorkerProcess(worker_env, session="bus-b", run="run-b")
    try:
        assert first.send("start", {"policyId": "fixture-restaurant"})["status"] == "ready"
        busy = second.send("start", {"policyId": "fixture-restaurant"})
        assert busy["status"] == "handoff" and busy["payload"]["reason"] == "PROFILE_BUSY"
    finally:
        first.close()
        second.close()


@needs_browser
def test_worker_serves_only_the_session_it_started(worker):
    assert worker.send("start", {"policyId": "fixture-restaurant"})["status"] == "ready"
    reply = worker.send("observe", accountId=OTHER)
    assert reply == {"status": "exited", "code": 2}
