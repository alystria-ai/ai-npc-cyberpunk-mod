"""Voice report v3: the listening page of the 29 characters, with references by DURATION (no clip counts).

  python scripts/clip-search/build_page.py render --columns omni16-short,omni16-long      # needs the GPU
  python scripts/clip-search/build_page.py render --columns omni32-short,omni32-long
  python scripts/clip-search/build_page.py render --columns pocket-base,pocket-v2          # CPU workers
  python scripts/clip-search/build_page.py build                                         # scores + index.html

Columns (user spec): Original | Pocket base | new Pocket student + decoder v2 | OmniVoice 16 short | OmniVoice 16 long |
OmniVoice 32 short | OmniVoice 32 long.  Every model uses the searched references (runtime/autobest-sets.json, schema v2): the
Pocket base and the new student share the Pocket best reference; OmniVoice uses its short (<= 10 s) and long (<= 18 s) sets.
Each character's two held-out game lines are rendered with seed 1042.  Header scores: ECAPA (cosine to the centroid of the
voice's held-out real clips, macro over the voices) first, then PLS (stock Pocket base = 60, OmniVoice 32 long = 90 on these same
voices).  Under each player: the reference length and, for OmniVoice, the predicted added first-audio latency (42 ms per second of
reference at 16 steps, 95 ms at 32), then that line's ECAPA.  Each row lists the clips of the references (each playable) and an
expandable list of the character's available clips; "Change reference" opens the picker's character page (/voice/<key>).
Served read-only at / (and /v3/) by the picker server from --out (default E:/CyberpunkConvai-offload/work/voice-report-v3).
"""
from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
import shutil
import sys
import urllib.parse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from search import LATENCY_MS_PER_SECOND, split_for  # noqa: E402

ROOT = common.ROOT
OUT = Path(r"E:\CyberpunkConvai-offload\work\voice-report-v3")
STUDENT_EXPORT = Path(r"E:\CyberpunkConvai-offload\work\pocket-v2\exports\student-v2-s2000-ema-decv2")
BASE_WEIGHTS = ROOT / "vendor/pocket-tts-training/models/english_2026-09.safetensors"
SEED = 1042

# column id -> (group title, label, engine, reference variant, omni steps)
COLUMNS = {
    "pocket-base": ("Pocket base (stock)", "best length", "pocket", "best", None),
    "pocket-v2": ("New Pocket student + decoder v2", "best length", "pocket", "best", None),
    "omni16-short": ("OmniVoice 16 steps", "short, up to 10 s", "omni", "short", 16),
    "omni16-long": ("OmniVoice 16 steps", "long, up to 18 s", "omni", "long", 16),
    "omni32-short": ("OmniVoice 32 steps", "short, up to 10 s", "omni", "short", 32),
    "omni32-long": ("OmniVoice 32 steps", "long, up to 18 s", "omni", "long", 32),
}
ORDER = list(COLUMNS)
LOW, HIGH = "pocket-base", "omni32-long"


def load_data():
    return json.loads((ROOT / "runtime/autobest-sets.json").read_text(encoding="utf-8"))


def page_lines(index, voice):
    return [l for l in index["voices"][voice]["lines"] if l.get("exists")]


def set_of(data, voice, column):
    _, _, engine, variant, _ = COLUMNS[column]
    return (data["voices"].get(voice, {}).get(engine) or {}).get(variant)


def reference_for(pool, ids):
    path = common.WORK / "refs" / f"{common_hash('|'.join(ids))}.wav"
    if not path.is_file():
        common.build_reference([pool.clip(i)["path"] for i in ids], path)
    return str(path), " ".join(pool.clip(i)["t"].strip() for i in ids)


def common_hash(text):
    import hashlib
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


# ---- render ------------------------------------------------------------------------------------------------------------

def render(args):
    index = common.load_index()
    data = load_data()
    shown = json.loads((ROOT / "scripts/reference-picker/shown-voices.json").read_text(encoding="utf-8"))
    columns = args.columns.split(",")
    for column in columns:
        group, label, engine, variant, steps = COLUMNS[column]
        jobs = []
        for voice in shown:
            chosen = set_of(data, voice, column)
            if not chosen:
                continue
            pool = common.VoicePool(index, voice)
            ref, transcript = reference_for(pool, tuple(chosen["ids"]))
            for li, line in enumerate(page_lines(index, voice)):
                out = args.out / "audio" / column / f"{voice}__{li}.wav"
                if not out.is_file():
                    jobs.append({"ref": ref, "transcript": transcript, "text": line["t"], "seed": SEED, "out": str(out)})
        if not jobs:
            print(f"{column}: nothing to render")
            continue
        if engine == "omni":
            from render import OmniRenderer
            renderer = OmniRenderer(steps)
        elif column == "pocket-base":
            from render import PocketRenderer
            renderer = PocketRenderer(STUDENT_EXPORT, args.workers, 4, weights=BASE_WEIGHTS, tag="pocket-base")
        else:
            from render import PocketRenderer
            renderer = PocketRenderer(STUDENT_EXPORT, args.workers, 4)
        try:
            results = []
            for start in range(0, len(jobs), 40):
                results += renderer.render(jobs[start:start + 40])
                print(f"{column}: {min(start + 40, len(jobs))}/{len(jobs)}", flush=True)
        finally:
            renderer.close()
        failed = [(j["out"], r["error"]) for j, r in zip(jobs, results) if not r["ok"]]
        print(f"{column}: rendered {len(jobs) - len(failed)}, failed {len(failed)} {failed[:3]}")


# ---- build -------------------------------------------------------------------------------------------------------------

CSS = """
:root{color-scheme:dark}
body{font:14px/1.45 system-ui,Segoe UI,sans-serif;margin:16px;background:#111;color:#ddd}
h1{font-size:20px;margin:0 0 6px} h2{font-size:17px;margin:26px 0 4px;display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
h2 a{font-size:13px;font-weight:400;color:#8cf} a{color:#8cf} .note{max-width:1150px;color:#aaa}
table{border-collapse:collapse;margin:6px 0 10px} th,td{border:1px solid #333;padding:4px 6px;vertical-align:top;text-align:center}
th{background:#1d1d1d} th.fam{background:#242424} td.text{text-align:left;max-width:240px;color:#eee}
audio{width:150px;height:30px} .s{font-size:11px;color:#9ab} .refs{margin:2px 0 6px;max-width:1150px}
.refs h3{font-size:13px;margin:8px 0 2px;color:#cde} .clip{display:flex;gap:8px;align-items:center;margin:2px 0}
.clip .t{color:#ccc} .clip .m{color:#89a;font-size:12px;min-width:82px}
details{margin:4px 0} summary{cursor:pointer;color:#9bd} .pool{border-collapse:collapse} .pool td,.pool th{border:1px solid #2c2c2c;text-align:left}
.badge{background:#264;color:#bfb;border-radius:3px;padding:0 4px;font-size:11px;margin-left:4px} .warn{color:#e96}
"""

JS = """
(function(){
  const fmt=(x,d=1)=>x==null?'':Number(x).toFixed(d);
  document.querySelectorAll('details.pool').forEach(det=>{
    det.addEventListener('toggle',async()=>{
      if(!det.open||det.dataset.loaded)return; det.dataset.loaded='1';
      const body=det.querySelector('.poolbody'); body.textContent='Loading…';
      try{
        const key=det.dataset.voice, used=new Set(JSON.parse(det.dataset.used||'[]'));
        const r=await fetch('/api/pool/'+encodeURIComponent(key)); if(!r.ok) throw new Error('HTTP '+r.status);
        const clips=(await r.json()).clips; let limit=150;
        const table=document.createElement('table'); table.className='pool';
        table.innerHTML='<thead><tr><th>Play</th><th>Seconds</th><th>Loudness dB vs usual</th><th>Text</th></tr></thead>';
        const tb=document.createElement('tbody'); table.appendChild(tb);
        const more=document.createElement('button');
        function draw(){
          tb.replaceChildren(...clips.slice(0,limit).map(c=>{
            const tr=document.createElement('tr');
            const au=document.createElement('audio'); au.controls=true; au.preload='none'; au.src=c.audio;
            const td0=document.createElement('td'); td0.appendChild(au);
            const td3=document.createElement('td'); td3.textContent=c.t+' ';
            const id=document.createElement('span'); id.className='s'; id.textContent=c.id.split('/').slice(1).join('/'); td3.appendChild(id);
            if(used.has(c.id)){const b=document.createElement('span'); b.className='badge'; b.textContent='in a reference above'; td3.appendChild(b);}
            tr.append(td0, Object.assign(document.createElement('td'),{textContent:fmt(c.d)}),
              Object.assign(document.createElement('td'),{textContent:c.rel==null?'':(c.rel>0?'+':'')+fmt(c.rel)}), td3);
            return tr;}));
          more.hidden=clips.length<=limit; more.textContent='Show more ('+(clips.length-limit)+' left)';
        }
        more.onclick=()=>{limit+=300;draw();};
        body.replaceChildren(Object.assign(document.createElement('div'),{className:'s',textContent:clips.length+' clips, whole recordings of this character from the game files.'}), table, more);
        draw();
      }catch(e){body.textContent='Could not load the clip list: '+e.message;}
    });
  });
})();
"""


def clip_audio(voice, cid):
    if cid.startswith("live:"):
        return f"/audio/live/{cid.split(':', 1)[1]}/{voice}"
    return f"/audio/clip/{voice}/{urllib.parse.quote(cid, safe='')}"


def build(args):
    from score import Scorer, pls_from_components  # noqa: F401
    from pocket_training import likeness
    import torch
    index = common.load_index()
    data = load_data()
    shown = json.loads((ROOT / "scripts/reference-picker/shown-voices.json").read_text(encoding="utf-8"))
    scorer = Scorer("cuda")
    audio = args.out / "audio"
    (audio / "original").mkdir(parents=True, exist_ok=True)
    per_voice = {}
    for voice in shown:
        pool = common.VoicePool(index, voice)
        split = split_for(index, voice)
        if not split["ok"]:
            continue
        scorer.load_embeddings(common.WORK / "emb" / f"{voice}.json")
        centroid = scorer.targets(pool, split)["centroid"]
        scorer.save_embeddings(common.WORK / "emb" / f"{voice}.json", {str(c["path"]) for c in pool.clips})
        stats = scorer.voice_stats(pool, split)
        per_voice[voice] = {"pool": pool, "centroid": centroid, "stats": stats, "lines": page_lines(index, voice)}
        for li, line in enumerate(per_voice[voice]["lines"]):
            dest = audio / "original" / f"{voice}__{li}.wav"
            if not dest.is_file():
                shutil.copy2(line["path"], dest)
    files = {}     # (column, voice, line) -> path
    for column in ["original"] + ORDER:
        for voice, info in per_voice.items():
            for li in range(len(info["lines"])):
                path = audio / column / f"{voice}__{li}.wav"
                if path.is_file() and (column == "original" or set_of(data, voice, column)):
                    files[(column, voice, li)] = path
    ecapa, rows = {}, {}
    for (column, voice, li), path in files.items():
        ecapa[(column, voice, li)] = float(scorer.embed(path) @ per_voice[voice]["centroid"])
    metrics = {}
    for column in ["original"] + ORDER:
        lines = [(voice, scorer.features(files[(column, voice, li)]), scorer.features(per_voice[voice]["lines"][li]["path"]))
                 for voice, info in per_voice.items() for li in range(len(info["lines"])) if (column, voice, li) in files]
        if not lines:
            continue
        m = likeness.condition_metrics(lines, {v: i["stats"] for v, i in per_voice.items()})
        by_voice = {}
        for (c, v, li), e in ecapa.items():
            if c == column:
                by_voice.setdefault(v, []).append(e)
        m["ecapa"] = sum(sum(x) / len(x) for x in by_voice.values()) / len(by_voice)
        m["ecapa_voices"] = len(by_voice)
        metrics[column] = m
    # PLS with the October 5 study's fixed anchors (stock Pocket 1 clip = 60, OmniVoice 32 1 clip = 90, 67 voices), so pages stay
    # comparable. The original has no PLS: its same-line distance is zero by definition.
    pls = {c: pls_from_components(m) for c, m in metrics.items() if c != "original"}
    # reference length and latency averages per column
    def average_seconds(column):
        if column == "original":
            return None
        values = [set_of(data, v, column)["seconds"] for v in per_voice if set_of(data, v, column)]
        return sum(values) / len(values) if values else None

    def latency_text(column, seconds):
        steps = COLUMNS[column][4]
        if steps is None or seconds is None:
            return ""
        return f" · +{LATENCY_MS_PER_SECOND[str(steps)] * seconds / 1000:.2f} s"

    def head(column):
        m = metrics.get(column, {})
        e, p = m.get("ecapa"), pls.get(column)
        score = f"ECAPA {e:.3f}" + (f" · PLS {p:.1f}" if p is not None else "") if e is not None else ""
        seconds = average_seconds(column)
        extra = f"<br><span class='s'>avg {seconds:.1f} s{latency_text(column, seconds)}</span>" if seconds else ""
        return f"<br><span class='s'>{score}</span>{extra}"

    shown_here = [v for v in shown if v in per_voice]
    out = ["<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>",
           f"<title>Voice report v3</title><style>{CSS}</style></head><body>", "<h1>Voice report v3</h1>",
           "<p class='note'>Every column speaks the original game line's text; those two lines per character are held out from every "
           "model's training and from every reference search. <b>References are chosen by total length, not clip count</b>, by an "
           "automatic search (speaker similarity first). <b>Pocket base</b> (the stock model) and the <b>new Pocket student + decoder v2</b> "
           "use the same best-length reference; OmniVoice uses a <b>short</b> (up to 10 s) and a <b>long</b> (up to 18 s) one, at 16 and at "
           "32 steps. Under each header: ECAPA (speaker identity: cosine to the centroid of the character's held-out real clips, higher is "
           "better) first, then PLS (perceptual likeness; the study's scale where stock Pocket with one clip = 60 and OmniVoice 32 with one clip = 90; the new student matches each original line's delivery closely, which the PLS delivery part rewards), both averaged over "
           f"the {len(shown_here)} characters, then the average reference length and, for OmniVoice, the predicted added first-audio latency "
           "(42 ms per second of reference at 16 steps, 95 ms at 32). Under each player: this reference's length and that line's ECAPA. "
           "Adam Smasher's references come only from the 11 clips the user chose, searched on his two lines (overfitting on purpose).</p>"]
    head1 = "<tr><th rowspan=2>Line (original text)</th><th rowspan=2>Original" + head("original") + "</th>"
    groups = []
    for column in ORDER:
        title = COLUMNS[column][0]
        if groups and groups[-1][0] == title:
            groups[-1][1] += 1
        else:
            groups.append([title, 1])
    head1 += "".join(f"<th class='fam' colspan={n}>{html.escape(t)}</th>" for t, n in groups) + "</tr>"
    head2 = "<tr>" + "".join(f"<th>{html.escape(COLUMNS[c][1])}{head(c)}</th>" for c in ORDER) + "</tr>"
    for voice in shown_here:
        info = per_voice[voice]
        pool = info["pool"]
        name = voice.replace("-", " ").title()
        out.append(f"<h2>{html.escape(name)} <a href='/voice/{voice}' target='_blank' rel='noopener'>Change reference ↗</a></h2>")
        out.append(f"<table>{head1}{head2}")
        for li, line in enumerate(info["lines"]):
            cells = [f"<td class='text'>{html.escape(line['t'])}</td>"]
            for column in ["original"] + ORDER:
                path = files.get((column, voice, li))
                if path is None:
                    cells.append("<td>—</td>")
                    continue
                src = f"audio/{column}/{voice}__{li}.wav"
                sub = ""
                if column != "original":
                    chosen = set_of(data, voice, column)
                    sub = f"<br><span class='s'>{chosen['seconds']:.1f} s{latency_text(column, chosen['seconds'])} · ECAPA {ecapa[(column, voice, li)]:.2f}</span>"
                cells.append(f"<td><audio controls preload='none' src='{src}'></audio>{sub}</td>")
            out.append("<tr>" + "".join(cells) + "</tr>")
        out.append("</table><div class='refs'>")
        used = []
        shown_refs = [("Pocket reference (Pocket base and the new student): best length", "pocket", "best"),
                      ("OmniVoice short reference (up to 10 s)", "omni", "short"), ("OmniVoice long reference (up to 18 s)", "omni", "long")]
        for title, engine, variant in shown_refs:
            chosen = (data["voices"].get(voice, {}).get(engine) or {}).get(variant)
            if not chosen:
                continue
            note = ""
            today = (data["voices"][voice][engine] or {}).get("today")
            if today:
                note = f" · today's single reference: {today['seconds']:.1f} s, ECAPA {today['ecapa']:.3f}"
            out.append(f"<h3>{html.escape(title)}: {chosen['seconds']:.1f} s in total · searched ECAPA {chosen['ecapa']:.3f}{note}</h3>")
            for cid in chosen["ids"]:
                used.append(cid)
                clip = pool.by_id.get(cid)
                text = clip["t"] if clip else cid
                dur = clip["d"] if clip else 0
                out.append(f"<div class='clip'><audio controls preload='none' src='{clip_audio(voice, cid)}'></audio>"
                           f"<span class='m'>{dur:.1f} s</span><span class='t'>{html.escape(text)}</span></div>")
        usable = [c for c in pool.clips if not c.get("fx")]
        out.append(f"<details class='pool' data-voice='{voice}' data-used='{html.escape(json.dumps(sorted(set(used))))}'>"
                   f"<summary>Available clips ({len(usable)})</summary><div class='poolbody'></div></details></div>")
    out.append(f"<script>{JS}</script></body></html>")
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "index.html").write_text("\n".join(out), encoding="utf-8")
    summary = {c: {"ecapa": round(m["ecapa"], 4), "pls": round(pls[c], 1) if pls.get(c) is not None else None, "voices": m.get("voices")}
               for c, m in metrics.items()}
    (args.out / "scores.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    print(json.dumps({"page": str(args.out / "index.html"), "voices": len(shown_here), "scores": summary}))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("stage", choices=["render", "build"])
    parser.add_argument("--columns", default=",".join(ORDER))
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args(argv)
    if args.stage == "render":
        render(args)
    else:
        build(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
