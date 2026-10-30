"""Write packaging/voice-clips-upload-list.json: the voice clips to put on Hugging Face (alystria-ai/ai-npc-cyberpunk-mod-packs, voice-clips/<kind>/<key>.wav) for players whose game has no English voice files.

    python scripts/voice-extract/upload_list.py [--out packaging/voice-clips-upload-list.json]

Nothing is uploaded.  Each row: the path in the repository, the file in the main checkout it comes from, its size and SHA-256.  The SHA-256 is the one in
characters/voice-clips-manifest.json, which the bridge checks a download against; the script stops if a source file does not have it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MAIN = Path(os.environ.get("CX_MAIN", r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod"))
CONFIGS = {"omni-short": "local-voices.autobest-short.json", "omni-long": "local-voices.autobest-long.json", "pocket": "pocket-voices.autobest.json"}
CAST_SWEEP = Path(os.environ.get("CX_CAST_SWEEP", r"E:\CyberpunkConvai-offload\work\cast-sweep"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=str(REPO / "packaging/voice-clips-upload-list.json"))
    args = parser.parse_args()
    manifest = json.loads((REPO / "characters/voice-clips-manifest.json").read_text(encoding="utf-8"))["voices"]
    configs = {kind: json.loads((MAIN / "runtime" / file).read_text(encoding="utf-8-sig"))["voices"] for kind, file in CONFIGS.items()}
    rows, side = [], []
    for key, kinds in sorted(manifest.items()):
        if not all(kind in kinds for kind in CONFIGS):
            continue                                              # a voice that is not rebuilt in all three kinds stays on the shipped clips
        for kind in CONFIGS:
            spec = kinds[kind] if "sameAs" not in kinds[kind] else kinds[kinds[kind]["sameAs"]]
            if spec.get("group") == "cast-sweep":
                source = CAST_SWEEP / f"{key}.wav"
            else:
                source = MAIN / configs[kind][key]["reference"]
            data = source.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            if digest != spec["sha256"]:
                raise SystemExit(f"{source} does not have the manifest hash")
            row = {"path": f"voice-clips/{kind}/{key}.wav", "source": str(source), "bytes": len(data), "sha256": digest}
            (side if spec.get("group") == "cast-sweep" else rows).append(row)
    total = sum(row["bytes"] for row in rows)
    result = {"repository": "alystria-ai/ai-npc-cyberpunk-mod-packs", "note": "Not uploaded.  The bridge downloads voice-clips/<kind>/<key>.wav and checks the SHA-256 against characters/voice-clips-manifest.json.",
              "files": len(rows), "bytes": total, "castSweepNote": "These 27 side characters have no shipped voice entry yet (no transcript in the voice lists), so nothing reads them; upload with the cast sweep release.",
              "rows": rows, "castSweep": side}
    Path(args.out).write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    print(f"{len(rows)} files, {total / 1e6:.1f} MB; cast sweep rows {len(side)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
