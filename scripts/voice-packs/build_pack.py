"""Build one multilingual pack from the game's dubbed voice-over (docs/VOICE_LANGUAGE_PACKS.md).

    python -I scripts/voice-packs/build_pack.py --lang zh-cn [--only key,key] [--no-speaker] [--threads 4] [--stage-name NAME]

Run it with vendor/reference-voicestudio/.venv/Scripts/python.exe (numpy, scipy, soundfile, torch, torchaudio, speechbrain).
Reads   scripts/voice-packs/line-lists.json     (which game lines make each shipped English reference; written by trace_english.py)
        E:/SteamLibrary/AiNpc-vo-stash/<lang>/{content,ep1}/lang_<archive>_voice.archive   (read-only; only the needed files are extracted)
        the installed lang_<archive>_text.archive files (subtitles, read-only)
Writes  E:/SteamLibrary/AiNpc-voice-packs/work/<lang>/     work files (wem, wav, reports)
        E:/SteamLibrary/AiNpc-voice-packs/<lang>/stage/    the pack tree: red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual/<lang>/{manifest.json,picked,archetypes,v-voice}
and a report (work/<lang>/build-report.json). prepare_slots.mjs and package_pack.mjs finish the job (Voxtral slots, zip, listing).

Per voice: the same line ids as the English reference -> the dub's file of each line (same file stem under the language's locale folder) -> decode
(vgmstream) -> join exactly like the English build (24 kHz mono, 0.4 s of silence between clips, no EQ or denoise; the same -20 LUFS gain stage
for the voices that have it in English) -> checks. A line that is missing in the dub or fails a check is replaced by the next line the English
scoring ranked for that voice; the transcript is the language's subtitle of the same line.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime
import itertools
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vp_common as vp  # noqa: E402
import vp_text  # noqa: E402

MAX_SECONDS = 19.9                 # OmniVoice's reference limit is 20 s
MIN_CLIP_SECONDS, MAX_CLIP_SECONDS = 1.0, 12.0
MIN_GATED_DB, MAX_GATED_DB = -36.0, -10.0        # per clip (the English pool's median is about -23)
SET_LUFS_RANGE = (-34.0, -12.0)                  # per finished reference, before the gain stage
MAX_TRIES = 14                                   # replacement lines tried per voice
MIN_VOICE_SECONDS = 5.0
PACK_ROOT = "red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual"


# ------------------------------------------------------------------ English-side data
class English:
    """The English game lines of a voice that rank after its shipped lines (the English scoring), for replacements."""

    def __init__(self):
        self.index = vp.wem_index("en")
        self.by_hex = {}
        for key in self.index:
            self.by_hex.setdefault(key[4], []).append(key)
        self.pool = None
        self.archetypes = None

    def line_of(self, key) -> dict:
        return {"hex": key[4], "fm": key[3], "vo": key[1], "stem": key[2], "rest": key[5], "archive": key[0]}

    def lines_for_id(self, clip_id: str) -> dict | None:
        import trace_english as te
        ref = te.parse_id(clip_id)
        if ref is None:
            return None
        cands = te.candidates_for_hex(self.by_hex, ref)
        return self.line_of(cands[0]) if cands else None

    def ranked(self, key: str, kind: str, used_hex: set) -> list[dict]:
        out = []
        if kind == "picked":
            if self.pool is None:
                self.pool = vp.read_json(vp.POOL_INDEX)["voices"]
            voice = self.pool.get(key)
            if voice:
                def usable(clip):
                    return (1.5 <= clip["d"] <= 9.0 and len(re.findall(r"[A-Za-z0-9']+", clip.get("t") or "")) >= 3 and clip.get("k") != "media"
                            and not clip.get("fx") and not clip.get("cb"))
                clips = sorted((c for c in voice["clips"] if usable(c)), key=lambda c: -(c.get("ty") or 0))
                for clip in clips:
                    line = self.lines_for_id(clip["id"])
                    if line and line["hex"] not in used_hex:
                        out.append(line)
        elif kind == "archetypes":
            if self.archetypes is None:
                self.archetypes = vp.read_json(vp.MAIN / "runtime/voice-references/archetypes/manifest.json")["voices"]
            row = self.archetypes.get(key)
            for clip in (row or {}).get("clips", []):
                m = vp.WEM_RE.match(clip["wem"])
                if m and m["hex"] not in used_hex:
                    out.append({"hex": m["hex"], "fm": m["fm"], "vo": m["vo"], "stem": m["stem"], "rest": m["rest"], "archive": clip["archive"]})
        seen, unique = set(), []
        for line in out:
            if line["hex"] not in seen:
                seen.add(line["hex"])
                unique.append(line)
        return unique


# ------------------------------------------------------------------ the dub
class Dub:
    def __init__(self, lang: str):
        self.lang = lang
        self.locale = vp.LANGUAGES[lang]["locale"]
        self.index = vp.wem_index(lang)
        self.by_hex = {}
        for key in self.index:
            self.by_hex.setdefault(key[4], []).append(key)
        self.work = vp.WORK / lang
        self.cache = {}

    def find(self, line: dict):
        """The dub's file for an English line: the same stem under the locale folder, else the same string id (same variant, then any)."""
        key = (line["archive"], line["vo"], line["stem"], line["fm"], line["hex"], line["rest"])
        if key in self.index:
            return key, ""
        cands = [k for k in self.by_hex.get(line["hex"], []) if k[1] == line["vo"]]
        for pick in ([k for k in cands if k[3] == line["fm"] and k[0] == line["archive"]], [k for k in cands if k[3] == line["fm"]], cands):
            if pick:
                return pick[0], f"file name differs in the dub ({pick[0][2]}_{pick[0][3]})"
        return None, "the line is not in the dub archive"

    def prepare(self, keys: list) -> None:
        """Extract and decode the files (only these), 4 decoders at most."""
        need = {}
        for key in keys:
            path = self.index[key]
            if not (self.work / "wav" / (path.replace("\\", "/") + ".wav")).is_file():
                need.setdefault(key[0], []).append(path)
        for sub, paths in need.items():
            vp.unbundle(self.lang, sub, sorted(set(paths)), self.work / "wem")
        jobs = [(self.work / "wem" / self.index[k].replace("\\", "/"), self.work / "wav" / (self.index[k].replace("\\", "/") + ".wav")) for k in keys]
        jobs = [(w, o) for w, o in jobs if not o.is_file() and w.is_file()]
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda job: vp.decode_wem(*job), jobs))

    def wav_path(self, key) -> Path:
        return self.work / "wav" / (self.index[key].replace("\\", "/") + ".wav")


def load_audio(dub: Dub, key, kind: str):
    wav = dub.wav_path(key)
    if not wav.is_file():
        return None
    return vp.load_v(wav) if kind == "v-voice" else vp.load_mono(wav, method="poly")


# ------------------------------------------------------------------ one voice
class Clip:
    def __init__(self, line, key, audio, text, notes):
        self.line, self.key, self.audio, self.text, self.notes = line, key, audio, text, notes
        self.seconds = len(audio) / vp.RATE
        self.emb = None


def check_clip(audio) -> str | None:
    seconds = len(audio) / vp.RATE
    if seconds < MIN_CLIP_SECONDS:
        return f"too short ({seconds:.2f} s)"
    if seconds > MAX_CLIP_SECONDS:
        return f"too long ({seconds:.1f} s)"
    m = vp.measure(audio)
    if m["clipped"]:
        return "clipped"
    if m["gatedRmsDb"] is None or m["gatedRmsDb"] < MIN_GATED_DB:
        return f"too quiet (gated rms {m['gatedRmsDb']} dB)"
    if m["gatedRmsDb"] > MAX_GATED_DB:
        return f"too loud (gated rms {m['gatedRmsDb']} dB)"
    return None


def build_voice(key, row, dub: Dub, subs: vp_text.Subtitles, english: English, speaker, threshold, log_rows) -> dict:
    kind = row["kind"]
    used_hex = {line["hex"] for line in row["lines"]}
    replacements = None
    report = {"kind": kind, "lines": [], "replaced": [], "missing": [], "dropped": [], "notes": []}
    clips = []

    def next_replacement():
        nonlocal replacements
        if replacements is None:
            replacements = english.ranked(key, kind, used_hex)
            report["rankedReplacementsAvailable"] = len(replacements)
        while replacements:
            line = replacements.pop(0)
            used_hex.add(line["hex"])
            return line
        return None

    def take(line):
        """A usable clip for a line, or (None, reason)."""
        wem, note = dub.find(line)
        if wem is None:
            return None, note
        dub.prepare([wem])
        audio = load_audio(dub, wem, kind)
        if audio is None:
            return None, "could not be extracted or decoded"
        problem = check_clip(audio)
        if problem:
            return None, problem
        text, why = subs.text(vp.sid_of(line["hex"]), wem[3])
        if not text:
            return None, why
        if len(re.sub(r"\W", "", text)) < 3:
            return None, "subtitle is empty"
        return Clip(line, wem, audio, text, [note] if note else []), ""

    slots = []                     # clips in order, one per English line; replaced lines take the same slot
    tries = 0
    for line in row["lines"]:
        clip, reason = take(line)
        if clip is None:
            report["missing"].append({"hex": line["hex"], "stem": line["stem"], "why": reason})
            while clip is None and tries < MAX_TRIES:
                repl = next_replacement()
                if repl is None:
                    break
                tries += 1
                clip, why = take(repl)
                if clip is None:
                    report["notes"].append(f"replacement {repl['stem']} also unusable: {why}")
            if clip is not None:
                report["replaced"].append({"hex": line["hex"], "by": clip.line["hex"], "because": reason})
        if clip is not None:
            slots.append(clip)
    clips = slots

    def total(cs):
        return sum(c.seconds for c in cs) + max(0, len(cs) - 1) * vp.GAP_SECONDS

    # speaker consistency: the clips of one voice must sound like one speaker
    if speaker is not None and len(clips) >= 2:
        for round_no in range(4):
            for c in clips:
                if c.emb is None:
                    c.emb = speaker.embed(c.audio)
            pairs = {(i, j): speaker.cosine(clips[i].emb, clips[j].emb) for i, j in itertools.combinations(range(len(clips)), 2)}
            worst = min(pairs.values())
            report["speakerMinCosine"] = round(worst, 3)
            if worst >= threshold:
                break
            if len(clips) >= 3:
                means = [sum(pairs[tuple(sorted((i, j)))] for j in range(len(clips)) if j != i) / (len(clips) - 1) for i in range(len(clips))]
                bad = min(range(len(clips)), key=lambda i: means[i])
            else:
                bad = len(clips) - 1 if round_no % 2 == 0 else 0
            lost = clips[bad]
            replacement = None
            while replacement is None and tries < MAX_TRIES:
                repl = next_replacement()
                if repl is None:
                    break
                tries += 1
                candidate, why = take(repl)
                if candidate is not None:
                    replacement = candidate
            report["replaced"].append({"hex": lost.line["hex"], "by": replacement.line["hex"] if replacement else None,
                                       "because": f"speaker check: cosine {worst:.2f} below {threshold:.2f}"})
            if replacement is None:
                report["notes"].append("no replacement left for the speaker check")
                break
            clips[bad] = replacement
        else:
            report["notes"].append("speaker check still failing after replacements")
        if "speakerMinCosine" in report and report["speakerMinCosine"] < threshold:
            # no replacement left: a pair clearly below the bar is a different speaker (a stranger scores near 0.1), one just under it is kept and reported
            if report["speakerMinCosine"] < max(0.05, threshold - 0.15):
                report["speakerFailed"] = True
            else:
                report["borderlineSpeaker"] = True
                report["notes"].append(f"speaker check borderline: lowest cosine {report['speakerMinCosine']:.2f}, bar {threshold:.2f}; kept")
    elif speaker is None:
        report["notes"].append("speaker check skipped (no ECAPA weights)")

    # the 20 s limit
    while total(clips) > MAX_SECONDS and len(clips) > 1:
        gone = clips.pop()
        report["dropped"].append({"hex": gone.line["hex"], "seconds": round(gone.seconds, 2), "because": f"set over {MAX_SECONDS} s"})
    # a set that shrank to under 12 s (a long dub line was dropped) is topped up with the next ranked line that fits and sounds like the same speaker
    # Also any set under 8 s, whatever made it short (lines swapped for shorter ones, lines missing in the dub): extended up to 12 s.
    topup = 0
    triggered = 0 < total(clips) < 8.0 or (bool(report["dropped"]) and 0 < total(clips) < 12.0)
    while triggered and 0 < total(clips) < 12.0 and tries < MAX_TRIES and topup < 6:
        repl = next_replacement()
        if repl is None:
            break
        tries += 1
        candidate, why = take(repl)
        if candidate is None or total(clips) + vp.GAP_SECONDS + candidate.seconds > MAX_SECONDS:
            continue
        if speaker is not None:
            candidate.emb = speaker.embed(candidate.audio)
            for c in clips:
                if c.emb is None:
                    c.emb = speaker.embed(c.audio)
            if min(speaker.cosine(candidate.emb, c.emb) for c in clips) < threshold:
                continue
        clips.append(candidate)
        topup += 1
        report["notes"].append(f"topped up with line {candidate.line['hex']} ({candidate.seconds:.1f} s) because the set was short")
    if total(clips) > MAX_SECONDS:
        report["notes"].append("single clip over the limit")
        return {"report": report, "ok": False}
    seconds = total(clips)
    report["lines"] = [{"hex": c.line["hex"], "stem": c.line["stem"], "seconds": round(c.seconds, 2), "text": c.text, "notes": c.notes} for c in clips]
    if not clips or seconds < MIN_VOICE_SECONDS:
        report["notes"].append(f"only {seconds:.1f} s usable")
        return {"report": report, "ok": False}
    if report.get("speakerFailed"):
        report["notes"].append("clips do not sound like one speaker: voice left out (keeps its English reference)")
        return {"report": report, "ok": False}
    joined = vp.join_clips([c.audio for c in clips])
    raw = vp.measure(joined)
    report["rawLoudness"] = raw
    if not (SET_LUFS_RANGE[0] <= raw["lufs"] <= SET_LUFS_RANGE[1]):
        report["notes"].append(f"loudness {raw['lufs']} LUFS outside {SET_LUFS_RANGE}")
    final = joined
    if row.get("gainStage"):
        final, info = vp.gain_match(joined)
        report["gain"] = info
    if raw["clipped"]:
        report["notes"].append("joined set has clipped samples")
    report["finalLoudness"] = vp.measure(final)
    return {"report": report, "ok": True, "audio": final, "clips": clips, "seconds": round(len(final) / vp.RATE, 3)}


# ------------------------------------------------------------------ gender
def gender_of(key, kind, roster, record_genders, archetypes_manifest) -> str | None:
    if kind == "v-voice":
        return key.split("-")[1]
    g = roster.get(key)
    if g:
        return g.lower()
    if key.endswith("-male") or "-male-" in key:
        return "male"
    if key.endswith("-female") or "-female-" in key:
        return "female"
    row = (archetypes_manifest or {}).get(key) or {}
    m = re.search(r"_(m|f)_\d\d_", row.get("voiceset", ""))
    return {"m": "male", "f": "female"}.get(m[1]) if m else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lang", required=True, choices=[k for k in vp.LANGUAGES if k != "en"])
    ap.add_argument("--only", default="")
    ap.add_argument("--no-speaker", action="store_true")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--speaker-threshold", type=float, default=None, help="minimum ECAPA cosine between a voice's clips (default: from the English baseline)")
    args = ap.parse_args()
    import numpy as np

    lang = args.lang
    info = vp.LANGUAGES[lang]
    for sub in ("content", "ep1"):
        if not vp.voice_archive(lang, sub).is_file():
            raise SystemExit(f"missing {vp.voice_archive(lang, sub)}")
    lists = vp.read_json(vp.HERE / "line-lists.json")
    voices = lists["voices"]
    only = set(filter(None, args.only.split(",")))
    if only:
        voices = {k: v for k, v in voices.items() if k in only}

    # The English references themselves score a wide spread between their clips (median 0.57, 5th percentile 0.2, ECAPA on 3-7 s clips of the
    # same speaker; work/en/ecapa-baseline.json), so one absolute bar would flag good voices. The bar is per voice: the lowest cosine between
    # the clips of its English reference minus 0.30, held between 0.10 (a bar that still catches a different speaker, who scores near 0) and 0.35.
    speaker, thresholds, threshold = None, {}, args.speaker_threshold
    if not args.no_speaker:
        import vp_speaker
        if vp_speaker.available():
            speaker = vp_speaker.Speaker(threads=args.threads)
            base = vp.read_json(vp.WORK / "en/ecapa-baseline.json")
            for key, row in base.items():
                if row["min"] is not None:
                    # never a stricter bar than the English reference itself meets (farida-nazeri's English clips already score 0.03 between two of them)
                    thresholds[key] = threshold if threshold is not None else float(max(0.05, min(row["min"], min(0.35, max(0.10, row["min"] - 0.30)))))
            vp.log(f"speaker check on, per-voice bars {min(thresholds.values()):.2f}..{max(thresholds.values()):.2f}")
        else:
            vp.log("ECAPA weights not found: speaker check skipped")

    vp.log(f"{lang}: indexing the dub archives")
    dub = Dub(lang)
    vp.log(f"{lang}: {len(dub.index)} voice files in the dub")
    english = English()
    subs = vp_text.Subtitles(lang)

    # first pass: extract and decode every primary line in bulk
    keys = []
    for row in voices.values():
        for line in row["lines"]:
            found, _ = dub.find(line)
            if found:
                keys.append(found)
    dub.prepare(sorted(set(keys)))

    roster = {r["key"]: r.get("gender") for r in vp.read_json(vp.ROOT / "characters/roster.json")}
    arche = vp.read_json(vp.MAIN / "runtime/voice-references/archetypes/manifest.json")["voices"]
    stage = vp.OUT / lang / "stage" / PACK_ROOT / lang
    manifest = {"version": 1, "language": lang, "languageTag": info["tag"], "gameLanguage": info["game"], "built": datetime.date.today().isoformat(),
                "source": {"game": "2.31", "lines": "the English picks' line ids"}, "voices": {}}
    reports, omitted = {}, {}
    previous = vp.WORK / lang / "build-report.json"
    if only and (stage / "manifest.json").is_file() and previous.is_file():
        # a re-run of a few voices: the rest of the finished pack stays as it is
        manifest = vp.read_json(stage / "manifest.json")
        old = vp.read_json(previous)
        reports, omitted = old["voices"], old["omitted"]
        for key in only:
            manifest["voices"].pop(key, None)
            omitted.pop(key, None)
            if (stage / "prepared" / f"{key}.json").is_file():
                (stage / "prepared" / f"{key}.json").unlink()
                (stage / "prepared" / f"{key}.ogg").unlink(missing_ok=True)
    elif stage.exists():
        import shutil
        shutil.rmtree(stage)
    for n, (key, row) in enumerate(sorted(voices.items())):
        result = build_voice(key, row, dub, subs, english, speaker, thresholds.get(key, 0.10), None)
        reports[key] = result["report"]
        if not result["ok"]:
            omitted[key] = result["report"]["notes"][-1] if result["report"]["notes"] else "unusable"
            vp.log(f"[{n + 1}/{len(voices)}] {key}: OMITTED ({omitted[key]})")
            continue
        folder = {"picked": "picked", "archetypes": "archetypes", "v-voice": "v-voice"}[row["kind"]]
        rel = f"{folder}/{key}.wav"
        path = stage / rel
        vp.write_pcm16(path, result["audio"])
        clips = result["clips"]
        entry = {"file": rel, "text": " ".join(c.text for c in clips), "seconds": result["seconds"], "lines": [c.line["hex"] for c in clips],
                 "sha256": vp.sha256_file(path)}
        g = gender_of(key, row["kind"], roster, None, arche)
        if g:
            entry["gender"] = g
        manifest["voices"][key] = entry
        if (n + 1) % 25 == 0 or result["report"]["replaced"] or result["report"]["missing"]:
            vp.log(f"[{n + 1}/{len(voices)}] {key}: {len(clips)} lines, {result['seconds']} s, replaced {len(result['report']['replaced'])}, missing {len(result['report']['missing'])}")
    vp.write_json(stage / "manifest.json", manifest)
    vp.write_json(vp.WORK / lang / "build-report.json", {"lang": lang, "built": manifest["built"], "speakerBars": thresholds, "voices": reports, "omitted": omitted,
                                                         "untraced": lists.get("untraced", [])})
    vp.log(f"{lang}: {len(manifest['voices'])} voices written, {len(omitted)} omitted -> {stage}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
