"""Choose the long/short/pocket sets for jake-estevez and 8ug8ear from the analysed clips, build the reference WAVs (whole clips, 0.4 s gaps,
mono 24 kHz torchaudio resample, 16-bit PCM: the clip-search recipe) and write candidate configs into the scratchpad (validated before they replace the
live autobest configs)."""
import itertools, json, sys, hashlib, shutil
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod")
sys.path.insert(0, str(ROOT / "scripts/clip-search"))
from common import build_reference, joined_seconds, words
WORK = Path("E:/CyberpunkConvai-offload/work/clip-search/missing-two")
SP = Path(sys.argv[1])
an = json.loads((WORK / "analysis.json").read_text("utf-8"))
man = {r["stringId"]: r for r in json.loads((WORK / "extract-manifest.json").read_text("utf-8"))}
BUDGET = {"omni-short": (7.0, 10.0), "omni-long": (12.0, 18.0), "pocket": (12.0, 18.0)}

def pick(key, lo, hi):
    clips = [c for c in an[key]["clips"] if 1.5 <= c["seconds"] <= 9 and words(c["text"]) >= 3 and c["ecapaToOthers"] >= 0.55]
    med = sorted(c["gatedRmsDb"] for c in an[key]["clips"])[len(an[key]["clips"]) // 2]
    clips = [c for c in clips if abs(c["gatedRmsDb"] - med) <= 2.0 and c["peakDbfs"] <= -3.0 and c["clipped"] == 0]
    best = None
    for n in range(1, len(clips) + 1):
        for combo in itertools.combinations(clips, n):
            total = joined_seconds(c["seconds"] for c in combo)
            if not lo <= total <= hi: continue
            typ = sum(c["seconds"] * c["ecapaToOthers"] for c in combo) / sum(c["seconds"] for c in combo)
            score = typ + 0.004 * total
            if best is None or score > best[0]: best = (score, typ, total, combo)
    return best, clips

result = {}
for key in ("jake-estevez", "8ug8ear"):
    for kind in ("omni-short", "omni-long"):
        lo, hi = BUDGET[kind]
        best, usable = pick(key, lo, hi)
        score, typ, total, combo = best
        print(key, kind, "usable", [c["id"][-6:] for c in usable], "->", [(c["id"], c["seconds"], c["text"][:40]) for c in combo], f"total {total:.2f} typ {typ:.3f}")
        result[(key, kind)] = combo
    result[(key, "pocket")] = result[(key, "omni-long")]

out_root = ROOT / "runtime/voice-references/picked/autobest"
entries = {"omni-short": {}, "omni-long": {}, "pocket": {}}
for (key, kind), combo in result.items():
    paths = [man[c["id"]]["wavPath"] for c in combo]
    wav = out_root / kind / f"{key}.wav"
    seconds = build_reference(paths, wav)
    transcript = " ".join(c["text"].strip() for c in combo)
    data = wav.read_bytes()
    ids = [f"{key}/{c['id']}" for c in combo]
    ec = sum(c["seconds"] * c["ecapaToOthers"] for c in combo) / sum(c["seconds"] for c in combo)
    entries[kind][key] = {"reference": f"runtime/voice-references/picked/autobest/{kind}/{key}.wav", "sha256": hashlib.sha256(data).hexdigest(),
        "transcript": transcript, "transcriptSha256": hashlib.sha256(transcript.encode("utf-8")).hexdigest(), "status": "ready",
        "pick": {"clips": ids, "seconds": round(seconds, 2), "keptAt": "2026-10-13T00:00:00+00:00",
                 "note": f"hand-extracted (no pool clips; lines found in the scene files and voice archive): {round(seconds, 2)} s, ECAPA leave-one-out typicality {ec:.3f}"}}
    print(kind, key, round(seconds, 3), "s", wav)

files = {"omni-short": "local-voices.autobest-short.json", "omni-long": "local-voices.autobest-long.json", "pocket": "pocket-voices.autobest.json"}
for kind, name in files.items():
    cfg = json.loads((ROOT / "runtime" / name).read_text("utf-8"))
    for key, entry in entries[kind].items():
        assert cfg["voices"][key] == {"status": "unprepared"}, (name, key, cfg["voices"][key])
        cfg["voices"][key] = entry
    (SP / name).write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
(SP / "entries.json").write_text(json.dumps({f"{k}|{kk}": vv for k, v in entries.items() for kk, vv in v.items()}, indent=1, ensure_ascii=False), encoding="utf-8")
