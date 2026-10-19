"""Lay out a listening folder for the owner and write the render jobs for it (CPU; renders are done by render_jobs_omni.py / render_jobs_pocket.py).

  python assemble_picks.py <spec.json> <out folder> <jobs dir>

spec.json: {"text": the test passage, "seed": 1042,
            "options": [{"dir": "0-current", "reference": abs wav, "words": "...", "balanced_reference": abs wav (optional; else the same reference),
                         "pocket_reference": abs wav (optional; else the same reference)}, ...]}
For every option: <out>/<dir>/reference.wav and reference-words.txt (copied), and jobs for omnivoice-ultra.wav (32 steps), omnivoice-balanced.wav (16 steps)
and pocket.wav.  Writes <jobs dir>/omni-jobs.json and pocket-jobs.json.  An option's own balanced / pocket reference is copied beside it as
reference-balanced.wav / pocket-reference.wav so the folder says what was used.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path


def main() -> int:
    spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out, jobs_dir = Path(sys.argv[2]), Path(sys.argv[3])
    jobs_dir.mkdir(parents=True, exist_ok=True)
    omni, pocket = [], []
    for option in spec["options"]:
        folder = out / option["dir"]
        folder.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(option["reference"], folder / "reference.wav")
        (folder / "reference-words.txt").write_text(option["words"] + "\n", encoding="utf-8")
        balanced, pocket_ref = option.get("balanced_reference"), option.get("pocket_reference")
        if balanced:
            shutil.copyfile(balanced, folder / "reference-balanced.wav")
        if pocket_ref:
            shutil.copyfile(pocket_ref, folder / "pocket-reference.wav")
        words = option.get("balanced_words") or option["words"]
        omni.append({"name": option["dir"] + "-ultra", "ref": str(folder / "reference.wav"), "transcript": option["words"], "text": spec["text"],
                     "seed": spec["seed"], "steps": 32, "out": str(folder / "omnivoice-ultra.wav")})
        omni.append({"name": option["dir"] + "-balanced", "ref": str(folder / ("reference-balanced.wav" if balanced else "reference.wav")),
                     "transcript": words, "text": spec["text"], "seed": spec["seed"], "steps": 16, "out": str(folder / "omnivoice-balanced.wav")})
        pocket.append({"name": option["dir"] + "-pocket", "ref": str(folder / ("pocket-reference.wav" if pocket_ref else "reference.wav")),
                       "text": spec["text"], "seed": spec["seed"], "out": str(folder / "pocket.wav")})
    (jobs_dir / "omni-jobs.json").write_text(json.dumps(omni, indent=1), encoding="utf-8")
    (jobs_dir / "pocket-jobs.json").write_text(json.dumps(pocket, indent=1), encoding="utf-8")
    print(len(spec["options"]), "options;", len(omni), "omni jobs;", len(pocket), "pocket jobs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
