"""Build lightweight local-voice references (OmniVoice short/long, Pocket TTS) for the generic NPC archetype profiles.

    python scripts/archetype-voices/build_archetype_voices.py [--only KEY,KEY] [--plan-only] [--rebuild KEY,KEY] [--no-bulk-unbundle]

For every archetype of characters/archetypes.json (and its `residentVoices`) this picks one generic NPC voiceset actor (e.g.
gang_mls_m_09_enus_40) per voice from the game's own voice archives.  `voiceCount` (1..4) is the number of distinct actors wanted per key:
voice 1 is the key itself, voices 2..4 are the keys `<key>-v2`, `<key>-v3`, `<key>-v4`.  No actor is ever used twice (not across variants,
not across archetypes).  Pass 1 gives every key its primary actor in catalogue order, pass 2 hands out the extra voices (all v2, then all
v3, then all v4, each in catalogue order) from the actors that remain.  A key that is already "ready" in the manifest is reused as it is
(its actor is reserved, its files are never rewritten) unless listed in --rebuild.  Fewer usable actors than `voiceCount` -> as many as
possible are built (at least the primary) and the shortfall is logged and written to the receipt.  Each actor's calm, conversational lines are decoded and whole clips are joined into three references in the project's
reference format (24 kHz mono 16-bit PCM, clips joined with 0.4 s of silence, no EQ / denoise / gain / trim):

    omni-short  <= 10 s     omni-long  <= 18 s     pocket  <= 20 s

No training, no likeness search, no GPU, no network.  Deterministic: same archives and same archetypes file -> same picks.
Reuses scripts/reference-pool (paths, WolvenKit/vgmstream helpers, text cleaning, decode_one) and scripts/phone_detect (band-limit flag).

Outputs
  runtime/voice-references/archetypes/<engine>/<key>.wav      the references          (git-ignored)
  runtime/voice-references/archetypes/manifest.json           clips, transcripts, hashes (git-ignored, holds game dialogue); MERGED, never rewritten
  characters/archetype-voices.json                            tracked receipt, NO dialogue text; MERGED (existing entries kept)
  E:/CyberpunkConvai-offload/work/archetype-voices/           unbundled .wem, decoded .wav (large intermediates)
register_archetype_voices.mjs then writes the entries into the live voice configs.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "scripts/reference-pool"))
import extract as pool_extract  # noqa: E402  (scripts/reference-pool/extract.py: clean_text, words_of, NONLEXICAL, source_combat, decode_one)
from common import ARCHIVES, ROOT, SRC, WEM_RE, read_json, wolven  # noqa: E402

sys.path.insert(0, str(ROOT / "scripts/phone_detect"))
from flag import STRONG, spectral_score  # noqa: E402

AWORK = Path("E:/CyberpunkConvai-offload/work/archetype-voices")
OUT_DIR = ROOT / "runtime/voice-references/archetypes"
MANIFEST = OUT_DIR / "manifest.json"
RECEIPT = ROOT / "characters/archetype-voices.json"
RATE = pool_extract.OUT_RATE            # 24000
GAP = 0.4
CAPS = {"omni-short": 10.0, "omni-long": 18.0, "pocket": 20.0}
RECEIPT_NAME = {"omni-short": "omniShort", "omni-long": "omniLong", "pocket": "pocket"}
MIN_CLIP, MAX_CLIP = 1.5, 9.0
LOUD_HIGH, LOUD_LOW = 4.0, 8.0          # dB above / below the actor's median gated level
LINES_PER_BATCH, MAX_BATCHES = 40, 3
MAX_WORDS = 28                          # longer lines are almost always > 9 s
MAX_VOICESETS_TRIED = 8
MIN_PREFILTERED = 3
MAX_VOICES = 4

TAG_RE = re.compile(r"^([a-z][a-z0-9]*(?:_[a-z0-9]+)*?)_(\d{1,3})_([a-z]+)_(\d{2})(?=_|$)")
BARK_RE = re.compile(r"_vs_|vs_vset|_vset")
EFFECT_TOKENS = {"radio", "media", "growl", "scream", "shout", "pain", "death", "combat", "battle", "attack", "holocall", "helmet", "rewind"}
COMBAT_RE = re.compile(r"\b(shoot\w*|kill\w*|fire|fires|firing|grenades?|reload\w*|cover|flank\w*|die|dies|dying|dead|run!|get down|take (him|her|them)|"
                       r"bullets?|bleed\w*|open fire|backup|attack\w*)\b", re.I)
RUN_RE = re.compile(r"\brun\b", re.I)


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def sid_of(hex16: str) -> str:
    return str(int(hex16, 16))


# ---------------------------------------------------------------- catalogue of generic NPC lines
def load_lines() -> dict[str, list[dict]]:
    """voiceset tag -> every line of that actor (vo dir only), from the cached archive listings."""
    by_tag: dict[str, list[dict]] = {}
    for archive in ("content", "ep1"):
        for raw in (SRC / f"{archive}.txt").read_text(encoding="utf-8").splitlines():
            raw = raw.strip()
            match = WEM_RE.match(raw)
            if not match or match["vo"] != "vo":
                continue
            tag = TAG_RE.match(match["stem"])
            if not tag:
                continue
            name = f"{tag[1]}_{tag[2]}_{tag[3]}_{tag[4]}"
            context = match["stem"][len(name):].strip("_")
            by_tag.setdefault(name, []).append({"wem": raw, "archive": archive, "stem": match["stem"], "context": context, "fm": match["fm"],
                                                "sid": sid_of(match["hex"])})
    return by_tag


def known_flagged_sids() -> set[str]:
    """String ids the older named-character exclusion files mark combat / effect (consulted by key in case a generic id appears)."""
    out = set()
    for name, key in (("combat-flags.json", "combat"), ("effect-exclusions.json", None)):
        data = read_json(ROOT / "scripts/phone_detect" / name)["clips"]
        for clip, value in data.items():
            if key is None or value.get(key):
                parts = clip.split("/")
                if len(parts) > 1:
                    out.add(re.match(r"\d+", parts[1]).group(0) if re.match(r"\d+", parts[1]) else parts[1])
    return out


def text_reason(line: dict, subtitles: dict, flagged: set[str]) -> str | None:
    """Why a line can never be a reference (decided from text and file name only), or None.  Sets line['text'] / line['words']."""
    if BARK_RE.search(line["stem"]):
        return "bark"
    if EFFECT_TOKENS & set(line["context"].split("_")):
        return "effect-name"
    pair = subtitles.get(line["sid"])
    raw = next((t for t in (pair or []) if t and t.strip()), "") if pair else ""
    if not raw:
        return "no-text"
    if "<" in raw or re.match(r"\[[a-z]{2}_[a-z]{2}\]", raw):
        return "markup-or-foreign"
    text = pool_extract.clean_text(raw)
    tokens = [w.lower() for w in pool_extract.words_of(text)]
    if len(tokens) < 4:
        return "few-words"
    if len(tokens) > MAX_WORDS:
        return "too-long"
    if sum(1 for t in tokens if t in pool_extract.NONLEXICAL or re.fullmatch(r"[aeiouhgr]+", t)) / len(tokens) >= 0.5:
        return "non-lexical"
    if re.search(r"<[^>]+>|\[[^\]]*\]|\*", text) or "!" in text:
        return "markup-or-shout"
    letters = re.sub(r"[^A-Za-z]", "", text)
    if letters and letters.upper() == letters:
        return "all-caps"
    if COMBAT_RE.search(text) or RUN_RE.search(text) and "!" in raw:
        return "combat-word"
    if line["sid"] in flagged or pool_extract.source_combat(line["sid"]):
        return "combat-flag"
    line["text"], line["words"] = text, len(tokens)
    return None


# ---------------------------------------------------------------- catalogue and voiceset choice
def variant_key(base: str, level: int) -> str:
    return base if level == 1 else f"{base}-v{level}"


def load_catalogue() -> list[dict]:
    """Archetype rows then the generic resident rows, each with 'voiceCount' clamped to 1..MAX_VOICES."""
    data = read_json(ROOT / "characters/archetypes.json")
    rows, seen = [], set()
    for row in list(data["archetypes"]) + list(data.get("residentVoices", [])):
        if row["key"] in seen:
            sys.exit(f"duplicate key {row['key']} in archetypes.json")
        seen.add(row["key"])
        rows.append({**row, "voiceCount": max(1, min(int(row.get("voiceCount", 1)), MAX_VOICES))})
    return rows


def ordered_steps(rows: list[dict]) -> list[tuple[dict, int]]:
    """Pass 1: every key's primary in catalogue order; pass 2: all v2, then all v3, then all v4 in catalogue order."""
    steps = [(row, 1) for row in rows]
    for level in range(2, MAX_VOICES + 1):
        steps += [(row, level) for row in rows if row["voiceCount"] >= level]
    return steps


def step_row(row: dict, level: int) -> dict:
    """The row a (row, level) step builds: same families / preferVoicesets, key = variant key."""
    return {**row, "key": variant_key(row["key"], level), "baseKey": row["key"], "level": level}


def candidates_for(archetype: dict, good: dict[str, list[dict]], taken: set[str]) -> list[str]:
    """Ordered voiceset tags to try: preferVoicesets first, then the rest by (lines desc, words desc, tag)."""
    fams = [f + "_" for f in archetype["voiceFamilies"]]
    pool = [tag for tag, lines in good.items() if tag not in taken and len(lines) >= MIN_PREFILTERED and any(tag.startswith(f) for f in fams)]
    ranked = sorted(pool, key=lambda t: (-len(good[t]), -sum(l["words"] for l in good[t]), t))
    prefer = [t for t in archetype.get("preferVoicesets", []) if t in pool]
    return prefer + [t for t in ranked if t not in prefer]


def pick_lines(lines: list[dict], batch: int) -> list[dict]:
    """Longest text first (then sid), deduplicated by text and by string id; batches of LINES_PER_BATCH."""
    seen_text, seen_sid, ordered = set(), set(), []
    for line in sorted(lines, key=lambda l: (-l["words"], l["fm"] != "f", l["sid"])):
        if line["sid"] in seen_sid or line["text"].lower() in seen_text:
            continue
        seen_sid.add(line["sid"]); seen_text.add(line["text"].lower())
        ordered.append(line)
    return ordered[batch * LINES_PER_BATCH:(batch + 1) * LINES_PER_BATCH]


def unbundle(lines: list[dict]) -> None:
    for archive in ("content", "ep1"):
        paths = [l["wem"] for l in lines if l["archive"] == archive]
        out = AWORK / "wem" / archive
        todo = [p for p in paths if not (out / p.replace("\\", "/")).exists()]
        for start in range(0, len(todo), pool_extract.CHUNK):
            batch = todo[start:start + pool_extract.CHUNK]
            rx = "^(" + "|".join(re.escape(p) for p in batch) + ")$"
            wolven(["unbundle", ARCHIVES[archive] / "lang_en_voice.archive", "--outpath", out, "--regex", rx], AWORK / "logs/unbundle.log")


def decode(lines: list[dict], key: str, cache: dict) -> list[dict]:
    jobs, results = [], []
    for line in lines:
        wem = AWORK / "wem" / line["archive"] / line["wem"].replace("\\", "/")
        wav = AWORK / "wav" / key / f"{line['sid']}.wav"
        if line["sid"] in cache and wav.exists():
            results.append({**line, **cache[line["sid"]], "wav": str(wav)})
        elif wem.exists():
            jobs.append((wem, wav, line))
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for (wem, wav, line), (path, meta) in zip(jobs, pool.map(pool_extract.decode_one, jobs)):
            if path is None:
                continue
            cache[line["sid"]] = meta
            results.append({**line, **meta, "wav": str(wav)})
    return results


def usable(decoded: list[dict]) -> tuple[list[dict], dict]:
    """The post-decode filters; returns (kept clips with 'dev' = loudness distance to the median, drop counts)."""
    drops: dict[str, int] = {}

    def drop(reason):
        drops[reason] = drops.get(reason, 0) + 1

    stage = []
    for clip in decoded:
        if clip["d"] < MIN_CLIP or clip["d"] > MAX_CLIP:
            drop("duration")
        elif clip["peak"] >= 0.99:
            drop("clipping")
        elif clip["lv"] is None:
            drop("no-level")
        else:
            stage.append(clip)
    # Band-limited / phone-like: spectral flag against the actor's own median (same rule as scripts/phone_detect/flag.py).
    keys = ("hi_rel", "vhi_rel", "lo_rel", "floor_hz", "cutoff_hz")
    have = [c for c in stage if all(c["spec"].get(k) is not None for k in keys)]
    if have:
        med = {k: statistics.median(c["spec"][k] for c in have) for k in ("hi_rel", "vhi_rel", "lo_rel")}
        phone = set()
        for clip in have:
            _score, reasons = spectral_score(clip["spec"], med)
            if any(r in STRONG for r in reasons):
                phone.add(clip["sid"])
        for clip in stage:
            if clip["sid"] in phone:
                drop("band-limited")
        stage = [c for c in stage if c["sid"] not in phone]
    if not stage:
        return [], drops
    median = statistics.median(c["lv"] for c in stage)
    kept = []
    for clip in stage:
        if clip["lv"] > median + LOUD_HIGH:
            drop("loud")
        elif clip["lv"] < median - LOUD_LOW:
            drop("quiet")
        else:
            kept.append({**clip, "dev": abs(clip["lv"] - median), "median": median})
    return kept, drops


def conversational(clip: dict) -> bool:
    return "?" in clip["text"] or "," in clip["text"] or clip["words"] >= 8


def rank(clips: list[dict]) -> list[dict]:
    # conversational first, closest to the actor's median loudness (1 dB steps), then longer, then sid for determinism
    return sorted(clips, key=lambda c: (not conversational(c), round(c["dev"]), -c["d"], c["sid"]))


def fill(ranked: list[dict], cap: float) -> list[dict] | None:
    """Greedy fill in rank order; whole clips, 0.4 s gaps, total <= cap.  >= 2 clips or fall back to the 2 shortest."""
    chosen, total = [], 0.0
    for clip in ranked:
        extra = clip["d"] + (GAP if chosen else 0)
        if total + extra <= cap + 1e-9:
            chosen.append(clip); total += extra
    if len(chosen) >= 2:
        return chosen
    shortest = sorted(ranked, key=lambda c: (c["d"], c["sid"]))[:2]
    if len(shortest) == 2 and shortest[0]["d"] + shortest[1]["d"] + GAP <= cap + 1e-9:
        return shortest
    return None


def write_reference(clips: list[dict], path: Path) -> dict:
    parts = []
    for index, clip in enumerate(clips):
        data, rate = sf.read(clip["wav"], dtype="float32", always_2d=True)
        assert rate == RATE, rate
        parts.append(data.mean(axis=1))
        if index < len(clips) - 1:
            parts.append(np.zeros(int(round(GAP * RATE)), dtype=np.float32))
    wave = np.concatenate(parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    sf.write(str(tmp), np.clip(wave, -1, 1), RATE, subtype="PCM_16", format="WAV")
    os.replace(tmp, path)
    return {"seconds": round(len(wave) / RATE, 2), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}




# ---------------------------------------------------------------- main
def try_voiceset(tag: str, key: str, good: dict, cache: dict) -> tuple[list[dict] | None, dict, str]:
    """Decode batches of the actor's lines until enough usable clips; returns (refs or None, drop counts, reason)."""
    decoded, drops, kept = [], {}, []
    for batch in range(MAX_BATCHES):
        lines = pick_lines(good[tag], batch)
        if not lines:
            break
        unbundle(lines)
        decoded += decode(lines, key, cache)
        kept, drops = usable(decoded)
        if len(kept) >= 8:
            break
    if len(kept) < 2:
        return None, drops, f"only {len(kept)} usable clip(s) of {len(decoded)} decoded"
    ranked = rank(kept)
    refs = {engine: fill(ranked, cap) for engine, cap in CAPS.items()}
    short = [e for e, v in refs.items() if v is None]
    if short:
        return None, drops, f"no two clips fit the {short[0]} cap"
    return refs, drops, ""


def build_archetype(archetype: dict, good: dict, taken: set[str], rejected: set[str], cache: dict, protected: set[str]) -> dict:
    key = archetype["key"]
    if key in protected:
        raise RuntimeError(f"refusing to rebuild {key}: it is ready in the manifest (use --rebuild)")
    tried = []
    for tag in candidates_for(archetype, good, taken | rejected)[:MAX_VOICESETS_TRIED]:
        refs, drops, why = try_voiceset(tag, key, good, cache)
        if refs is None:
            tried.append(f"{tag}: {why}")
            rejected.add(tag)               # the verdict depends on the actor only, so no other key retries it
            log(f"  {key}: {tag} rejected ({why}); drops {drops}")
            continue
        taken.add(tag)
        used = {}
        for engine, clips in refs.items():
            for clip in clips:
                used.setdefault(clip["sid"], clip)
        result = {"status": "ready", "voiceset": tag, "drops": drops, "tried": tried,
                  "clips": [{"sid": c["sid"], "wem": c["wem"], "archive": c["archive"], "seconds": c["d"], "gatedDb": c["lv"], "text": c["text"]} for c in used.values()],
                  "references": {}}
        if archetype.get("level", 1) > 1:
            result["variantOf"], result["variant"] = archetype["baseKey"], archetype["level"]
        for engine, clips in refs.items():
            path = OUT_DIR / engine / f"{key}.wav"
            info = write_reference(clips, path)
            result["references"][engine] = {"path": path.relative_to(ROOT).as_posix(), **info, "clips": [c["sid"] for c in clips],
                                            "transcript": " ".join(c["text"] for c in clips)}
        return result
    families = ", ".join(archetype["voiceFamilies"])
    return {"status": "unprepared", "reason": f"no usable voiceset in {families}" + (f" (tried: {'; '.join(tried)})" if tried else " (none with enough clean ambient lines left)"),
            "tried": tried}


def atomic_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def receipt_entry(r: dict) -> dict:
    if r["status"] == "ready":
        entry = {"status": "ready", "voiceset": r["voiceset"], "clips": [c["sid"] for c in r["clips"]],
                 "seconds": {RECEIPT_NAME[e]: r["references"][e]["seconds"] for e in CAPS}}
        if r.get("variantOf"):
            entry["variantOf"] = r["variantOf"]
        return entry
    return {"status": "unprepared", "voiceset": None, "clips": [], "seconds": {}, "reason": r["reason"]}


def write_receipt(manifest: dict, rows: list[dict], shortfalls: dict, rebuilt: set[str], built: str) -> None:
    """Merge into the tracked receipt: existing entries stay as they are, new / rebuilt keys are added or replaced."""
    receipt = read_json(RECEIPT) if RECEIPT.exists() else {"version": 1, "builtAt": built, "rules": {}, "voices": {}}
    receipt["updatedAt"] = built
    receipt["rules"].update({"oneVoicesetPerArchetype": True, "noVoicesetSharedBetweenKeys": True, "variantKeys": "<key>-v2 .. <key>-v4 (voiceCount)"})
    voices = receipt["voices"]
    for key, r in manifest["voices"].items():
        if key not in voices or key in rebuilt:
            voices[key] = receipt_entry(r)
    wanted = {row["key"]: row["voiceCount"] for row in rows}
    built_count = {key: 1 + sum(1 for n in range(2, MAX_VOICES + 1) if manifest["voices"].get(variant_key(key, n), {}).get("status") == "ready")
                   for key in wanted if manifest["voices"].get(key, {}).get("status") == "ready"}
    receipt["shortfalls"] = {key: {"wanted": wanted[key], "built": built_count.get(key, 0), **({"reason": shortfalls[key]} if key in shortfalls else {})}
                             for key in wanted if built_count.get(key, 0) < wanted[key]}
    atomic_json(RECEIPT, receipt)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", help="comma-separated keys (incl. -vN variants) to build; the others are left alone (manifest / receipt are merged either way)")
    parser.add_argument("--plan-only", action="store_true", help="choose voiceset per key (variants included) from the text prefilter and stop")
    parser.add_argument("--rebuild", help="comma-separated keys that are ready in the manifest but must be derived again (their files ARE rewritten)")
    parser.add_argument("--no-bulk-unbundle", action="store_true")
    args = parser.parse_args()
    pool_extract.set_low_priority()
    started = time.time()
    rows = load_catalogue()
    if not pool_extract.VGM.exists():
        sys.exit(f"vgmstream-cli not found at {pool_extract.VGM}")
    subtitles = read_json(SRC / "subtitles.json")
    flagged = known_flagged_sids()
    wanted = {f + "_" for a in rows for f in a["voiceFamilies"]}
    log("reading listings")
    by_tag = {tag: lines for tag, lines in load_lines().items() if any(tag.startswith(f) for f in wanted)}
    log(f"{len(by_tag)} candidate voicesets; text prefilter (loads the combat scene index, ~1 min)")
    good, dropped = {}, {}
    for tag, lines in by_tag.items():
        keep = []
        for line in lines:
            reason = text_reason(line, subtitles, flagged)
            if reason:
                dropped[reason] = dropped.get(reason, 0) + 1
            else:
                keep.append(line)
        if keep:
            good[tag] = keep
    log(f"prefilter dropped {dropped}; {len(good)} voicesets have lines")

    manifest = read_json(MANIFEST) if MANIFEST.exists() else {"version": 1, "builtAt": None, "note": "contains game dialogue; git-ignored", "voices": {}}
    rebuild = set(filter(None, (args.rebuild or "").split(",")))
    only = set(filter(None, (args.only or "").split(","))) or None
    steps = [(step_row(row, level), level) for row, level in ordered_steps(rows)]
    known = {row["key"] for row, _ in steps}
    for key in (rebuild | (only or set())) - known:
        sys.exit(f"unknown key {key}")
    # Keys that are ready in the manifest keep their actor and files (the live bridge uses them) unless --rebuild names them.
    protected = {k for k, v in manifest["voices"].items() if v.get("status") == "ready" and k not in rebuild}
    reserved = {manifest["voices"][k]["voiceset"] for k in protected}
    owners: dict[str, str] = {}
    for key in sorted(protected):
        tag = manifest["voices"][key]["voiceset"]
        if tag in owners:
            log(f"WARNING: {tag} is used by both {owners[tag]} and {key} in the existing manifest")
        owners[tag] = key

    # Plan (assumes every first choice works): used for --plan-only and so the .wem files can be unbundled in a few big batches.
    sim_taken = set(reserved)
    plan: dict[str, str | None] = {}
    for row, level in steps:
        key = row["key"]
        if key in protected:
            plan[key] = manifest["voices"][key]["voiceset"]
            continue
        cand = candidates_for(row, good, sim_taken)
        plan[key] = cand[0] if cand else None
        if cand:
            sim_taken.add(cand[0])
    for row, level in steps:
        key, tag = row["key"], plan[row["key"]]
        state = "kept " if key in protected else ("NEW  " if tag else "NONE ")
        extra = f"({len(good[tag])} lines)" if tag and key not in protected else ""
        log(f"plan {state}{key:34} -> {tag or '-'} {extra}")
    for r in rows:
        have = sum(1 for n in range(1, r["voiceCount"] + 1) if plan.get(variant_key(r["key"], n)))
        if have < r["voiceCount"]:
            log(f"plan SHORT {r['key']}: {have} of {r['voiceCount']} voices have an actor")
    if args.plan_only:
        return 0
    if not args.no_bulk_unbundle:
        todo, seen = [], set()
        for row, level in steps:
            key, tag = row["key"], plan[row["key"]]
            if tag and key not in protected and (not only or key in only):
                for line in pick_lines(good[tag], 0):
                    if line["wem"] not in seen:
                        seen.add(line["wem"]); todo.append(line)
        log(f"bulk unbundle of {len(todo)} files")
        unbundle(todo)

    cache_path = AWORK / "decode-cache.json"
    cache = read_json(cache_path) if cache_path.exists() else {}
    taken, rejected = set(reserved), set()
    results, shortfalls, blocked = {}, {}, set()
    built = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest["builtAt"] = manifest.get("builtAt") or built
    manifest["updatedAt"] = built
    for row, level in steps:
        key, base = row["key"], row["baseKey"]
        if key in protected:
            continue
        if only and key not in only:
            if plan.get(key):
                taken.add(plan[key])        # keep later picks of this run consistent with the full plan
            continue
        if base in blocked:
            shortfalls[key] = "an earlier voice of this key could not be built"
            log(f"{key:34} skipped: {shortfalls[key]}")
            continue
        r = build_archetype(row, good, taken, rejected, cache, protected)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache), encoding="utf-8")
        if r["status"] == "ready":
            results[key] = manifest["voices"][key] = r
            atomic_json(MANIFEST, manifest)     # checkpoint: a later failure never loses finished keys
            secs = {e: r["references"][e]["seconds"] for e in CAPS}
            counts = {e: len(r["references"][e]["clips"]) for e in CAPS}
            log(f"{key:34} {r['voiceset']:28} clips {counts} seconds {secs}")
        elif level == 1:
            results[key] = manifest["voices"][key] = r      # primary stays "unprepared": the bridge then uses the Convai voice
            blocked.add(base)
            log(f"{key:34} UNPREPARED: {r['reason']}")
        else:
            shortfalls[key] = r["reason"]
            blocked.add(base)
            log(f"{key:34} SHORT (voice {level} of {row['voiceCount']} not built): {r['reason']}")
    atomic_json(MANIFEST, manifest)
    write_receipt(manifest, rows, shortfalls, set(rebuild), built)
    ready = sum(1 for r in results.values() if r["status"] == "ready")
    log(f"done: {ready} built, {len(results) - ready} unprepared, {len(shortfalls)} variant(s) short, {len(protected)} kept in {time.time() - started:.0f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
