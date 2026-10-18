"""Extract Rita Wheeler's nine Corpo-Rat door lines from the installed game archives and decode them (file output only).

Attribution (scene level, not voice tag alone): scene base\\quest\\main_quests\\prologue\\q000\\scenes\\q000_corpo_04_lizzies_club.scene,
actor id 6 `lizzies_bouncer` (the name of her character record, community entry `bouncer`, voicetag id 1624173162027036812) is the
speaker of nine screenplay lines; the locstring ids of those nine lines are listed in LINES below (read from the exported scene
JSON, `scripts/clip-search/rita-wheeler/scene_lines.py`). Each id maps to one WEM, `civ_prnd_f_01_enus_30_q000_f_<hex of id>.wem`, and
to one installed English subtitle entry (the transcript). Those are exactly the nine files with that prefix in the voice archive.

Usage: python extract_rita.py <out_dir>   (default runtime/voice-references/extracted/rita-wheeler under the main checkout)
"""
import importlib.util, json, sqlite3, subprocess, sys
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod")
spec = importlib.util.spec_from_file_location("ext", ROOT / "scripts/Extract-VoiceReferences.py")
ext = importlib.util.module_from_spec(spec); spec.loader.exec_module(ext)
GAME = Path("E:/SteamLibrary/steamapps/common/Cyberpunk 2077")
VGM = r"E:\misc\misc1\modding\fmodel\Output\.data\vgmstream-cli.exe"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "runtime/voice-references/extracted/rita-wheeler"
SCENE = r"base\quest\main_quests\prologue\q000\scenes\q000_corpo_04_lizzies_club.scene"
PREFIX = "civ_prnd_f_01_enus_30_q000_f_"
LINES = ["1672130344050925568", "1877987316845268992", "1877988965424844800", "1882154225697222656", "1877994627231928320",
         "1877996582163468288", "1985029826350608384", "1985029922668605440", "1985029939546484736"]
oodle = ext.Oodle(GAME / "tools/redmod/bin/oo2ext_7_win64.dll")
archives = [ext.Archive(GAME, r) for r in ext.ARCHIVES]
db = sqlite3.connect("file:" + (ROOT / "research/cyberpunk/cache/game/localization/index/lookup.sqlite3").as_posix() + "?mode=ro", uri=True)
OUT.mkdir(parents=True, exist_ok=True)
manifest = []
for sid in LINES:
    hexid = format(int(sid), "x")
    p = rf"base\localization\en-us\vo\{PREFIX}{hexid}.wem"
    row = db.execute("select female,male from entries where domain='subtitle.stringId' and entry_id=?", (sid,)).fetchone()
    text = (row[0] or row[1] or "").strip() if row else ""
    matches = [m for a in archives if (m := a.read(p, oodle))]
    assert len(matches) == 1, (p, len(matches))
    data, src = matches[0]
    assert data[:4] == b"RIFF"
    wem = OUT / f"{sid}.wem"; wav = OUT / f"{sid}.wav"
    wem.write_bytes(data)
    r = subprocess.run([VGM, "-i", "-o", str(wav), str(wem)], capture_output=True, text=True, creationflags=0x08000000)
    assert r.returncode == 0, r.stderr
    (OUT / f"{sid}.txt").write_text(text + "\n", encoding="utf-8")
    q = ext.wav_quality(wav)
    print(f"{sid} {hexid} {q['durationSeconds']:.3f}s ch{q['channels']} {q['sampleRate']} peak{q['peakAbsolute']} clip{q['clippedSamples']} rms{q['rmsDbfs']:.1f} | {text}")
    manifest.append({"key": "rita-wheeler", "stringId": sid, "wemPath": p, "transcript": text, "scene": SCENE, "actor": "lizzies_bouncer",
                     "source": src, "wav": q, "wavPath": str(wav).replace("\\", "/")})
(OUT.parent / "rita-wheeler-extract-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
