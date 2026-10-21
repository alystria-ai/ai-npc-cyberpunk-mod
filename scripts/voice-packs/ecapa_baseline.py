"""English baseline for the speaker-consistency check: the ECAPA cosine between the clips of every shipped English reference.

    python -I scripts/voice-packs/ecapa_baseline.py        (after trace_english.py has decoded the English clips)

Writes E:/SteamLibrary/AiNpc-voice-packs/work/en/ecapa-baseline.json.  The pack builder takes its 'a clip is someone else' threshold from it.
"""
from __future__ import annotations

import itertools
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vp_common as vp  # noqa: E402
import vp_speaker  # noqa: E402


def main() -> int:
    import numpy as np
    lists = vp.read_json(vp.HERE / "line-lists.json")["voices"]
    speaker = vp_speaker.Speaker(threads=4)
    out = {}
    for n, (key, row) in enumerate(sorted(lists.items())):
        embeddings = []
        for line in row["lines"]:
            path = f"{vp.ARCH_DIR[line['archive']]}\\localization\\en-us\\{line['vo']}\\{line['stem']}_{line['fm']}_{line['hex']}{line['rest']}.wem"
            wav = vp.WORK / "en/wav" / (path.replace("\\", "/") + ".wav")
            audio = vp.load_v(wav) if row["kind"] == "v-voice" else vp.load_mono(wav, method="poly")
            embeddings.append(speaker.embed(audio))
        pairs = [round(speaker.cosine(a, b), 4) for a, b in itertools.combinations(embeddings, 2)]
        out[key] = {"kind": row["kind"], "clips": len(embeddings), "pairs": pairs, "min": min(pairs) if pairs else None}
        if n % 40 == 0:
            vp.log(f"{n}/{len(lists)} {key} {pairs}")
    vp.write_json(vp.WORK / "en/ecapa-baseline.json", out)
    mins = np.array([v["min"] for v in out.values() if v["min"] is not None])
    allp = np.array([p for v in out.values() for p in v["pairs"]])
    for name, arr in (("per-voice minimum", mins), ("all pairs", allp)):
        vp.log(f"{name}: n={len(arr)} min {arr.min():.3f} p1 {np.percentile(arr, 1):.3f} p5 {np.percentile(arr, 5):.3f} p10 {np.percentile(arr, 10):.3f} median {np.median(arr):.3f}")
    for kind in ("picked", "archetypes", "v-voice"):
        arr = np.array([v["min"] for v in out.values() if v["kind"] == kind and v["min"] is not None])
        if len(arr):
            vp.log(f"  {kind}: n={len(arr)} min {arr.min():.3f} p5 {np.percentile(arr, 5):.3f} median {np.median(arr):.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
