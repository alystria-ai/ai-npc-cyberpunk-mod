"""Extract plain-Delamain voice lines (English, Samuel Barnett) from the installed game archives for the Delamain cab
add-on's voice reference.  Adapted from scripts/clip-search/missing-two/extract_two.py (file output only, nothing played).

Usage (any python with the repo's deps; the Oodle dll and vgmstream-cli paths below must exist):
    python scripts/clip-search/delamain/extract_delamain.py OUT_DIR [PREFIX ...]
PREFIX defaults to delamain_delamain_taxi_f_ (the cab's own twelve lines).  Personality tags (sad, deep, glados, manic,
angry, scared, suicidal, distorted, merged, receptionist) and holocall-folder files are always refused.
Writes <OUT_DIR>/<StringID>.wem/.wav/.txt and <OUT_DIR>/extract-manifest.json.
"""
import importlib.util, json, sqlite3, subprocess, sys
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")
REPO = Path(__file__).resolve().parents[3]
MAIN = Path(r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod")          # runtime/ and research/ caches live in the main checkout
spec = importlib.util.spec_from_file_location("ext", REPO / "scripts/Extract-VoiceReferences.py")
ext = importlib.util.module_from_spec(spec); spec.loader.exec_module(ext)
GAME = Path("E:/SteamLibrary/steamapps/common/Cyberpunk 2077")
VGM = r"E:\misc\misc1\modding\fmodel\Output\.data\vgmstream-cli.exe"
BAD = ("sad", "deep", "glados", "manic", "angry", "scared", "suicidal", "distorted", "merged", "receptionist", "holocall")
OUT = Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
prefixes = sys.argv[2:] or ["delamain_delamain_taxi_f_"]
lists = [(MAIN / f"runtime/voice-cast-inventory-20261001/{l}-wem-paths.txt").read_text("utf-8").splitlines() for l in ("base", "ep1")]
oodle = ext.Oodle(GAME / "tools/redmod/bin/oo2ext_7_win64.dll")
archives = [ext.Archive(GAME, r) for r in ext.ARCHIVES]
db = sqlite3.connect("file:" + (MAIN / "research/cyberpunk/cache/game/localization/index/lookup.sqlite3").as_posix() + "?mode=ro", uri=True)
manifest = []
for prefix in prefixes:
    assert prefix.startswith("delamain_") and not any(b in prefix for b in BAD), prefix
    paths = sorted({p for l in lists for p in l if "\\vo\\" in p and p.split("\\vo\\")[-1].startswith(prefix) and "holocall" not in p.lower()})
    print(prefix, len(paths), "wem paths")
    for p in paths:
        hexid = p.rsplit("_", 1)[-1][:-4]
        sid = str(int(hexid, 16))
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
        print(f"  {sid} {hexid} {q['durationSeconds']:.3f}s ch{q['channels']} {q['sampleRate']} peak{q['peakAbsolute']} clip{q['clippedSamples']} rms{q['rmsDbfs']:.1f} | {text}")
        manifest.append({"prefix": prefix, "stringId": sid, "wemPath": p, "transcript": text, "source": src, "wav": q, "wavPath": str(wav).replace("\\", "/")})
(OUT / "extract-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
