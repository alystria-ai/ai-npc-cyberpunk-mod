"""Build the clip universe for the combat/shouted-delivery flag: one row per key 'voice/stringId' with the audio path to use.

    vendor/reference-voicestudio/.venv/Scripts/python.exe scripts/combat_flags/acoustic_paths.py [--out DIR]

Sources (all merged by key):
  pool    E:/.../reference-picker/pool-index.json   (voices -> clips; 'p' relative to dataRoot, or absolute for expanded clips)
  corpus  E:/.../pocket-v2/payload/corpus.json      (rows; src 'fa' = dataset wav under the final entry, 'pool' = a 24 kHz flac
                                                     in pool-audio.tar whose original wav is the pool-index clip with the same id)
  dataset <final-entry-v5-001>/data/{train,dev,test,teacher_conditional,teacher_regression}.jsonl (path relative to data/..)

Key = '<voice>/<id>' with a trailing '/female' or '/male' removed (the same line exists as '.../female' in the dataset and
without it in the expanded pool).  The remainder of an id is kept verbatim ('.holocall', '.m', '-ab12', '/female/<hash>'
variants are different recordings or cuts of one string id); 'string_id' is the leading decimal so a join on the plain
string id is possible.  The chosen audio is the highest sample rate on disk (ties: the longest file, then the dataset cut
over the expanded extraction); every candidate is kept in paths.jsonl.

Writes paths.jsonl (+ paths-summary.json) into --out (default E:/CyberpunkConvai-offload/work/combat-flags).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT_DEFAULT = Path(r"E:\CyberpunkConvai-offload\work\combat-flags")
POOL_INDEX = Path(r"E:\CyberpunkConvai-offload\work\reference-picker\pool-index.json")
CORPUS = Path(r"E:\CyberpunkConvai-offload\work\pocket-v2\payload\corpus.json")
EXPANDED = Path(r"E:\CyberpunkConvai-offload\work\reference-pool-expanded")
ENTRY = ROOT / "runtime/voice-data-expansion-20261004/final-corpus-assembly/final-entries/final-entry-v5-001"
DATASET_SPLITS = ["train", "dev", "test", "teacher_conditional", "teacher_regression"]


def norm_key(raw_id: str) -> str:
    return re.sub(r"/(female|male)$", "", raw_id)


def string_id(key: str) -> str:
    m = re.match(r"[^/]+/(\d+)", key)
    return m.group(1) if m else ""


def read_jsonl(path: Path):
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def build(out: Path) -> dict:
    import soundfile as sf

    cands: dict[str, list[dict]] = defaultdict(list)       # key -> candidate audio files
    rows_src: dict[str, dict] = defaultdict(lambda: {"sources": [], "text": {}, "pool": [], "corpus": [], "dataset": []})
    pool_by_id: dict[str, dict] = {}

    index = json.loads(POOL_INDEX.read_text(encoding="utf-8"))
    data_root = Path(index["dataRoot"])
    for voice, v in index["voices"].items():
        for clip in v["clips"]:
            key = norm_key(clip["id"])
            p = Path(clip["p"])
            path = p if p.is_absolute() or ":" in clip["p"] else data_root / p
            info = rows_src[key]
            info["pool"].append({"id": clip["id"], "s": clip.get("s"), "d": clip.get("d"), "k": clip.get("k"), "fx": clip.get("fx")})
            if clip.get("t"):
                info["text"]["pool"] = clip["t"]
            cands[key].append({"src": "pool:" + str(clip.get("s")), "path": str(path)})
            pool_by_id[clip["id"]] = {"key": key, "path": str(path)}

    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))["rows"]
    for row in corpus:
        key = norm_key(row["id"])
        info = rows_src[key]
        info["corpus"].append({"id": row["id"], "src": row["src"], "dur": row.get("dur"), "path": row["path"]})
        if row.get("text"):
            info["text"]["corpus"] = row["text"]
        if row["src"] == "fa":
            cands[key].append({"src": "corpus:fa", "path": str(ENTRY / row["path"])})
        else:                                           # a 24 kHz flac in the tar; the original wav is the pool clip of the same id
            hit = pool_by_id.get(row["id"])
            if hit:
                cands[key].append({"src": "corpus:pool", "path": hit["path"]})
            else:
                fallback = EXPANDED / row["voice"] / (row["id"].split("/", 1)[1] + ".wav")
                cands[key].append({"src": "corpus:pool-fallback", "path": str(fallback)})

    for split in DATASET_SPLITS:
        for row in read_jsonl(ENTRY / "data" / f"{split}.jsonl"):
            key = norm_key(row["id"])
            info = rows_src[key]
            info["dataset"].append({"id": row["id"], "split": split, "panel": row.get("source_panel"), "duration": row.get("duration"),
                                    "audio_sha256": row.get("audio_sha256")})
            if row.get("transcript"):
                info["text"]["dataset"] = row["transcript"]
            cands[key].append({"src": f"dataset:{split}", "path": str(ENTRY / row["path"])})

    # probe every distinct path once
    paths = sorted({c["path"] for lst in cands.values() for c in lst})
    print(f"{len(cands)} keys, {len(paths)} distinct audio paths; probing", flush=True)

    def probe(path: str):
        try:
            i = sf.info(path)
            return path, {"sr": i.samplerate, "ch": i.channels, "frames": i.frames, "dur": i.frames / i.samplerate if i.samplerate else 0}
        except Exception as error:                      # missing or unreadable
            return path, {"error": f"{type(error).__name__}: {str(error)[:80]}"}

    with ThreadPoolExecutor(16) as pool:
        probed = dict(pool.map(probe, paths))

    out.mkdir(parents=True, exist_ok=True)
    stats = Counter()
    missing_keys, with_rows = [], []
    for key in sorted(cands):
        seen, options = set(), []
        for c in cands[key]:
            if c["path"] in seen:
                for o in options:
                    if o["path"] == c["path"]:
                        o["srcs"].append(c["src"])
                continue
            seen.add(c["path"])
            options.append({"path": c["path"], "srcs": [c["src"]], **probed[c["path"]]})
        ok = [o for o in options if "error" not in o]
        info = rows_src[key]
        voice = key.split("/", 1)[0]
        text = info["text"].get("dataset") or info["text"].get("corpus") or info["text"].get("pool") or ""
        row = {"key": key, "voice": voice, "string_id": string_id(key), "text": text,
               "sources": sorted({s.split(":")[0] if not s.startswith("dataset") else "dataset" for o in options for s in o["srcs"]} |
                                 ({"corpus"} if info["corpus"] else set()) | ({"pool"} if info["pool"] else set()) | ({"dataset"} if info["dataset"] else set())),
               "pool_rows": info["pool"], "corpus_rows": info["corpus"], "dataset_rows": info["dataset"], "candidates": options}
        if ok:
            def score(o):
                dataset_cut = any(x.startswith(("dataset", "corpus:fa", "pool:train", "pool:teacher")) for x in o["srcs"])
                return (o["sr"], round(o["dur"], 2), int(dataset_cut))
            chosen = max(ok, key=score)
            row.update({"audio_path": chosen["path"], "sr": chosen["sr"], "ch": chosen["ch"], "dur_file": round(chosen["dur"], 4), "audio_srcs": chosen["srcs"]})
            stats[f"sr{chosen['sr']}"] += 1
        else:
            row.update({"audio_path": None, "missing": True})
            missing_keys.append(key)
        with_rows.append(row)
    tmp = out / "paths.jsonl.part"
    with open(tmp, "w", encoding="utf-8") as handle:
        for row in with_rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    tmp.replace(out / "paths.jsonl")

    summary = {
        "keys": len(with_rows), "distinct_voices": len({r["voice"] for r in with_rows}),
        "keys_with_audio": len(with_rows) - len(missing_keys), "keys_missing_all_audio": len(missing_keys), "missing_keys": missing_keys[:200],
        "distinct_paths": len(paths), "unreadable_paths": sorted(p for p, i in probed.items() if "error" in i)[:200],
        "unreadable_path_count": sum(1 for i in probed.values() if "error" in i),
        "keys_per_source": {s: sum(1 for r in with_rows if s in r["sources"]) for s in ("pool", "corpus", "dataset")},
        "pool_rows": sum(len(r["pool_rows"]) for r in with_rows), "corpus_rows": sum(len(r["corpus_rows"]) for r in with_rows),
        "dataset_rows": sum(len(r["dataset_rows"]) for r in with_rows),
        "keys_per_dataset_split": {s: sum(1 for r in with_rows if any(d["split"] == s for d in r["dataset_rows"])) for s in DATASET_SPLITS},
        "keys_per_corpus_src": {s: sum(1 for r in with_rows if any(d["src"] == s for d in r["corpus_rows"])) for s in ("fa", "pool")},
        "keys_per_pool_source": {s: sum(1 for r in with_rows if any(d["s"] == s for d in r["pool_rows"])) for s in ("expanded", "train", "teacher_regression", "teacher_conditional")},
        "chosen_sample_rates": dict(stats),
        "keys_with_several_distinct_audio_files": sum(1 for r in with_rows if len(r["candidates"]) > 1),
        "keys_with_a_missing_candidate": sum(1 for r in with_rows if any("error" in c for c in r["candidates"])),
    }
    (out / "paths-summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    return summary


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=OUT_DEFAULT)
    args = ap.parse_args()
    print(json.dumps(build(args.out), indent=1))
