"""Rebuild the multi-clip reference sets without phone/holocall clips and write PROPOSED configs (live configs untouched).

Same "most typical" rule as the research agent's builders (E:/CyberpunkConvai-offload/work/likeness-phase1/exp-scripts/
multiref_build.py strategy B = three most typical whole clips <= 18 s; multiref10_build.py strategy C = most typical
clips <= 5 s each, <= 10 s total), with two differences:
  * every clip flagged `phone` in runtime/voice-data-phone-flags.json is removed from the pool, and
  * a voice's "typical" centroid (ECAPA mean) is taken over its phone-free clips (when it has at least 3).
The held-out evaluation lines, duplicate audio and the live reference clip stay excluded exactly as before.

Also proposes phone-free SINGLE references for voices whose live single reference is a phone clip.

Run with vendor/reference-voicestudio/.venv/Scripts/python.exe (needs torch).  Writes:
  <likeness>/out/multiref/sets_nophone.json, sets10_nophone.json and the joined audio under out/multiref/<engine>/{Bnp,Cnp}/
  runtime/{pocket,local}-voices.multiref.nophone.json, runtime/{pocket,local}-voices.multiref10.nophone.json,
  runtime/{pocket,local}-voices.single.nophone.json  and  runtime/voice-references/{multiref,multiref10,single}-nophone-proposed/<engine>/<voice>.wav
"""
import hashlib
import json
import shutil
import sys
from collections import defaultdict

sys.path.insert(0, r"E:\CyberpunkConvai-offload\work\likeness-phase1\exp-scripts")
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402

from common import *  # noqa: E402,F401,F403

FLAGS = json.loads((ROOT / "runtime/voice-data-phone-flags.json").read_text(encoding="utf-8"))
PHONE = {k for k, v in FLAGS["clips"].items() if v["phone"]}
GAP = 0.4
panel = json.loads((OUT / "panel.json").read_text())
held = {t["id"] for e in panel.values() for t in e["targets"]}
rows = load_rows()
live = {"pocket": json.loads((ROOT / "runtime/pocket-voices.json").read_text(encoding="utf-8-sig")),
        "omni": json.loads((ROOT / "runtime/local-voices.json").read_text(encoding="utf-8-sig"))}
emb = torch.load(OUT / "multiref_emb.pt", weights_only=False)

by, seen = defaultdict(list), set()
for r in rows:
    if r["id"] in held or r["sha"] in seen or not (2.0 <= r["duration"] <= 9.0):
        continue
    seen.add(r["sha"])
    by[r["speaker"]].append(r)
missing = [r["id"] for items in by.values() for r in items if r["id"] not in emb]
if missing:
    raise SystemExit(f"{len(missing)} clips have no cached ECAPA embedding (first: {missing[0]}); extend multiref_emb.pt first")


def ranked_pool(spk, ref_sha, max_clip_s=None):
    items = by.get(spk, [])
    if not items:
        return []
    clean = [r for r in items if r["id"] not in PHONE]
    basis = clean if len(clean) >= 3 else items
    centroid = F.normalize(torch.stack([emb[r["id"]] for r in basis]).mean(0), dim=0)
    cands = [r for r in clean if r["sha"] != ref_sha and (max_clip_s is None or r["duration"] <= max_clip_s)]
    return sorted(cands, key=lambda r: -float(emb[r["id"]] @ centroid))


def build(budget, max_clip_s):
    result = {"pocket": {}, "omni": {}}
    for engine in ("pocket", "omni"):
        for spk, v in live[engine]["voices"].items():
            if not isinstance(v, dict) or "reference" not in v:
                continue
            ref_sha = file_sha(ROOT / v["reference"])
            ranked = ranked_pool(spk, ref_sha, max_clip_s)
            parts, texts, ids = [], [], []
            for r in ranked:
                if len(ids) >= 3:
                    break
                w = load_audio(r["path"], 24000, r["start"], r["duration"])
                if sum(len(p) for p in parts) / 24000 + len(parts) * GAP + len(w) / 24000 > budget:
                    continue
                parts.append(w); texts.append(r["transcript"]); ids.append(r["id"])
            if len(parts) < 2:
                continue
            gap = torch.zeros(int(GAP * 24000))
            wav = torch.cat([x for p in parts for x in (p, gap)][:-1])
            tag = "Bnp" if budget == 18 else "Cnp"
            path = OUT / "multiref" / engine / tag / f"{spk}.wav"
            write_wav(path, wav, 24000)
            result[engine][spk] = {"path": str(path), "transcript": " ".join(t.strip() for t in texts), "clips": ids, "seconds": round(len(wav) / 24000, 2)}
    return result


sets18, sets10 = build(18.0, None), build(10.0, 5.0)
(OUT / "multiref" / "sets_nophone.json").write_text(json.dumps({"Bnp": sets18}, indent=1, ensure_ascii=False), encoding="utf-8")
(OUT / "multiref" / "sets10_nophone.json").write_text(json.dumps({"Cnp": sets10}, indent=1, ensure_ascii=False), encoding="utf-8")

old18 = json.loads((OUT / "multiref/sets.json").read_text(encoding="utf-8"))["B"]
old10 = json.loads((OUT / "multiref/sets10.json").read_text(encoding="utf-8"))["C"]


def write_config(engine, live_name, out_name, sets, folder, strategy, old):
    live_path = ROOT / "runtime" / live_name
    config = json.loads(live_path.read_text(encoding="utf-8-sig"))
    dest = ROOT / "runtime/voice-references" / folder / engine
    changed, kept = [], []
    for spk, v in config["voices"].items():
        item = sets[engine].get(spk)
        if not isinstance(v, dict) or "reference" not in v or item is None:
            kept.append(spk)
            continue
        target = dest / f"{spk}.wav"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(item["path"], target)
        v["reference"] = target.relative_to(ROOT).as_posix()
        v["sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
        v["transcript"] = item["transcript"]
        v["multiref"] = {"strategy": strategy, "clips": item["clips"], "seconds": item["seconds"], "phone_free": True}
        changed.append(spk)
    differs = [s for s in changed if old.get(engine, {}).get(s, {}).get("clips") != sets[engine][s]["clips"]]
    config["proposal"] = {"status": "PROPOSED - not active", "based_on": live_name, "based_on_sha256": hashlib.sha256(live_path.read_bytes()).hexdigest(),
                          "strategy": strategy, "phone_free": True, "phone_flags": "runtime/voice-data-phone-flags.json",
                          "voices_changed": len(changed), "voices_kept": kept, "voices_differing_from_previous_proposal": len(differs),
                          "evaluation": "E:/CyberpunkConvai-offload/work/likeness-phase1/out"}
    (ROOT / "runtime" / out_name).write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"changed": len(changed), "kept": kept, "differs_from_previous": len(differs), "differing_voices": differs}


report = {}
for engine, live_name in (("pocket", "pocket-voices.json"), ("omni", "local-voices.json")):
    stem = live_name.replace(".json", "")
    report[f"{engine}_18s"] = write_config(engine, live_name, f"{stem}.multiref.nophone.json", sets18, "multiref-nophone-proposed", "Bnp", old18)
    report[f"{engine}_10s"] = write_config(engine, live_name, f"{stem}.multiref10.nophone.json", sets10, "multiref10-nophone-proposed", "Cnp",
                                           {e: {s: x for s, x in d.items()} for e, d in old10.items()})

# phone-free single references for voices whose live single reference is flagged
singles = {}
for engine, live_name in (("pocket", "pocket-voices.json"), ("omni", "local-voices.json")):
    live_path = ROOT / "runtime" / live_name
    config = json.loads(live_path.read_text(encoding="utf-8-sig"))
    flagged = sorted(v for v, x in FLAGS["live_references"][engine].items() if x["phone"])
    done, none = [], []
    for spk in flagged:
        v = config["voices"][spk]
        pool = [r for r in ranked_pool(spk, file_sha(ROOT / v["reference"])) if 3.0 <= r["duration"] <= 8.0 and len(r["transcript"].split()) >= 4]
        if not pool:
            none.append(spk)
            continue
        r = pool[0]
        wav = load_audio(r["path"], 24000, r["start"], r["duration"])
        target = ROOT / "runtime/voice-references/single-nophone-proposed" / engine / f"{spk}.wav"
        write_wav(target, wav, 24000)
        v["reference"] = target.relative_to(ROOT).as_posix()
        v["sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
        v["transcript"] = r["transcript"].strip()
        v["single_phone_free"] = {"clip": r["id"], "seconds": round(len(wav) / 24000, 2)}
        done.append({"voice": spk, "clip": r["id"], "seconds": round(len(wav) / 24000, 2)})
    config["proposal"] = {"status": "PROPOSED - not active", "based_on": live_name, "based_on_sha256": hashlib.sha256(live_path.read_bytes()).hexdigest(),
                          "kind": "phone-free single references (only the voices whose live single reference is flagged phone are changed)",
                          "voices_changed": [d["voice"] for d in done], "voices_without_phone_free_clip": none}
    if done:                       # nothing to propose (and no file) when no voice has a phone-free alternative
        (ROOT / "runtime" / live_name.replace(".json", ".single.nophone.json")).write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    singles[engine] = {"flagged": flagged, "replaced": done, "none": none}
report["singles"] = singles
print(json.dumps(report, indent=1))
