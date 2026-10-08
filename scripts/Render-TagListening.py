"""Offline listening test of OmniVoice non-verbal tags, rendered the way the game renders them.

A separate process: it never touches the bridge, the game or the resident worker. It mirrors render() in
bridge/resident-voice-worker.py: the pinned k2-fsa/OmniVoice snapshot, FP16 on CUDA, the live "Omni short" profile
(runtime/voice-configs.json -> omni.short), guidance_scale 2.0, speed 1, denoise off, no post-processing, 16 steps.
The bridge's CUDA-graph replay (a speed optimization) is not used. The game seeds every request with 1042; this test
renders each line with two seeds (1042 and 2077) so one bad sample is not mistaken for a bad tag.

Run with vendor/reference-voicestudio/.venv/Scripts/python.exe:
    python scripts/Render-TagListening.py [--out runtime/tag-listening] [--page <html>] [--steps 16] [--page-only]

Writes <out>/<id>.wav and a self-contained listening page (audio embedded as base64 FLAC).
Existing WAVs are reused, so an interrupted run resumes.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import html
import io
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
SEEDS = (1042, 2077)

# (group, character, language, text with tag or None for a control built by removing the tag, kind)
# Each entry: group title, voice key, language name for OmniVoice, text
Q_OH = [
    "You took the job anyway? [question-oh] Without even checking who posted it?",
    "So you walked in through the front door, [question-oh] and nobody stopped you?",
    "Nobody told me about that. [question-oh] When did this happen?",
]
Q_AH = [
    "[question-ah] Wait, you mean the guy from the Afterlife?",
    "That was the plan all along, [question-ah] or did you make it up on the way?",
    "He said the deal was off. [question-ah] So who is paying for the damage?",
]
CONFIRM = [
    "[confirmation-en] Yeah, that sounds about right.",
    "I get it. [confirmation-en] You do not have to explain.",
    "Leave it with me, [confirmation-en] I will sort it out by morning.",
]
COMPARE = {
    "laughter": ["Six hours in a car with him? [laughter] You are braver than I am.",
                 "[laughter] I told you it was a bad idea."],
    "sigh": ["I am just tired. [sigh] It has been a long week.",
             "Some days, [sigh] I wish I could switch my head off."],
    "surprise-oh": ["[surprise-oh] You actually fixed it?",
                    "I did not expect to see you here, [surprise-oh] of all places."],
    "dissatisfaction-hnn": ["[dissatisfaction-hnn] Another corp contract, huh.",
                            "That is not what I asked for. [dissatisfaction-hnn] Try again."],
}
CJK = [
    ("surprise-wa", "Chinese", "zh", "[surprise-wa] 真的吗？你一个人去的？"),
    ("surprise-wa", "Japanese", "ja", "[surprise-wa] 本当に？一人で行ったの？"),
    ("surprise-yo", "Chinese", "zh", "[surprise-yo] 你今天来得真早。"),
    ("surprise-yo", "Chinese", "zh", "你居然还记得，[surprise-yo] 我都忘了。"),
    ("question-ei", "Chinese", "zh", "[question-ei] 你说什么？再说一遍？"),
    ("question-ei", "Japanese", "ja", "[question-ei] 本当に？"),
    ("question-yi", "Chinese", "zh", "[question-yi] 这扇门怎么开着？"),
    ("question-yi", "Chinese", "zh", "谁把灯关了？[question-yi] 刚才还亮着呢。"),
]
VOICES = {"judy-alvarez": "Judy", "johnny-silverhand": "Johnny", "panam-palmer": "Panam"}


def untag(text: str) -> str:
    import re
    return re.sub(r"\s*\[[a-z-]+\]\s*", " ", text).strip().replace(" ,", ",").replace("  ", " ")


def build_jobs():
    """Each job: id, group, voice, language label, language code or None, text, tag, control(bool), seed, line index."""
    jobs = []

    def add(group, voice, lang_name, lang_code, text, tag, control, index):
        for seed in SEEDS:
            jobs.append(dict(id=f"{len(jobs):03d}-{voice.split('-')[0]}-{tag or 'plain'}-{'ctl' if control else 'tag'}-l{index}-s{seed}",
                             group=group, voice=voice, lang=lang_name, code=lang_code, text=text, tag=tag,
                             control=control, seed=seed, line=index))

    for tag, lines in (("question-oh", Q_OH), ("question-ah", Q_AH)):
        for voice in ("judy-alvarez", "johnny-silverhand"):
            for i, line in enumerate(lines, 1):
                add(f"[{tag}] English", voice, "English", None, line, tag, False, i)
                add(f"[{tag}] English", voice, "English", None, untag(line), tag, True, i)
    for voice in ("judy-alvarez", "panam-palmer"):
        for i, line in enumerate(CONFIRM, 1):
            add("[confirmation-en] English", voice, "English", None, line, "confirmation-en", False, i)
            add("[confirmation-en] English", voice, "English", None, untag(line), "confirmation-en", True, i)
    for tag, lines in COMPARE.items():
        for i, line in enumerate(lines, 1):
            add(f"[{tag}] English, for comparison", "judy-alvarez", "English", None, line, tag, False, i)
    counters = {}
    for tag, lang_name, code, line in CJK:
        counters[tag] = counters.get(tag, 0) + 1
        add(f"[{tag}] Chinese / Japanese on Judy's reference", "judy-alvarez", lang_name, code, line, tag, False, counters[tag])
    return jobs


def render(args, jobs):
    config = json.loads((ROOT / "runtime/voice-configs.json").read_text(encoding="utf-8-sig"))
    voices = json.loads((ROOT / "runtime" / config["omni"]["short"]).read_text(encoding="utf-8-sig"))
    model_dir = ROOT / voices["model"]
    if not (model_dir / "model.safetensors").is_file() or voices.get("engine") != "omnivoice":
        raise FileNotFoundError("The configured OmniVoice snapshot is missing")
    refs = {}
    for key in VOICES:
        entry = voices["voices"][key]
        path = ROOT / entry["reference"]
        if hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError(f"{key}: reference clip changed")
        refs[key] = (str(path), entry["transcript"])
    args.out.mkdir(parents=True, exist_ok=True)
    os.environ.update({
        "HF_HOME": str(ROOT / "vendor/voice-models"), "HF_HUB_OFFLINE": "1",
        "OMNIVOICE_DATA_DIR": str(args.out / "omni-prompt-cache"), "OMNIVOICE_MODEL": str(model_dir),
        "OMNIVOICE_TTS_BACKEND": "omnivoice", "OMNIVOICE_GPU_WORKERS": "1",
        "OMNIVOICE_PRELOAD_TTS_ASR": "0", "OMNIVOICE_ASR_BACKEND": "pytorch-whisper",
        "TORCH_COMPILE_DISABLE": "1", "PYTHONUTF8": "1"})
    sys.path.insert(0, str(ROOT / "vendor/reference-voicestudio/backend"))
    import numpy as np
    import soundfile as sf
    import torch
    from services import tts_backend

    if not torch.cuda.is_available():
        raise RuntimeError("OmniVoice needs CUDA")
    free, total = torch.cuda.mem_get_info()
    print(json.dumps({"gpu_free_mib": free // 2**20, "gpu_total_mib": total // 2**20}), flush=True)
    if free < 4.5 * 2**30:
        raise RuntimeError("The GPU is busy (under 4.5 GB free); not rendering")
    began = time.monotonic()
    backend = tts_backend.get_backend_class("omnivoice")()
    backend._ensure_loaded()
    print(json.dumps({"loaded_seconds": round(time.monotonic() - began, 1), "device": backend.execution_device,
                      "dtype": backend.dtype}), flush=True)
    for job in jobs:
        path = args.out / f"{job['id']}.wav"
        if path.is_file():
            continue
        ref, transcript = refs[job["voice"]]
        torch.manual_seed(job["seed"])
        t0 = time.perf_counter()
        with torch.inference_mode():
            wav = backend.generate(job["text"], ref_audio=ref, ref_text=transcript, language=job["code"] or "English",
                                   num_step=args.steps, guidance_scale=2.0, speed=1, denoise=False,
                                   postprocess_output=False)
        torch.cuda.synchronize()
        values = np.asarray(wav.detach().float().cpu() if hasattr(wav, "detach") else wav).reshape(-1)
        if not values.size or not np.isfinite(values).all():
            print(json.dumps({"id": job["id"], "error": "empty or non-finite audio"}), flush=True)
            continue
        sf.write(str(path), values, backend.sample_rate, format="WAV", subtype="PCM_16")
        print(json.dumps({"id": job["id"], "seconds": round(values.size / backend.sample_rate, 2),
                          "took": round(time.perf_counter() - t0, 2)}), flush=True)
    backend.unload()


PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OmniVoice Tag Listening Test</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1c1e;--mut:#6b6b70;--line:#d9d9de;--ctl:#f3f3f6;--acc:#0a6cff}
@media(prefers-color-scheme:dark){:root{--bg:#161618;--fg:#ececf0;--mut:#9a9aa2;--line:#35353a;--ctl:#202024;--acc:#5aa0ff}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif;max-width:1100px;margin:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 6px}p{margin:0 0 8px;color:var(--mut)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 8px;border-top:1px solid var(--line);vertical-align:middle}
th{font-size:12px;color:var(--mut);font-weight:600}tr.ctl td{background:var(--ctl)}td.t{min-width:260px}
audio{height:32px;width:240px}select,input{font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px}
input{width:150px}.pill{font-size:11px;border:1px solid var(--line);border-radius:10px;padding:0 6px;color:var(--mut)}
button{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
@media(max-width:700px){.wrap{overflow-x:auto}}
</style></head><body>
<h1>OmniVoice tag listening test</h1>
<p>__INTRO__ <button id="copy">Copy verdicts</button></p>
__BODY__
<script>
const K='omni-tag-listening-v1';let S={};try{S=JSON.parse(localStorage.getItem(K)||'{}')}catch(e){}
const save=()=>{try{localStorage.setItem(K,JSON.stringify(S))}catch(e){}};
document.querySelectorAll('tr[data-id]').forEach(r=>{const id=r.dataset.id,s=S[id]||{};
 const sel=r.querySelector('select'),inp=r.querySelector('input');sel.value=s.v||'';inp.value=s.n||'';
 const up=()=>{S[id]={v:sel.value,n:inp.value};save()};sel.onchange=up;inp.oninput=up});
document.getElementById('copy').onclick=()=>{const out=[];document.querySelectorAll('tr[data-id]').forEach(r=>{
 const v=r.querySelector('select').value,n=r.querySelector('input').value;if(v||n)out.push(r.dataset.id+'\\t'+v+'\\t'+n)});
 navigator.clipboard.writeText(out.join('\\n')).catch(()=>{})};
document.addEventListener('play',e=>{document.querySelectorAll('audio').forEach(a=>{if(a!==e.target)a.pause()})},true);
</script></body></html>"""


def build_page(args, jobs):
    import numpy as np
    import soundfile as sf
    groups, stats = {}, []
    for job in jobs:
        path = args.out / f"{job['id']}.wav"
        if not path.is_file():
            continue
        data, rate = sf.read(str(path), dtype="float32")
        buf = io.BytesIO()
        sf.write(buf, data, rate, format="FLAC", subtype="PCM_16")
        job["b64"] = base64.b64encode(buf.getvalue()).decode("ascii")
        job["dur"] = round(len(data) / rate, 2)
        job["peak"] = round(float(np.abs(data).max()), 3)
        groups.setdefault(job["group"], []).append(job)
        stats.append(job)
    body = []
    for group, items in groups.items():
        rows = []
        for j in items:
            lang = f' <span class="pill">{html.escape(j["lang"])}</span>' if j["lang"] != "English" else ""
            kind = "no tag (control)" if j["control"] else "tag"
            rows.append(
                f'<tr data-id="{html.escape(j["id"])}"{" class=ctl" if j["control"] else ""}>'
                f'<td class="t">{html.escape(j["text"])}{lang}</td><td>{VOICES[j["voice"]]}</td>'
                f'<td>{j["seed"]}</td><td>{kind}</td><td>{j["dur"]:.2f} s</td>'
                f'<td><audio controls preload="none" src="data:audio/flac;base64,{j["b64"]}"></audio></td>'
                '<td><select><option value="">-</option><option>good</option><option>ok</option><option>tic</option>'
                '<option>wrong sound</option><option>bad</option></select> <input placeholder="note"></td></tr>')
        body.append(f'<h2>{html.escape(group)}</h2><div class="wrap"><table><thead><tr><th>Line</th><th>Character</th>'
                    '<th>Seed</th><th>Kind</th><th>Length</th><th>Audio</th><th>Verdict</th></tr></thead><tbody>'
                    + "".join(rows) + '</tbody></table></div>')
    intro = (f"Same model, settings and short references as the game (16 steps); every line is rendered with two seeds, "
             f"shaded rows are the same line without the tag. {len(stats)} samples.")
    args.page.parent.mkdir(parents=True, exist_ok=True)
    args.page.write_text(PAGE.replace("__INTRO__", html.escape(intro)).replace("__BODY__", "\n".join(body)), encoding="utf-8")
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=ROOT / "runtime/tag-listening")
    parser.add_argument("--page", type=Path, default=Path.home() / "Downloads" / "OmniVoice Tag Listening Test.html")
    parser.add_argument("--steps", type=int, default=16, choices=(16, 32))
    parser.add_argument("--page-only", action="store_true", help="skip rendering; build the page from existing WAVs")
    args = parser.parse_args()
    jobs = build_jobs()
    if not args.page_only:
        render(args, jobs)
    stats = build_page(args, jobs)
    (args.out / "jobs.json").write_text(json.dumps([{k: v for k, v in j.items() if k != "b64"} for j in stats],
                                                   ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"page": str(args.page), "samples": len(stats), "jobs": len(jobs)}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
