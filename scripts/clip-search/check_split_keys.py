"""Does today's pool index give the same held-out split (so the same cache key) as the finished 2026-10-07 runs?  CPU, reads only."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
import search  # noqa: E402
from loud_survey import voices43  # noqa: E402

index = common.load_index()
print("index built", index.get("built"))
same = diff = 0
for v in voices43():
    for tag, sizes_key in (("omni16", "omni"), ("pocket-student-v2-s2000-ema-decv2", "pocket")):
        old = json.loads((common.WORK / "runs3" / tag / v / "result.json").read_text(encoding="utf-8"))
        split = search.split_for(index, v)
        if not split["ok"]:
            print(v, tag, "split not ok", split.get("reason")); diff += 1; continue
        n = search.SIZES[sizes_key]["final_lines"]
        split["final"] = split["final"][:n]
        key = search.sha1(json.dumps([split.get("holdout"), split.get("dev"), split.get("final")], sort_keys=True))[:10]
        ok = key == old.get("split_key")
        same += ok; diff += (not ok)
        if not ok:
            print(v, tag, "key", key, "old", old.get("split_key"))
print("same", same, "different", diff)
