"""Extract candidate lines of the player character V (English; male V = Gavin Drea, female V = Cherami Leigh) from the installed
game archives, for the "speak the player's typed lines in V's voice" reference clips.  Adapted from
scripts/clip-search/delamain/extract_delamain.py.  CPU only; writes files, plays nothing, never writes to the game folder.

Usage (any python with numpy; the Oodle dll and vgmstream-cli paths below must exist):
    python scripts/clip-search/v-voice/extract_v.py GENDER OUT_DIR [--max N] [--seed S] [--list]
GENDER is male or female.  V's lines are the WEM files whose stem starts with "v_"; the suffix before the hex string id is
V's gender (_f_ = female V, _m_ = male V).  Only calm quest dialogue is considered: the scene part of the stem must start with a
main/side quest id (q###, sq###, mq###, or ep1), any effect/special-state token (vset, posessed, phone, holocall, braindance,
radio, helmet, mask, flashback, relic, johnny, underwater, whisper, scream, sts, ...) refuses the file, and the subtitle must be a
plain complete sentence (no markup, brackets, digits, ellipsis, exclamation, swearing, mojibake, rare names or in-world slang).
The candidates are a random sample of at most N (default 700) of the files that pass; --list only prints the counts.
Subtitle text: the female column for female V; for male V the male column when it holds a variant, else the female column
(the table keeps one text with an optional male variant).  Writes <OUT_DIR>/<stringId>.wem/.wav and extract-manifest.json.
"""
import argparse, importlib.util, json, random, re, sqlite3, subprocess, sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
REPO = Path(__file__).resolve().parents[3]
MAIN = Path(r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod")          # runtime/ and research/ caches live in the main checkout
GAME = Path("E:/SteamLibrary/steamapps/common/Cyberpunk 2077")
VGM = r"E:\misc\misc1\modding\fmodel\Output\.data\vgmstream-cli.exe"
VOICE_ARCHIVES = ("archive/pc/content/lang_en_voice.archive", "archive/pc/ep1/lang_en_voice.archive")

BAD_TOKENS = {"vs", "vset", "posessed", "possessed", "phone", "holocall", "holo", "call", "calls", "braindance", "bd", "radio", "helmet",
              "mask", "flashback", "relic", "johnny", "underwater", "whisper", "scream", "screams", "sts", "tv", "media", "scanner",
              "hologram", "intercom", "comm", "voicelines", "interactive", "interactions", "template", "play", "melee", "impulse",
              "female", "male", "final", "finalboards", "funeral", "totentanz", "nok", "mws", "ue", "v3"}
SWEAR = {"fuck", "fucking", "fuckin", "fucked", "shit", "shitty", "damn", "damned", "goddamn", "hell", "ass", "asshole", "bitch", "bastard",
         "dick", "piss", "crap", "cunt", "motherfucker", "bullshit", "dammit", "kill", "kills", "killed", "die", "dead", "death", "dying",
         "blood", "shoot", "gun", "bomb", "suicide", "rape", "whore", "slut", "hooker", "hookers", "junkie", "drug", "drugs"}
SLANG = {"choom", "gonk", "gonks", "nova", "preem", "delta", "netrunner", "netrunners", "chrome", "eddies", "eddie", "corpo", "corpos",
         "cyberpsycho", "cyberpsychos", "braindance", "braindances", "scav", "scavs", "chombatta", "flatline", "flatlined", "nomad",
         "nomads", "solo", "solos", "edgerunner", "edgerunners", "ripperdoc", "cyberware", "implant", "implants", "virtu", "relic",
         "biochip", "cyberdeck", "daemon", "daemons", "netwatch", "afterlife", "militech", "arasaka", "bd", "bds", "fixer", "fixers",
         "tyger", "tygers", "claws", "valentinos", "maelstrom", "maelstrom's", "voodoo", "boys", "mox", "joytoys", "megabuilding",
         "megabuildings", "badlands", "ai", "algo", "algos", "blackwall", "chip", "ncpd", "trauma", "gig", "gigs", "psycho"}

STEM_RE = re.compile(r"^v_(.+)_(f|m)_([0-9a-f]{16})$")
SCENE_RE = re.compile(r"^(q\d+|sq\d+|mq\d+|ep1)$")


def stem_ok(scene: str) -> bool:
    toks = scene.split("_")
    return bool(SCENE_RE.match(toks[0])) and not (set(toks) & BAD_TOKENS)


def text_ok(t: str) -> bool:
    """Plain complete everyday-English sentence(s) of 7-17 words."""
    t = t.strip().replace("\u2019", "'")
    if not t or not t.isascii() or "\ufffd" in t or "LocKey" in t:
        return False
    if re.search(r"[\[\]<>{}|_/\\*#@~^\d!&;:\"()]|\.\.\.|--| - |\s{2}", t):
        return False
    if t[-1] not in ".?":
        return False
    words = re.findall(r"[A-Za-z']+", t)
    if not 7 <= len(words) <= 17:
        return False
    low = {w.lower().strip("'") for w in words}
    if low & SWEAR or low & SLANG:
        return False
    # capitalised words other than "I..." and sentence starts are names: refuse
    for m in re.finditer(r"[A-Za-z']+", t):
        w = m.group(0)
        if w[0].isupper() and not (w == "I" or w.startswith("I'")):
            before = t[:m.start()].rstrip()
            if before and before[-1] not in ".?":
                return False
        if len(w) > 1 and w.isupper() and w != "OK":
            return False
    if re.search(r"\b(uh|um|hm+|hmph|huh|ah|oh|ugh|mm+|er|uhh|umm|ahh)\b", t, re.I) and len(words) < 10:
        return False
    return True


def candidates(gender: str):
    suffix = "f" if gender == "female" else "m"
    lists = [(MAIN / f"runtime/voice-cast-inventory-20261001/{l}-wem-paths.txt").read_text("utf-8").splitlines() for l in ("base", "ep1")]
    db = sqlite3.connect("file:" + (MAIN / "research/cyberpunk/cache/game/localization/index/lookup.sqlite3").as_posix() + "?mode=ro", uri=True)
    out, seen, counts = [], set(), {"v_files_gender": 0, "scene_ok": 0, "text_ok": 0}
    for p in sorted({p for l in lists for p in l if "\\vo\\" in p}):
        name = p.split("\\vo\\")[-1]
        if not name.startswith("v_") or not name.endswith(".wem"):
            continue
        m = STEM_RE.match(name[:-4])
        if not m or m.group(2) != suffix:
            continue
        counts["v_files_gender"] += 1
        scene, hexid = m.group(1), m.group(3)
        if not stem_ok(scene):
            continue
        counts["scene_ok"] += 1
        sid = str(int(hexid, 16))
        row = db.execute("select female,male from entries where domain='subtitle.stringId' and entry_id=?", (sid,)).fetchone()
        if not row:
            continue
        fem, mal = (row[0] or "").strip(), (row[1] or "").strip()
        text = fem if gender == "female" else (mal or fem)
        if not text_ok(text) or sid in seen:
            continue
        seen.add(sid)
        counts["text_ok"] += 1
        out.append({"stringId": sid, "stem": name, "scene": scene, "wemPath": p, "transcript": text.replace("\u2019", "'"),
                    "otherVariant": (fem if gender == "male" else mal) if (fem != mal and fem and mal) else ""})
    return out, counts


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("gender", choices=("male", "female"))
    ap.add_argument("out_dir")
    ap.add_argument("--max", type=int, default=700)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    cands, counts = candidates(a.gender)
    print(a.gender, counts, "candidates", len(cands))
    random.Random(a.seed).shuffle(cands)
    cands = cands[: a.max]
    if a.list:
        for c in cands[:40]:
            print(" ", c["stringId"], c["scene"], "|", c["transcript"])
        return
    spec = importlib.util.spec_from_file_location("ext", REPO / "scripts/Extract-VoiceReferences.py")
    ext = importlib.util.module_from_spec(spec); spec.loader.exec_module(ext)
    out = Path(a.out_dir); out.mkdir(parents=True, exist_ok=True)
    oodle = ext.Oodle(GAME / "tools/redmod/bin/oo2ext_7_win64.dll")
    archives = [ext.Archive(GAME, r) for r in VOICE_ARCHIVES]
    manifest = []
    for i, c in enumerate(cands):
        matches = [m for ar in archives if (m := ar.read(c["wemPath"], oodle))]
        if len(matches) != 1:
            print("  skip (archives matched %d)" % len(matches), c["stem"]); continue
        data, src = matches[0]
        if data[:4] != b"RIFF":
            print("  skip (not RIFF)", c["stem"]); continue
        wem, wav = out / f"{c['stringId']}.wem", out / f"{c['stringId']}.wav"
        wem.write_bytes(data)
        r = subprocess.run([VGM, "-i", "-o", str(wav), str(wem)], capture_output=True, text=True, creationflags=0x08000000)
        if r.returncode != 0:
            print("  skip (vgmstream failed)", c["stem"], r.stderr[:80]); continue
        c.update({"source": src, "wavPath": str(wav).replace("\\", "/")})
        manifest.append(c)
        if i % 100 == 0:
            print(f"  {i}/{len(cands)}", flush=True)
    (out / "extract-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print("extracted", len(manifest), "->", out)


if __name__ == "__main__":
    main()
