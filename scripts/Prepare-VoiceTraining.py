"""Build bounded, private character datasets from the user's installed dialogue.

SoundDB supplies scene/speaker metadata, never downloaded audio. The existing
extractor verifies local archive checksums and exact installed subtitle entries.
Whole connected scene groups stay in one split. Nothing is published or copied
into the game; original decoded WAVs remain unprocessed.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import time

import requests

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "runtime/voice-references/training"
SPEAKERS = {"judy-alvarez": "judy", "johnny-silverhand": "johnny", "panam-palmer": "panam"}
API = "https://sounddb.zhincore.eu/v1/search/subtitles"
SEED = "cyberpunk-voice-pilot-v1"


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def stable(value):
    return hashlib.sha256((SEED + value).encode()).hexdigest()


def fetch(key):
    directory = OUT / key
    directory.mkdir(parents=True, exist_ok=True)
    actor = SPEAKERS[key]
    session = requests.Session()
    session.headers.update({"User-Agent": "CyberpunkConvaiLocalVoiceResearch/1.0", "Accept": "application/json"})
    items, urls = {}, []
    for page in range(40):
        params = {"per_page": 100, "page": page, "q": f"actor:{actor} AND expression:Vo_Expression_Spoken"}
        request = requests.Request("GET", API, params=params).prepare()
        url = request.url
        cached = directory / "index" / f"page-{page:02d}.json"
        if cached.exists():
            payload = read_json(cached)
        else:
            response = session.get(url, timeout=45)
            response.raise_for_status()
            payload = response.json()
            write_json(cached, payload)
            time.sleep(0.15)
        if payload.get("syntaxErrors") or payload.get("queryErrors"):
            raise ValueError("SoundDB rejected the explicit query")
        urls.append(url)
        for item in payload["items"]:
            items[str(item["id"])] = item
        if (page + 1) * 100 >= payload["totalCount"]:
            break
    else:
        raise ValueError("Index request bound exceeded")
    candidates, rejected = [], Counter()
    text_seen = set()
    for item in items.values():
        female, scenes = item.get("female", {}), item.get("scenes", {})
        text = female.get("text", "").strip()
        duration = female.get("duration", 0)
        main = female.get("vo", {}).get("main", "")
        actors = {a.lower() for sc in scenes.values() for a in sc.get("actors", [])}
        expressions = {n.get("expression") for sc in scenes.values() for n in sc.get("nodes", {}).values()}
        normalized = re.sub(r"[^\w]+", " ", text.lower()).strip()
        words = len(normalized.split())
        reason = None
        if actors != {actor} or not scenes or not Path(main).name.startswith(actor + "_"):
            reason = "speaker_not_unambiguous"
        elif expressions - {"Vo_Expression_Spoken", None}:
            reason = "mixed_delivery"
        elif not 3 <= duration <= 12 or words < 5 or not 0.9 <= words / duration <= 4.2:
            reason = "duration_or_text_rate"
        elif any(s in main.lower() for s in ("holocall", "phone", "underwater")) or any(
                re.search(r"(?:call|holo|underwater|diving|singing|singalong|braindance)", p, re.I) for p in scenes):
            reason = "processed_or_special_scene"
        elif re.search(r"[<>\[\]{}]|^\W*$", text) or text.count("!") > 1:
            reason = "non_plain_spoken_text"
        elif normalized in text_seen:
            reason = "duplicate_transcript"
        if reason:
            rejected[reason] += 1
            continue
        text_seen.add(normalized)
        candidates.append({"key": key, "stringId": str(item["id"]), "speakerNames": [actor],
            "wemPath": main, "subtitlePaths": item["path"], "scenePaths": sorted(scenes),
            "durationFromRemoteIndexSeconds": duration, "metadataSource": urls[0],
            "indexedTranscript": text, "expressions": sorted(e for e in expressions if e)})
    write_json(directory / "eligible.json", {"key": key, "queryUrls": urls, "indexed": len(items),
        "rejected": dict(rejected), "candidates": candidates})
    print(json.dumps({"key": key, "indexed": len(items), "eligible": len(candidates), "rejected": dict(rejected)}), flush=True)


def split_and_select(candidates, limit):
    # Union scenes shared by a reused line, preventing scene leakage across splits.
    parents = {}
    def find(p):
        parents.setdefault(p, p)
        if parents[p] != p:
            parents[p] = find(parents[p])
        return parents[p]
    for row in candidates:
        first = find(row["scenePaths"][0])
        for p in row["scenePaths"][1:]:
            parents[find(p)] = first
    groups = defaultdict(list)
    for row in candidates:
        groups[find(row["scenePaths"][0])].append(row)
    if len(groups) < 8:
        raise ValueError("Insufficient distinct scene groups for an honest split")
    ordered = sorted(groups, key=stable)
    allocations, sizes = {}, Counter()
    target = min(limit, len(candidates))
    for group in ordered:
        split = "dev" if sizes["dev"] < target * .1 else "test" if sizes["test"] < target * .1 else "train"
        allocations[group] = split
        sizes[split] += len(groups[group])
    selected = []
    # Round-robin scene sampling stops one long quest dominating a character.
    for split, quota in (("train", round(target * .8)), ("dev", round(target * .1)), ("test", round(target * .1))):
        queues = [sorted(groups[g], key=lambda r: (abs(r["durationFromRemoteIndexSeconds"] - 6.5), stable(r["stringId"])))
                  for g in ordered if allocations[g] == split]
        picked = []
        while queues and len(picked) < quota:
            for queue in queues:
                if queue and len(picked) < quota:
                    picked.append(dict(queue.pop(0), split=split))
            queues = [q for q in queues if q]
        selected.extend(picked)
    return selected


def extract(key, limit):
    directory = OUT / key
    source = read_json(directory / "eligible.json")
    selected = split_and_select(source["candidates"], limit)
    selected_by_id = {r["stringId"]: r for r in selected}
    base = read_json(ROOT / "runtime/voice-references/inventory.json")
    # Inspect installed archive metadata through the existing read-only extractor.
    spec = importlib.util.spec_from_file_location("voice_extract", ROOT / "scripts/Extract-VoiceReferences.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    archives = [module.Archive(Path(base["gameRoot"]), p) for p in module.ARCHIVES[:2]]
    selected = [r for r in selected if any(module.depot_hash(r["wemPath"]) in a.entries for a in archives)]
    write_json(directory / "selection.json", {"key": key, "seed": SEED, "limit": limit, "candidates": selected})
    collected = []
    for start in range(0, len(selected), 32):
        batch = start // 32
        target = directory / f"batch-{batch:02d}"
        inventory = directory / f"inventory-{batch:02d}.json"
        write_json(inventory, {"gameRoot": base["gameRoot"], "tools": base["tools"], "queries": [],
                               "candidates": selected[start:start + 32]})
        existing = read_json(target / "manifest.json") if (target / "manifest.json").exists() else None
        expected_ids = {r["stringId"] for r in selected[start:start + 32]}
        if not existing or {r["stringId"] for r in existing["candidates"]} != expected_ids:
            log = directory / f"extract-{batch:02d}.log"
            with log.open("w", encoding="utf-8") as stream:
                subprocess.run([sys.executable, str(ROOT / "scripts/Extract-VoiceReferences.py"),
                    "--inventory", str(inventory), "--extra-candidates", str(directory / "no-extra.json"),
                    "--output", str(target)], cwd=ROOT, check=True, stdout=stream, stderr=subprocess.STDOUT,
                    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
            existing = read_json(target / "manifest.json")
        for row in existing["candidates"]:
            expected = selected_by_id[row["stringId"]]
            if row["transcript"].strip() != expected["indexedTranscript"].strip():
                raise ValueError("Local and indexed transcript disagree: " + row["stringId"])
            row["split"] = expected["split"]
            collected.append(row)
        print(json.dumps({"key": key, "extracted": len(collected), "selected": len(selected)}), flush=True)
    write_json(directory / "manifest.json", {"createdAt": datetime.now(timezone.utc).isoformat(),
        "audioProcessing": "Decoded original PCM; no filters, normalization, editing or denoising.",
        "speakerAttribution": "SoundDB scene metadata; local WEM archive SHA1 and subtitle verified",
        "candidates": collected})


def prepare(key):
    directory = OUT / key
    manifest = read_json(directory / "manifest.json")
    rows, excluded, hashes, texts = [], [], set(), set()
    for row in manifest["candidates"]:
        wav = Path(row["wavPath"])
        actual = hashlib.sha256(wav.read_bytes()).hexdigest()
        if actual != row["wav"]["sha256"] or not row["source"]["sha1Verified"]:
            raise ValueError("A source recording failed integrity verification")
        stats = row["wav"]
        text_key = re.sub(r"[^\w]+", " ", row["transcript"].lower()).strip()
        reason = None
        if stats["clippedSamples"] or not stats["nonSilent"] or stats["rmsDbfs"] < -35:
            reason = "audio_level_or_clipping"
        # Johnny's verified stereo resources commonly differ from the remote
        # index by +/-0.300 s; local WAV frame counts and ffprobe agree. The
        # index is a hint, not the authority for decoded length. Keep this
        # observed tolerance explicit rather than trimming original speech.
        elif abs(row["durationDifferenceSeconds"]) > (.35 if key == "johnny-silverhand" else .15):
            reason = "unexpected_duration"
        elif actual in hashes or text_key in texts:
            reason = "duplicate_audio_or_text"
        if reason:
            excluded.append({"id": row["stringId"], "reason": reason})
            continue
        hashes.add(actual); texts.add(text_key)
        rows.append(row)
    scenes = {split: {s for r in rows if r["split"] == split for s in r["scenePaths"]}
              for split in ("train", "dev", "test")}
    if any(scenes[a] & scenes[b] for a, b in (("train", "dev"), ("train", "test"), ("dev", "test"))):
        raise ValueError("Scene leakage between training and evaluation")
    summary = {"key": key, "splits": {}, "excluded": excluded,
        "listeningVerified": False, "notes": "Metadata and waveform gates are not a listening quality score."}
    for split in ("train", "dev", "test"):
        selected = [r for r in rows if r["split"] == split]
        if len(selected) < (60 if split == "train" else 10):
            raise ValueError(f"Too few verified {split} recordings: {len(selected)}")
        records = [{"id": r["stringId"], "audio_path": r["wavPath"], "text": r["transcript"],
                    "language_id": "en", "duration": r["wav"]["durationSeconds"],
                    "sha256": r["wav"]["sha256"], "scenes": r["scenePaths"]} for r in selected]
        (directory / f"{split}.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records), encoding="utf-8")
        summary["splits"][split] = {"clips": len(selected), "seconds": round(sum(r["wav"]["durationSeconds"] for r in selected), 3),
                                    "sceneCount": len(scenes[split])}
    write_json(directory / "dataset-report.json", summary)
    print(json.dumps(summary), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keys", default="judy-alvarez,johnny-silverhand,panam-palmer")
    parser.add_argument("--phase", choices=("index", "extract", "prepare", "all"), default="all")
    parser.add_argument("--limit", type=int, default=240)
    args = parser.parse_args()
    if not 100 <= args.limit <= 480:
        parser.error("Use a bounded 100-480 recordings per character")
    for key in args.keys.split(","):
        if key not in SPEAKERS:
            parser.error("Unsupported character")
        if args.phase in ("index", "all"): fetch(key)
        if args.phase in ("extract", "all"): extract(key, args.limit)
        if args.phase in ("prepare", "all"): prepare(key)


if __name__ == "__main__":
    main()
