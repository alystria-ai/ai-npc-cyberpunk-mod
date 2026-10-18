"""Survey one character's voice files: per voice-file stem, the distinct lines, subtitle coverage, words, seconds; plus TweakDB
record checks.  Reads the installed archives (headers only for the seconds; nothing is decoded) and the local subtitle index.

Usage:
  python survey.py --prefix bryce_mosley [--prefix other_stem] [--record Character.q110_netwatch_agent ...] [--key bryce-mosley]
                   [--no-seconds] [--top 0]
With --key the result is written to staging/cast/<key>/survey.json as well as summarised on stdout.
A prefix matches the start of the voice-file stem (the part before _f_/_m_<hex>); give the most specific prefix you can, and
check the stems listed: a voice tag can be shared (civ_* models) or carry unrelated roles.
"""
from __future__ import annotations

import argparse
from collections import defaultdict

from cx_common import GAME, STAGING, Subtitles, load_extractor, parse_wem, prefix_paths, tweakdb_has, wem_seconds, words, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", action="append", required=True)
    parser.add_argument("--record", action="append", default=[])
    parser.add_argument("--key")
    parser.add_argument("--no-seconds", action="store_true")
    parser.add_argument("--top", type=int, default=0, help="also print the N longest lines (text) per stem")
    args = parser.parse_args()
    subs = Subtitles()
    ext = load_extractor() if not args.no_seconds else None
    archives = oodle = None
    if ext:
        oodle = ext.Oodle(GAME / "tools/redmod/bin/oo2ext_7_win64.dll")
        archives = [ext.Archive(GAME, r) for r in ext.ARCHIVES[:2]]
    stems = defaultdict(lambda: {"files": 0, "folders": defaultdict(int), "variants": defaultdict(int), "archives": defaultdict(int), "lines": {}})
    for prefix in args.prefix:
        for label, path in prefix_paths(prefix):
            folder, stem, variant, sid = parse_wem(path)
            row = stems[stem]
            row["files"] += 1
            row["folders"][folder] += 1
            row["variants"][variant] += 1
            row["archives"][label] += 1
            if folder != "vo":
                continue        # holocall, helmet and radio copies are processed deliveries; count them but do not use them
            text = subs.text(sid, variant)
            seconds = None
            if archives:
                for archive in archives:
                    got = archive.read(path, oodle)
                    if got:
                        seconds = wem_seconds(got[0])
                        break
            line = row["lines"].setdefault(sid, {"id": sid, "variants": [], "text": text, "words": words(text), "seconds": seconds, "path": path})
            line["variants"].append(variant)
    out = {"prefixes": args.prefix, "records": {name: tweakdb_has(name) for name in args.record}, "stems": {}}
    total = {"lines": 0, "seconds": 0.0, "words": 0, "lines8": 0, "lines15": 0, "withText": 0}
    for stem, row in sorted(stems.items()):
        lines = list(row["lines"].values())
        secs = [l["seconds"] for l in lines if l["seconds"]]
        summary = {"files": row["files"], "folders": dict(row["folders"]), "variants": dict(row["variants"]), "archives": dict(row["archives"]),
                   "distinctLines": len(lines), "withText": sum(1 for l in lines if l["text"]),
                   "words": sum(l["words"] for l in lines), "lines8": sum(1 for l in lines if l["words"] >= 8),
                   "lines15": sum(1 for l in lines if l["words"] >= 15), "seconds": round(sum(secs), 1),
                   "clips3to9s": sum(1 for s in secs if 3 <= s <= 9)}
        out["stems"][stem] = {**summary, "lines": sorted(lines, key=lambda l: -(l["seconds"] or 0))}
        for k in ("withText", "words", "lines8", "lines15"):
            total[k] += summary[k]
        total["lines"] += summary["distinctLines"]
        total["seconds"] += summary["seconds"]
        print(f"{stem}: {summary}")
        for l in out["stems"][stem]["lines"][:args.top]:
            print(f"   {l['seconds'] and round(l['seconds'], 2)}s {l['words']}w {l['id']} | {l['text'][:140]}")
    total["seconds"] = round(total["seconds"], 1)
    total["minutes"] = round(total["seconds"] / 60, 2)
    out["total"] = total
    print("records:", out["records"])
    print("total:", total)
    if args.key:
        write_json(STAGING / args.key / "survey.json", out)
        print("wrote", STAGING / args.key / "survey.json")


if __name__ == "__main__":
    main()
