"""Write packaging/voice-language-clips-upload-list.json: the dubbed clips on Hugging Face (alystria-ai/ai-npc-cyberpunk-mod-packs, voice-clips/<lang>/<kind>/<key>.wav) for players whose game has no voice files of that language.

    python scripts/voice-extract/language_upload_list.py --pack <voices/multilingual folder> [--staging <folder>] [--out packaging/voice-language-clips-upload-list.json]

Nothing is uploaded by this script (scripts/voice-extract/upload_language_clips.py does that).  Each row: the path in the repository, the file it comes from, its size and SHA-256.  The SHA-256 is the
one in characters/voice-language-clips/<lang>.json, which the bridge checks a download against, the script stops if a source file does not have it.  The folder name <lang> is the pack's
(de, es-es, fr, it, ja, ko, pl, pt-br, ru, zh-cn).  A row whose path is not in the list that is already there (every row without a "toUpload" flag was uploaded and read back) gets
`"toUpload": true`, the file is looked for in the installed pack first and then in --staging (the clips add_language_voice.py wrote).  A row that is already in the list keeps its source.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LANGUAGES = ("de", "es-es", "fr", "it", "ja", "ko", "pl", "pt-br", "ru", "zh-cn")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pack", required=True)
    parser.add_argument("--staging", help="a folder of clips added later by add_language_voice.py (<staging>/<lang>/<kind>/<key>.wav), tried when the pack has no such file")
    parser.add_argument("--out", default=str(REPO / "packaging/voice-language-clips-upload-list.json"))
    args = parser.parse_args()
    out_path = Path(args.out)
    previous = json.loads(out_path.read_text(encoding="utf-8")) if out_path.is_file() else {"rows": []}
    known = {row["path"]: row for row in previous["rows"]}
    rows, per_language = [], {}
    for language in LANGUAGES:
        manifest = json.loads((REPO / "characters/voice-language-clips" / f"{language}.json").read_text(encoding="utf-8"))
        total = 0
        for key, voice in sorted(manifest["voices"].items()):
            path = f"voice-clips/{language}/{voice['file']}"
            old = known.get(path)
            if old is not None:
                if old["sha256"] != voice["sha256"] or old["bytes"] != voice["samples"] * 2 + 44:
                    raise SystemExit(f"{path} changed since it was listed: upload it again under a new name or remove the old row on purpose")
                rows.append(old)
                total += old["bytes"]
                continue
            # the installed pack first, then the staging folder: the first file that has the manifest hash (a pack folder can hold a stale file of a voice its manifest left out)
            candidates = [Path(args.pack) / language / voice["file"]] + ([Path(args.staging) / language / voice["file"]] if args.staging else [])
            source = data = digest = None
            for candidate in candidates:
                if candidate.is_file():
                    found = candidate.read_bytes()
                    if hashlib.sha256(found).hexdigest() == voice["sha256"]:
                        source, data, digest = candidate, found, voice["sha256"]
                        break
            if source is None:
                raise SystemExit(f"{path}: no file with the manifest hash in the pack or the staging folder")
            rows.append({"path": path, "source": str(source), "bytes": len(data), "sha256": digest, "toUpload": True})
            total += len(data)
        per_language[language] = {"files": len(manifest["voices"]), "bytes": total}
    new = sum(1 for row in rows if row.get("toUpload"))
    result = {"repository": "alystria-ai/ai-npc-cyberpunk-mod-packs",
              "note": previous.get("note") or "The bridge downloads voice-clips/<lang>/<picked|archetypes|v-voice>/<key>.wav one clip at a time and checks the SHA-256 against characters/voice-language-clips/<lang>.json.",
              "newFilesToUpload": new, "files": len(rows), "bytes": sum(row["bytes"] for row in rows), "perLanguage": per_language, "rows": rows}
    out_path.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    print(f"{len(rows)} files, {result['bytes'] / 1e6:.1f} MB, {new} to upload")
    for language, row in per_language.items():
        print(f"  {language}: {row['files']} files, {row['bytes'] / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
