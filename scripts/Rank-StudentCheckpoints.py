"""Rank Pocket student checkpoints by how much they sound like the real voice.

Primary metric: WavLM speaker-verification cosine (same model as
scripts/Make-ListeningSamples.py and scripts/Evaluate-VoiceSamples.py) between
a generated line and the voice's runtime reference clip, macro-averaged over
voices so a voice with one clip counts as much as a voice with hundreds.
Secondary: word error rate of the same lines by the local wav2vec2 CTC ASR the
training run uses as its guard (tentative: proper names and accents miss).

Everything runs on CPU in its own processes; the runtime install,
runtime/pocket-voices.json and the live worker are never touched.  Checkpoints
must already be on disk (no token is read here).

Stages (each is resumable and takes --model for the synthesis/scoring ones):
  --export               write transient student exports from last.pt files
  --synth  --model NAME  synthesize the 3 panel lines for every panel voice
  --score  --model NAME  speaker cosine + impostor margin + WER per sample
  --report               aggregate all scored models into ranking.json / .md
  --page-plan            page jobs + ASR check that each reference transcript matches its clip
  --page-synth --model N synthesize the reference-clip transcripts for the page (OmniVoice
                         columns come from scripts/Synthesize-OmniSamples.py)
  --page --recommended M build the labeled listening page, runtime/.../student-ranking/index.html

Decode settings: students and the stock base use the runtime path of
bridge/pocket-voice-worker.py (CFG 1, one decode step, temperature 0.3,
eos_threshold -1, frames_after_eos 1); the teacher uses its training sampler
(CFG 2, two decode steps, temperature 0.3).  Seeds are fixed per line.
"""
from __future__ import annotations

import argparse
import collections
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import time
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "runtime/listening-20261005/student-ranking"
# Large files (last.pt, exports) can be redirected off the system drive.
CKPT = Path(os.environ.get("RANK_CHECKPOINT_DIR") or ROOT / "runtime/listening-20261005/checkpoints")
RUN = CKPT / "student-run"
EXPORTS = CKPT / "exports"
DATA = ROOT / "runtime/voice-data-expansion-20261004/final-corpus-assembly/final-entries/final-entry-v5-001/data"
RUNTIME_STUDENT = ROOT / "runtime/kaggle-pocket-student-transfer-ddb133ba-output/student-transfer-results/distill/export"
SEED = 1337

# Three new lines, none in any dataset manifest; same text for every model.
PANEL_LINES = [
    "The meeting has been moved to tomorrow morning, so please bring the documents with you.",
    "I didn't expect to see you here, but I'm glad you stopped by.",
    "We should leave soon, before the weather gets any worse.",
]

# Held-out dev speakers that have no runtime reference: use one of their own
# dataset clips as reference (dataset reference, flagged in the report).
DATASET_REFERENCE_VOICES = {
    "alt-cunningham": "data/audio/alt-cunningham/4e5f4e369868226489659f5357b5f5b614926facced428ef6d7856b03c51baec.wav",
    "fingers": "data/audio/fingers/242b575fe388848774e2d692095519b95bfe4a13cbfef1e0df8e1c870de75ab1.wav",
}

# slot -> step; weights kinds exported from each last.pt.
STUDENT_SLOTS = {"s4000": "slot-1", "s5000": "slot-2", "s6000": "slot-0"}
STUDENT_MODELS = {f"{step}-{kind}": (slot, kind) for step, slot in STUDENT_SLOTS.items() for kind in ("ema", "raw")}
MODELS = [*STUDENT_MODELS, "student-current", "pocket-base", "teacher-u1000-raw"]
LABELS = {
    "s4000-ema": "Student update 4,000 (EMA; the run's best by dev loss)",
    "s4000-raw": "Student update 4,000 (raw)",
    "s5000-ema": "Student update 5,000 (EMA)", "s5000-raw": "Student update 5,000 (raw)",
    "s6000-ema": "Student update 6,000 (EMA)", "s6000-raw": "Student update 6,000 (raw)",
    "student-current": "Current runtime student", "pocket-base": "Pocket TTS base (no fine-tuning)",
    "teacher-u1000-raw": "Teacher update 1,000 (raw)",
}


def load_helpers():
    spec = importlib.util.spec_from_file_location("mls", ROOT / "scripts/Make-ListeningSamples.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ------------------------------------------------------------------- panel

def clip_counts() -> dict[str, int]:
    counts = collections.Counter()
    for split in ("train", "dev", "test"):
        with (DATA / f"{split}.jsonl").open(encoding="utf-8") as stream:
            for line in stream:
                row = json.loads(line)
                counts[row.get("character") or row["id"].split("/")[0]] += 1
    return counts


def panel() -> dict[str, dict]:
    """voice -> reference path, transcript (when known), clip count, kind."""
    voices = json.loads((ROOT / "runtime/pocket-voices.json").read_text(encoding="utf-8"))["voices"]
    counts = clip_counts()
    result = {}
    for key, value in sorted(voices.items()):
        if "reference" not in value:
            continue
        result[key] = {"reference": str(ROOT / value["reference"]), "transcript": value["transcript"],
                       "clips": counts.get(key, 0), "kind": "runtime"}
    for key, relative in DATASET_REFERENCE_VOICES.items():
        result[key] = {"reference": str(DATA.parent / relative),
                       "transcript": None, "clips": counts.get(key, 0), "kind": "dataset"}
    for key, row in result.items():
        if not Path(row["reference"]).is_file():
            raise FileNotFoundError(row["reference"])
    return dict(sorted(result.items()))


# ------------------------------------------------------------------ export

def export_base() -> None:
    """The stock english_2026-09 weights (identical to the kyutai/pocket-tts cache blob) in the student layout.

    The stock config equals the student's inference.yaml except for hf:// paths,
    so the same relocated-config loader serves it; the tokenizer is the shared one.
    """
    destination = EXPORTS / "pocket-base"
    destination.mkdir(parents=True, exist_ok=True)
    stock = ROOT / "vendor/pocket-tts-training/models"
    if (stock / "tokenizer.json").read_bytes() != (RUNTIME_STUDENT / "tokenizer.json").read_bytes():
        raise ValueError("The stock and student tokenizers differ")
    shutil.copyfile(stock / "english_2026-09.safetensors", destination / "model.safetensors")
    for extra in ("inference.yaml", "tokenizer.json"):
        shutil.copyfile(RUNTIME_STUDENT / extra, destination / extra)
    print(json.dumps({"export": "pocket-base", "status": "written"}), flush=True)


def export_students(args) -> None:
    import safetensors.torch as st
    import torch

    if not args.model or args.model == "pocket-base":
        export_base()

    runtime = st.load_file(str(RUNTIME_STUDENT / "model.safetensors"))
    for name, (slot, kind) in STUDENT_MODELS.items():
        if args.model and args.model != name:
            continue
        destination = EXPORTS / name
        if (destination / "model.safetensors").is_file() and not args.force:
            print(json.dumps({"export": name, "status": "exists"}), flush=True)
            continue
        payload = torch.load(RUN / slot / "last.pt", map_location="cpu", weights_only=True, mmap=True)
        state = dict(payload["model"])
        if kind == "ema":
            if not payload.get("ema"):
                raise ValueError(f"{slot} has no EMA weights")
            state.update(payload["ema"])
        bundle = dict(runtime)
        replaced = 0
        for key, value in state.items():
            if not key.startswith("flow_lm."):
                continue
            if key not in bundle or bundle[key].shape != value.shape:
                raise ValueError(f"{name}: {key} does not fit the student layout")
            bundle[key] = value.detach().float().contiguous().clone()
            replaced += 1
        if replaced != sum(k.startswith("flow_lm.") for k in runtime):
            raise ValueError(f"{name}: expected every flow_lm tensor to be replaced ({replaced})")
        destination.mkdir(parents=True, exist_ok=True)
        st.save_file(bundle, str(destination / "model.safetensors"))
        for extra in ("inference.yaml", "tokenizer.json"):
            shutil.copyfile(RUNTIME_STUDENT / extra, destination / extra)
        print(json.dumps({"export": name, "step": payload["step"], "tensors_replaced": replaced}), flush=True)
        del payload, state, bundle


# -------------------------------------------------------------- synthesis

def build_generator(mls, torch, name: str, work: Path):
    """Return (generate(reference_path, text, seed) -> np.ndarray, prepare(ref) -> None)."""
    import numpy as np

    if name == "teacher-u1000-raw":
        teacher = ROOT / "runtime/voice-data-expansion-20261005/student-a1000/teacher"
        checkpoint = teacher / "step000001000-raw.pt"
        namespace = argparse.Namespace(
            teacher_build_config=teacher / "teacher-export-build.yaml", tokenizer=teacher / "export/tokenizer.json")
        model, mimi = mls.build_teacher(torch, mls.teacher_build_config(namespace, work), from_export=False)
        payload = torch.load(checkpoint, map_location="cpu", weights_only=True, mmap=True)
        if payload.get("step") != 1000 or payload.get("ema") is not None:
            raise ValueError("Expected the raw update-1,000 teacher checkpoint")
        model.load_state_dict(dict(payload["model"]), strict=True)
        del payload
        latents = {}

        def prepare(reference):
            latents[reference] = mls.voice_latent(torch, mimi, Path(reference))

        def generate(reference, text, seed):
            return mls.teacher_audio(torch, model, mimi, latents[reference], text, seed)[0]

        return generate, prepare, lambda ref: latents.pop(ref, None)

    from pocket_tts import TTSModel

    kwargs = dict(temp=mls.TEMPERATURE, sampler_decode_steps=1, eos_threshold=-1.0, noise_clamp=None)
    export = RUNTIME_STUDENT if name == "student-current" else EXPORTS / name
    model = TTSModel.load_model(config=mls.relocated_export_config(export, work, 6, f"{name}.yaml"), **kwargs)
    model.eval()
    states = {}

    def prepare(reference):
        states[reference] = model.get_state_for_audio_prompt(Path(reference), truncate=False)

    def generate(reference, text, seed):
        torch.manual_seed(seed)
        chunks = [c.detach().cpu().float().numpy().reshape(-1)
                  for c in model.generate_audio_stream(states[reference], text, frames_after_eos=1, copy_state=True)]
        return np.concatenate(chunks)

    return generate, prepare, lambda ref: states.pop(ref, None)


def synth(args) -> None:
    mls = load_helpers()
    torch = mls.import_stack(args.threads)
    voices = panel()
    if args.voices:
        voices = {k: voices[k] for k in args.voices}
    folder = OUT / "panel" / args.model
    folder.mkdir(parents=True, exist_ok=True)
    work = OUT / "work" / args.model
    work.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    generate, prepare, release = build_generator(mls, torch, args.model, work)
    print(json.dumps({"model": args.model, "loaded_seconds": round(time.monotonic() - started, 1)}), flush=True)
    done = 0
    for key, info in voices.items():
        todo = [i for i in range(len(PANEL_LINES)) if not (folder / f"{key}__{i + 1}.wav").is_file()]
        if not todo:
            continue
        prepare(info["reference"])
        for i in todo:
            began = time.monotonic()
            audio = generate(info["reference"], PANEL_LINES[i], SEED + i)
            mls.write_wav(folder / f"{key}__{i + 1}.wav", audio, 24000)
            done += 1
            print(json.dumps({"model": args.model, "voice": key, "line": i + 1, "seconds": round(len(audio) / 24000, 2),
                              "took": round(time.monotonic() - began, 1)}), flush=True)
        release(info["reference"])
    print(json.dumps({"model": args.model, "status": "synthesized", "new_lines": done,
                      "total_seconds": round(time.monotonic() - started)}), flush=True)


# ----------------------------------------------------------------- scoring

def normalized_words(text: str) -> list[str]:
    value = unicodedata.normalize("NFKC", str(text)).casefold().replace("’", "'")
    return [word.replace("'", "") for word in re.findall(r"[^\W_]+(?:'[^\W_]+)*", value)]


def word_errors(reference: str, hypothesis: str) -> dict:
    expected, observed = normalized_words(reference), normalized_words(hypothesis)
    previous = [(i, 0) for i in range(len(observed) + 1)]
    for i, word in enumerate(expected, 1):
        current = [(i, i)]
        for j, token in enumerate(observed, 1):
            diagonal = (previous[j - 1][0] + (word != token), previous[j - 1][1])
            deletion = (previous[j][0] + 1, previous[j][1] + 1)
            insertion = (current[j - 1][0] + 1, current[j - 1][1])
            current.append(min((diagonal, deletion, insertion), key=lambda item: item[0]))
        previous = current
    edits, deletions = previous[-1]
    return {"words": len(expected), "edits": edits, "deletions": deletions}


class Scorer:
    def __init__(self, threads: int):
        mls = load_helpers()
        self.torch = mls.import_stack(threads)
        sys.path.insert(0, str(ROOT / "runtime/listening-20261005/pylibs"))
        os.environ["HF_HOME"] = str(ROOT / "vendor/voice-models")
        from transformers import (AutoFeatureExtractor, AutoModelForAudioXVector, Wav2Vec2ForCTC, Wav2Vec2Processor)

        info = json.loads((ROOT / "runtime/voice-training/evaluation-models.json").read_text(encoding="utf-8"))
        path = info["microsoft/wavlm-base-plus-sv"]["path"]
        self.features = AutoFeatureExtractor.from_pretrained(path, local_files_only=True)
        self.sv = AutoModelForAudioXVector.from_pretrained(path, local_files_only=True).eval()
        align = ROOT / "vendor/pocket-tts-training/models/alignment"
        self.processor = Wav2Vec2Processor.from_pretrained(str(align), local_files_only=True)
        self.ctc = Wav2Vec2ForCTC.from_pretrained(str(align), local_files_only=True).float().eval()
        from pocket_tts.data.audio_utils import convert_audio
        self.convert = convert_audio

    def mono16k(self, wav: Path):
        import soundfile as sf

        data, rate = sf.read(str(wav), dtype="float32", always_2d=True)
        tensor = self.torch.from_numpy(data.mean(axis=1))[None]
        return self.convert(tensor, int(rate), 16000, 1)[0].numpy()

    def embed(self, mono):
        batch = self.features(mono, sampling_rate=16000, return_tensors="pt", padding=True)
        with self.torch.inference_mode():
            return self.torch.nn.functional.normalize(self.sv(**batch).embeddings, dim=-1)[0]

    def transcribe(self, mono) -> str:
        inputs = self.processor(mono, sampling_rate=16000, return_tensors="pt")
        with self.torch.inference_mode():
            logits = self.ctc(**inputs).logits.float()
        return str(self.processor.batch_decode(logits.argmax(dim=-1))[0]).strip()


def reference_embeddings(scorer: Scorer, voices: dict) -> dict:
    cache = OUT / "reference-embeddings.pt"
    if cache.is_file():
        stored = scorer.torch.load(cache, weights_only=True)
        if set(stored) == set(voices):
            return stored
    result = {key: scorer.embed(scorer.mono16k(Path(info["reference"]))) for key, info in voices.items()}
    scorer.torch.save(result, cache)
    return result


def score(args) -> None:
    voices = panel()
    scorer = Scorer(args.threads)
    refs = reference_embeddings(scorer, voices)
    torch = scorer.torch
    keys = list(voices)
    matrix = torch.stack([refs[k] for k in keys])
    folder = OUT / "panel" / args.model
    output = OUT / "scores" / f"{args.model}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    samples = []
    for key in keys:
        for i, text in enumerate(PANEL_LINES):
            wav = folder / f"{key}__{i + 1}.wav"
            if not wav.is_file():
                continue
            mono = scorer.mono16k(wav)
            embedding = scorer.embed(mono)
            cosines = matrix @ embedding
            own = float(cosines[keys.index(key)])
            others = torch.cat([cosines[:keys.index(key)], cosines[keys.index(key) + 1:]])
            transcript = scorer.transcribe(mono)
            samples.append({"voice": key, "line": i + 1, "cosine": round(own, 5),
                            "margin": round(own - float(others.mean()), 5),
                            "top1": bool(int(cosines.argmax()) == keys.index(key)),
                            "rank": int((cosines > cosines[keys.index(key)]).sum()) + 1,
                            "seconds": round(len(mono) / 16000, 2), "transcript": transcript,
                            **word_errors(text, transcript)})
        print(json.dumps({"model": args.model, "scored_voice": key}), flush=True)
    output.write_text(json.dumps({"model": args.model, "label": LABELS.get(args.model, args.model),
                                  "samples": samples}, indent=1), encoding="utf-8")
    print(json.dumps({"model": args.model, "status": "scored", "samples": len(samples)}), flush=True)


# ------------------------------------------------------------------ report

def aggregate(samples: list[dict], clips: dict[str, int], voices: list[str]) -> dict:
    per = collections.defaultdict(list)
    for s in samples:
        per[s["voice"]].append(s)
    voice_cos = {v: sum(s["cosine"] for s in per[v]) / len(per[v]) for v in voices if per[v]}
    voice_margin = {v: sum(s["margin"] for s in per[v]) / len(per[v]) for v in voices if per[v]}
    ordered = sorted(voice_cos.values())
    rare = [voice_cos[v] for v in voice_cos if clips.get(v, 0) <= 5]
    words = sum(s["words"] for s in samples)
    return {"voices": len(voice_cos), "samples": len(samples),
            "macro_cosine": sum(voice_cos.values()) / len(voice_cos),
            "worst10_cosine": sum(ordered[:10]) / min(10, len(ordered)),
            "rare_cosine": sum(rare) / len(rare) if rare else None, "rare_voices": len(rare),
            "macro_margin": sum(voice_margin.values()) / len(voice_margin),
            "top1_accuracy": sum(s["top1"] for s in samples) / len(samples),
            "wer": sum(s["edits"] for s in samples) / words, "deletion_rate": sum(s["deletions"] for s in samples) / words,
            "per_voice_cosine": voice_cos, "per_voice_margin": voice_margin}


def bootstrap_gap(a: dict, b: dict, voices: list[str], rounds: int = 2000):
    """Paired bootstrap over voices of macro cosine (a - b): mean and 95% interval."""
    import random

    rng = random.Random(7)
    diffs = [a[v] - b[v] for v in voices if v in a and v in b]
    means = sorted(sum(rng.choice(diffs) for _ in diffs) / len(diffs) for _ in range(rounds))
    return sum(diffs) / len(diffs), means[int(rounds * .025)], means[int(rounds * .975)]


def report(args) -> None:
    voices = panel()
    clips = {k: v["clips"] for k, v in voices.items()}
    results = {}
    for path in sorted((OUT / "scores").glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        results[data["model"]] = {"label": data["label"], **aggregate(data["samples"], clips, list(voices))}
    # A model scored on only some voices (the slow teacher) is compared on that subset below.
    partial = {m: r for m, r in results.items() if r["voices"] < len(voices)}
    results = {m: r for m, r in results.items() if m not in partial}
    ranking = sorted(results, key=lambda m: -results[m]["macro_cosine"])
    common = [v for v in voices if all(v in results[m]["per_voice_cosine"] for m in results)]
    current = results.get("student-current")
    lines = ["| Rank | Model | Macro cosine | Worst-10 cosine | Rare (<=5 clips) cosine | Margin | Top-1 id | WER | Deletions |",
             "|---|---|---|---|---|---|---|---|---|"]
    for place, name in enumerate(ranking, 1):
        r = results[name]
        lines.append(f"| {place} | {r['label']} | {r['macro_cosine']:.4f} | {r['worst10_cosine']:.4f} | "
                     f"{r['rare_cosine']:.4f} ({r['rare_voices']}) | {r['macro_margin']:.4f} | {r['top1_accuracy']:.1%} | "
                     f"{r['wer']:.1%} | {r['deletion_rate']:.1%} |")
    extra = []
    if current:
        for name in ranking:
            if name != "student-current" and name in STUDENT_MODELS:
                mean, low, high = bootstrap_gap(results[name]["per_voice_cosine"], current["per_voice_cosine"], common)
                extra.append(f"- {results[name]['label']} minus current student, macro cosine over {len(common)} voices: "
                             f"{mean:+.4f} (95% bootstrap interval {low:+.4f} to {high:+.4f})")
    if partial:
        subset = sorted({v for r in partial.values() for v in r["per_voice_cosine"]})
        extra += ["", f"Teacher comparison on the {len(subset)} voices it was synthesized for ({', '.join(subset)}):",
                  "| Model | Macro cosine | WER |", "|---|---|---|"]
        every = {**results, **partial}
        for name in sorted(every, key=lambda m: -sum(every[m]["per_voice_cosine"][v] for v in subset) if m in partial
                           else -sum(every[m]["per_voice_cosine"][v] for v in subset)):
            r = every[name]
            mean = sum(r["per_voice_cosine"][v] for v in subset) / len(subset)
            kept = [x for x in json.loads((OUT / "scores" / f"{name}.json").read_text(encoding="utf-8"))["samples"]
                    if x["voice"] in subset]
            wer = sum(x["edits"] for x in kept) / sum(x["words"] for x in kept)
            extra.append(f"| {r['label']} | {mean:.4f} | {wer:.1%} |")
    best_new = next((m for m in ranking if m in STUDENT_MODELS), None)
    differ = []
    if best_new and current:
        gap = {v: results[best_new]["per_voice_cosine"][v] - current["per_voice_cosine"][v] for v in common}
        order = sorted(gap, key=gap.get)
        differ = [{"voice": v, "clips": clips[v], "best_new": round(results[best_new]["per_voice_cosine"][v], 4),
                   "current": round(current["per_voice_cosine"][v], 4), "gap": round(gap[v], 4)}
                  for v in order[:10] + order[-10:]]
    payload = {"panel_voices": len(voices), "lines": PANEL_LINES, "seed_base": SEED, "ranking": ranking,
               "models": {m: {k: v for k, v in r.items() if k not in ("per_voice_cosine", "per_voice_margin")}
                          for m, r in results.items()},
               "best_new_student": best_new, "largest_differences_best_new_vs_current": differ,
               "per_voice_cosine": {m: r["per_voice_cosine"] for m, r in results.items()},
               "clip_counts": clips}
    (OUT / "ranking.json").write_text(json.dumps(payload, indent=1), encoding="utf-8")
    text = "\n".join(lines + [""] + extra + [""] + ["voice | clips | best new | current | gap"] +
                     [f"{d['voice']} | {d['clips']} | {d['best_new']} | {d['current']} | {d['gap']:+}" for d in differ])
    (OUT / "ranking.md").write_text(text + "\n", encoding="utf-8")
    print(text)


# -------------------------------------------------------------------- page

PAGE_VOICES = ["dennis-cranmer", "jesse", "ozob-bozo", "cassidy-righter", "evelyn-parker",
               "misty-olszewski", "jackie-welles", "solomon-reed"]
PAGE_DIR = OUT / "page"


def page_plan(args) -> None:
    """Jobs for the Omni script plus an ASR check that each transcript matches its clip."""
    voices = panel()
    jobs, checks = [], {}
    scorer = Scorer(args.threads)
    for key in PAGE_VOICES:
        info = voices[key]
        heard = scorer.transcribe(scorer.mono16k(Path(info["reference"])))
        checks[key] = {"transcript": info["transcript"], "asr": heard, **word_errors(info["transcript"], heard)}
        jobs.append({"key": key, "reference": info["reference"], "transcript": info["transcript"],
                     "text": info["transcript"], "clips": info["clips"]})
    (OUT / "page-jobs.json").write_text(json.dumps(jobs, indent=1, ensure_ascii=False), encoding="utf-8")
    (OUT / "page-transcript-check.json").write_text(json.dumps(checks, indent=1, ensure_ascii=False), encoding="utf-8")
    for key, row in checks.items():
        print(json.dumps({"voice": key, "words": row["words"], "asr_edits": row["edits"]}), flush=True)


def page_synth(args) -> None:
    """Each model reads the reference clip's own transcript, conditioned on that clip."""
    mls = load_helpers()
    torch = mls.import_stack(args.threads)
    jobs = json.loads((OUT / "page-jobs.json").read_text(encoding="utf-8"))
    folder = PAGE_DIR / args.model
    folder.mkdir(parents=True, exist_ok=True)
    work = OUT / "work" / f"page-{args.model}"
    work.mkdir(parents=True, exist_ok=True)
    generate, prepare, release = build_generator(mls, torch, args.model, work)
    for job in jobs:
        path = folder / f"{job['key']}.wav"
        if path.is_file():
            continue
        prepare(job["reference"])
        began = time.monotonic()
        audio = generate(job["reference"], job["text"], SEED)
        mls.write_wav(path, audio, 24000)
        release(job["reference"])
        print(json.dumps({"model": args.model, "voice": job["key"], "seconds": round(len(audio) / 24000, 2),
                          "took": round(time.monotonic() - began, 1)}), flush=True)


def page_build(args) -> None:
    import html

    jobs = json.loads((OUT / "page-jobs.json").read_text(encoding="utf-8"))
    columns = [("pocket-base", "Pocket TTS base<br><small>stock, no fine-tuning</small>"),
               ("teacher-u1000-raw", "Pocket teacher fine-tuned<br><small>update 1,000, raw</small>"),
               (args.recommended, "Pocket student fine-tuned<br><small>recommended: "
                f"{html.escape(LABELS[args.recommended])}</small>"),
               ("student-current", "Pocket student fine-tuned<br><small>current runtime student (extra)</small>"),
               ("omni16", "OmniVoice<br><small>16 steps</small>"), ("omni32", "OmniVoice<br><small>32 steps</small>")]
    PAGE_DIR.mkdir(exist_ok=True)
    scorer = Scorer(args.threads)
    voices = panel()
    refs = reference_embeddings(scorer, voices)
    rows, cosines = [], {}
    for job in jobs:
        key = job["key"]
        shutil.copyfile(job["reference"], PAGE_DIR / f"{key}__original.wav")
        cells = [f'<td><div class="tag">Original game line</div><audio controls preload="none" '
                 f'src="page/{key}__original.wav"></audio></td>']
        for column, _ in columns:
            source = (OUT / "omni-out" / column / f"{key}.wav") if column.startswith("omni") \
                else PAGE_DIR / column / f"{key}.wav"
            if not source.is_file():
                cells.append("<td><em>missing</em></td>")
                continue
            target = PAGE_DIR / f"{key}__{column}.wav"
            shutil.copyfile(source, target)
            cosine = float(scorer.torch.dot(refs[key], scorer.embed(scorer.mono16k(target))))
            cosines.setdefault(column, []).append(cosine)
            cells.append(f'<td><audio controls preload="none" src="page/{key}__{column}.wav"></audio>'
                         f'<div class="sim">speaker match {cosine:.3f}</div></td>')
        name = key.replace("-", " ").title()
        rows.append(f'<tr><th scope="row">{html.escape(name)}<div class="clips">{job["clips"]} training clips</div>'
                    f'<div class="said">&ldquo;{html.escape(job["text"])}&rdquo;</div></th>{"".join(cells)}</tr>')
    means = "".join(f"<td>{sum(cosines[c]) / len(cosines[c]):.3f}</td>" if c in cosines else "<td></td>" for c, _ in columns)
    head = "".join(f"<th>{title}</th>" for _, title in columns)
    document = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pocket voices: same line, every model</title>
<style>
body{{font:15px/1.4 system-ui,sans-serif;margin:24px;max-width:1700px;color:#222;background:#fafafa}}
table{{border-collapse:collapse;width:100%}}
th,td{{border:1px solid #ccc;padding:8px;vertical-align:top;background:#fff}}
thead th{{background:#eee;font-size:13px}}
tbody th{{text-align:left;min-width:220px}}
audio{{width:200px;display:block}}
.tag{{font-weight:700;font-size:13px;margin-bottom:4px}}
.clips{{font-weight:400;font-size:12px;color:#666}}
.said{{font-weight:400;font-size:12px;color:#444;margin-top:6px}}
.sim{{font-size:12px;color:#666;margin-top:4px}}
tfoot td{{font-size:13px;background:#f3f3f3}}
</style></head><body>
<h1>Same line, every model</h1>
<p>Each row is one voice. The first column is the real game recording; every other column speaks the same words,
conditioned on that same recording. Columns are labeled, not blind. "Speaker match" is the WavLM
speaker-verification cosine to the real clip (1 is identical; a rough aid, trust your ears). Because the text is the
reference's own transcript, a model can lean on its prompt more than it would for a new line.</p>
<table><thead><tr><th>Voice</th><th>Original</th>{head}</tr></thead><tbody>
{''.join(rows)}
</tbody><tfoot><tr><td colspan="2">Mean speaker match over these voices</td>{means}</tr></tfoot></table>
</body></html>
"""
    (OUT / "index.html").write_text(document, encoding="utf-8")
    print(json.dumps({"page": str(OUT / "index.html"),
                      "mean_match": {c: round(sum(v) / len(v), 4) for c, v in cosines.items()}}), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for flag in ("export", "synth", "score", "report", "force", "page-plan", "page-synth", "page"):
        parser.add_argument(f"--{flag}", action="store_true")
    parser.add_argument("--model", choices=MODELS)
    parser.add_argument("--recommended", default="s6000-ema", choices=list(STUDENT_MODELS))
    parser.add_argument("--voices", nargs="*")
    parser.add_argument("--threads", type=int, default=3)
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    if args.export:
        export_students(args)
    if args.synth:
        synth(args)
    if args.score:
        score(args)
    if args.report:
        report(args)
    if args.page_plan:
        page_plan(args)
    if args.page_synth:
        page_synth(args)
    if args.page:
        page_build(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
