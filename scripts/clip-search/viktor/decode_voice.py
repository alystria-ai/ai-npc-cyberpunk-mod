"""Decode every kept voice WEM of one voice tag to WAV and write a manifest with the subtitle text (CPU, read-only on the game and the pool).

The expanded pool's WAVs were deleted in the 2026-10-16 clean-up but its extracted WEMs stayed (reference-pool-expanded/_work/wem/...), and
the subtitle table (reference-pool-expanded/_work/subtitles.json: string id -> [female variant, male variant]) is still there, so the lines
are decoded again with the same vgmstream-cli the extractor used.  Nothing is changed in the game folder.

  python decode_voice.py <wem file-name prefix, e.g. victor_vector_> <out dir>
Writes <out dir>/wav/<stem>.wav and <out dir>/manifest.json: [{file, dir, stem, fm, hex, sid, text, seconds, rate, ch}].
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import soundfile as sf

WORK = Path("E:/CyberpunkConvai-offload/work/reference-pool-expanded/_work")
VGM = Path(r"E:\misc\misc1\modding\fmodel\Output\.data\vgmstream-cli.exe")
NAME = re.compile(r"^(?P<stem>.+)_(?P<fm>[fm])_(?P<hex>[0-9a-f]{16})(?P<rest>.*)\.wem$")


def main() -> int:
    prefix, out = sys.argv[1], Path(sys.argv[2])
    (out / "wav").mkdir(parents=True, exist_ok=True)
    table = json.loads((WORK / "subtitles.json").read_text(encoding="utf-8"))
    rows = []
    for wem in sorted((WORK / "wem").rglob(prefix + "*.wem")):
        match = NAME.match(wem.name)
        if not match:
            continue
        sid = str(int(match["hex"], 16))
        female, male = (table.get(sid) or ["", ""])[:2]
        text = (female if match["fm"] == "f" else male) or female or male
        archive = "ep1" if "ep1" in wem.relative_to(WORK / "wem").parts[0] else "content"
        wav = out / "wav" / ((wem.stem if wem.parent.name == "vo" else wem.parent.name + "__" + wem.stem) + ".wav")   # vo_holocall shares file stems with vo
        if not wav.is_file():
            subprocess.run([str(VGM), "-o", str(wav), str(wem)], check=True, capture_output=True, creationflags=0x08000000)
        info = sf.info(str(wav))
        rows.append({"file": str(wav), "wem": str(wem), "dir": wem.parent.name, "archive": archive, "stem": match["stem"], "fm": match["fm"],
                     "hex": match["hex"], "sid": sid, "rest": match["rest"], "text": text, "seconds": round(info.frames / info.samplerate, 3),
                     "rate": info.samplerate, "ch": info.channels})
    (out / "manifest.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
    print(len(rows), "files decoded ->", out / "manifest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
