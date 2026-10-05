"""Score voice candidates with the perceptual likeness score (PLS) and an ECAPA guard.

Inputs:
  --panel     JSON {voice: {"targets": [{"id","path","start","duration","transcript"}, ...]}}
              (paths absolute); every candidate speaks each target's own text
  --gen-root  folder of condition subfolders, each with records.json
              {"records": [{"speaker", "line", "file"}, ...]} and the WAVs it names
  --manifest  JSONL rows (id, path relative to --audio-root, duration, speaker/character)
              from which each voice's real comparison clips are drawn
  --exclude-ids JSON list of clip IDs that must not be comparison clips (reference
              clips, evaluation lines); panel target IDs are always excluded
  --low/--high the two calibration conditions (PLS 60 and 90)

Example (the October 5 study):
  python scripts/Evaluate-VoiceLikeness.py --panel E:/.../out/panel.json --gen-root E:/.../out/gen \
    --manifest <entry>/data/train.jsonl --audio-root <entry> --exclude-ids E:/.../exclude.json \
    --ecapa-dir E:/.../ecapa-src --low base6-2609__cfg1 --high omni__s32_g2 --out E:/.../pls.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import random
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pocket_training import likeness  # noqa: E402


def speaker_of(row: dict) -> str:
    for field in ("character", "speaker", "speaker_id", "character_id"):
        if row.get(field) is not None:
            return str(row[field])
    return "unknown"


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--panel", type=Path, required=True)
    p.add_argument("--gen-root", type=Path, required=True)
    p.add_argument("--conditions", nargs="*")
    p.add_argument("--manifest", type=Path, action="append", required=True)
    p.add_argument("--audio-root", type=Path, required=True)
    p.add_argument("--exclude-ids", type=Path)
    p.add_argument("--per-voice", type=int, default=10)
    p.add_argument("--ecapa-dir", type=Path)
    p.add_argument("--device", default="cuda")
    p.add_argument("--cache", type=Path)
    p.add_argument("--low", required=True)
    p.add_argument("--high", required=True)
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args(argv)
    import torch

    panel = json.loads(args.panel.read_text(encoding="utf-8"))
    excluded = {t["id"] for e in panel.values() for t in e["targets"]}
    if args.exclude_ids:
        excluded |= set(json.loads(args.exclude_ids.read_text(encoding="utf-8")))
    analyzer = likeness.Analyzer(args.device, args.ecapa_dir, args.cache.parent / "ecapa" if args.cache else None)
    cache = torch.load(args.cache, weights_only=False) if args.cache and args.cache.exists() else {}

    def feats(path, start=0.0, duration=None):
        key = hashlib.sha256(f"{path}|{start}|{duration}|{analyzer.ecapa is not None}".encode()).hexdigest()
        if key not in cache:
            cache[key] = analyzer.features(likeness.load_audio(path, likeness.SR, start, duration))
        return cache[key]

    pools: dict[str, list[dict]] = {}
    for manifest in args.manifest:
        for line in manifest.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                if row["id"] not in excluded and 2.0 <= float(row["duration"]) <= 9.0:
                    pools.setdefault(speaker_of(row), []).append(row)
    voices = {}
    for voice in panel:
        rows = sorted(pools.get(voice, []), key=lambda r: hashlib.sha256(r["id"].encode()).hexdigest())[: args.per_voice]
        if len(rows) >= 3:
            voices[voice] = likeness.voice_reference_stats(
                [feats(args.audio_root / r["path"], float(r.get("start", 0)), float(r["duration"])) for r in rows])
    names = args.conditions or sorted(d.name for d in args.gen_root.iterdir() if (d / "records.json").exists())
    for needed in (args.low, args.high):
        if needed not in names:
            names.append(needed)
    metrics = {}
    for name in names:
        records = json.loads((args.gen_root / name / "records.json").read_text(encoding="utf-8"))["records"]
        lines = []
        for r in records:
            target = panel[r["speaker"]]["targets"][r["line"]]
            lines.append((r["speaker"], feats(args.gen_root / name / r["file"]),
                          feats(target["path"], target["start"], target["duration"])))
        metrics[name] = likeness.condition_metrics(lines, voices)
        print(name, json.dumps({k: round(v, 3) if isinstance(v, float) else v for k, v in metrics[name].items()}), flush=True)
    scores = likeness.pls(metrics, args.low, args.high)
    for name in metrics:
        metrics[name]["PLS"] = scores[name]
    if args.cache:
        torch.save(cache, args.cache)
    args.out.write_text(json.dumps({"calibration": {"low": args.low, "high": args.high}, "comparison_voices": len(voices),
                                    "conditions": metrics}, indent=1), encoding="utf-8")
    width = max(len(n) for n in metrics)
    print(f"{'condition':{width}s}    PLS   fd_mfcc     mcd  ltas_hi  guard")
    for name, m in sorted(metrics.items(), key=lambda kv: -kv[1]["PLS"]):
        print(f"{name:{width}s} {m['PLS']:6.1f} {m['fd_mfcc'] or float('nan'):9.1f} {m['mcd']:7.1f} {m.get('ltas_hi', float('nan')):8.2f}"
              f" {m.get('guard_ecapa', float('nan')):6.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
