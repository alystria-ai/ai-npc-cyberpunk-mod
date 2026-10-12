"""Extract the known voice lines of 8ug8ear (bugbear_default scene) and Jake Estevez (sts_hey_gle_06 scene) from the
installed game archives, decode with vgmstream (file output only, nothing is played), write wem/wav/txt per line."""
import importlib.util, json, sqlite3, subprocess, sys, os, hashlib
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod")
spec = importlib.util.spec_from_file_location("ext", ROOT / "scripts/Extract-VoiceReferences.py")
ext = importlib.util.module_from_spec(spec); spec.loader.exec_module(ext)
GAME = Path("E:/SteamLibrary/steamapps/common/Cyberpunk 2077")
VGM = r"E:\misc\misc1\modding\fmodel\Output\.data\vgmstream-cli.exe"
OUT = Path("E:/CyberpunkConvai-offload/work/clip-search/missing-two/raw")
lists = {}
for label in ("base", "ep1"):
    lists[label] = (ROOT / f"runtime/voice-cast-inventory-20261001/{label}-wem-paths.txt").read_text("utf-8").splitlines()
want = {
    "jake-estevez": ("civ_mid_m_14_enus_20_sts_hey_gle_06_f_", "sts_hey_gle_06"),
    "8ug8ear": ("civ_mid_f_07_enus_15_scene_bugbear_default_f_", "scene_bugbear_default"),
}
oodle = ext.Oodle(GAME / "tools/redmod/bin/oo2ext_7_win64.dll")
archives = [ext.Archive(GAME, r) for r in ext.ARCHIVES]
db = sqlite3.connect("file:" + (ROOT / "research/cyberpunk/cache/game/localization/index/lookup.sqlite3").as_posix() + "?mode=ro", uri=True)
manifest = []
for key, (prefix, scene) in want.items():
    paths = sorted({p for l in lists.values() for p in l if "\\vo\\" in p and prefix in p})
    print(key, len(paths), "wem paths")
    d = OUT / key; d.mkdir(parents=True, exist_ok=True)
    for p in paths:
        hexid = p.rsplit("_", 1)[-1][:-4]
        sid = str(int(hexid, 16))
        row = db.execute("select female,male from entries where domain='subtitle.stringId' and entry_id=?", (sid,)).fetchone()
        text = (row[0] or row[1] or "").strip() if row else ""
        matches = [m for a in archives if (m := a.read(p, oodle))]
        assert len(matches) == 1, (p, len(matches))
        data, src = matches[0]
        assert data[:4] == b"RIFF"
        wem = d / f"{sid}.wem"; wav = d / f"{sid}.wav"
        wem.write_bytes(data)
        r = subprocess.run([VGM, "-i", "-o", str(wav), str(wem)], capture_output=True, text=True, creationflags=0x08000000)
        assert r.returncode == 0, r.stderr
        (d / f"{sid}.txt").write_text(text + "\n", encoding="utf-8")
        q = ext.wav_quality(wav)
        print(f"  {sid} {hexid} {q['durationSeconds']:.3f}s ch{q['channels']} {q['sampleRate']} peak{q['peakAbsolute']} clip{q['clippedSamples']} rms{q['rmsDbfs']:.1f} | {text}")
        manifest.append({"key": key, "stringId": sid, "wemPath": p, "transcript": text, "source": src, "wav": q, "wavPath": str(wav).replace("\\", "/")})
(OUT.parent / "extract-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
