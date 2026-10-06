"""Build a portable package of the clip search so Pocket voices can run on another machine (Kaggle CPU notebooks).

  python scripts/clip-search/make_portable.py --plans <plans dir> --voices a,b,c --out <package dir>

Needs the plans written by `search.py --make-plans` (they fix each voice's held-out split and prescreen, so the remote run scores
against exactly the same targets and dev/final lines and produces the same score-cache key).  The package holds only what those
voices need:
  data/pool-index.json   trimmed pool index; clip paths relative to data/audio (set CLIP_SEARCH_DATA_ROOT=<package>/data/audio)
  data/audio/<voice>/    the screened clips, the holdout clips, the two page lines
  data/plans/<voice>.json
  repo/                  scripts/clip-search/*.py (no tests), scripts/pocket_training/likeness.py, shown-voices.json,
                         vendor/pocket-tts-training/source (pocket_tts), runtime/voice-references/portable/<voice>/<engine>.wav
  assets/ecapa-src       the ECAPA model of the likeness study; assets/pls-tool.json the PLS anchors
  assets/pocket-export   the Pocket student export (model.safetensors, inference.yaml, tokenizer.json)
Run remotely (all paths in the package, CPU only):
  CLIP_SEARCH_ROOT=<pkg>/repo CLIP_SEARCH_WORK=<scratch>/work CLIP_SEARCH_INDEX=<pkg>/data/pool-index.json
  CLIP_SEARCH_DATA_ROOT=<pkg>/data/audio CLIP_SEARCH_ECAPA_DIR=<pkg>/assets/ecapa-src CLIP_SEARCH_PLS_ANCHORS=<pkg>/assets/pls-tool.json
  python <pkg>/repo/scripts/clip-search/search.py --engine pocket --voices <list> --plan-dir <pkg>/data/plans
      --export <pkg>/assets/pocket-export --scorer-device cpu --workers <n> --threads <t> --out <scratch>/runs3
Results are <out>/<tag>/<voice>/result.json and scores-<key>.json, the same layout as the local run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

ROOT = common.ROOT
EXPORT = Path(r"E:\CyberpunkConvai-offload\work\pocket-v2\exports\student-v2-s2000-ema-decv2")


def digest(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--plans", type=Path, required=True)
    parser.add_argument("--voices", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--export", type=Path, default=EXPORT)
    parser.add_argument("--no-export", action="store_true", help="skip copying the 418 MB student export")
    args = parser.parse_args(argv)
    voices = args.voices.split(",")
    index = common.load_index()
    out = args.out
    audio, plans = out / "data/audio", out / "data/plans"
    for folder in (audio, plans):
        folder.mkdir(parents=True, exist_ok=True)
    trimmed = {"version": index.get("version", 1), "dataRoot": "__set CLIP_SEARCH_DATA_ROOT__", "voices": {}}
    for voice in voices:
        plan = json.loads((args.plans / f"{voice}.json").read_text(encoding="utf-8"))
        source = index["voices"][voice]
        by_id = {c["id"]: c for c in source["clips"]}
        pool = common.VoicePool(index, voice)
        (audio / voice).mkdir(exist_ok=True)
        clips = []
        for cid in plan["files"]:
            clip = dict(by_id[cid])
            name = f"{voice}/{digest(cid)}.wav"
            dest = audio / name
            if not dest.is_file():
                shutil.copy2(pool.clip(cid)["path"], dest)
            clip["p"] = name
            clips.append(clip)
        lines = []
        for line, path in zip([l for l in source["lines"] if l.get("exists")], plan["lines"]):
            name = f"{voice}/line-{digest(line['id'])}.wav"
            if not (audio / name).is_file():
                shutil.copy2(path, audio / name)
            lines.append({**line, "path": name, "exists": True})
        live = {}
        for engine, entry in source["live"].items():
            if not entry.get("exists"):
                continue
            rel = f"runtime/voice-references/portable/{voice}/{engine}.wav"
            dest = out / "repo" / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            if not dest.is_file():
                shutil.copy2(ROOT / entry["reference"], dest)
            live[engine] = {**entry, "reference": rel}
        trimmed["voices"][voice] = {"clips": clips, "loudMedian": source.get("loudMedian"), "lines": lines, "live": live,
                                    "proposed": {}, "embedded": 0, "typicalityRanked": False}
        (plans / f"{voice}.json").write_text(json.dumps({k: v for k, v in plan.items() if k not in ("files", "lines", "live")}, indent=1),
                                             encoding="utf-8")
        print(f"{voice}: {len(clips)} clips, {len(lines)} lines", flush=True)
    (out / "data/pool-index.json").write_text(json.dumps(trimmed, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    # code
    repo = out / "repo"
    code = repo / "scripts/clip-search"
    code.mkdir(parents=True, exist_ok=True)
    for file in (ROOT / "scripts/clip-search").glob("*.py"):
        if not file.name.startswith("test_"):
            shutil.copy2(file, code / file.name)
    (repo / "scripts/pocket_training").mkdir(parents=True, exist_ok=True)
    for name in ("__init__.py", "likeness.py"):
        if (ROOT / "scripts/pocket_training" / name).is_file():
            shutil.copy2(ROOT / "scripts/pocket_training" / name, repo / "scripts/pocket_training" / name)
    (repo / "scripts/reference-picker").mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "scripts/reference-picker/shown-voices.json", repo / "scripts/reference-picker/shown-voices.json")
    source_dir = repo / "vendor/pocket-tts-training/source"
    if not source_dir.exists():
        shutil.copytree(ROOT / "vendor/pocket-tts-training/source", source_dir, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    # assets
    assets = out / "assets"
    assets.mkdir(exist_ok=True)
    if not (assets / "ecapa-src").exists():
        shutil.copytree(common.LIKENESS / "ecapa-src", assets / "ecapa-src")
    shutil.copy2(common.LIKENESS / "out/pls-tool.json", assets / "pls-tool.json")
    if not args.no_export:
        target = assets / "pocket-export"
        target.mkdir(exist_ok=True)
        for name in ("model.safetensors", "inference.yaml", "tokenizer.json"):
            if not (target / name).is_file():
                shutil.copy2(args.export / name, target / name)
    total = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    print(f"package {out}: {total / 1e6:.0f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
