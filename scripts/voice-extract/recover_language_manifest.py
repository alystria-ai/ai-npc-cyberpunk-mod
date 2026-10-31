"""Recover how every clip of a multilingual voice pack was made and write the manifest bridge/voice_clip_build.py builds it again from.

    python -I scripts/voice-extract/recover_language_manifest.py --lang de --pack <voices/multilingual folder> --out characters/voice-language-clips/de.json
            [--stash E:/SteamLibrary/AiNpc-vo-stash] [--lists <folder of WolvenKit listings>] [--vgmstream <vgmstream-cli.exe>] [--keys a,b] [--report report.json]

The packs (docs/VOICE_LANGUAGE_PACKS.md) record, per voice, the dub's line ids in order, the subtitles and the SHA-256 of the clip.  What they do not record is the
dub's file for each id, how the line was resampled, and the gain of the 44 voices that have a loudness stage.  This tool finds them from the installed pack and the
dub's own voice archives (read only) and keeps a recipe only when the clip is reproduced sample for sample (the SHA-256 of the 16-bit WAV equals the shipped one).

Per voice: every dub file that carries a line id is a candidate (the name listing of the archive comes from WolvenKit, only for this recovery; the player's PC never
lists an archive, the manifest names the paths); the candidate sets are tried in order with the resamplers `pack` and `pack64` (V: `packv`); a clip that is off by a
gain gets the exact linear factor from the samples.  A voice with no exact recipe is written with `exact: false` and stays download only.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import os
import re
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "bridge"))
import voice_clip_build as V  # noqa: E402

MAIN = Path(os.environ.get("CX_MAIN", r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod"))
WK = MAIN / "vendor/wolvenkit-console-9.0.1/WolvenKit.CLI.exe"
DOTNET = MAIN / "vendor/dotnet-runtime-10.0.12"
VGM_DEFAULT = r"E:\misc\misc1\modding\fmodel\Output\.data\vgmstream-cli.exe"
LOCALES = {"fr": "fr-fr", "it": "it-it", "de": "de-de", "es-es": "es-es", "ja": "jp-jp", "ko": "kr-kr", "pl": "pl-pl", "pt-br": "pt-br", "ru": "ru-ru", "zh-cn": "zh-cn"}
ARCHIVE_NAME = {"pt-br": "pt"}
WEM = re.compile(r"^(?P<top>[^\\/]+)\\localization\\(?P<loc>[^\\/]+)\\(?P<rest>(?P<vo>vo[^\\/]*)\\(?P<stem>.+?)_(?P<fm>[fm])_(?P<hex>[0-9a-f]{16})(?P<tail>[^\\/]*)\.wem)$")
MAX_COMBINATIONS = 64


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as handle:
        assert handle.getnchannels() == 1 and handle.getsampwidth() == 2 and handle.getframerate() == V.RATE, path
        return np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2")


def wav_bytes(samples: np.ndarray) -> bytes:
    import io
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(V.RATE)
        handle.writeframes(samples.astype("<i2").tobytes())
    return buffer.getvalue()


def listing(lang: str, sub: str, lists: Path) -> list[str]:
    cache = lists / f"{lang}-{sub}.txt"
    if not cache.is_file() or cache.stat().st_size < 1000:
        lists.mkdir(parents=True, exist_ok=True)
        archive = Path(os.environ.get("CX_STASH", "E:/SteamLibrary/AiNpc-vo-stash")) / lang / sub / f"lang_{ARCHIVE_NAME.get(lang, lang)}_voice.archive"
        env = dict(os.environ, DOTNET_ROOT=str(DOTNET))
        with open(cache, "w", encoding="utf8") as out:
            subprocess.run([str(WK), "archive", str(archive), "-l"], stdout=out, env=env, check=True, creationflags=0x08000000 | 0x00004000)
    return [line.strip() for line in cache.read_text(encoding="utf-8").splitlines() if line.strip().endswith(".wem")]


def hex_index(lang: str, lists: Path) -> dict[str, list[tuple[str, str]]]:
    """{line id: [(archive, path under localization\\<locale>\\)...]} for the voice files of the dub."""
    index: dict[str, list[tuple[str, str]]] = {}
    for sub, top in V.LANGUAGE_TOP.items():
        for path in listing(lang, sub, lists):
            m = WEM.match(path)
            if m and m["top"] == top and m["loc"] == LOCALES[lang]:
                index.setdefault(m["hex"], []).append((sub, m["rest"]))
    return index


def english_hints(voice: str, hints: dict) -> dict[str, tuple]:
    """{line id: (vo, stem, fm)} of the English line the pack builder started from (scripts/voice-packs/line-lists.json)."""
    return {line["hex"]: (line["vo"], line["stem"], line["fm"]) for line in (hints.get(voice) or {}).get("lines", [])}


def ordered(candidates: list[tuple[str, str]], hint: tuple | None) -> list[tuple[str, str]]:
    if not hint:
        return sorted(candidates)
    vo, stem, fm = hint
    def rank(candidate):
        m = WEM.match(f"base\\localization\\x\\{candidate[1]}")
        return (0 if m and m["vo"] == vo and m["stem"] == stem and m["fm"] == fm else 1 if m and m["vo"] == vo and m["fm"] == fm else 2, candidate)
    return sorted(candidates, key=rank)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lang", required=True)
    ap.add_argument("--pack", required=True, help="the installed voices/multilingual folder")
    ap.add_argument("--out", required=True)
    ap.add_argument("--stash", default="E:/SteamLibrary/AiNpc-vo-stash")
    ap.add_argument("--lists", default=str(Path(os.environ.get("TEMP", ".")) / "ainpc-dub-lists"))
    ap.add_argument("--vgmstream", default=VGM_DEFAULT)
    ap.add_argument("--keys", default="")
    ap.add_argument("--report")
    args = ap.parse_args()
    lang, started = args.lang, time.time()
    os.environ["CX_STASH"] = args.stash
    pack = Path(args.pack) / lang
    installed = json.loads((pack / "manifest.json").read_text(encoding="utf-8-sig"))
    hints = json.loads((REPO / "scripts/voice-packs/line-lists.json").read_text(encoding="utf-8"))["voices"]
    oodle = V.Oodle(Path("E:/SteamLibrary/steamapps/common/Cyberpunk 2077"))
    archives = {sub: V.Archive(Path(args.stash) / lang / sub / f"lang_{ARCHIVE_NAME.get(lang, lang)}_voice.archive", oodle) for sub in V.LANGUAGE_TOP}
    index = hex_index(lang, Path(args.lists))
    vgm = Path(args.vgmstream)
    locale = LOCALES[lang]
    only = set(filter(None, args.keys.split(",")))
    cache: dict = {}
    voices, report = {}, {}
    for key, row in sorted(installed["voices"].items()):
        if only and key not in only:
            continue
        shipped_path = pack / row["file"]
        shipped = read_wav(shipped_path)
        shipped_sha = hashlib.sha256(shipped_path.read_bytes()).hexdigest()
        kind = row["file"].split("/")[0]
        entry = {"kind": kind, "file": row["file"], **({"gender": row["gender"]} if row.get("gender") else {}), "text": row["text"], "seconds": row["seconds"],
                 "samples": int(len(shipped)), "sha256": row["sha256"]}
        info = {"manifestSha": row["sha256"] == shipped_sha}
        hint = english_hints(key, hints)
        sets = [ordered(index.get(h, []), hint.get(h)) for h in row["lines"]]
        found = None
        if all(sets):
            hows = ["packv"] if kind == "v-voice" else ["pack", "pack64"]
            tried = 0
            for combo in itertools.product(*sets):
                tried += 1
                if tried > MAX_COMBINATIONS:
                    break
                for how in hows:
                    spec = {"lines": [list(c) for c in combo], "how": how}
                    try:
                        joined = V.joined_language_clip(spec, locale, archives, vgm, cache)
                    except V.BuildError as error:
                        info["error"] = str(error)
                        continue
                    made = V.quantise_pack(joined)
                    if len(made) == len(shipped) and np.array_equal(made, shipped):
                        found = {**spec, "gain": None}
                    else:
                        gain = V.exact_pack_gain(joined, shipped)
                        if gain is not None and np.array_equal(V.quantise_pack(joined, gain), shipped):
                            found = {**spec, "gain": gain}
                    if found:
                        break
                    if len(made) == len(shipped):
                        d = np.abs(made.astype(np.int32) - shipped.astype(np.int32))
                        info["closest"] = {"how": how, "maxDiff": int(d.max()), "differing": int((d > 0).sum())}
                    else:
                        info["closest"] = {"how": how, "samples": [int(len(made)), int(len(shipped))]}
                if found:
                    break
            info["combinations"] = tried
        else:
            info["missing"] = [h for h, s in zip(row["lines"], sets) if not s]
        if found and hashlib.sha256(wav_bytes(V.build_language_clip(found, locale, archives, vgm, cache))).hexdigest() == row["sha256"]:
            entry.update(exact=True, how=found["how"], gain=found["gain"], lines=found["lines"])
        else:
            entry.update(exact=False)
        voices[key] = entry
        report[key] = {"exact": entry["exact"], **info}
        if len(voices) % 25 == 0:
            print(f"{lang}: {len(voices)}/{len(installed['voices'])} voices, {sum(v['exact'] for v in voices.values())} exact, {round(time.time() - started)} s", flush=True)
    manifest = {"version": 1, "language": lang, "locale": locale, "archive": f"lang_{ARCHIVE_NAME.get(lang, lang)}_voice.archive",
                "languageTag": installed["languageTag"], "gameLanguage": installed.get("gameLanguage"), "built": installed.get("built"), "voices": voices}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    exact = sum(v["exact"] for v in voices.values())
    print(f"{lang}: {exact} of {len(voices)} voices rebuild sample for sample, {len(voices) - exact} stay download only, {round(time.time() - started)} s")
    if args.report:
        Path(args.report).write_text(json.dumps({"lang": lang, "exact": exact, "total": len(voices), "voices": report}, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
