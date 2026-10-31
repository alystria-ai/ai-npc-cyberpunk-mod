"""Add characters' dubbed clips to the language manifests (characters/voice-language-clips/<lang>.json).

    python -I scripts/voice-extract/add_language_voice.py --spec spec.json --staging <folder> [--ref <folder>] [--stash E:/SteamLibrary/AiNpc-vo-stash] [--lists <folder of WolvenKit listings>] [--vgmstream <exe>]

For a new voice key (a side character that gets a dub voice of its own, a generated archetype voice) there is no installed pack to recover the recipe from, so the lines are named here.
The spec is one object or {"voices": [object, ...]}:

    {"key": "some-side-character", "kind": "picked" | "archetypes", "gender": "female" | "male",
     "voices": {"de": {"lines": [<line>, ...], "text": "what the clip says in German"}, "fr": {...}, ...}}

A <line> is a 16 hex line id (looked up in the dub archive's listing: the base game before Phantom Liberty) or {"id": "<16 hex>", "path": "base\\localization\\de-de\\vo\\<file>.wem", "stash": "content" | "ep1"}
(the exact file, as scripts/voice-extract/side_language_voices.py writes it).  For every language named the clip is built with the same code the player's PC runs (bridge/voice_clip_build.py,
resampler `pack`, no gain), written to <staging>/<lang>/<kind>/<key>.wav, and an exact entry is added to (or replaces the entry of) the language's manifest, with the SHA-256 and the sample
count of what was written.  With --ref a clip that has a file of the same name in that folder (the builder's own audio) must equal it, else nothing is written for it.  The files in <staging> are what
goes to Hugging Face (voice-clips/<lang>/<kind>/<key>.wav), scripts/voice-extract/language_upload_list.py --staging <folder> lists them.  The format is one object per key, so adding a key never
touches the others.
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


def under_locale(path: str, locale: str) -> str:
    """The part of a depot path after <top>\\localization\\<locale>\\ (what the manifest stores)."""
    prefix_end = path.lower().index("\\localization\\") + len("\\localization\\")
    folder, _, rest = path[prefix_end:].partition("\\")
    if folder.lower() != locale:
        raise SystemExit(f"{path} is not under the {locale} folder")
    return rest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--staging", required=True)
    ap.add_argument("--ref", help="a folder of the builder's own audio (<ref>/<lang>/<kind>/<key>.wav) every rebuilt clip must equal")
    ap.add_argument("--stash", default="E:/SteamLibrary/AiNpc-vo-stash")
    ap.add_argument("--lists", default=str(Path(os.environ.get("TEMP", ".")) / "ainpc-dub-lists"))
    ap.add_argument("--vgmstream", default=R.VGM_DEFAULT)
    ap.add_argument("--langs", default="")
    args = ap.parse_args()
    raw = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    specs = raw["voices"] if isinstance(raw.get("voices"), list) else [raw]
    os.environ["CX_STASH"] = args.stash
    oodle = V.Oodle(Path("E:/SteamLibrary/steamapps/common/Cyberpunk 2077"))
    only = set(filter(None, args.langs.split(",")))
    langs = [lang for lang in R.LOCALES if (not only or lang in only) and any(lang in s["voices"] for s in specs)]
    problems = 0
    for lang in langs:
        locale = R.LOCALES[lang]
        index = None
        archives = {sub: V.Archive(Path(args.stash) / lang / sub / f"lang_{R.ARCHIVE_NAME.get(lang, lang)}_voice.archive", oodle) for sub in V.LANGUAGE_TOP}
        manifest_path = REPO / "characters" / "voice-language-clips" / f"{lang}.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        cache: dict = {}
        added = compared = 0
        for spec in specs:
            if lang not in spec["voices"]:
                continue
            key, kind, row = spec["key"], spec["kind"], spec["voices"][lang]
            if kind not in ("picked", "archetypes"):
                raise SystemExit("kind is picked or archetypes")
            lines = []
            for line in row["lines"]:
                if isinstance(line, str):
                    index = index if index is not None else R.hex_index(lang, Path(args.lists))
                    found = sorted(index.get(line, []), key=lambda c: (c[0] != "content", c[1]))
                    if not found:
                        raise SystemExit(f"{lang}: the dub has no file for line {line}")
                    lines.append(list(found[0]))
                else:
                    lines.append([line["stash"], under_locale(line["path"], locale)])
            entry = {"lines": lines, "how": "pack", "gain": None}
            samples = V.build_language_clip(entry, locale, archives, Path(args.vgmstream), cache)
            file = f"{kind}/{key}.wav"
            target = Path(args.staging) / lang / file
            V.write_wav(target, samples)
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            if args.ref and (Path(args.ref) / lang / file).is_file():
                ref = Path(args.ref) / lang / file
                compared += 1
                if ref.read_bytes() != target.read_bytes():
                    print(f"{lang}: {key} DIFFERS from the builder's audio ({ref}), not added")
                    target.unlink()
                    problems += 1
                    continue
            manifest["voices"][key] = {"kind": kind, "file": file, **({"gender": spec["gender"]} if spec.get("gender") else {}), "text": row["text"],
                                       "seconds": round(len(samples) / V.RATE, 3), "samples": int(len(samples)), "sha256": digest, "exact": True, "how": "pack", "gain": None, "lines": lines}
            added += 1
        manifest["voices"] = dict(sorted(manifest["voices"].items()))
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        print(f"{lang}: {added} voices added ({compared} equal to the builder's own audio), {len(manifest['voices'])} in the manifest", flush=True)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
