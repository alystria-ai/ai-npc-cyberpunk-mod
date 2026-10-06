"""Write a Pocket v2 training manifest without combat or shouted delivery (a NEW file; the old corpus.json is never touched).

    python scripts/combat_flags/clean_training_corpus.py [--corpus <corpus.json>] [--flags scripts/phone_detect/combat-flags.json]
                                                         [--out <dir>] [--min-clips 20] [--min-seconds 120]

Input: the v2 corpus (scripts/pocket_training/v2_corpus.py; default E:/CyberpunkConvai-offload/work/pocket-v2/payload/corpus.json)
and the combat flags (scripts/combat_flags/build_flags.py).  The cleaned manifest keeps the same schema
(rows, roles, panels, bank, weights) so the runner can use it as is:
  * training rows (rows with no role) flagged combat are dropped;
  * the reference bank loses every set that contains a flagged clip (a reference must be conversational, like at run time);
  * speaker weights are recomputed from the surviving training clips (min(clips, SPEAKER_CAP), like v2_corpus.py);
  * panel (D/Z) roles are left alone: they are evaluation lines.  Flagged panel members are counted and listed in the receipt, and
    flagged clips are removed from each panel's centroid list (the centroid is a scoring target).
Writes corpus.no-combat.json and receipt.no-combat.json (with per-voice before/after counts and the voices left thin) next to the corpus.
"""
from __future__ import annotations

import argparse
import collections
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORPUS = Path("E:/CyberpunkConvai-offload/work/pocket-v2/payload/corpus.json")
FLAGS = ROOT / "scripts/phone_detect/combat-flags.json"
SPEAKER_CAP = 300          # same as v2_corpus.py


def canonical(clip_id: str) -> str:
    match = re.match(r"([^/]+)/(\d+)", clip_id)
    return f"{match[1]}/{match[2]}" if match else clip_id


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--corpus", type=Path, default=CORPUS)
    parser.add_argument("--flags", type=Path, default=FLAGS)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--min-clips", type=int, default=20)
    parser.add_argument("--min-seconds", type=float, default=120.0)
    args = parser.parse_args()
    out = args.out or args.corpus.parent
    corpus = json.loads(args.corpus.read_text(encoding="utf-8"))
    flags = json.loads(args.flags.read_text(encoding="utf-8"))["clips"]
    combat = lambda clip_id: bool(flags.get(canonical(clip_id), {}).get("combat"))

    roles = corpus["roles"]
    train_before = [r for r in corpus["rows"] if r["id"] not in roles]
    dropped = [r for r in train_before if combat(r["id"])]
    drop_ids = {r["id"] for r in dropped}
    rows = [r for r in corpus["rows"] if r["id"] not in drop_ids]
    train = [r for r in rows if r["id"] not in roles]

    bank, bank_lost = {}, collections.Counter()
    for voice, sets in corpus["bank"].items():
        kept = {k: [s for s in group if not any(combat(c) for c in s)] for k, group in sets.items()}
        bank_lost[voice] = sum(len(g) for g in sets.values()) - sum(len(g) for g in kept.values())
        if any(kept.values()):
            bank[voice] = kept

    by_voice_after = collections.defaultdict(list)
    for r in train:
        by_voice_after[r["voice"]].append(r)
    weights = {v: min(len(c), SPEAKER_CAP) for v, c in sorted(by_voice_after.items()) if v in bank}

    panels = json.loads(json.dumps(corpus["panels"]))
    panel_flagged = []
    for name, group in panels.items():
        for voice, entry in group.items():
            for field in ("lines", "centroid"):
                for clip_id in entry.get(field, []):
                    if combat(clip_id):
                        panel_flagged.append({"panel": name, "voice": voice, "field": field, "id": clip_id})
            for count, ids in entry.get("refs", {}).items():
                for clip_id in ids:
                    if combat(clip_id):
                        panel_flagged.append({"panel": name, "voice": voice, "field": f"refs.{count}", "id": clip_id})
            if "centroid" in entry:
                entry["centroid"] = [c for c in entry["centroid"] if not combat(c)]

    before = collections.defaultdict(lambda: [0, 0.0]); after = collections.defaultdict(lambda: [0, 0.0])
    for r in train_before:
        before[r["voice"]][0] += 1; before[r["voice"]][1] += r["dur"]
    for r in train:
        after[r["voice"]][0] += 1; after[r["voice"]][1] += r["dur"]
    per_voice = {}
    for voice in sorted(before):
        b, a = before[voice], after.get(voice, [0, 0.0])
        thin = a[0] < args.min_clips or a[1] < args.min_seconds
        per_voice[voice] = {"clips_before": b[0], "clips_after": a[0], "dropped": b[0] - a[0], "dropped_pct": round(100 * (b[0] - a[0]) / b[0], 1) if b[0] else 0.0,
                            "seconds_before": round(b[1], 1), "seconds_after": round(a[1], 1), "bank_sets_dropped": bank_lost.get(voice, 0),
                            "weight_before": corpus["weights"].get(voice), "weight_after": weights.get(voice), "thin": thin}
    cleaned = {**corpus, "schema": corpus["schema"] + "+no-combat", "rows": rows, "panels": panels, "bank": bank, "weights": weights,
               "combat_filter": {"flags": str(args.flags), "dropped_rows": len(dropped)}}
    receipt = {"schema": "pocket_v2_corpus_no_combat_v1", "source_corpus": str(args.corpus), "flags": str(args.flags),
               "train_rows_before": len(train_before), "train_rows_after": len(train), "dropped_rows": len(dropped),
               "train_hours_before": round(sum(r["dur"] for r in train_before) / 3600, 2), "train_hours_after": round(sum(r["dur"] for r in train) / 3600, 2),
               "dropped_by_source": dict(collections.Counter(r["src"] for r in dropped)),
               "bank_sets_before": sum(len(g) for s in corpus["bank"].values() for g in s.values()), "bank_sets_after": sum(len(g) for s in bank.values() for g in s.values()),
               "voices_dropped_from_bank": sorted(set(corpus["bank"]) - set(bank)), "weights_sum_before": sum(corpus["weights"].values()), "weights_sum_after": sum(weights.values()),
               "thin_thresholds": {"clips": args.min_clips, "seconds": args.min_seconds}, "thin_voices": [v for v, e in per_voice.items() if e["thin"]],
               "panel_members_flagged": panel_flagged, "per_voice": per_voice}
    out.mkdir(parents=True, exist_ok=True)
    (out / "corpus.no-combat.json").write_text(json.dumps(cleaned, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out / "receipt.no-combat.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in receipt.items() if k not in ("per_voice", "panel_members_flagged")}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
