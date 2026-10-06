"""Stage 2: phone/holocall flags for every clip from the stage-1 features (extract.py) and the dataset metadata.

    python scripts/phone_detect/flag.py [--work E:/CyberpunkConvai-offload/work/phone-detect] [--out runtime/voice-data-phone-flags.json]

A clip is `phone` when EITHER
  * `spectral`: its long-term spectrum is band-limited relative to the voice's own clips (little energy above the
    telephone band, no bass, or a hard bandwidth limit), or
  * `metadata`: the game's own delivery metadata calls it a phone/holocall/media/speaker delivery (delivery kind,
    Vo_Expression_Phone/GlobalTV, isHolocallSpeaker, a holo/screen/speaker custom VO event).
`score` (0-1) combines both; `scene` (a holocall/phone/call word in the scene file name) only adds a little to the
score, since one scene mixes in-person and phone lines.  See docs/VOICE_PHONE_CLIPS_2026-10-06.md for what the
validation showed (most metadata-phone clips are NOT band-limited in the stored audio).

Writes the flags file and prints the share tables (training dataset overall and per voice, live single references,
proposed multi-clip sets, held-out evaluation lines).  Read-only on every input except --out.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
LIKENESS = Path("E:/CyberpunkConvai-offload/work/likeness-phase1/out")
PHONE_KINDS = ("phone", "media")
EXPRESSION = ("Vo_Expression_Phone", "Vo_Expression_GlobalTV")
EVENT = re.compile(r"holo|screen|speaker|phone|radio|\btv\b|call", re.I)
SCENE = re.compile(r"holocall|holo_|phone|(^|_)calls?(_|\.|$)|braindance|(^|_)bd_|talkshow|radio|broadcast|(^|_)news(_|\.|$)", re.I)

# Thresholds (dB are relative to the voice's own median clip, so a naturally dark or bass-light voice is not flagged).
HI_DEV, HI_ABS = -12.0, -28.0        # 4-8 kHz level vs the 300-3400 Hz band
VHI_DEV, VHI_ABS = -15.0, -45.0      # 8-16 kHz
LO_DEV, LO_ABS = -15.0, -15.0        # 50-200 Hz vs 300-1000 Hz (missing bass)
FLOOR_HZ = 9000.0                    # spectrum sits on the noise floor above this frequency
CUTOFF_HZ = 9000.0                   # smoothed spectrum is 45 dB under the phone band above this frequency


def scene_name(path: str) -> str:
    return path.replace("\\", "/").split("/")[-1]


def metadata_flags(meta: dict) -> list[str]:
    reasons = []
    kinds = [meta.get("kind")] + list(meta.get("delivery_kinds") or [])
    if any(k and any(p in k for p in PHONE_KINDS) for k in kinds):
        reasons.append("delivery-kind")
    if meta.get("vo_expression") in EXPRESSION:
        reasons.append("vo-expression")
    if meta.get("holocall_speaker"):
        reasons.append("holocall-speaker")
    event = meta.get("custom_vo_event")
    if event and event != "None" and EVENT.search(event):
        reasons.append("vo-event")
    return reasons


STRONG = ("bandwidth-limit", "high-band-missing", "band-pass-shape")


def spectral_score(f: dict, med: dict) -> tuple[float, list[str]]:
    """Severity 0-1 and the reasons that fired.  A clip is `spectral` when a STRONG reason fires."""
    clip = lambda x: float(min(1.0, max(0.0, x)))
    hi_dev, vhi_dev, lo_dev = f["hi_rel"] - med["hi_rel"], f["vhi_rel"] - med["vhi_rel"], f["lo_rel"] - med["lo_rel"]
    bandwidth = max(clip((FLOOR_HZ + 3000 - f["floor_hz"]) / 6000), clip((CUTOFF_HZ + 3000 - f["cutoff_hz"]) / 6000))
    high = max(clip((-hi_dev - 4) / 8) if f["hi_rel"] <= HI_ABS + 4 else 0.0,
               clip((-vhi_dev - 7) / 8) if f["vhi_rel"] <= VHI_ABS + 5 else 0.0)
    low = clip((-lo_dev - 7) / 8) if f["lo_rel"] <= LO_ABS + 5 else 0.0
    reasons = []
    if bandwidth >= 0.5:
        reasons.append("bandwidth-limit")
    if (hi_dev <= HI_DEV and f["hi_rel"] <= HI_ABS) or (vhi_dev <= VHI_DEV and f["vhi_rel"] <= VHI_ABS):
        reasons.append("high-band-missing")
    if lo_dev <= LO_DEV and f["lo_rel"] <= LO_ABS:
        reasons.append("bass-missing")
        if hi_dev <= -6:
            reasons.append("band-pass-shape")
    return max(bandwidth, high, 0.5 * low), reasons


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, default=Path("E:/CyberpunkConvai-offload/work/phone-detect"))
    parser.add_argument("--out", type=Path, default=ROOT / "runtime/voice-data-phone-flags.json")
    args = parser.parse_args()
    feats = json.loads((args.work / "features.json").read_text(encoding="utf-8"))
    meta = json.loads((args.work / "meta.json").read_text(encoding="utf-8"))

    keys = ("hi_rel", "vhi_rel", "lo_rel")
    by_voice = defaultdict(list)
    for clip_id, m in meta.items():
        by_voice[m["speaker"]].append(clip_id)
    everything = {k: float(np.median([feats[i][k] for i in meta])) for k in keys}
    medians = {}
    for voice, ids in by_voice.items():
        medians[voice] = {k: float(np.median([feats[i][k] for i in ids])) for k in keys} if len(ids) >= 8 else everything

    clips = {}
    for clip_id, m in meta.items():
        f = feats[clip_id]
        spec, spec_reasons = spectral_score(f, medians[m["speaker"]])
        meta_reasons = metadata_flags(m)
        scene = any(SCENE.search(scene_name(s)) for s in m.get("scenes", []))
        score = 1 - (1 - spec) * (1 - 0.7 * bool(meta_reasons)) * (1 - 0.15 * scene)
        spectral = any(r in STRONG for r in spec_reasons)
        metadata = bool(meta_reasons)
        clips[clip_id] = {"phone": spectral or metadata, "score": round(score, 3), "spectral": spectral, "metadata": metadata,
                          "scene": scene, "bw_hz": f["floor_hz"], "hi_db": f["hi_rel"], "lo_db": f["lo_rel"],
                          "spec_score": round(spec, 3), "reasons": spec_reasons + meta_reasons}

    # ---- groups ----------------------------------------------------------------------------------------------
    def share(ids, label=None):
        ids = list(ids)
        n = len(ids)
        flag = lambda k: sum(1 for i in ids if clips[i][k])
        return {"clips": n, "phone": flag("phone"), "metadata": flag("metadata"), "spectral": flag("spectral"),
                "both": sum(1 for i in ids if clips[i]["spectral"] and clips[i]["metadata"]),
                "phone_share": round(flag("phone") / n, 4) if n else None,
                "metadata_share": round(flag("metadata") / n, 4) if n else None,
                "spectral_share": round(flag("spectral") / n, 4) if n else None}

    train = [i for i, m in meta.items() if m["split"] == "train"]
    per_voice = {v: share(i for i in ids if meta[i]["split"] == "train") for v, ids in sorted(by_voice.items())}
    per_voice = {v: s for v, s in per_voice.items() if s["clips"]}
    summary = {"training_dataset": {"overall": share(train), "voices": len(per_voice), "per_voice": per_voice}}

    # live single references (match the dataset by file hash; spectral flag from the file itself otherwise)
    sha_to_id = {m["sha"]: i for i, m in meta.items() if m.get("sha")}
    live = {"pocket": {}, "omni": {}}
    for engine, name in (("pocket", "pocket-voices.json"), ("omni", "local-voices.json")):
        voices = json.loads((ROOT / "runtime" / name).read_text(encoding="utf-8-sig"))["voices"]
        for voice, item in voices.items():
            if not (isinstance(item, dict) and item.get("reference")):
                continue
            path = ROOT / item["reference"]
            sha = hashlib.sha256(path.read_bytes()).hexdigest()
            f = feats.get(f"live:{name}:{voice}")
            medians_v = medians.get(voice, everything)
            spec, spec_reasons = spectral_score(f, medians_v) if f and "hi_rel" in f else (0.0, [])
            clip_id = sha_to_id.get(sha)
            via = "sha" if clip_id else None
            if not clip_id:                      # extracted/<voice>/<stringId>.wav or a cast receipt folder <stringId>-<variant>
                stem = Path(item["reference"]).stem
                receipt = Path(item.get("sourceReceipt", "")).parent.name
                for guess in (f"{voice}/{stem}", f"{voice}/{stem}/female", f"{voice}/{stem}/male"):
                    if guess in meta:
                        clip_id, via = guess, "file-name"
                        break
                if not clip_id and receipt:
                    number, _, variant = receipt.partition("-")
                    for guess in (f"{voice}/{number}/{variant}", f"{voice}/{number}"):
                        if guess in meta:
                            clip_id, via = guess, "receipt"
                            break
            if not clip_id:                      # last resort: same text in the same voice
                words = " ".join(item.get("transcript", "").lower().split())
                hits = [i for i in by_voice.get(voice, []) if " ".join((meta[i].get("text") or "").lower().split()) == words]
                if len(hits) >= 1:
                    clip_id, via = hits[0], "transcript"
            meta_reasons = metadata_flags(meta[clip_id]) if clip_id else []
            if not clip_id and isinstance(item.get("sourceDelivery"), dict):
                d = item["sourceDelivery"]
                synthetic = {"kind": d.get("kind"), "holocall_speaker": d.get("isHolocallSpeaker"), "vo_expression": d.get("voExpression"),
                             "custom_vo_event": d.get("customVoEvent")}
                meta_reasons, via = metadata_flags(synthetic), "config-sourceDelivery"
            spectral = any(r in STRONG for r in spec_reasons)
            live[engine][voice] = {"phone": spectral or bool(meta_reasons), "score": round(1 - (1 - spec) * (1 - 0.7 * bool(meta_reasons)), 3),
                                   "spectral": spectral, "metadata": bool(meta_reasons), "clip": clip_id, "matched_dataset_clip": clip_id is not None, "matched_via": via,
                                   "reference": item["reference"], "reasons": spec_reasons + meta_reasons}
    summary["live_single_references"] = {e: {"voices": len(v), "phone": sum(1 for x in v.values() if x["phone"]),
                                             "spectral": sum(1 for x in v.values() if x["spectral"]),
                                             "metadata": sum(1 for x in v.values() if x["metadata"]),
                                             "unmatched_to_dataset": sum(1 for x in v.values() if not x["matched_via"]),
                                             "phone_voices": sorted(k for k, x in v.items() if x["phone"])} for e, v in live.items()}

    # proposed multi-clip sets
    def set_stats(path, label):
        data = json.loads(Path(path).read_text(encoding="utf-8-sig"))["voices"]
        entries, bad_sets = 0, []
        clip_count = phone_count = 0
        for voice, item in data.items():
            ids = (item.get("multiref") or {}).get("clips") if isinstance(item, dict) else None
            if not ids:
                continue
            entries += 1
            flags = []
            for clip_id in ids:
                if clip_id == "runtime-reference":
                    continue
                flags.append(clips[clip_id]["phone"] if clip_id in clips else False)
            clip_count += len(flags)
            phone_count += sum(flags)
            if any(flags):
                bad_sets.append({"voice": voice, "phone_clips": [c for c in ids if c in clips and clips[c]["phone"]]})
        return {"voices": entries, "clips": clip_count, "phone_clips": phone_count,
                "clip_share": round(phone_count / clip_count, 4) if clip_count else None,
                "sets_with_phone": len(bad_sets), "set_share": round(len(bad_sets) / entries, 4) if entries else None, "detail": bad_sets}
    summary["proposed_sets"] = {}
    for label, name in (("pocket_18s", "pocket-voices.multiref.json"), ("omni_18s", "local-voices.multiref.json"), ("omni_10s", "local-voices.multiref10.json")):
        path = ROOT / "runtime" / name
        if path.is_file():
            summary["proposed_sets"][label] = set_stats(path, label)

    # evaluation lines
    panel = json.loads((LIKENESS / "panel.json").read_text(encoding="utf-8"))
    evaluation = {}
    for voice, entry in panel.items():
        for at, target in enumerate(entry["targets"]):
            if target["id"] in clips:
                evaluation[target["id"]] = {**{k: clips[target["id"]][k] for k in ("phone", "score", "spectral", "metadata")}, "voice": voice, "line": at}
    summary["evaluation_lines"] = {"lines": len(evaluation), "phone": sum(1 for v in evaluation.values() if v["phone"]),
                                   "spectral": sum(1 for v in evaluation.values() if v["spectral"]), "metadata": sum(1 for v in evaluation.values() if v["metadata"]),
                                   "voices_with_a_phone_line": sorted({v["voice"] for v in evaluation.values() if v["phone"]}),
                                   "voices_with_both_lines_phone": sorted(v for v in {x["voice"] for x in evaluation.values()}
                                                                          if all(x["phone"] for x in evaluation.values() if x["voice"] == v))}

    out = {"schema": "voice-data-phone-flags/v1",
           "detector": {"features": "scripts/phone_detect/spectral.py (long-term spectrum of speech-active frames, 48 kHz source)",
                        "spectral": {"hi_dev_db": HI_DEV, "hi_abs_db": HI_ABS, "vhi_dev_db": VHI_DEV, "vhi_abs_db": VHI_ABS, "lo_dev_db": LO_DEV, "lo_abs_db": LO_ABS,
                                     "floor_hz": FLOOR_HZ, "cutoff_hz": CUTOFF_HZ, "relative_to": "the voice's median clip"},
                        "metadata": "source_delivery.kind phone/media, Vo_Expression_Phone/GlobalTV, isHolocallSpeaker, holo/screen/speaker custom VO event",
                        "phone": "spectral OR metadata", "scene": "holocall/phone/call word in the scene file name; adds to score only"},
           "summary": summary, "clips": clips, "live_references": live, "evaluation_lines": evaluation}
    args.out.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "training_dataset"}, indent=1)[:4000])
    print(json.dumps(summary["training_dataset"]["overall"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
