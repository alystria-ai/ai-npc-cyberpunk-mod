"""Extract one character's attributed lines from the installed archives and decode them (file output only, nothing is played).

Reads staging/cast/<key>/voice-spec.json and attribution.json (attribute.py) and survey.json (survey.py).  Only the lines the
spec accepts are taken: "accept" lists {scene, actorName} pairs from attribution.json (the scene-level identity decision), or,
for the rare voice that no scene export covers, "acceptIds" with a written reason.  Candidates are the accepted 'vo' lines of
1.5 to 9.5 s with at least three words, longest first, at most --max (default 60).

Writes WORK/<key>/raw/<StringID>.{wem,wav,txt} and WORK/<key>/manifest.json.

Usage: python extract.py --key bryce-mosley [--max 60]
"""
from __future__ import annotations

import argparse

from cx_common import GAME, STAGING, decode, load_extractor, load_spec, read_json, work_dir, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--key", required=True)
    parser.add_argument("--max", type=int, default=60)
    args = parser.parse_args()
    spec = load_spec(args.key)
    survey = read_json(STAGING / args.key / "survey.json")
    accepted = {}
    if spec.get("accept"):
        attribution = read_json(STAGING / args.key / "attribution.json")
        for scene in attribution["scenes"]:
            for speaker in scene["speakers"]:
                for rule in spec["accept"]:
                    if scene["scene"].lower() == rule["scene"].lower() and speaker["actorName"] == rule["actorName"]:
                        for sid in speaker["ids"]:
                            accepted[sid] = scene["scene"]
    for sid in spec.get("acceptIds", []):
        accepted.setdefault(sid, "acceptIds")
    excluded = set(spec.get("exclude", []))
    lines = {}
    for stem in survey["stems"].values():
        for line in stem["lines"]:
            if line["id"] in accepted and line["id"] not in excluded:
                lines[line["id"]] = line
    candidates = [l for l in lines.values() if l["seconds"] and 1.5 <= l["seconds"] <= 9.5 and l["words"] >= 3]
    candidates.sort(key=lambda l: -l["seconds"])
    candidates = candidates[:args.max]
    print(f"{len(accepted)} accepted ids, {len(lines)} in survey, {len(candidates)} candidates")
    ext = load_extractor()
    oodle = ext.Oodle(GAME / "tools/redmod/bin/oo2ext_7_win64.dll")
    archives = [ext.Archive(GAME, r) for r in ext.ARCHIVES[:2]]
    out = work_dir(args.key) / "raw"
    out.mkdir(parents=True, exist_ok=True)
    manifest = []
    for line in candidates:
        variant = "f" if "f" in line["variants"] else "m"
        path = line["path"] if f"_{variant}_" in line["path"] else line["path"].replace("_f_", f"_{variant}_")
        matches = [m for a in archives if (m := a.read(path, oodle))]
        assert len(matches) == 1, (path, len(matches))
        data, source = matches[0]
        assert data[:4] == b"RIFF"
        sid = line["id"]
        wem, wav = out / f"{sid}.wem", out / f"{sid}.wav"
        wem.write_bytes(data)
        decode(wem, wav)
        (out / f"{sid}.txt").write_text(line["text"] + "\n", encoding="utf-8")
        quality = ext.wav_quality(wav)
        manifest.append({"key": args.key, "stringId": sid, "wemPath": path, "transcript": line["text"], "scene": accepted[sid],
                         "source": source, "wav": quality, "wavPath": str(wav).replace("\\", "/")})
        print(f"{sid} {quality['durationSeconds']:.2f}s ch{quality['channels']} {quality['sampleRate']} clip{quality['clippedSamples']} | {line['text'][:90]}")
    write_json(work_dir(args.key) / "manifest.json", manifest)
    print("wrote", len(manifest), "clips to", out)


if __name__ == "__main__":
    main()
