"""Add a character's dubbed clip to the language manifests (characters/voice-language-clips/<lang>.json).

    python -I scripts/voice-extract/add_language_voice.py --spec spec.json --staging <folder> [--stash E:/SteamLibrary/AiNpc-vo-stash] [--lists <folder of WolvenKit listings>] [--vgmstream <exe>]

For a new voice key (a side character that gets lines of its own) there is no installed pack to recover the recipe from, so the lines are named here.  The spec:

    {"key": "some-side-character", "kind": "picked" | "archetypes", "gender": "female" | "male",
     "voices": {"de": {"lines": ["<16 hex line id>", ...], "text": "what the clip says in German"}, "fr": {...}, ...}}

For every language named, each line id is looked up in the dub archive's listing (the first file that carries it, base game before Phantom Liberty), the clip is built with the same code the
player's PC runs (bridge/voice_clip_build.py, resampler `pack`, no gain), written to <staging>/<lang>/<kind>/<key>.wav, and an exact entry is added to (or replaces the entry of) the
language's manifest, with the SHA-256 and the sample count of what was written.  The files in <staging> are what goes to Hugging Face (voice-clips/<lang>/<kind>/<key>.wav);
scripts/voice-extract/language_upload_list.py --staging <folder> lists them.  Run the pack-wide checks afterwards (node --test bridge/language-clips.test.mjs bridge/language-clips-manifests.test.mjs).
The format is one object per key, so adding a key never touches the others.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "bridge"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import voice_clip_build as V  # noqa: E402
import recover_language_manifest as R  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--staging", required=True)
    ap.add_argument("--stash", default="E:/SteamLibrary/AiNpc-vo-stash")
    ap.add_argument("--lists", default=str(Path(os.environ.get("TEMP", ".")) / "ainpc-dub-lists"))
    ap.add_argument("--vgmstream", default=R.VGM_DEFAULT)
    args = ap.parse_args()
    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    key, kind = spec["key"], spec["kind"]
    if kind not in ("picked", "archetypes"):
        raise SystemExit("kind is picked or archetypes")
    os.environ["CX_STASH"] = args.stash
    oodle = V.Oodle(Path("E:/SteamLibrary/steamapps/common/Cyberpunk 2077"))
    for lang, row in spec["voices"].items():
        if lang not in R.LOCALES:
            raise SystemExit(f"{lang} is not a pack language")
        index = R.hex_index(lang, Path(args.lists))
        lines = []
        for hex_id in row["lines"]:
            found = sorted(index.get(hex_id, []), key=lambda c: (c[0] != "content", c[1]))
            if not found:
                raise SystemExit(f"{lang}: the dub has no file for line {hex_id}")
            lines.append(list(found[0]))
        archives = {sub: V.Archive(Path(args.stash) / lang / sub / f"lang_{R.ARCHIVE_NAME.get(lang, lang)}_voice.archive", oodle) for sub in V.LANGUAGE_TOP}
        entry = {"lines": lines, "how": "pack", "gain": None}
        samples = V.build_language_clip(entry, R.LOCALES[lang], archives, Path(args.vgmstream))
        file = f"{kind}/{key}.wav"
        target = Path(args.staging) / lang / file
        V.write_wav(target, samples)
        manifest_path = REPO / "characters" / "voice-language-clips" / f"{lang}.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["voices"][key] = {"kind": kind, "file": file, **({"gender": spec["gender"]} if spec.get("gender") else {}), "text": row["text"],
                                   "seconds": round(len(samples) / V.RATE, 3), "samples": int(len(samples)), "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                                   "exact": True, "how": "pack", "gain": None, "lines": lines}
        manifest["voices"] = dict(sorted(manifest["voices"].items()))
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        print(f"{lang}: {key} added, {len(lines)} lines, {len(samples) / V.RATE:.1f} s -> {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
