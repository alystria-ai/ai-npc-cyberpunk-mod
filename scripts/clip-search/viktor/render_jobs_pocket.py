"""Render a list of Pocket jobs offline with the shipped student on the CPU (no game, no bridge, nothing else is touched).

  python render_jobs_pocket.py <jobs.json> [results.json] [--export <student dir>]

jobs.json: [{"name", "ref" (abs wav), "text", "seed", "out" (abs wav)}].  Uses scripts/clip-search/render.py's PocketRenderer, which mirrors the
bridge's Pocket worker (temperature from runtime/pocket-voices.json, one flow decode step, reference prepared untruncated).  The default student is
runtime/pocket-student-v2-s2000-ema-decv2 (the one runtime/pocket-voices.autobest.json names).  CLIP_SEARCH_ROOT must name the main checkout.
Run with vendor/pocket-tts-env/Scripts/python.exe (the renderer starts its own workers with that interpreter).
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import render  # noqa: E402


def main() -> int:
    args = [a for a in sys.argv[1:]]
    export = None
    if "--export" in args:
        at = args.index("--export")
        export = Path(args[at + 1])
        del args[at:at + 2]
    jobs = json.loads(Path(args[0]).read_text(encoding="utf-8"))
    results_path = Path(args[1]) if len(args) > 1 else None
    root = Path(os.environ.get("CLIP_SEARCH_ROOT") or render.ROOT)
    export = export or root / "runtime/pocket-student-v2-s2000-ema-decv2"
    began = time.monotonic()
    renderer = render.PocketRenderer(export=export, workers=1, threads=4)
    print(json.dumps({"loaded_seconds": round(time.monotonic() - began, 1), "export": export.name}), flush=True)
    try:
        started = time.monotonic()
        done = renderer.render(jobs)
        wall = round(time.monotonic() - started, 1)
    finally:
        renderer.close()
    out = {job["name"]: result for job, result in zip(jobs, done)}
    out["_wall_seconds"] = wall
    if results_path:
        results_path.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(json.dumps({"jobs": len(jobs), "failed": [job["name"] for job, r in zip(jobs, done) if not r["ok"]], "wall_seconds": wall}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
