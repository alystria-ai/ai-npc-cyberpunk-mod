#!/usr/bin/env python3
"""Bounded, resumable public reference collection; never game-state authority.

Python 3.10+, standard library only. No cookies, remote script execution, proxies,
browser impersonation, captcha handling, or access-control workarounds. Raw text
and response bytes stay in the ignored cache/public directory. robots failures
fail closed except an explicit 404/410 (no robots policy published).
"""
from __future__ import annotations

import argparse
from collections import Counter, deque
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import time
from urllib import error, parse, request, robotparser

ROOT = Path(__file__).resolve().parents[3]
RESEARCH = ROOT / "research" / "cyberpunk"
USER_AGENT = "CyberpunkConvaiResearch/1.0 (bounded local reference collector)"
ROBOT_AGENT = "CyberpunkConvaiResearch"
VERSION = 4


def utcnow():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def clean(value):
    return re.sub(r"\s+", " ", value).strip()


def canonical_url(url):
    parts = parse.urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
        raise ValueError("Only public HTTP(S) URLs without credentials are accepted")
    if parts.port not in {None, 80, 443}:
        raise ValueError("Nonstandard ports are outside the source scope")
    # Preserve opaque server routing queries such as XenForo's ?threads/foo.123/.
    # Re-encoding these as ordinary key=value pairs changes the resource.
    query = "&".join(piece for piece in parts.query.split("&")
                     if not parse.unquote(piece.split("=", 1)[0]).lower().startswith("utm_"))
    path = parse.quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
    query = parse.quote(query, safe="/%?:@!$&'()*+,;=-._~")
    return parse.urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, query, ""))


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # Windows readers/indexers can briefly deny replace while holding the target.
    # Retain the complete temporary file and retry, rather than losing a receipt.
    for attempt in range(7):
        try:
            tmp.replace(path)
            break
        except PermissionError:
            if attempt == 6:
                raise
            time.sleep(0.05 * (2 ** attempt))


def robots_path_allowed(parser, agent, url):
    """Conservative stdlib policy plus wildcard/$ deny support (RFC 9309)."""
    if not parser.can_fetch(agent, url):
        return False
    groups = list(parser.entries) + ([parser.default_entry] if parser.default_entry else [])
    agent = agent.lower().split("/")[0]
    selected, best = [], -1
    for group in groups:
        score = max((0 if token == "*" else len(token)
                     for token in group.useragents if token == "*" or token.lower() in agent), default=-1)
        if score > best:
            selected, best = [group], score
        elif score == best and score >= 0:
            selected.append(group)
    target = parse.urlsplit(url)
    path = parse.unquote(target.path + (("?" + target.query) if target.query else ""))
    matched = []
    for group in selected:
        for rule in group.rulelines:
            pattern = parse.unquote(rule.path)
            if not pattern:
                continue
            end = pattern.endswith("$")
            pattern = pattern[:-1] if end else pattern
            expression = "^" + re.escape(pattern).replace(r"\*", ".*") + ("$" if end else "")
            if re.match(expression, path):
                matched.append((len(pattern.replace("*", "")), rule.allowance))
    return not matched or max(matched)[1]  # Allow wins an equal-length tie.


class PageParser(HTMLParser):
    """Extract inert article content, preserving heading and link provenance."""
    SKIP = {"script", "style", "noscript", "template", "svg", "nav", "footer", "form", "dialog"}
    BLOCK = {"p", "div", "section", "article", "li", "tr", "br", "h1", "h2", "h3", "h4", "h5", "h6"}
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self, url):
        super().__init__(convert_charrefs=True)
        self.url, self.stack = url, []
        self.all_text, self.article_text, self.title_parts = [], [], []
        self.headings, self.links, self.outline = [], [], []
        self.list_items, self.item_stack = [], []
        self.heading, self.link = None, None
        self.has_article = False

    def _skip(self):
        return any(frame[1] for frame in self.stack)

    def _article(self):
        return any(frame[2] for frame in self.stack)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = set(attrs.get("class", "").split())
        article = bool(classes & {"entry-content", "mw-parser-output", "archive-style-wrapper"}) or tag in {"article", "main"}
        # WordPress <article> includes comments on some themes. Prefer its inner
        # entry-content whenever available; finish() filters extracted records.
        specific = bool(classes & {"entry-content", "mw-parser-output", "archive-style-wrapper"})
        skip = tag in self.SKIP or attrs.get("aria-hidden") == "true" or "hidden" in attrs
        if tag not in self.VOID:
            self.stack.append((tag, skip, article, specific))
        if self._skip() or skip:
            return
        if article:
            self.has_article = True
        in_article = self._article()
        in_specific = any(frame[3] for frame in self.stack)
        if tag in self.BLOCK:
            self.all_text.append("\n")
            if in_article:
                self.article_text.append(("\n", in_specific))
        if tag == "li":
            self.item_stack.append({"parts": [], "links": [], "headings": [dict(item) for item in self.outline],
                                    "article": in_article, "specific": in_specific})
        if re.fullmatch(r"h[1-6]", tag):
            self.heading = {"level": int(tag[1]), "id": attrs.get("id", ""), "parts": [],
                            "article": in_article, "specific": in_specific}
        elif self.heading is not None and attrs.get("id") and not self.heading["id"]:
            # MediaWiki puts anchor IDs on an inner span rather than the h tag.
            self.heading["id"] = attrs["id"]
        if tag == "a" and attrs.get("href"):
            self.link = {"url": parse.urljoin(self.url, attrs["href"]), "parts": [],
                         "headings": [dict(item) for item in self.outline],
                         "inList": any(frame[0] in {"li", "tr"} for frame in self.stack),
                         "article": in_article, "specific": in_specific}
            for item in self.item_stack:
                item["links"].append(self.link["url"])

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if not self._skip():
            if tag == "li" and self.item_stack:
                item = self.item_stack.pop()
                item["text"] = clean(" ".join(item.pop("parts")))
                if item["text"]:
                    self.list_items.append(item)
            if self.heading and tag == "h" + str(self.heading["level"]):
                item = self.heading
                item["text"] = clean(" ".join(item.pop("parts")))
                if item["text"]:
                    self.headings.append(item)
                    self.outline = [h for h in self.outline if h["level"] < item["level"]]
                    self.outline.append({"level": item["level"], "text": item["text"], "id": item["id"]})
                self.heading = None
            if self.link and tag == "a":
                item = self.link
                item["text"] = clean(" ".join(item.pop("parts")))
                if item["text"] and parse.urlsplit(item["url"]).scheme in {"http", "https"}:
                    self.links.append(item)
                self.link = None
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        if self._skip():
            return
        if any(frame[0] == "title" for frame in self.stack):
            self.title_parts.append(data)
        if self.heading is not None:
            self.heading["parts"].append(data)
        if self.link is not None:
            self.link["parts"].append(data)
        for item in self.item_stack:
            item["parts"].append(data)
        self.all_text.append(data)
        if self._article():
            self.article_text.append((data, any(frame[3] for frame in self.stack)))

    def finish(self):
        specific = any(flag for _, flag in self.article_text)
        selected = [text for text, flag in self.article_text if flag or not specific] if self.has_article else self.all_text
        text = "\n".join(filter(None, (clean(line) for line in "".join(selected).splitlines())))
        def relevant(item):
            return item.get("specific") if specific else item.get("article") if self.has_article else True
        headings = [{k: v for k, v in item.items() if k not in {"article", "specific"}}
                    for item in self.headings if relevant(item)]
        links = [{k: v for k, v in item.items() if k not in {"article", "specific"}}
                 for item in self.links if relevant(item)]
        items = [{k: v for k, v in item.items() if k not in {"article", "specific"}}
                 for item in self.list_items if relevant(item)]
        return {"title": clean(" ".join(self.title_parts)), "text": text, "headings": headings,
                "links": links, "listItems": items, "extraction": "article" if self.has_article else "visible-document"}


class RestrictedRedirect(request.HTTPRedirectHandler):
    def __init__(self, collector, robots_request=False):
        self.collector, self.robots_request = collector, robots_request

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        newurl = canonical_url(parse.urljoin(req.full_url, newurl))
        self.collector.check_host(newurl)
        if self.robots_request:
            if parse.urlsplit(req.full_url).netloc != parse.urlsplit(newurl).netloc:
                raise ValueError("Cross-host robots redirect is outside policy")
        else:
            permitted, reason = self.collector.allowed(newurl)
            if not permitted:
                raise ValueError("Redirect blocked: " + reason)
        self.collector.pace(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Collector:
    def __init__(self, cache, hosts, delay=2.0, timeout=25, max_bytes=12_000_000,
                 max_total_bytes=160_000_000, refresh=False):
        self.cache = Path(cache).resolve()
        self.cache.mkdir(parents=True, exist_ok=True)
        self.manifest_path = self.cache / "manifest.json"
        self.manifest = json.loads(self.manifest_path.read_text(encoding="utf-8")) if self.manifest_path.exists() else {
            "version": VERSION, "createdAt": utcnow(), "entries": {}, "robots": {}, "runs": []}
        self.hosts, self.delay, self.timeout = set(hosts), max(1.0, delay), timeout
        self.max_bytes, self.max_total_bytes, self.refresh = max_bytes, max_total_bytes, refresh
        self.bytes_received, self.last_request, self.robot_parsers = 0, {}, {}
        self.host_blocked = {}

    def save(self):
        self.manifest["updatedAt"] = utcnow()
        atomic_json(self.manifest_path, self.manifest)

    def check_host(self, url):
        normalized = canonical_url(url)
        if parse.urlsplit(normalized).hostname not in self.hosts:
            raise ValueError("Host is not in reviewed allowedHosts")
        return normalized

    def pace(self, url, extra=0):
        host = parse.urlsplit(url).netloc
        pause = max(self.delay, extra) - (time.monotonic() - self.last_request.get(host, 0))
        if pause > 0:
            time.sleep(pause)
        self.last_request[host] = time.monotonic()

    def _read(self, response, limit):
        # Bound both headers-declared and actual bytes. Never execute downloaded content.
        declared = response.headers.get("Content-Length")
        if declared and int(declared) > limit:
            raise ValueError("Response exceeds byte bound (Content-Length)")
        body = response.read(limit + 1)
        self.bytes_received += len(body)
        if len(body) > limit:
            raise ValueError("Response exceeds byte bound")
        return body

    def _robots(self, url):
        origin = parse.urlunsplit((*parse.urlsplit(url)[:2], "", "", ""))
        if origin in self.robot_parsers:
            return self.robot_parsers[origin]
        saved = self.manifest["robots"].get(origin)
        fresh = saved and (datetime.now(timezone.utc) - datetime.fromisoformat(saved["fetchedAt"])).total_seconds() < 86400
        if not fresh or self.refresh:
            robots_url = origin + "/robots.txt"
            self.pace(robots_url)
            saved = {"url": robots_url, "fetchedAt": utcnow(), "status": "unavailable", "httpStatus": None}
            try:
                opener = request.build_opener(RestrictedRedirect(self, robots_request=True))
                with opener.open(request.Request(robots_url, headers={"User-Agent": USER_AGENT}), timeout=self.timeout) as response:
                    body = self._read(response, min(512_000, self.max_total_bytes - self.bytes_received))
                    robots_text = body.decode("utf-8", "replace")
                    status = "unexpected-content" if re.search(r"<(?:!doctype|html|script)\b", robots_text[:1000], re.I) else "ok"
                    saved.update(status=status, httpStatus=response.status, finalUrl=response.url,
                                 sha256=hashlib.sha256(body).hexdigest(), text=body.decode("utf-8", "replace"))
            except error.HTTPError as exc:
                saved.update(httpStatus=exc.code, error=str(exc.reason))
                if exc.code in {404, 410}:
                    saved["status"] = "not-published"
                elif exc.code in {401, 403}:
                    saved["status"] = "access-denied"
            except (error.URLError, OSError, ValueError) as exc:
                saved["error"] = str(exc)
            self.manifest["robots"][origin] = saved
            self.save()
        parser = robotparser.RobotFileParser()
        if saved["status"] == "ok":
            parser.parse(saved.get("text", "").splitlines())
        elif saved["status"] == "not-published":
            parser.parse(["User-agent: *", "Allow: /"])
        else:
            parser.parse(["User-agent: *", "Disallow: /"])
        self.robot_parsers[origin] = (parser, saved)
        return parser, saved

    def allowed(self, url):
        self.check_host(url)
        host = parse.urlsplit(url).netloc
        if host in self.host_blocked:
            return False, self.host_blocked[host]
        parser, receipt = self._robots(url)
        if not robots_path_allowed(parser, ROBOT_AGENT, url):
            return False, "robots-" + receipt["status"] if receipt["status"] != "ok" else "robots-disallow"
        return True, "allowed"

    def fetch(self, seed):
        url = canonical_url(seed["url"])
        prior = self.manifest["entries"].get(url)
        if prior and (prior["status"] == "cache-error" or
                      ("[WinError 5]" in prior.get("reason", "") and "manifest.json" in prior.get("reason", ""))):
            prior = None  # A local file-lock failure is not a remote access denial.
        if prior and prior.get("reason") == "Host is not in reviewed allowedHosts" and parse.urlsplit(url).hostname in self.hosts:
            prior = None  # A reviewed scope expansion is not an access-control retry.
        if prior and prior.get("reason", "").startswith("Response exceeds byte bound") and self.max_bytes > prior.get("byteLimit", 12_000_000):
            prior = None  # Explicitly increasing a byte budget permits this retry.
        cache_valid = bool(prior and prior.get("cacheFiles")) and all(
            (self.cache / name).is_file() for name in (prior or {}).get("cacheFiles", {}).values())
        if prior and not self.refresh:
            if prior["status"] not in {"ok", "binary-only"} or cache_valid:
                # Persistent failures are deliberately not retried without --refresh.
                associations_changed = False
                for field in ("characters", "lanes"):
                    combined = sorted(set(prior.get(field, [])) | set(seed.get(field, [])))
                    if prior.get(field, []) != combined:
                        prior[field] = combined
                        associations_changed = True
                if prior["status"] == "ok" and prior.get("parserVersion") != VERSION and "html" in prior.get("contentType", ""):
                    raw = (self.cache / prior["cacheFiles"]["raw"]).read_bytes()
                    if hashlib.sha256(raw).hexdigest() != prior["sha256"]:
                        raise ValueError("Cached raw response hash mismatch: " + url)
                    page = PageParser(prior["finalUrl"] or url)
                    page.feed(raw.decode(prior.get("encoding") or "utf-8", "replace"))
                    parsed = page.finish()
                    prior.update(title=parsed["title"], headings=parsed["headings"], links=parsed["links"],
                                 listItems=parsed["listItems"], textCharacters=len(parsed["text"]), extraction=parsed["extraction"], parserVersion=VERSION)
                    atomic_json(self.cache / prior["cacheFiles"]["parsed"], {**prior, **parsed})
                    self.save()
                elif associations_changed:
                    self.save()
                return prior, True
        entry = {"url": url, "originalUrl": seed["url"], "finalUrl": None, "status": "pending",
                 "httpStatus": None, "fetchedAt": utcnow(), "sha256": None, "bytes": 0,
                 "kind": seed.get("kind", "reference"), "seedTitle": seed.get("title", ""),
                 "characters": sorted(set(seed.get("characters", []))), "discoveredFrom": seed.get("discoveredFrom", []),
                 "lanes": sorted(set(seed.get("lanes", []))),
                 "depth": seed.get("depth", 0), "byteLimit": self.max_bytes}
        try:
            permitted, reason = self.allowed(url)
            if not permitted:
                entry.update(status="blocked", reason=reason)
            else:
                parser, _ = self._robots(url)
                rate = parser.request_rate(ROBOT_AGENT)
                wait = max(parser.crawl_delay(ROBOT_AGENT) or 0, rate.seconds / rate.requests if rate else 0)
                self.pace(url, wait)
                headers = {"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,text/plain,application/pdf;q=0.8", "Accept-Encoding": "identity"}
                # Refresh is an explicit revisit, using validators when a prior body exists.
                if prior and cache_valid and prior.get("etag"):
                    headers["If-None-Match"] = prior["etag"]
                if prior and cache_valid and prior.get("lastModified"):
                    headers["If-Modified-Since"] = prior["lastModified"]
                opener = request.build_opener(RestrictedRedirect(self))
                with opener.open(request.Request(url, headers=headers), timeout=self.timeout) as response:
                    mime = response.headers.get_content_type()
                    entry.update(finalUrl=response.url, httpStatus=response.status, contentType=mime,
                                 responseContentLength=response.headers.get("Content-Length"),
                                 etag=response.headers.get("ETag"), lastModified=response.headers.get("Last-Modified"),
                                 encoding=response.headers.get_content_charset() or "utf-8")
                    limit = min(self.max_bytes, self.max_total_bytes - self.bytes_received)
                    if limit <= 0:
                        raise ValueError("Run byte budget exhausted")
                    body = self._read(response, limit)
                    entry.update(bytes=len(body), sha256=hashlib.sha256(body).hexdigest())
                    if mime in {"text/html", "application/xhtml+xml"}:
                        page = PageParser(response.url)
                        page.feed(body.decode(response.headers.get_content_charset() or "utf-8", "replace"))
                        parsed = page.finish()
                        # Challenge pages are evidence of an access limit, never page content.
                        if re.search(r"^(just a moment|access denied|attention required|verify you are human)", parsed["title"], re.I):
                            entry.update(status="blocked", reason="access-challenge")
                            self.host_blocked[parse.urlsplit(url).netloc] = "prior-access-challenge"
                        else:
                            entry.update(status="ok", title=parsed["title"], headings=parsed["headings"],
                                         links=parsed["links"], listItems=parsed["listItems"], textCharacters=len(parsed["text"]), extraction=parsed["extraction"])
                            entry["parserVersion"] = VERSION
                    elif mime.startswith("text/"):
                        parsed = {"title": seed.get("title", ""), "text": body.decode("utf-8", "replace"), "headings": [], "links": []}
                        entry.update(status="ok", title=parsed["title"], textCharacters=len(parsed["text"]), headings=[], links=[])
                    elif mime == "application/pdf":
                        parsed = {"title": seed.get("title", ""), "text": "", "headings": [], "links": [],
                                  "extractionNote": "Binary PDF retained; this standard-library collector does not extract PDF text."}
                        entry.update(status="binary-only", title=parsed["title"], textCharacters=0, headings=[], links=[])
                    else:
                        parsed = None
                        entry.update(status="unsupported-content", reason=mime)
                    if parsed is not None:
                        key = hashlib.sha256(url.encode()).hexdigest()[:20]
                        suffix = ".html" if "html" in mime else ".pdf" if mime == "application/pdf" else ".txt"
                        raw_path, json_path = Path("pages") / (key + suffix), Path("pages") / (key + ".json")
                        (self.cache / "pages").mkdir(exist_ok=True)
                        (self.cache / raw_path).write_bytes(body)
                        entry["cacheFiles"] = {"raw": raw_path.as_posix(), "parsed": json_path.as_posix()}
                        atomic_json(self.cache / json_path, {**entry, **parsed})
        except error.HTTPError as exc:
            if exc.code == 304 and prior:
                entry = {**prior, "revalidatedAt": utcnow(), "revalidationStatus": 304}
            else:
                entry.update(status="http-error", httpStatus=exc.code, finalUrl=exc.url, reason=str(exc.reason))
                if exc.code in {401, 403, 429}:
                    self.host_blocked[parse.urlsplit(url).netloc] = "prior-http-" + str(exc.code)
        except PermissionError as exc:
            entry.update(status="cache-error", reason=str(exc))
        except (error.URLError, OSError, ValueError) as exc:
            entry.update(status="fetch-error", reason=str(exc))
        self.manifest["entries"][url] = entry
        self.save()
        return entry, False


def link_category(seed, link):
    context = " | ".join(h["text"] for h in link.get("headings", []))
    low = context.lower()
    game = "phantom-liberty" if "phantom liberty" in low or seed.get("game") == "phantom-liberty" else "base"
    if "dogtown" in low:
        game = "phantom-liberty"
    if "side quest" in low or "side job" in low:
        return "side", game, context
    if "gigs" in low:
        return "gig", game, context
    if "main mission" in low or "main quest" in low or "main job" in low:
        return "main", game, context
    return seed.get("category", "unknown"), game, context


def inventory_from_page(seed, entry):
    """Only observed index links or transcript headings, never native IDs."""
    if entry.get("status") != "ok":
        return []
    rows = []
    if seed.get("kind") == "index":
        # This entry point describes numbered map images by district, not named
        # scanner jobs. Keep its text but don't invent per-job inventory rows.
        if seed.get("category") == "scanner":
            return []
        host = parse.urlsplit(entry["url"]).hostname
        for link in entry.get("links", []):
            url, label = link["url"], link["text"]
            if host == "www.powerpyx.com":
                target = parse.urlsplit(url)
                if target.hostname != host or not target.path.startswith("/cyberpunk-2077-"):
                    continue
                if not re.search(r"(?:walkthrough|locations|location)/?$", target.path):
                    continue
                if re.search(r"all-missions|all-gigs|side-jobs-walkthrough-side-quests|dlc-walkthrough|all-ncpd", target.path):
                    continue
                if re.search(r"(?:wiki|guide|walkthroughs|trophy)", label, re.I):
                    continue
                if not link.get("inList") or re.match(r"(?:cyberpunk\s*2077|next\b|.*\bprev\b)", label, re.I):
                    continue
            elif host == "cyberpunk.fandom.com":
                if not parse.urlsplit(url).path.startswith("/wiki/") or re.search(r"(?:Category:|File:|Template:|Special:|User:)", url):
                    continue
                # Fandom layouts vary. Retain candidates with provenance rather than
                # misrepresenting every linked NPC or location as a quest.
                if not any(re.search(r"(?:act |prologue|epilogue|jobs|gigs)", h["text"], re.I) for h in link.get("headings", [])):
                    continue
            elif host == "game8.co":
                target = parse.urlsplit(url)
                context = " | ".join(h["text"] for h in link.get("headings", []))
                if target.hostname != host or not re.fullmatch(r"/games/Cyberpunk-2077/archives/\d+/?", target.path):
                    continue
                if not link.get("inList") or re.search(r"related|comments|popular articles", context, re.I):
                    continue
                if not re.search(r"(?:quest|jobs|story)", context, re.I):
                    continue
            else:
                continue
            category, game, context = link_category(seed, link)
            if category == "mixed" and "collectibles" in context.lower():
                category = "activity"
            rows.append({"title": label, "url": canonical_url(url), "category": category, "game": game,
                         "sourceUrl": entry["url"], "sourceSha256": entry["sha256"], "sourceLocator": context,
                         "evidenceKind": "index-link", "nativeMappingStatus": "unmapped"})
        if host == "www.powerpyx.com":
            for item in entry.get("listItems", []):
                # Some PL job titles have no walkthrough link. Preserve their
                # observed list labels, without fabricating a URL or native ID.
                if item.get("links"):
                    continue
                context = " | ".join(h["text"] for h in item["headings"] if h["level"] >= 2)
                if not re.search(r"main (?:jobs|quests|missions)|side (?:jobs|quests)|gigs", context, re.I):
                    continue
                category, game, _ = link_category(seed, item)
                title = re.split(r"\s+(?:[–—-]?>|→)\s*", item["text"], maxsplit=1)[0].strip()
                if not title or len(title) > 160:
                    continue
                rows.append({"title": title, "url": entry["url"], "category": category, "game": game,
                             "sourceUrl": entry["url"], "sourceSha256": entry["sha256"], "sourceLocator": context + ": " + title,
                             "evidenceKind": "unlinked-index-label", "nativeMappingStatus": "unmapped"})
    if seed.get("kind") == "transcript":
        for heading in entry.get("headings", []):
            # This source contains selected dialogue sections. Unrecognized heading
            # names remain explicitly unclassified; no main/side status is guessed.
            if heading["level"] not in {2, 3, 4, 5}:
                continue
            title = re.sub(r"\s*\[\s*edit\s*\]\s*$", "", heading["text"], flags=re.I).strip()
            if not title or title.lower() in {"contents", "references", "navigation", "notes", "gallery", "dump of game scripts wiki", "scripters", "walkthrough", "dialogues", "actions"}:
                continue
            rows.append({"title": title, "url": entry["url"] + ("#" + heading["id"] if heading.get("id") else ""),
                         "category": "unclassified", "game": "unknown", "sourceUrl": entry["url"],
                         "sourceSha256": entry["sha256"], "sourceLocator": "heading h" + str(heading["level"]) + ": " + title,
                         "evidenceKind": "transcript-heading", "nativeMappingStatus": "unmapped"})
    return rows


def load_seeds(config, roster_path, dossier_dir=None, quest_map_dir=None, roster=None):
    seeds = {canonical_url(item["url"]): {**item, "depth": 0} for item in config["sources"]}
    if roster is None:
        roster = json.loads(Path(roster_path).read_text(encoding="utf-8-sig"))
    for character in roster:
        for source in character.get("sources", []):
            item = source if isinstance(source, dict) else {"url": source}
            url = canonical_url(item["url"])
            seed = seeds.setdefault(url, {**item, "kind": "character-reference", "depth": 0})
            seed.setdefault("characters", []).append(character["key"])
    if dossier_dir and Path(dossier_dir).exists():
        for path in sorted(Path(dossier_dir).glob("*.json")):
            character = json.loads(path.read_text(encoding="utf-8-sig"))
            for source in character.get("sources", []):
                url = canonical_url(source["url"])
                seed = seeds.setdefault(url, {**source, "kind": "dossier-reference", "depth": 0})
                seed.setdefault("characters", []).append(character["key"])
    if quest_map_dir and Path(quest_map_dir).exists():
        for path in sorted(Path(quest_map_dir).glob("*.json")):
            lane = json.loads(path.read_text(encoding="utf-8-sig"))
            for source in lane.get("sources", []):
                if not source.get("url", "").startswith(("https://", "http://")):
                    continue  # Installed-game evidence is collected by the native-data lane.
                url = canonical_url(source["url"])
                seed = seeds.setdefault(url, {**source, "kind": "quest-map-reference", "depth": 0})
                seed.setdefault("lanes", []).append(lane["lane"])
    return list(seeds.values()), roster


def make_inventory(rows, entries):
    unique = {}
    for row in rows:
        if row["evidenceKind"] == "unlinked-index-label":
            key = (row["category"], row["game"], row["evidenceKind"], clean(row["title"]).casefold())
        else:
            key = (row["url"], row["category"], row["evidenceKind"], row["title"] if row["evidenceKind"] != "index-link" else "")
        if key not in unique:
            unique[key] = {**row, "observations": []}
        observation = {"url": row["sourceUrl"], "locator": row["sourceLocator"], "sha256": row["sourceSha256"]}
        if observation not in unique[key]["observations"]:
            unique[key]["observations"].append(observation)
    for row in unique.values():
        target = entries.get(canonical_url(row["url"]))
        row["linkedPageStatus"] = "no-linked-page" if row["evidenceKind"] == "unlinked-index-label" else target["status"] if target else "not-fetched"
    return {"version": 1, "createdAt": utcnow(), "scope": "observed public index links and selected transcript headings",
            "warning": "Not a complete quest catalog, decision map, or proof of save state. A job can have multiple publisher links; row counts are not unique quest counts. Native mappings are all unmapped.",
            "rows": sorted(unique.values(), key=lambda row: (row["category"], row["title"].casefold(), row["url"]))}


def report_text(manifest, inventory, roster, run):
    entries = list(manifest["entries"].values())
    status = Counter(entry["status"] for entry in entries)
    counts = Counter(row["category"] for row in inventory["rows"] if row["evidenceKind"] == "index-link")
    unlinked = Counter(row["category"] for row in inventory["rows"] if row["evidenceKind"] == "unlinked-index-label")
    text_chars = sum(entry.get("textCharacters", 0) for entry in entries if entry["status"] == "ok")
    character_ok = {key for entry in entries if entry["status"] == "ok" for key in entry.get("characters", [])}
    lines = ["# Public research collection", "", f"Collection snapshot: {manifest['updatedAt']}. Collector version {VERSION}.", "",
             "This is source acquisition and a coverage report. It does not certify quest decisions, native fact semantics, or any player's history.", "",
             "## Reproduce or resume", "", "From the repository root:", "", "```powershell",
             f"python research/cyberpunk/scripts/collect_sources.py --max-pages 450 --max-bytes {run['maxPageBytes']} --delay 2 --write-report",
             "```", "", "Previously recorded URLs are reused, including access failures. `--refresh` explicitly revisits them with HTTP validators where available. An expanded reviewed host allowlist or larger per-page byte bound retries only the corresponding scope/budget failures. A successful cached file must still exist before it is reused. Runs stop at their page/byte bounds and can be resumed; index links are rediscovered from cached metadata.", "",
             "The collector uses a reviewed host allowlist, identifies itself, honors robots rules and Crawl-delay, and checks redirect destinations. Missing robots.txt (404/410) permits a request; denied/unavailable robots files fail closed. A 401/403/429 or human-verification response stops further requests to that host for the run. It does not execute remote scripts or use login cookies. Full article text and downloaded PDFs remain in ignored `research/cyberpunk/cache/public/`.", "",
             "## Actual fetched coverage", "", f"- {len(entries)} distinct URLs recorded; statuses: " + ", ".join(f"{key}={value}" for key, value in sorted(status.items())) + ".",
             f"- {text_chars:,} extracted text characters from accessible pages. Boilerplate can remain; this is not a reviewed corpus word count.",
             f"- {len(character_ok)} of {len(roster)} roster identities have at least one directly fetched textual source attached to their roster/dossier seed. A shared page can support multiple identities; this does not establish individual dossier completeness.",
             f"- Latest run: {run['newRequests']} recorded fresh URL attempts, {run['cached']} cache reuses, {run['bytesReceived']:,} received bytes; stop reason `{run['stopReason']}`.", "",
             "| Host | Parsed text pages | Binary only | Blocked or failed |", "|---|---:|---:|---:|"]
    hosts = sorted({parse.urlsplit(entry["url"]).hostname for entry in entries})
    for host in hosts:
        own = [entry for entry in entries if parse.urlsplit(entry["url"]).hostname == host]
        lines.append(f"| {host} | {sum(e['status'] == 'ok' for e in own)} | {sum(e['status'] == 'binary-only' for e in own)} | {sum(e['status'] not in {'ok','binary-only'} for e in own)} |")
    lines += ["", "## Quest inventory evidence", "", "The cached `quest-inventory.json` records each observed title/link, category from its index heading, source hash, source locator, and linked-page fetch status. Repeated links across indices are deduplicated by URL/category; unlinked labels by title/category/game, retaining each observation. A job linked by two publishers yields two source entries: these counts are **not unique quest totals**. Transcript headings remain separately marked `unclassified`; they may be scene/act labels rather than jobs. No item is assigned a native ID or runtime rule.", "",
              "| Observed index category | Distinct linked entries | Unlinked labels |", "|---|---:|---:|"]
    for category in sorted(set(counts) | set(unlinked)):
        lines.append(f"| {category} | {counts[category]} | {unlinked[category]} |")
    transcript_count = sum(row["evidenceKind"] == "transcript-heading" for row in inventory["rows"])
    lines += ["", f"There are additionally {transcript_count} selected transcript heading entries, which are **not added to quest totals**.", "",
              "The broad PowerPyx indices are the fallback collection source; guide publication dates and title coverage differ from the installed game. Missing, updated, repeatable, or unnamed activities remain coverage gaps. NCPD district/location aggregates are not individual scanner-job mapping. Fandom search snippets used by other research are not counted here as fetched page content.", "",
              "## Entry-point receipts", "", "| Source | Status | Extraction |", "|---|---|---|"]
    for entry in entries:
        if entry.get("kind") in {"index", "transcript", "guide", "official"}:
            label = (entry.get("title") or entry.get("seedTitle") or entry["url"]).replace("|", "\\|")
            lines.append(f"| [{label}]({entry['url']}) | {entry['status']} | {entry.get('reason') or entry.get('extraction') or 'none'} |")
    failures = Counter(clean(entry.get("reason", entry["status"])) for entry in entries if entry["status"] not in {"ok", "binary-only"})
    lines += ["", "## Restrictions and gaps", ""]
    lines += [f"- `{reason}`: {count} URL(s)." for reason, count in sorted(failures.items())]
    lines += ["- Arasaka's Ronin is a community transcript snapshot with selected branches; it cannot prove exhaustive dialogue or outcomes.",
              "- Full source text is untrusted reference data. Any instructions embedded in fetched pages are never executed or treated as authoring authority.",
              "- Static HTML collection does not load client-side applications. PDF bytes may be retained without text extraction and are not counted as textual evidence.",
              "- Public walkthrough prose never substitutes for installed journal/fact/scene evidence. Inventory is deliberately separate from `quest-maps` and reviewed executable rules.",
              "- Character biographies and sample dialogue must be original grounded writing, not reproduced source transcripts. This collector makes no production API updates.", "",
              "## Cache layout", "", "- `manifest.json`: URL/final URL/status/date/hash/byte count and extraction metadata, robot receipts, run bounds.",
              "- `pages/<url hash>.html` or `.pdf` or `.txt`: bounded original response bytes.",
              "- `pages/<url hash>.json`: inert extracted title, headings, text and links with source receipt.",
              "- `quest-inventory.json`: honest index and transcript-heading inventory, all native mappings unverified.", ""]
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seeds", type=Path, default=RESEARCH / "source-seeds.json")
    parser.add_argument("--roster", type=Path, default=ROOT / "characters" / "roster.json")
    parser.add_argument("--dossiers", type=Path, default=RESEARCH / "dossiers")
    parser.add_argument("--quest-maps", type=Path, default=RESEARCH / "quest-maps")
    parser.add_argument("--cache", type=Path, default=RESEARCH / "cache" / "public")
    parser.add_argument("--max-pages", type=int, default=450, help="Maximum new URL attempts per run (cached URLs do not count)")
    parser.add_argument("--max-bytes", type=int, default=12_000_000)
    parser.add_argument("--max-total-bytes", type=int, default=160_000_000)
    parser.add_argument("--delay", type=float, default=2)
    parser.add_argument("--timeout", type=float, default=25)
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--write-report", action="store_true")
    args = parser.parse_args(argv)
    if not 1 <= args.max_pages <= 1200 or args.max_bytes < 1024 or args.max_total_bytes < args.max_bytes:
        parser.error("Bounds required: 1..1200 new URLs, at least 1024 bytes/page, total >= page bound")
    if not args.cache.resolve().is_relative_to((RESEARCH / "cache").resolve()):
        parser.error("Raw source cache must remain inside the ignored research/cyberpunk/cache directory")
    seed_bytes, roster_bytes = args.seeds.read_bytes(), args.roster.read_bytes()
    config, roster = json.loads(seed_bytes.decode("utf-8-sig")), json.loads(roster_bytes.decode("utf-8-sig"))
    seeds, roster = load_seeds(config, args.roster, args.dossiers, args.quest_maps, roster)
    seed_set_hash = hashlib.sha256(json.dumps(seeds, sort_keys=True).encode()).hexdigest()
    collector = Collector(args.cache, config["allowedHosts"], args.delay, args.timeout,
                          args.max_bytes, args.max_total_bytes, args.refresh)
    queue, seen, rows = deque(seeds), set(), []
    started, fresh, reused, stop = utcnow(), 0, 0, "queue-exhausted"
    try:
        while queue:
            if fresh >= args.max_pages or collector.bytes_received >= args.max_total_bytes:
                stop = "page-bound" if fresh >= args.max_pages else "byte-bound"
                break
            seed = queue.popleft()
            url = canonical_url(seed["url"])
            if url in seen:
                continue
            seen.add(url)
            entry, cached = collector.fetch(seed)
            reused += int(cached)
            fresh += int(not cached)
            page_rows = inventory_from_page(seed, entry)
            rows.extend(page_rows)
            print(json.dumps({"url": url, "status": entry["status"], "cached": cached,
                              "new": fresh, "queue": len(queue)}), flush=True)
            if seed.get("expand") and seed.get("depth", 0) == 0:
                for row in page_rows:
                    if row["evidenceKind"] != "index-link":
                        continue
                    queue.append({"url": row["url"], "title": row["title"], "kind": "quest-guide", "depth": 1,
                                  "discoveredFrom": [entry["url"]]})
    except KeyboardInterrupt:
        stop = "interrupted-resumable"
    run = {"startedAt": started, "endedAt": utcnow(), "maxPages": args.max_pages,
           "maxPageBytes": args.max_bytes, "maxTotalBytes": args.max_total_bytes,
           "delaySeconds": collector.delay, "newRequests": fresh, "cached": reused,
           "bytesReceived": collector.bytes_received, "stopReason": stop, "remainingQueue": len(queue),
           "seedCount": len(seeds), "seedManifestSha256": hashlib.sha256(seed_bytes).hexdigest(),
           "rosterSha256": hashlib.sha256(roster_bytes).hexdigest(), "resolvedSeedSetSha256": seed_set_hash}
    collector.manifest["runs"].append(run)
    collector.save()
    inventory = make_inventory(rows, collector.manifest["entries"])
    atomic_json(collector.cache / "quest-inventory.json", inventory)
    if args.write_report:
        (RESEARCH / "PUBLIC_SOURCES.md").write_text(report_text(collector.manifest, inventory, roster, run), encoding="utf-8")
    print(json.dumps({"run": run, "statuses": dict(Counter(e["status"] for e in collector.manifest["entries"].values())),
                      "inventoryEntries": len(inventory["rows"])}), flush=True)


if __name__ == "__main__":
    main()
