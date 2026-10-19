"""Render a list of OmniVoice jobs offline with the live settings (GPU, one process, nothing else is touched).

  python render_jobs_omni.py <jobs.json> [results.json]

jobs.json: [{"name", "ref" (abs wav), "transcript", "text", "seed", "steps" (16 or 32), "out" (abs wav)}].  Jobs are grouped by step count and
rendered with scripts/clip-search/render.py's OmniRenderer (FP16, guidance 2.0, speed 1, denoise off, no post-processing, the pinned snapshot named in
runtime/local-voices.json), one batch of up to 4 jobs at a time (same seed within a batch).  CLIP_SEARCH_ROOT must name the main checkout (runtime/ and
vendor/ live there).  Run with vendor/reference-voicestudio/.venv/Scripts/python.exe.  Refuses to start when under 4.5 GB of GPU memory is free.
Results (per job: ok, seconds of audio, wall ms) and the total wall time are printed and written to results.json.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import render  # noqa: E402


def main() -> int:
    jobs = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    results_path = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    import torch
    free, total = torch.cuda.mem_get_info()
    print(json.dumps({"gpu_free_mib": free // 2**20, "gpu_total_mib": total // 2**20, "jobs": len(jobs)}), flush=True)
    if free < 4.5 * 2**30:
        raise RuntimeError("The GPU is busy (under 4.5 GB free); not rendering")
    began = time.monotonic()
    renderer = render.OmniRenderer(steps=16, batch=4)
    print(json.dumps({"loaded_seconds": round(time.monotonic() - began, 1)}), flush=True)
    out = {}
    wall = time.monotonic()
    try:
        for steps in sorted({job["steps"] for job in jobs}):
            batch = [job for job in jobs if job["steps"] == steps]
            renderer.steps = steps
            started = time.monotonic()
            done = renderer.render(batch)
            for job, result in zip(batch, done):
                out[job["name"]] = result
            print(json.dumps({"steps": steps, "jobs": len(batch), "seconds": round(time.monotonic() - started, 1),
                              "failed": [job["name"] for job, r in zip(batch, done) if not r["ok"]]}), flush=True)
    finally:
        renderer.close()
    out["_wall_seconds"] = round(time.monotonic() - wall, 1)
    if results_path:
        results_path.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(json.dumps({"wall_seconds": out["_wall_seconds"]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
