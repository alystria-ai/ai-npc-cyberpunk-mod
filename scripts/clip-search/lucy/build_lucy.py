"""Build Lucy Kushinada's reference WAVs (the clip-search recipe: whole clips, 0.4 s gaps, mono 24 kHz, 16-bit PCM; no EQ, denoise or gain)
from the three user-approved clips (docs/NCA_FOLLOWERS_PLAN.md section 8) and write her entries into the three live autobest voice configs,
replacing her {"status": "unprepared"}.

The clips are Demucs vocals-stem cuts of the official English dub clip "David and the Mystery Girl" (HI8ubzVgvio), cut by cut_candidates.py and
approved by ear by the user (clips 2, 3 and 4; clip 1 was dropped).  Their words are the dub's, as read by Whisper on the stem.

Sets: omni-short is at most 10 s, so it takes clips 3 and 4 (the two cleanest); omni-long and pocket take all three (10.78 s with the gaps,
under the usual 12 to 18 s, as for Rita; it is not padded with the dropped clip).

Usage: python build_lucy.py <backup_dir> [--dry-run]
"""
import hashlib, json, shutil, sys
from datetime import datetime, timezone
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod")
sys.path.insert(0, str(ROOT / "scripts/clip-search"))
from common import build_reference, joined_seconds, words

CUTS = ROOT / "runtime/voice-references/external/lucy/work/cuts"
CLIPS = {  # id: (file, words the dub says)
    "lucy-2-trainee": ("lucy-2-trainee.wav", "Plus, got a trainee to supervise now."),
    "lucy-3-seventy-thirty": ("lucy-3-seventy-thirty.wav", "70-30. And I'll pay the second the job's done. I think that's fair."),
    "lucy-4-crazy-idea": ("lucy-4-crazy-idea.wav", "Hey, crazy idea. How about we work together?"),
}
SETS = {"omni-short": ["lucy-3-seventy-thirty", "lucy-4-crazy-idea"],
        "omni-long": ["lucy-2-trainee", "lucy-3-seventy-thirty", "lucy-4-crazy-idea"],
        "pocket": ["lucy-2-trainee", "lucy-3-seventy-thirty", "lucy-4-crazy-idea"]}

import soundfile as sf
dur = {i: sf.info(str(CUTS / f)).duration for i, (f, _) in CLIPS.items()}
for kind, ids in SETS.items():
    print(kind, ids, round(joined_seconds(dur[i] for i in ids), 2), "s")
assert 7.0 <= joined_seconds(dur[i] for i in SETS["omni-short"]) <= 10.0
assert joined_seconds(dur[i] for i in SETS["omni-long"]) <= 18.0
assert all(words(t) >= 3 for _, t in CLIPS.values())
if "--dry-run" in sys.argv:
    raise SystemExit
backup = Path(sys.argv[1]); backup.mkdir(parents=True, exist_ok=True)
src = ROOT / "runtime/voice-references/extracted/lucy-kushinada"; src.mkdir(parents=True, exist_ok=True)
for i, (f, _) in CLIPS.items():
    shutil.copyfile(CUTS / f, src / f)
(src / "manifest.json").write_text(json.dumps({i: {"file": f, "words": t, "seconds": round(dur[i], 2),
    "source": "HI8ubzVgvio (official Netflix Anime clip, English dub), Demucs htdemucs vocals stem"} for i, (f, t) in CLIPS.items()}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

out_root = ROOT / "runtime/voice-references/picked/autobest"
entries = {}
for kind, ids in SETS.items():
    wav = out_root / kind / "lucy-kushinada.wav"
    seconds = build_reference([str(src / CLIPS[i][0]) for i in ids], wav)
    transcript = " ".join(CLIPS[i][1].strip() for i in ids)
    entries[kind] = {"reference": f"runtime/voice-references/picked/autobest/{kind}/lucy-kushinada.wav", "sha256": hashlib.sha256(wav.read_bytes()).hexdigest(),
        "transcript": transcript, "transcriptSha256": hashlib.sha256(transcript.encode("utf-8")).hexdigest(), "status": "ready",
        "pick": {"clips": [f"lucy-kushinada/{i}" for i in ids], "seconds": round(seconds, 2), "keptAt": datetime.now(timezone.utc).isoformat(),
                 "note": f"web clip, not game audio: three dub lines from the official Netflix Anime clip HI8ubzVgvio with the music removed by Demucs (htdemucs vocals); "
                         f"approved by ear by the user; {round(seconds, 2)} s; no EQ, denoise or gain"}}
    print(kind, round(seconds, 3), "s", wav)
files = {"omni-short": "local-voices.autobest-short.json", "omni-long": "local-voices.autobest-long.json", "pocket": "pocket-voices.autobest.json"}
for kind, name in files.items():
    path = ROOT / "runtime" / name
    raw = path.read_text("utf-8")
    (backup / name).write_text(raw, encoding="utf-8")
    cfg = json.loads(raw.lstrip("\ufeff"))
    assert cfg["voices"]["lucy-kushinada"] == {"status": "unprepared"}, (name, cfg["voices"]["lucy-kushinada"])
    cfg["voices"]["lucy-kushinada"] = entries[kind]
    tmp = path.with_name(path.name + ".part")
    tmp.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)
    print("wrote", name, len(cfg["voices"]), "voices")
