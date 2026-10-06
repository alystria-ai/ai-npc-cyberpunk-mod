"""Collect Adam Smasher's hand-picked-pool results into: the picker data (runtime/autobest-sets.json), the picks to record,
and the override file for the Pocket v2 listening page.  Run after adam.py for omni (16 steps), omni (32 verify) and pocket.

  python scripts/clip-search/adam_finish.py            # writes E:/.../clip-search/adam/final.json and page-override.json
  python scripts/clip-search/adam_finish.py --patch    # also writes the Adam entries of runtime/autobest-sets.json

Page columns: 1 clip = the best single, 2 clips (10 s) = the best <= 10 s pair, 3 clips (18 s) = the best set within 18 s (any number
of clips; the note under Adam's table says how many each engine used).  Scores are ECAPA between each render and the original recording of the same line (mean over both lines and five
seeds) and PLS (secondary, from the same renders against the voice's other real clips).  The page shows the seed-1042 render.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from adam import SEEDS, VOICE, POOL_IDS, mean  # noqa: E402

ADAM = common.WORK / "adam"
ENGINES = {  # tag -> (engine, page conditions for 1 / 2 / 3 clips)
    "omni16": ("omni", ["omni__s16_g2", "omni__s16_g2_multiC", "omni__s16_g2_multiB"]),
    "omni32": ("omni", ["omni__s32_g2", "omni__s32_g2_multiC", "omni__s32_g2_multiB"]),
    "pocket-student-v2-s2000-ema-decv2": ("pocket", ["ft6-v2__decv2", "ft6-v2__decv2_multiC", "ft6-v2__decv2_multiB"]),
}


def render(tag, ids, line, seed):
    key = f"{'|'.join(ids)}#{line}#{seed}"
    return ADAM / tag / "r" / f"{hashlib.sha1(key.encode()).hexdigest()[:16]}.wav"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--patch", action="store_true")
    args = parser.parse_args(argv)
    from score import Scorer, pls_from_components
    scorer = Scorer("cuda")
    index = common.load_index()
    pool = common.VoicePool(index, VOICE)
    lines = [l for l in index["voices"][VOICE]["lines"] if l["exists"]]
    chosen = {f"{VOICE}/{i}" for i in POOL_IDS}
    others = sorted((c for c in pool.clips if c.id not in chosen and not c.get("fx") and c.d >= 1.5), key=lambda c: common.stable(c.id))[:10]
    from pocket_training import likeness
    voice_stats = likeness.voice_reference_stats([scorer.features(c["path"]) for c in others])

    def pls(tag, ids):
        pairs = [(str(render(tag, ids, li, s)), lines[li]["path"]) for li in range(len(lines)) for s in SEEDS if render(tag, ids, li, s).is_file()]
        if not pairs:
            return None, None
        comps = scorer.pls_components(VOICE, pairs, voice_stats)
        return round(pls_from_components(comps), 1), {k: round(v, 3) for k, v in comps.items() if isinstance(v, float)}

    final = {"lines": [l["t"] for l in lines], "engines": {}}
    override = {VOICE: {"conditions": {}}}
    notes = []
    for tag, (engine, conds) in ENGINES.items():
        folder = ADAM / tag
        if tag == "omni32":
            base = json.loads((ADAM / "omni16" / "result.json").read_text(encoding="utf-8"))
            verify = json.loads((folder / "verify.json").read_text(encoding="utf-8"))["verify"]
            by_ids = {tuple(r["ids"]): r for r in verify}
            picks = {k: v for k, v in base["picks"].items() if v}
            rows = {name: by_ids.get(tuple(p["ids"])) for name, p in picks.items()}
            today = None
        else:
            result = json.loads((folder / "result.json").read_text(encoding="utf-8"))
            picks = {k: v for k, v in result["picks"].items() if v}
            rows = picks
            today = result["today"]
        entry = {"picks": {}, "today": today, "previous_autobest": None if tag == "omni32" else result.get("previous_autobest")}
        for name, row in rows.items():
            if row is None:
                continue
            ids = tuple(row["ids"])
            p, parts = pls(tag, ids)
            entry["picks"][name] = {**row, "pls": p, "pls_parts": parts}
        for label in ("today", "previous_autobest"):
            if entry[label]:
                p, parts = pls(tag, tuple(entry[label]["ids"]))
                entry[label] = {**entry[label], "pls": p}
        final["engines"][tag] = entry
        for slot, (name, cond) in enumerate(zip(("single", "short", "best"), conds)):
            row = entry["picks"].get(name)
            if not row:
                continue
            files = [str(render(tag, tuple(row["ids"]), li, SEEDS[0])) for li in range(len(lines))]
            override[VOICE]["conditions"][cond] = {"files": files, "ecapa": row["per_line"], "set": row["ids"], "seconds": row["seconds"],
                                                  "ecapa_mean": row["ecapa"], "pls": row["pls"]}
    (ADAM / "final.json").write_text(json.dumps(final, indent=1), encoding="utf-8")
    # the note under Adam's table
    items = []
    names = {"omni__s16_g2": "OmniVoice 16", "omni__s32_g2": "OmniVoice 32", "ft6-v2__decv2": "New Pocket student + decoder v2"}
    for cond, entry in override[VOICE]["conditions"].items():
        pass
    def short(ids):
        return " + ".join(i.split("/")[-1] for i in ids)
    parts = []
    for tag, label in (("pocket-student-v2-s2000-ema-decv2", "New Pocket student + decoder v2"), ("omni16", "OmniVoice (ECAPA at 16 steps; 32 steps within 0.01)")):
        entry = final["engines"][tag]["picks"]
        for name, size in (("single", "1 clip"), ("short", "2 clips (10 s)"), ("best", "up to 18 s")):
            row = entry.get(name)
            if row:
                parts.append(f"{label}, {size}: {len(row['ids'])} clip(s) {short(row['ids'])} ({row['seconds']:.1f} s; ECAPA to the original lines {row['ecapa']:.3f}, PLS {row['pls']})")
    override[VOICE]["note"] = ("<b>Adam Smasher: these columns use clips the user chose by ear</b> (a pool of 11 game clips), and the sets were searched "
                               "on these two lines themselves (overfitting on purpose). The small number under each player here is ECAPA to the "
                               "original recording of the line, not to the voice centroid, and is not comparable with the other characters'. "
                               "Pocket base columns still use the previous references. The header averages above were not recomputed. "
                               "Sets (clip ids): " + "; ".join(parts) + ".")
    (ADAM / "page-override.json").write_text(json.dumps(override, indent=1), encoding="utf-8")
    print(json.dumps({t: {n: (r["k"], r["seconds"], r["ecapa"], r["pls"]) for n, r in e["picks"].items()} for t, e in final["engines"].items()}))
    if args.patch:
        path = common.ROOT / "runtime" / "autobest-sets.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        row = data["voices"][VOICE]
        for tag, engine in (("pocket-student-v2-s2000-ema-decv2", "pocket"), ("omni16", "omni")):
            entry = final["engines"][tag]
            old = row[engine]
            fields = ("ids", "k", "seconds", "ecapa", "ecapa_se", "pls")
            new = {}
            for name in ("best", "short", "single", "best3"):
                src = entry["picks"].get(name)
                new[name] = {k: src[k] for k in fields if k in src} | {"scored_on": "the voice's two page lines (user-chosen pool)"}
            new["today"] = {k: entry["today"][k] for k in ("ids", "k", "seconds", "ecapa", "ecapa_se", "pls") if entry["today"] and k in entry["today"]}
            new["previous_autobest"] = old.get("best")
            new["user_chosen_pool"] = [f"{VOICE}/{i}" for i in POOL_IDS]
            new["significance"] = {"call": "user-chosen pool, scored on the page lines (overfit on purpose)"}
            row[engine] = new
        path.write_text(json.dumps(data, indent=1), encoding="utf-8")
        (common.WORK / "results" / "autobest-sets.json").write_text(json.dumps(data, indent=1), encoding="utf-8")
        print("patched runtime/autobest-sets.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
