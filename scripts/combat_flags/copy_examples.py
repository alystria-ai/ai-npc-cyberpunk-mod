"""Copy listening examples of flagged and unflagged clips into runtime/effect-examples/combat-check/ (plain names, nothing else).

    python scripts/combat_flags/copy_examples.py
Adam Smasher: three fixed combat lines and three of the user's conversational picks; Johnny and Panam: one combat line decided by the game's
metadata and one decided by acoustics each, plus two unflagged lines of the same length range.
"""
from __future__ import annotations

import json
import os
import random
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORK = Path("E:/CyberpunkConvai-offload/work/combat-flags")
OUT = ROOT / "runtime/effect-examples/combat-check"


def main() -> int:
    flags = json.loads((ROOT / "scripts/phone_detect/combat-flags.json").read_text(encoding="utf-8"))["clips"]
    paths = {}
    dur = {}
    for line in (WORK / "paths.jsonl").read_text(encoding="utf-8").splitlines():
        r = json.loads(line); paths[r["key"]] = r
    for line in (WORK / "acoustic-features.jsonl").read_text(encoding="utf-8").splitlines():
        r = json.loads(line); dur[r["key"]] = r["dur_s"]
    rng = random.Random(7)

    def pick(voice, flag, n, how=None, tier=None, lo=2.2, hi=6.5, text_ok=lambda t: len(t.split()) >= 3):
        found = [k for k, v in flags.items() if k.startswith(voice + "/") and v["combat"] == flag and lo <= dur[k] <= hi and "holocall" not in k
                 and (how is None or v.get("how") == how) and (tier is None or v["tier"] == tier) and text_ok(paths[k]["text"])]
        found.sort(key=lambda k: -flags[k]["score"])
        top = found[:8] if flag else found
        rng.shuffle(top)
        return top[:n]

    chosen = [(f"adam-smasher/{i}", True) for i in ("2237587921157070856", "1796622482639142916", "2237599067335401476")]
    chosen += [(f"adam-smasher/{i}", False) for i in ("1995324830177058816", "1792271201864474624", "1876335864338989056")]
    for voice in ("johnny-silverhand", "panam-palmer"):
        chosen += [(k, True) for k in pick(voice, True, 1, how="source") + pick(voice, True, 1, how="acoustic")]
        chosen += [(k, False) for k in pick(voice, False, 2, tier="conversation")]
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.wav"):
        old.unlink()
    for k, flag in chosen:
        slug = re.sub(r"[^a-z0-9]+", "-", paths[k]["text"].lower()).strip("-")[:40]
        name = f"{k.split('/')[0]}_{'COMBAT' if flag else 'normal'}_{k.split('/')[1][:8]}_{slug}.wav"
        shutil.copy2(paths[k]["audio_path"], OUT / name)
        print(name, round(dur[k], 1), flags[k].get("how"), flags[k]["tier"], "|", (flags[k]["reasons"] or [""])[0][:100])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
