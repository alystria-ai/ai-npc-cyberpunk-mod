"""After build_pack.py: Voxtral slots, the bridge's own validation, the zip with its listing and checksums, the listening sheet, a summary.

    python -I scripts/voice-packs/finish_pack.py --lang zh-cn [--bridge <bridge folder>]

Outputs in E:/SteamLibrary/AiNpc-voice-packs/<lang>/: AI-NPC-Cyberpunk-Mod-Voices-<lang>.zip, .files.json, SHA256SUMS.txt (the stage/ tree stays beside them).
Also writes work/<lang>/summary.json (per voice: lines used, replaced, missing, seconds, checks) and prints the exceptions.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vp_common as vp  # noqa: E402

NODE = "node"


def run(args: list) -> str:
    done = subprocess.run([str(a) for a in args], capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=str(vp.ROOT))
    out = (done.stdout or "") + (done.stderr or "")
    if done.returncode:
        raise SystemExit(f"{args[1] if len(args) > 1 else args[0]} failed ({done.returncode}):\n{out[-1500:]}")
    return out.strip()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--lang", required=True)
    ap.add_argument("--bridge", default=str(vp.ROOT / "bridge"))
    ap.add_argument("--skip-slots", action="store_true")
    args = ap.parse_args()
    lang = args.lang
    stage = vp.OUT / lang / "stage"
    pack = stage / "red4ext/plugins/AiNpcCyberpunkMod/voices/multilingual" / lang
    if not (pack / "manifest.json").is_file():
        raise SystemExit("run build_pack.py first")
    tool = vp.HERE
    if not args.skip_slots:
        vp.log("building the Voxtral slots with the bridge's own code")
        vp.log(run([NODE, tool / "prepare_slots.mjs", pack, "--bridge", args.bridge, "--report", vp.WORK / lang / "slots-report.json"]).splitlines()[-1])
    vp.log("validating with the bridge's pack loader")
    vp.log(run([NODE, tool / "validate_pack.mjs", pack, lang, "--bridge", args.bridge]))
    vp.log("zipping")
    vp.log(run([NODE, tool / "package_pack.mjs", lang, stage, vp.OUT / lang]))
    vp.log(run([sys.executable, "-I", tool / "listening_sheet.py", "--lang", lang]))

    manifest = vp.read_json(pack / "manifest.json")
    report = vp.read_json(vp.WORK / lang / "build-report.json")
    summary = {"lang": lang, "voices": len(manifest["voices"]), "omitted": report["omitted"], "perVoice": {}}
    exceptions = []
    for key, rep in sorted(report["voices"].items()):
        entry = manifest["voices"].get(key)
        row = {"inPack": entry is not None, "seconds": entry["seconds"] if entry else None, "lines": len(rep["lines"]), "replaced": len(rep["replaced"]),
               "missing": len(rep["missing"]), "dropped": len(rep["dropped"]), "speakerMinCosine": rep.get("speakerMinCosine"),
               "finalLufs": (rep.get("finalLoudness") or {}).get("lufs"), "truePeakDb": (rep.get("finalLoudness") or {}).get("truePeakDb"),
               "clipped": (rep.get("finalLoudness") or {}).get("clipped"), "gainDb": (rep.get("gain") or {}).get("gainDb"), "notes": rep["notes"]}
        summary["perVoice"][key] = row
        if row["replaced"] or row["missing"] or row["dropped"] or not row["inPack"] or row["notes"] or row["clipped"]:
            exceptions.append(key)
    summary["exceptions"] = exceptions
    vp.write_json(vp.WORK / lang / "summary.json", summary)
    csv_lines = ["voice,kind,in_pack,seconds,lines,replaced,missing,dropped,speaker_min_cosine,final_lufs,true_peak_db,gain_db,notes"]
    for key, row in summary["perVoice"].items():
        kind = report["voices"][key]["kind"]
        notes = "; ".join(row["notes"]).replace('"', "'")
        csv_lines.append(",".join(str(x) for x in (key, kind, row["inPack"], row["seconds"], row["lines"], row["replaced"], row["missing"], row["dropped"],
                                                    row["speakerMinCosine"], row["finalLufs"], row["truePeakDb"], row["gainDb"])) + f',"{notes}"')
    sheet = vp.MAIN / "deliverables/voice-packs" / lang
    sheet.mkdir(parents=True, exist_ok=True)
    (sheet / "per-voice.csv").write_text("\n".join(csv_lines) + "\n", encoding="utf-8")
    pv = summary["perVoice"].values()
    vp.log(f"{lang}: {summary['voices']} voices in the pack, {len(report['omitted'])} omitted; lines replaced {sum(r['replaced'] for r in pv)}, missing {sum(r['missing'] for r in pv)}, "
           f"dropped {sum(r['dropped'] for r in pv)}; {len(exceptions)} voices with something to report (work/{lang}/summary.json)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
