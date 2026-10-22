"""Re-run the voices of already built packs that a newer rule of the builder changes, then report which voices differ.

    python -I scripts/voice-packs/final_pass.py --langs zh-cn,ja,ko,fr,de,it

For each language: the voices whose finished set is under 8 s (the extension rule), or that dropped a line and ended under 12 s without a top-up, are
built again with build_pack.py --only (the rest of the pack stays as it is), then finish_pack.py makes the slots, checks, zip and sheet again. Voices that
were left out of a pack stay out. The report lists the voices whose lines or audio changed and the new zip's SHA-256 (work/final-pass-report.json).
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vp_common as vp  # noqa: E402

PACK_ROOT = "red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual"


def zip_sha(lang):
    """The SHA-256 of the language's zip, computed from the file (no loose checksum file is written any more)."""
    zips = sorted((vp.OUT / lang).glob("Voices-*.zip"))
    if len(zips) != 1:
        raise SystemExit(f"{lang}: expected one Voices-<Language>.zip in {vp.OUT / lang}, found {len(zips)}")
    return vp.sha256_file(zips[0])


def run(args):
    done = subprocess.run([sys.executable, "-I", "-W", "ignore", *map(str, args)], capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=str(vp.ROOT))
    if done.returncode:
        raise SystemExit((done.stdout + done.stderr)[-2000:])
    return done.stdout


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--langs", required=True)
    args = ap.parse_args()
    report = {}
    for lang in args.langs.split(","):
        pack = vp.OUT / lang / "stage" / PACK_ROOT / lang
        before = vp.read_json(pack / "manifest.json")
        old_zip = zip_sha(lang)
        summary = vp.read_json(vp.WORK / lang / "summary.json")["perVoice"]
        todo = [k for k, v in summary.items() if v["inPack"] and v["seconds"] is not None
                and (v["seconds"] < 8.0 or (v["dropped"] and v["seconds"] < 12.0 and not any("topped up" in n for n in v["notes"])))]
        vp.log(f"{lang}: re-running {len(todo)} voices: {', '.join(todo)}")
        if not todo:
            report[lang] = {"rerun": [], "changed": [], "oldZip": old_zip, "newZip": old_zip}
            continue
        shutil.copyfile(pack / "manifest.json", vp.WORK / lang / "manifest-before-final-pass.json")
        run([vp.HERE / "build_pack.py", "--lang", lang, "--only", ",".join(todo)])
        vp.log(run([vp.HERE / "finish_pack.py", "--lang", lang]).strip().splitlines()[-1])
        after = vp.read_json(pack / "manifest.json")
        changed = []
        for key in todo:
            b, a = before["voices"].get(key), after["voices"].get(key)
            if (b or {}).get("sha256") != (a or {}).get("sha256"):
                changed.append({"voice": key, "seconds": [b and b["seconds"], a and a["seconds"]], "lines": [b and len(b["lines"]), a and len(a["lines"])]})
        new_zip = zip_sha(lang)
        report[lang] = {"rerun": todo, "changed": changed, "oldZip": old_zip, "newZip": new_zip, "voicesInPack": len(after["voices"])}
        vp.log(f"{lang}: {len(changed)} voices changed; zip {new_zip}")
    vp.write_json(vp.WORK / "final-pass-report.json", report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
