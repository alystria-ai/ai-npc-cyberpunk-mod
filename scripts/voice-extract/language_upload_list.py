"""Write packaging/voice-language-clips-upload-list.json: the dubbed clips to put on Hugging Face (alystria-ai/ai-npc-cyberpunk-mod-packs, voice-clips/<lang>/<kind>/<key>.wav) for players whose game has no voice files of that language.

    python scripts/voice-extract/language_upload_list.py --pack <voices/multilingual folder> [--out packaging/voice-language-clips-upload-list.json]

Nothing is uploaded by this script.  Each row: the path in the repository, the installed pack file it comes from, its size and SHA-256.  The SHA-256 is the one in
characters/voice-language-clips/<lang>.json, which the bridge checks a download against; the script stops if a source file does not have it.  The folder name <lang> is the pack's
(de, es-es, fr, it, ja, ko, pl, pt-br, ru, zh-cn).  Once the owner has uploaded the files and read every size and hash back, remove the "toUpload" flags.
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
    rows, per_language = [], {}
    for language in LANGUAGES:
        manifest = json.loads((REPO / "characters/voice-language-clips" / f"{language}.json").read_text(encoding="utf-8"))
        total = 0
        for key, voice in sorted(manifest["voices"].items()):
            source = Path(args.pack) / language / voice["file"]
            if not source.is_file() and args.staging:
                source = Path(args.staging) / language / voice["file"]
            data = source.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if digest != voice["sha256"]:
                raise SystemExit(f"{source} does not have the manifest hash")
            rows.append({"path": f"voice-clips/{language}/{voice['file']}", "source": str(source), "bytes": len(data), "sha256": digest, "toUpload": True})
            total += len(data)
        per_language[language] = {"files": len(manifest["voices"]), "bytes": total}
    result = {"repository": "alystria-ai/ai-npc-cyberpunk-mod-packs",
              "note": "Not uploaded yet. The bridge downloads voice-clips/<lang>/<picked|archetypes|v-voice>/<key>.wav one clip at a time and checks the SHA-256 against characters/voice-language-clips/<lang>.json. Nothing else on the repository changes: the multilingual/Voices-<Language>.zip packs stay for the players who have them.",
              "files": len(rows), "bytes": sum(row["bytes"] for row in rows), "perLanguage": per_language, "rows": rows}
    Path(args.out).write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    print(f"{len(rows)} files, {result['bytes'] / 1e6:.1f} MB")
    for language, row in per_language.items():
        print(f"  {language}: {row['files']} files, {row['bytes'] / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
