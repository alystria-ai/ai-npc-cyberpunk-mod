"""Trace which English game lines make up every shipped English OmniVoice long reference, and prove the join recipe.

Reads (all read-only):
  * the shipped Runtime's app/defaults/local-voices.autobest-long.json   (pick.clips = the line ids of every voice's reference)
  * the shipped Runtime's voices/picked/autobest/omni-long, voices/archetypes/omni-long, voices/v-voice   (the WAVs)
  * assets/v-voice/v-voice.json                                        (V's two voices: string ids + wem stems)
  * the English voice archives in the stash

Writes scripts/voice-packs/line-lists.json (line ids and file stems only: no dialogue, no audio) and a proof report.

    python -I scripts/voice-packs/trace_english.py [--only key,key] [--report PATH]
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vp_common as vp  # noqa: E402

CONFIG = vp.RUNTIME / "app/defaults/local-voices.autobest-long.json"
PICKED_DIR = vp.RUNTIME / "voices/picked/autobest/omni-long"
ARCHETYPE_DIR = vp.RUNTIME / "voices/archetypes/omni-long"
V_DIR = vp.RUNTIME / "voices/v-voice"
V_JSON = vp.ROOT / "assets/v-voice/v-voice.json"
LISTS = vp.HERE / "line-lists.json"
ID_RE = re.compile(r"^(\d+)(?:/(female|male))?(?:/([0-9a-f]{16}))?((?:\.[A-Za-z0-9]+)*)$")


def parse_id(clip_id: str) -> dict | None:
    """'<voice>/<string id>[/female|/male][/<hash>][.m][.holocall]' -> the parts (None for the non-numeric ids of a few cut clips)."""
    voice, _, rest = clip_id.partition("/")
    m = ID_RE.match(rest)
    if not m:
        return None
    suffix = [s for s in m[4].split(".") if s]
    fm = "m" if (m[2] == "male" or "m" in suffix) else ("f" if m[2] == "female" else None)
    vo = "vo"
    for token in suffix:
        if token in ("holocall", "helmet", "rewinded"):
            vo = "vo_" + token
    return {"voice": voice, "hex": vp.hex_of(m[1]), "sid": m[1], "fm": fm, "vo": vo, "hash": m[3], "explicitFm": m[2] is not None or "m" in suffix}


def candidates_for(index: dict, ref: dict) -> list[tuple]:
    by_hex = {}
    for key in index:
        if key[4] == ref["hex"]:
            by_hex.setdefault(key[4], []).append(key)
    return candidates_for_hex(by_hex, ref)


def candidates_for_hex(by_hex: dict, ref: dict) -> list[tuple]:
    keys = by_hex.get(ref["hex"], [])
    exact = [key for key in keys if key[1] == ref["vo"] and (ref["fm"] is None or key[3] == ref["fm"])]
    if ref["fm"] is None:                       # no gender in the id: the female (V) variant is the default name, a male one only exists beside it
        exact_f = [key for key in exact if key[3] == "f"]
        exact = exact_f or exact
    return exact or [key for key in keys if key[1] == ref["vo"]] or keys


def segment_error(clip, shipped, offset: int, gain: float = 1.0):
    import numpy as np
    n = len(clip)
    if offset + n > len(shipped) + 2:
        return None
    seg = shipped[offset:offset + n].astype(np.float64) / 32768.0 / gain
    clip = clip[:len(seg)]
    return float(np.sqrt(np.mean((seg - clip[:len(seg)]) ** 2))) if len(seg) == n else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", default="")
    ap.add_argument("--report", default=str(vp.OUT / "work/en/mapping-proof.json"))
    args = ap.parse_args()
    import numpy as np

    config = vp.read_json(CONFIG)["voices"]
    only = set(filter(None, args.only.split(",")))
    index = vp.wem_index("en")
    vp.log(f"English voice files: {len(index)}")
    wem_dir = vp.WORK / "en/wem"

    jobs = {}        # voice key -> {"kind", "wav", "refs": [parsed], "cands": [[keys]]}
    untraced = []
    for key, entry in config.items():
        if only and key not in only:
            continue
        kind = "archetypes" if "/archetypes/" in entry["reference"] else "picked"
        refs = [parse_id(c) for c in entry["pick"]["clips"]]
        if any(r is None for r in refs):
            untraced.append({"voice": key, "why": "clip ids that are not game string ids: " + ", ".join(c for c, r in zip(entry["pick"]["clips"], refs) if r is None)})
            continue
        cands = [candidates_for(index, r) for r in refs]
        if any(not c for c in cands):
            untraced.append({"voice": key, "why": "no English voice file for line(s) " + ", ".join(r["sid"] for r, c in zip(refs, cands) if not c)})
            continue
        wav = (ARCHETYPE_DIR if kind == "archetypes" else PICKED_DIR) / Path(entry["reference"]).name     # viktor-vektor's file is viktor-vektor-2.wav
        pick = entry["pick"]
        stage = pick.get("gain") is not None or "gain match" in (pick.get("note") or "")
        jobs[key] = {"kind": kind, "wav": wav, "refs": refs, "cands": cands, "ids": pick["clips"], "transcript": entry["transcript"],
                     "gainDb": (pick.get("gain") or {}).get("db", 0.0), "gainStage": stage, "gainEstimated": stage and pick.get("gain") is None}

    # V's voices come with their own line list
    v_manifest = vp.read_json(V_JSON)["voices"]
    for gender in ("male", "female"):
        row = v_manifest[gender]
        refs, cands = [], []
        for clip in row["clips"]:
            m = vp.WEM_RE.match("base\\localization\\en-us\\vo\\" + clip["stem"])
            ref = {"voice": f"v-{gender}", "hex": m["hex"], "sid": clip["stringId"], "fm": m["fm"], "vo": "vo", "hash": None, "explicitFm": True}
            refs.append(ref)
            cands.append([k for k in index if k[4] == m["hex"] and k[3] == m["fm"] and k[1] == "vo"])
        jobs[f"v-{gender}"] = {"kind": "v-voice", "wav": V_DIR / f"v-{gender}.wav", "refs": refs, "cands": cands,
                               "ids": [c["stringId"] for c in row["clips"]], "transcript": row["transcript"], "gainDb": 0.0, "gainStage": False, "gainEstimated": False}
    if only:
        jobs = {k: v for k, v in jobs.items() if k in only}

    # extract every candidate wem (English stash, only those files), decode them
    need = {}
    for job in jobs.values():
        for cs in job["cands"]:
            for key in cs:
                need.setdefault(key[0], set()).add(index[key])
    for sub, paths in need.items():
        vp.unbundle("en", sub, sorted(paths), wem_dir)
    vp.log(f"{sum(len(p) for p in need.values())} candidate wem files extracted")
    decoded = {}

    def clip_audio(key, method):
        if (key, method) not in decoded:
            path = index[key]
            wav = vp.WORK / "en/wav" / (path.replace("\\", "/") + ".wav")
            if not wav.is_file() and not vp.decode_wem(wem_dir / path.replace("\\", "/"), wav):
                decoded[(key, method)] = None
                return None
            decoded[(key, method)] = vp.load_v(wav) if method == "v" else vp.load_mono(wav, method=method)
        return decoded[(key, method)]

    report = {"voices": {}, "untraced": untraced}
    lists = {}
    for key, job in sorted(jobs.items()):
        shipped, rate = vp.read_pcm16(job["wav"])
        assert rate == vp.RATE, (key, rate)
        offset, chosen, notes, ok = 0, [], [], True
        gap = round(vp.GAP_SECONDS * vp.RATE)
        if job["gainEstimated"]:      # no recorded gain: fit it to the first clip (least squares); the later clips then have to line up with it
            a0 = clip_audio(job["cands"][0][0], "sinc")
            s0 = shipped[:len(a0)].astype(np.float64) / 32768.0
            job["gainDb"] = round(20 * float(np.log10(float(np.dot(a0, s0) / np.dot(a0, a0)))), 2)
            notes.append(f"no recorded gain; fitted {job['gainDb']} dB")
        for ref, cs in zip(job["refs"], job["cands"]):
            best = None
            for ck in cs:
              for method in (("v",) if job["kind"] == "v-voice" else ("sinc", "poly")):
                audio = clip_audio(ck, method)
                if audio is None:
                    continue
                err = segment_error(audio, shipped, offset, 10 ** (job["gainDb"] / 20))
                if err is not None and (best is None or err < best[0]):
                    best = (err, ck, audio, method)
            if best is not None and best[0] > 0.002:       # a wrong file (or a trimmed/processed variant) never lines up to within ~65 LSB rms
                notes.append(f"line {ref['sid']}: best candidate {best[1][2]}_{best[1][3]} still differs by rms {best[0]:.4f}")
                best = None
            if best is None:
                ok = False
                notes.append(f"line {ref['sid']}: no candidate fits the shipped WAV at offset {offset}; candidates {[(c[2], c[3], len(clip_audio(c, 'sinc'))) for c in cs]}")
                break
            chosen.append(best)
            if len(cs) > 1:
                notes.append(f"line {ref['sid']}: {len(cs)} candidate files, matched {best[1][2]}_{best[1][3]}")
            offset += len(best[2]) + gap
        if not ok:
            report["voices"][key] = {"ok": False, "notes": notes}
            continue
        rebuilt = vp.join_clips([c[2] for c in chosen])
        pcm = np.clip(np.rint(np.clip(rebuilt.astype(np.float64) * 10 ** (job["gainDb"] / 20), -1, 1) * 32767.0), -32768, 32767).astype(np.int16)
        recomputed = vp.gain_match(rebuilt)[1]["gainDb"] if job["gainStage"] else None
        same_length = len(pcm) == len(shipped)
        n = min(len(pcm), len(shipped))
        diff = pcm[:n].astype(np.int32) - shipped[:n].astype(np.int32)
        sig = float(np.sqrt(np.mean(shipped[:n].astype(np.float64) ** 2))) or 1.0
        rms = float(np.sqrt(np.mean(diff.astype(np.float64) ** 2)))
        report["voices"][key] = {"ok": True, "sameLength": same_length, "samples": [len(pcm), len(shipped)], "maxAbsDiff": int(np.abs(diff).max()),
                                 "snrDb": round(20 * float(np.log10(sig / max(rms, 1e-9))), 1), "identical": bool(same_length and not diff.any()), "notes": notes,
                                 "segmentErrorsRms": [round(c[0], 5) for c in chosen], "resampler": [c[3] for c in chosen], "gainDb": job["gainDb"],
                                 "gainStage": job["gainStage"], "gainRecomputedDb": recomputed}
        lists[key] = {"kind": job["kind"], "ids": job["ids"], "englishGainDb": job["gainDb"], "gainStage": job["gainStage"],
                      "lines": [{"hex": ck[4], "fm": ck[3], "vo": ck[1], "stem": ck[2], "rest": ck[5], "archive": ck[0]} for _, ck, _, _ in chosen]}
    vp.write_json(args.report, report)
    if not only:
        vp.write_json(LISTS, {"version": 1, "source": "shipped Runtime 0.2.7 local-voices.autobest-long.json + assets/v-voice/v-voice.json",
                              "voices": lists, "untraced": untraced})
    bad = {k: v for k, v in report["voices"].items() if not v["ok"] or v["snrDb"] < 40}
    ident = sum(1 for v in report["voices"].values() if v.get("identical"))
    vp.log(f"traced {len(lists)} voices; byte-identical {ident}; poor/failed {len(bad)}; untraced {len(untraced)}")
    for k, v in list(bad.items())[:40]:
        vp.log(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
