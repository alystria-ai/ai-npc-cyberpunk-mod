"""Build lightweight local-voice references (OmniVoice short/long, Pocket TTS) for the generic NPC archetype profiles.

    python scripts/archetype-voices/build_archetype_voices.py [--only npc-a,npc-b] [--plan-only] [--no-bulk-unbundle]

For every archetype of characters/archetypes.json this picks ONE generic NPC voiceset actor (e.g. gang_mls_m_09_enus_40) from the game's
own voice archives, decodes a few of its calm, conversational lines and joins whole clips into three references in the project's
reference format (24 kHz mono 16-bit PCM, clips joined with 0.4 s of silence, no EQ / denoise / gain / trim):

    omni-short  <= 10 s     omni-long  <= 18 s     pocket  <= 20 s

No training, no likeness search, no GPU, no network.  Deterministic: same archives and same archetypes file -> same picks.
Reuses scripts/reference-pool (paths, WolvenKit/vgmstream helpers, text cleaning, decode_one) and scripts/phone_detect (band-limit flag).

Outputs
  runtime/voice-references/archetypes/<engine>/<key>.wav      the references          (git-ignored)
  runtime/voice-references/archetypes/manifest.json           clips, transcripts, hashes (git-ignored, holds game dialogue)
  characters/archetype-voices.json                            tracked receipt, NO dialogue text
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


# ---------------------------------------------------------------- voiceset choice
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


def build_archetype(archetype: dict, good: dict, taken: set[str], cache: dict) -> dict:
    key = archetype["key"]
    tried = []
    for tag in candidates_for(archetype, good, taken)[:MAX_VOICESETS_TRIED]:
        refs, drops, why = try_voiceset(tag, key, good, cache)
        if refs is None:
            tried.append(f"{tag}: {why}")
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
        for engine, clips in refs.items():
            path = OUT_DIR / engine / f"{key}.wav"
            info = write_reference(clips, path)
            result["references"][engine] = {"path": path.relative_to(ROOT).as_posix(), **info, "clips": [c["sid"] for c in clips],
                                            "transcript": " ".join(c["text"] for c in clips)}
        return result
    families = ", ".join(archetype["voiceFamilies"])
    return {"status": "unprepared", "reason": f"no usable voiceset in {families}" + (f" (tried: {'; '.join(tried)})" if tried else " (none with enough clean ambient lines left)"),
            "tried": tried}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", help="comma-separated archetype keys (testing; the receipt/manifest are not rewritten)")
    parser.add_argument("--plan-only", action="store_true", help="choose voicesets from the text prefilter and stop")
    parser.add_argument("--no-bulk-unbundle", action="store_true")
    args = parser.parse_args()
    pool_extract.set_low_priority()
    started = time.time()
    archetypes = read_json(ROOT / "characters/archetypes.json")["archetypes"]
    if not pool_extract.VGM.exists():
        sys.exit(f"vgmstream-cli not found at {pool_extract.VGM}")
    subtitles = read_json(SRC / "subtitles.json")
    flagged = known_flagged_sids()
    wanted = {f + "_" for a in archetypes for f in a["voiceFamilies"]}
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

    # Plan (assumes every first choice works) so all .wem files can be unbundled in a few big batches.
    sim_taken: set[str] = set()
    plan = {}
    for archetype in archetypes:
        cand = candidates_for(archetype, good, sim_taken)
        plan[archetype["key"]] = cand[0] if cand else None
        if cand:
            sim_taken.add(cand[0])
    for key, tag in plan.items():
        log(f"plan {key:26} -> {tag} ({len(good[tag]) if tag else 0} lines)")
    if args.plan_only:
        return 0
    only = set(args.only.split(",")) if args.only else None
    if not args.no_bulk_unbundle:
        todo = [l for a in archetypes if plan[a["key"]] and (not only or a["key"] in only) for l in pick_lines(good[plan[a["key"]]], 0)]
        log(f"bulk unbundle of {len(todo)} files")
        unbundle(todo)

    cache_path = AWORK / "decode-cache.json"
    cache = read_json(cache_path) if cache_path.exists() else {}
    taken: set[str] = set()
    results = {}
    for archetype in archetypes:
        key = archetype["key"]
        if only and key not in only:
            continue
        results[key] = build_archetype(archetype, good, taken, cache)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(cache), encoding="utf-8")
        r = results[key]
        if r["status"] == "ready":
            secs = {e: r["references"][e]["seconds"] for e in CAPS}
            counts = {e: len(r["references"][e]["clips"]) for e in CAPS}
            log(f"{key:26} {r['voiceset']:28} clips {counts} seconds {secs}")
        else:
            log(f"{key:26} UNPREPARED: {r['reason']}")
    if only:
        log("--only run: manifest and receipt not rewritten")
        return 0

    built = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest = {"version": 1, "builtAt": built, "note": "contains game dialogue; git-ignored", "voices": results}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = MANIFEST.with_name("manifest.json.tmp")
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, MANIFEST)
    voices = {}
    for key, r in results.items():
        if r["status"] == "ready":
            voices[key] = {"status": "ready", "voiceset": r["voiceset"], "clips": [c["sid"] for c in r["clips"]],
                           "seconds": {RECEIPT_NAME[e]: r["references"][e]["seconds"] for e in CAPS}}
        else:
            voices[key] = {"status": "unprepared", "voiceset": None, "clips": [], "seconds": {}, "reason": r["reason"]}
    receipt = {"version": 1, "builtAt": built,
               "rules": {"engineCapsSeconds": CAPS, "gapSeconds": GAP, "clipSeconds": [MIN_CLIP, MAX_CLIP], "maxPeak": 0.99,
                         "loudnessWindowDb": {"above": LOUD_HIGH, "below": LOUD_LOW}, "minWords": 4, "maxWords": MAX_WORDS, "linesPerBatch": LINES_PER_BATCH,
                         "oneVoicesetPerArchetype": True, "format": "24 kHz mono 16-bit PCM, whole clips, no EQ/denoise/gain/trim",
                         "source": "generic NPC voicesets of the English voice archives; no dialogue text is stored here"},
               "voices": voices}
    tmp = RECEIPT.with_name("archetype-voices.json.tmp")
    tmp.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, RECEIPT)
    ready = sum(1 for r in results.values() if r["status"] == "ready")
    log(f"done: {ready} ready, {len(results) - ready} unprepared in {time.time() - started:.0f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
