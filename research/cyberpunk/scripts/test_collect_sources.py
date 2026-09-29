import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from urllib import error, request

SPEC = importlib.util.spec_from_file_location("collect_sources", Path(__file__).with_name("collect_sources.py"))
sources = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sources)


class PublicCollectorTests(unittest.TestCase):
    def test_html_is_inert_and_article_scope_excludes_navigation_and_comments(self):
        page = sources.PageParser("https://www.powerpyx.com/index/")
        page.feed('''<title>Reference &amp; guide</title><nav>Ignore menu</nav>
          <article><h1>Title</h1><div class="entry-content"><h2>Main Missions</h2>
          <p>Useful <b>reference</b> text.</p><script>fetch('bad')</script>
          <a href="/cyberpunk-2077-the-heist-walkthrough/">The Heist</a>
          </div><div>Reader comment</div></article>''')
        parsed = page.finish()
        self.assertEqual(parsed["title"], "Reference & guide")
        self.assertIn("Useful reference text.", parsed["text"])
        self.assertNotIn("fetch", parsed["text"])
        self.assertNotIn("Reader comment", parsed["text"])
        self.assertNotIn("Ignore menu", parsed["text"])
        self.assertEqual(parsed["links"][0]["headings"][-1]["text"], "Main Missions")

    def test_index_categories_follow_observed_heading_not_url_guess(self):
        page = sources.PageParser("https://www.powerpyx.com/index/")
        page.feed('''<article><h2>Gigs</h2><h3>Dogtown (Phantom Liberty DLC)</h3>
          <ul><li><a href="/cyberpunk-2077-spy-in-the-jungle-walkthrough/">Spy in the Jungle</a></li></ul>
          <h2>Phantom Liberty DLC</h2><h3>Phantom Liberty DLC – Main Quests:</h3>
          <ul><li><a href="/cyberpunk-2077-firestarter-walkthrough/">Firestarter</a></li></ul></article>''')
        entry = {"status": "ok", "url": page.url, "sha256": "fixture", **page.finish()}
        rows = sources.inventory_from_page({"kind": "index", "category": "mixed"}, entry)
        self.assertEqual([(r["category"], r["game"]) for r in rows],
                         [("gig", "phantom-liberty"), ("main", "phantom-liberty")])
        self.assertTrue(all(r["nativeMappingStatus"] == "unmapped" for r in rows))

    def test_transcript_headings_are_not_asserted_to_be_jobs(self):
        entry = {"status": "ok", "url": "https://arasakas-ronin.netlify.app/", "sha256": "fixture",
                 "headings": [{"level": 2, "text": "Prologue", "id": "Prologue"},
                              {"level": 3, "text": "The Rescue", "id": "The_Rescue"}]}
        rows = sources.inventory_from_page({"kind": "transcript"}, entry)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(r["category"] == "unclassified" and r["game"] == "unknown" for r in rows))

    def test_unlinked_job_titles_survive_without_invented_walkthrough_url(self):
        page = sources.PageParser("https://www.powerpyx.com/index/")
        page.feed('''<article><h2>Phantom Liberty DLC – Main Jobs</h2><ol>
          <li>Firestarter</li><li>The Killing Moon → Ending path, if chosen</li></ol></article>''')
        entry = {"status": "ok", "url": page.url, "sha256": "fixture", **page.finish()}
        rows = sources.inventory_from_page({"kind": "index", "category": "mixed"}, entry)
        self.assertEqual([r["title"] for r in rows], ["Firestarter", "The Killing Moon"])
        self.assertTrue(all(r["url"] == page.url and r["evidenceKind"] == "unlinked-index-label" for r in rows))
        self.assertEqual(len(sources.make_inventory(rows, {})["rows"]), 2)

    def test_mediawiki_inner_heading_anchor_preserved(self):
        page = sources.PageParser("https://arasakas-ronin.netlify.app/")
        page.feed('<main><h3><span id="The_Heist">The Heist</span></h3></main>')
        self.assertEqual(page.finish()["headings"][0]["id"], "The_Heist")

    def test_game8_guide_wins_over_membership_modal_and_related_links(self):
        page = sources.PageParser("https://game8.co/games/Cyberpunk-2077/archives/Quests-Main-Jobs")
        page.feed('''<dialog><main><h2>Membership tools</h2>Sign in!</main></dialog>
          <div class="archive-style-wrapper"><h2>Main Quests</h2><table><tr><td>
          <a href="/games/Cyberpunk-2077/archives/312450">The Rescue</a></td></tr></table>
          <h2>Cyberpunk Related Links</h2><table><tr><td><a href="/games/Cyberpunk-2077/archives/99999">Weapons</a>
          </td></tr></table></div>''')
        parsed = page.finish()
        self.assertNotIn("Sign in!", parsed["text"])
        self.assertIn("The Rescue", parsed["text"])
        rows = sources.inventory_from_page({"kind": "index", "category": "main"},
            {"status": "ok", "url": page.url, "sha256": "fixture", **parsed})
        self.assertEqual([r["title"] for r in rows], ["The Rescue"])

    def test_robots_access_denial_blocks_page_without_requesting_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            collector = sources.Collector(tmp, ["cyberpunk.fandom.com"], delay=1)
            fake = mock.Mock()
            fake.open.side_effect = error.HTTPError("https://cyberpunk.fandom.com/robots.txt", 403, "Forbidden", {}, None)
            with mock.patch.object(sources.request, "build_opener", return_value=fake):
                entry, cached = collector.fetch({"url": "https://cyberpunk.fandom.com/wiki/Judy"})
            self.assertFalse(cached)
            self.assertEqual(entry["status"], "blocked")
            self.assertEqual(entry["reason"], "robots-access-denied")
            self.assertEqual(fake.open.call_count, 1)
            self.assertTrue(fake.open.call_args.args[0].full_url.endswith("/robots.txt"))

    def test_no_robots_published_is_distinct_from_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            collector = sources.Collector(tmp, ["example.com"], delay=1)
            fake = mock.Mock()
            fake.open.side_effect = error.HTTPError("https://example.com/robots.txt", 404, "Not Found", {}, None)
            with mock.patch.object(sources.request, "build_opener", return_value=fake):
                permitted, reason = collector.allowed("https://example.com/page")
            self.assertTrue(permitted)
            self.assertEqual(reason, "allowed")

    def test_wildcard_robots_disallow_is_not_ignored_by_stdlib_prefix_rules(self):
        parser = sources.robotparser.RobotFileParser()
        parser.parse(["User-agent: *", "Disallow: /*?private=", "Disallow: /internal/*$"])
        self.assertFalse(sources.robots_path_allowed(parser, sources.ROBOT_AGENT, "https://example.com/a?private=1"))
        self.assertFalse(sources.robots_path_allowed(parser, sources.ROBOT_AGENT, "https://example.com/internal/path"))
        self.assertTrue(sources.robots_path_allowed(parser, sources.ROBOT_AGENT, "https://example.com/guide"))

    def test_redirects_must_remain_in_reviewed_host_scope(self):
        with tempfile.TemporaryDirectory() as tmp:
            collector = sources.Collector(tmp, ["example.com"])
            redirect = sources.RestrictedRedirect(collector)
            with self.assertRaisesRegex(ValueError, "allowedHosts"):
                redirect.redirect_request(request.Request("https://example.com/page"), None, 302, "Found", {}, "http://127.0.0.1/private")

    def test_byte_limit_checks_actual_body_and_header(self):
        with tempfile.TemporaryDirectory() as tmp:
            collector = sources.Collector(tmp, ["example.com"])
            fake = mock.Mock(headers={})
            fake.read.return_value = b"123456"
            with self.assertRaisesRegex(ValueError, "byte bound"):
                collector._read(fake, 5)
            fake.headers = {"Content-Length": "100"}
            with self.assertRaisesRegex(ValueError, "Content-Length"):
                collector._read(fake, 5)

    def test_failed_entries_are_resumed_without_hammering(self):
        with tempfile.TemporaryDirectory() as tmp:
            collector = sources.Collector(tmp, ["example.com"])
            collector.manifest["entries"]["https://example.com/page"] = {"url": "https://example.com/page", "status": "blocked"}
            with mock.patch.object(collector, "allowed", side_effect=AssertionError("must reuse cache")):
                entry, cached = collector.fetch({"url": "https://example.com/page"})
            self.assertTrue(cached)
            self.assertEqual(entry["status"], "blocked")

    def test_missing_successful_cache_is_not_reported_as_reused_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            collector = sources.Collector(tmp, ["example.com"])
            collector.manifest["entries"]["https://example.com/page"] = {
                "url": "https://example.com/page", "status": "binary-only",
                "cacheFiles": {"raw": "pages/missing.pdf", "parsed": "pages/missing.json"}}
            with mock.patch.object(collector, "allowed", return_value=(False, "robots-disallow")) as checked:
                entry, cached = collector.fetch({"url": "https://example.com/page"})
            self.assertFalse(cached)
            self.assertEqual(checked.call_count, 1)
            self.assertEqual(entry["status"], "blocked")

    def test_inventory_retains_each_source_without_duplicate_quest(self):
        first = {"title": "The Heist", "url": "https://example.com/heist", "category": "main", "game": "base",
                 "sourceUrl": "https://example.com/a", "sourceSha256": "one", "sourceLocator": "Main",
                 "evidenceKind": "index-link", "nativeMappingStatus": "unmapped"}
        second = {**first, "sourceUrl": "https://example.com/b", "sourceSha256": "two"}
        result = sources.make_inventory([first, first, second], {})
        self.assertEqual(len(result["rows"]), 1)
        self.assertEqual(len(result["rows"][0]["observations"]), 2)
        self.assertEqual(result["rows"][0]["linkedPageStatus"], "not-fetched")

    def test_credentials_and_nonstandard_ports_rejected(self):
        for url in ("https://user:secret@example.com/a", "file:///secret", "https://example.com:8000/a"):
            with self.assertRaises(ValueError):
                sources.canonical_url(url)

    def test_atomic_manifest_replace_retries_transient_windows_reader_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "manifest.json"
            original = Path.replace
            calls = []
            def briefly_locked(source, target):
                calls.append(target)
                if len(calls) < 3:
                    raise PermissionError("reader still holds file")
                return original(source, target)
            with mock.patch.object(Path, "replace", briefly_locked), mock.patch.object(sources.time, "sleep"):
                sources.atomic_json(path, {"receipt": "complete"})
            self.assertEqual(len(calls), 3)
            self.assertEqual(json.loads(path.read_text()), {"receipt": "complete"})

    def test_opaque_queries_survive_and_unicode_path_is_request_safe(self):
        url = "https://forums.cdprojektred.com/index.php?threads/humans.123/"
        self.assertEqual(sources.canonical_url(url), url)
        self.assertEqual(sources.canonical_url("https://example.com/Judy_Álvarez?utm_source=x"),
                         "https://example.com/Judy_%C3%81lvarez")


if __name__ == "__main__":
    unittest.main()
