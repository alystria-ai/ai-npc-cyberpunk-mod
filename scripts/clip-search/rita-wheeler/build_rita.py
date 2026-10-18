"""Build Rita Wheeler's reference WAVs (the clip-search recipe: whole clips, 0.4 s gaps, mono 24 kHz, 16-bit PCM; no EQ, denoise or gain)
from her nine extracted Corpo-Rat door lines, and write her entries into the three live autobest voice configs. Lucy Kushinada has no
game voice, so she gets {"status": "unprepared"} (the same entry every profile without a clip has).

Selection (objective, no ECAPA because the weights are not on disk): clips of 1.5-9 s with at least three words whose gated loudness
is within 2 dB of the set's median and whose peak is at most -3 dBFS. The four louder lines (gated -17 to -19.5 dB, peaks to -1.9 dBFS)
are shouted or snapped and stay out of the references; "Good to hear." (1.33 s) joins the long set only, because the set would otherwise
be under 12 s.

Usage: python build_rita.py <backup_dir> [--dry-run]
"""
import hashlib, json, sys
from datetime import datetime, timezone
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod")
sys.path.insert(0, str(ROOT / "scripts/clip-search"))
from common import build_reference, joined_seconds, words
EXTRACT = ROOT / "runtime/voice-references/extracted"
an = json.loads((EXTRACT / "rita-wheeler-analysis.json").read_text("utf-8"))["rita-wheeler"]["clips"]
man = {r["stringId"]: r for r in json.loads((EXTRACT / "rita-wheeler-extract-manifest.json").read_text("utf-8"))}
order = list(man)  # scene order of the nine lines
by_id = {c["id"]: c for c in an}
med = sorted(c["gatedRmsDb"] for c in an)[len(an) // 2]
quiet = [i for i in order if abs(by_id[i]["gatedRmsDb"] - med) <= 2.0 and by_id[i]["peakDbfs"] <= -3.0 and by_id[i]["clipped"] == 0]
short = [i for i in quiet if 1.5 <= by_id[i]["seconds"] <= 9 and words(by_id[i]["text"]) >= 3]
long_ = quiet  # adds the 1.33 s line
sets = {"omni-short": short, "omni-long": long_, "pocket": long_}
print("median gated", med, "quiet", [(i[-6:], by_id[i]["text"]) for i in quiet])
for kind, ids in sets.items():
    print(kind, [by_id[i]["text"] for i in ids], round(joined_seconds(by_id[i]["seconds"] for i in ids), 2), "s")
assert 7.0 <= joined_seconds(by_id[i]["seconds"] for i in short) <= 10.0
assert joined_seconds(by_id[i]["seconds"] for i in long_) <= 18.0
if "--dry-run" in sys.argv:
    raise SystemExit
backup = Path(sys.argv[1]); backup.mkdir(parents=True, exist_ok=True)
out_root = ROOT / "runtime/voice-references/picked/autobest"
entries = {}
for kind, ids in sets.items():
    wav = out_root / kind / "rita-wheeler.wav"
    seconds = build_reference([man[i]["wavPath"] for i in ids], wav)
    transcript = " ".join(by_id[i]["text"].strip() for i in ids)
    entries[kind] = {"reference": f"runtime/voice-references/picked/autobest/{kind}/rita-wheeler.wav", "sha256": hashlib.sha256(wav.read_bytes()).hexdigest(),
        "transcript": transcript, "transcriptSha256": hashlib.sha256(transcript.encode("utf-8")).hexdigest(), "status": "ready",
        "pick": {"clips": [f"rita-wheeler/{i}" for i in ids], "seconds": round(seconds, 2), "keptAt": datetime.now(timezone.utc).isoformat(),
                 "note": f"hand-extracted: the nine lines of the actor lizzies_bouncer in scene q000_corpo_04_lizzies_club (Rita Wheeler's record is Character.lizzies_bouncer); "
                         f"{round(seconds, 2)} s; the four shouted lines are left out; no EQ, denoise or gain"}}
    print(kind, round(seconds, 3), "s", wav)
files = {"omni-short": "local-voices.autobest-short.json", "omni-long": "local-voices.autobest-long.json", "pocket": "pocket-voices.autobest.json"}
for kind, name in files.items():
    path = ROOT / "runtime" / name
    raw = path.read_text("utf-8")
    (backup / name).write_text(raw, encoding="utf-8")
    cfg = json.loads(raw.lstrip("\ufeff"))
    for key, value in (("rita-wheeler", entries[kind]), ("lucy-kushinada", {"status": "unprepared"})):
        assert key not in cfg["voices"] or cfg["voices"][key] == {"status": "unprepared"}, (name, key, cfg["voices"][key])
        cfg["voices"][key] = value
    tmp = path.with_name(path.name + ".part")
    tmp.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)
    print("wrote", name, len(cfg["voices"]), "voices")
