"""Checks of scripts/voice-extract/upload_language_clips.py with a stand-in Hugging Face client: batches, the pause, retries on 429 and 503, resuming, the read-back and the flags."""
import hashlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent / "voice-extract"))
import upload_language_clips as U  # noqa: E402


class HttpError(Exception):
    def __init__(self, status, retry_after=None):
        super().__init__(f"HTTP {status}")
        self.response = types.SimpleNamespace(status_code=status, headers={"Retry-After": str(retry_after)} if retry_after else {})


class FakeApi:
    """A repository in a dict: path -> (size, sha256). `failures` is a list of statuses to answer before a commit goes through."""
    repo: dict = {}
    failures: list = []
    commits: list = []
    corrupt: set = set()
    token = None

    def __init__(self, token=None):
        FakeApi.token = token

    def get_paths_info(self, repository, paths, expand=True):
        return [types.SimpleNamespace(path=p, size=FakeApi.repo[p][0], lfs={"sha256": FakeApi.repo[p][1]}) for p in paths if p in FakeApi.repo]

    def create_commit(self, repo_id, operations, commit_message):
        if FakeApi.failures:
            raise HttpError(FakeApi.failures.pop(0), 3)
        FakeApi.commits.append([op.path_in_repo for op in operations])
        for op in operations:
            data = Path(op.path_or_fileobj).read_bytes()
            sha = hashlib.sha256(data).hexdigest()
            FakeApi.repo[op.path_in_repo] = (len(data), "0" * 64 if op.path_in_repo in FakeApi.corrupt else sha)


class FakeAdd:
    def __init__(self, path_in_repo, path_or_fileobj):
        self.path_in_repo, self.path_or_fileobj = path_in_repo, path_or_fileobj


def install_fakes():
    hub = types.ModuleType("huggingface_hub")
    hub.HfApi, hub.CommitOperationAdd = FakeApi, FakeAdd
    errors = types.ModuleType("huggingface_hub.errors")
    errors.HfHubHTTPError = HttpError
    return mock.patch.dict(sys.modules, {"huggingface_hub": hub, "huggingface_hub.errors": errors})


class Upload(unittest.TestCase):
    def setUp(self):
        FakeApi.repo, FakeApi.failures, FakeApi.commits, FakeApi.corrupt = {}, [], [], set()
        self.folder = tempfile.TemporaryDirectory()
        root = Path(self.folder.name)
        self.rows = []
        for n in range(7):
            data = bytes([n]) * (100 + n)
            source = root / f"clip{n}.wav"
            source.write_bytes(data)
            self.rows.append({"path": f"voice-clips/de/picked/clip{n}.wav", "source": str(source), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "toUpload": n != 0})
        self.list = root / "list.json"
        self.list.write_text(json.dumps({"repository": "owner/repo", "newFilesToUpload": 6, "rows": self.rows}), encoding="utf-8")
        self.token = root / "token.txt"
        self.token.write_text("hf_not_a_real_token\n", encoding="utf-8")

    def tearDown(self):
        self.folder.cleanup()

    def run_tool(self, *extra):
        argv = ["upload_language_clips.py", "--token-file", str(self.token), "--list", str(self.list), "--pause", "7", *extra]
        sleeps = []
        with install_fakes(), mock.patch.object(sys, "argv", argv), mock.patch.object(U.time, "sleep", side_effect=sleeps.append), mock.patch("builtins.print"):
            try:
                code = U.main()
            except SystemExit as stop:
                code = stop.code
        return code, sleeps

    def test_only_flagged_rows_go_in_batches_with_a_pause_and_the_flags_are_removed_after_a_clean_read_back(self):
        code, sleeps = self.run_tool("--batch", "4", "--clear-flags")
        self.assertEqual(code, 0)
        self.assertEqual([len(c) for c in FakeApi.commits], [4, 2])
        self.assertNotIn("voice-clips/de/picked/clip0.wav", FakeApi.repo, "an unflagged row is not sent")
        self.assertEqual(sleeps, [7], "one pause between two commits, none after the last")
        self.assertEqual(FakeApi.token, "hf_not_a_real_token")
        saved = json.loads(self.list.read_text(encoding="utf-8"))
        self.assertFalse(any("toUpload" in row for row in saved["rows"]))
        self.assertNotIn("newFilesToUpload", saved)

    def test_a_rate_limited_commit_is_retried_after_the_servers_wait(self):
        FakeApi.failures = [429, 503]
        code, sleeps = self.run_tool("--batch", "10")
        self.assertEqual(code, 0)
        self.assertEqual(sleeps, [3.0, 3.0])
        self.assertEqual(len(FakeApi.commits), 1)

    def test_another_error_or_too_many_retries_stops(self):
        FakeApi.failures = [500]
        code, _ = self.run_tool("--batch", "10")
        self.assertIn("HTTP 500", str(code))
        FakeApi.failures = [429, 429, 429]
        code, _ = self.run_tool("--batch", "10", "--retries", "3")
        self.assertIn("HTTP 429", str(code))

    def test_a_started_again_run_skips_what_is_there_and_a_wrong_hash_on_the_server_keeps_the_flags(self):
        self.run_tool("--batch", "3")
        FakeApi.commits.clear()
        code, _ = self.run_tool("--batch", "3")
        self.assertEqual(code, 0)
        self.assertEqual(FakeApi.commits, [], "everything is already there with the right size and hash")
        FakeApi.repo.clear()
        FakeApi.corrupt = {"voice-clips/de/picked/clip3.wav"}
        code, _ = self.run_tool("--batch", "10", "--clear-flags")
        self.assertEqual(code, 1)
        self.assertTrue(any(row.get("toUpload") for row in json.loads(self.list.read_text(encoding="utf-8"))["rows"]), "a mismatch leaves the flags")

    def test_a_missing_or_resized_source_stops_before_anything_is_sent_and_a_dry_run_sends_nothing(self):
        Path(self.rows[2]["source"]).write_bytes(b"x")
        code, _ = self.run_tool()
        self.assertIn("source file is missing or its size differs", str(code))
        self.assertEqual(FakeApi.commits, [])
        Path(self.rows[2]["source"]).write_bytes(bytes([2]) * 102)
        code, _ = self.run_tool("--dry-run")
        self.assertEqual(code, 0)
        self.assertEqual(FakeApi.commits, [])


if __name__ == "__main__":
    unittest.main()
