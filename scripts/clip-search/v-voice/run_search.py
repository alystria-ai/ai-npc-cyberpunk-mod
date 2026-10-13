"""Run the project's automatic reference search (scripts/clip-search/search.py, the "Auto-best" the picker loads) for V's two voices on the
pool built by build_v_pool.py.  Pocket on the CPU only, one low-priority worker, the ECAPA scorer on the CPU.

    CLIP_SEARCH_ROOT=<main checkout> CLIP_SEARCH_WORK=<work folder> python scripts/clip-search/v-voice/run_search.py INDEX OUT_DIR [--voices v-male,v-female]
        [--threads 2] [--cap 18]

Same method as the companions (search.py docstring); two differences, both about length: the growth cap is 18 s (the length Pocket's student was
trained up to and OmniVoice's long budget) instead of 27 s, so every set it proposes fits every voice route, and the search runs one worker with
two threads so it can run beside a live game.  Needs vendor/reference-voicestudio/.venv (ECAPA) and vendor/pocket-tts-env (Pocket).
"""
import argparse, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import search  # noqa: E402
import common  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("index"); ap.add_argument("out")
    ap.add_argument("--voices", default="v-male,v-female")
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--cap", type=float, default=18.0)
    ap.add_argument("--export", default=str(common.ROOT / "runtime/pocket-student-v2-s2000-ema-decv2"))
    a = ap.parse_args()
    search.SIZES["pocket"]["caps"] = (a.cap,)
    return search.main(["--engine", "pocket", "--voices", a.voices, "--index", a.index, "--out", a.out, "--workers", "1", "--threads", str(a.threads),
                        "--scorer-device", "cpu", "--export", a.export, "--tag", "pocket-v2"])


if __name__ == "__main__":
    sys.exit(main())
