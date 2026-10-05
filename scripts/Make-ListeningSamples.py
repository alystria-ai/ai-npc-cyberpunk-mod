"""Blind listening samples: Pocket teacher checkpoints vs the runtime student.

Every model speaks the same new lines for the same characters, conditioned on
one real game reference clip per character (voice condition A: one shared
model plus a reference per voice).  Nothing here touches the runtime install,
runtime/pocket-voices.json or the live worker; it runs as its own CPU process
with its own work directory.

Per-model settings (taken from the training/runtime code, not invented):
  teacher (any 24-layer): the training sampler TrainableTTS.generate used by
      scripts/pocket_training/runner.py generate_samples, CFG 2.0, 2 decode
      steps (teacher_sample_decode_steps), temperature 0.3, seed 1337+line,
      eos_threshold -1, eos_countdown 1, 30 s cap.  The public inference API
      has no CFG argument, so the teacher cannot be voiced through it.
  student: the exact runtime path of bridge/pocket-voice-worker.py,
      TTSModel.load_model(temp 0.3, sampler_decode_steps 1, eos_threshold -1)
      + get_state_for_audio_prompt(truncate=False) + generate_audio_stream
      (frames_after_eos=1); six layers, effective CFG 1.

Voice conditioning is computed the way the runtime computes it for every
model: audio_read -> convert_audio(24 kHz mono) -> end_on_pause -> Mimi
encode_to_latent -> speaker projection.

Stages (all optional, combine freely):
  --synthesize   write <character>__<line>__<model>.wav files
  --page         write index.html (blind A/B/C/D, key collapsed at the bottom)
  --similarity   WavLM speaker-verification cosine vs the reference clip,
                 written to similarity.json only (never to the page)

No token is read here: checkpoints must already be on disk.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "vendor/pocket-tts-training/source"
DATA = ROOT / "runtime/voice-data-expansion-20261004/final-corpus-assembly/final-entries/final-entry-v5-001/data"
VOICES = ROOT / "runtime/pocket-voices.json"
SEED = 1337
TEMPERATURE = 0.3
MAX_SECONDS = 30
TEACHER_CFG = 2.0
TEACHER_STEPS = 2

# Character -> (reference path relative to ROOT, why it is that clip).  A path
# under runtime/voice-references is the runtime's own reference; red-menace has
# no runtime voice, so one of its two TRAIN recordings is the reference.
CHARACTERS = {
    "evelyn-parker": "runtime/voice-references/full-cast-draft/evelyn-parker/reference.wav",
    "jackie-welles": "runtime/voice-references/full-cast-draft/jackie-welles/reference.wav",
    "jesse": "runtime/voice-references/full-cast-draft/jesse/reference.wav",
    "adam-smasher": "runtime/voice-references/full-cast-draft/adam-smasher/reference.wav",
    "red-menace": ("runtime/voice-data-expansion-20261004/final-corpus-assembly/final-entries/"
                   "final-entry-v5-001/data/audio/red-menace/"
                   "c596d6c7b8105048bc0fe69cc26b701f65f6742cdf03df8289796a49b3251000.wav"),
    "ozob-bozo": "runtime/voice-references/full-cast-draft/ozob-bozo/reference.wav",
}

# New text in each character's register; none of it is in any dataset manifest.
LINES = {
    "evelyn-parker": [
        "Hm. You look like someone who has never had to ask permission for anything. How refreshing.",
        "Don't misunderstand me, darling. I'm not asking for a favor, I'm offering you a way out.",
    ],
    "jackie-welles": [
        "Hey, choom, you hear that? Sounds like the whole city's wakin' up just for us.",
        "Come on, V, we ain't gonna let a little rain slow us down. Let's go get paid.",
    ],
    "jesse": [
        "Look, I just came in for a checkup, not an interrogation. Can we skip the questions?",
        "Fine, but if this hurts, I'm telling everyone it was your fault.",
    ],
    "adam-smasher": [
        "Your resistance is noted and irrelevant. The outcome has already been decided.",
        "Run if you like. I will find you, and it will not take long.",
    ],
    "red-menace": [
        "Thank you, everyone! You have been a wonderful crowd tonight.",
        "Our managers talked it over, and we would love to share the stage with you.",
    ],
    "ozob-bozo": [
        "Well, look who finally showed up. Did you bring snacks, or just trouble?",
        "Give us a minute, darlings. The show must go on, and I look fabulous.",
    ],
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(8 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path: Path, value) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def model_specs(args) -> dict:
    """Model id -> description.  Paths are inputs only; nothing is modified."""
    sp = {
        "teacher-u1000-raw": dict(kind="teacher", label="Teacher update 1,000 (raw weights, the selected teacher)",
                                  checkpoint=args.teacher1000, weights="raw", step=1000,
                                  sha256=args.teacher1000_sha256),
        "teacher-u5000-ema": dict(kind="teacher", label="Teacher update 5,000 (EMA weights, latest retained of the expanded run)",
                                  checkpoint=args.teacher5000, weights="ema", step=5000,
                                  sha256=args.teacher5000_sha256),
        "student-runtime": dict(kind="student", label="Runtime student (six layers, CFG 1, one decode step)",
                                export=args.student_export,
                                model_sha256="373a0df2115b1e5dc1c583bb0033838ba4ae337499831261e3938218d239a391"),
        "teacher-earlier-u500-ema": dict(kind="teacher_export", label="Earlier accepted teacher (update 500, EMA)",
                                         export=args.earlier_teacher_export,
                                         model_sha256="95d91ae4b970e51bc6270326dccf1294d576f9cb9df4f9667ebb2838c7cb0d27"),
    }
    return sp


# ---------------------------------------------------------------- synthesis

def import_stack(threads: int):
    os.environ.update(CUDA_VISIBLE_DEVICES="-1", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                      HF_HUB_DISABLE_TELEMETRY="1", PYTHONDONTWRITEBYTECODE="1",
                      TOKENIZERS_PARALLELISM="false", OMP_NUM_THREADS=str(threads),
                      MKL_NUM_THREADS=str(threads), OPENBLAS_NUM_THREADS=str(threads))
    for name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "KAGGLE_API_TOKEN"):
        os.environ.pop(name, None)
    sys.path.insert(0, str(SOURCE))
    import torch

    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)
    return torch


def voice_latent(torch, mimi, reference: Path):
    """Runtime conditioning (TTSModel.get_state_for_audio_prompt, truncate=False)."""
    from pocket_tts.data.audio import audio_read
    from pocket_tts.data.audio_utils import convert_audio, end_on_pause

    audio, rate = audio_read(reference)
    audio = convert_audio(audio, rate, mimi.sample_rate, 1)
    audio = end_on_pause(audio, mimi.sample_rate)
    with torch.no_grad():
        return mimi.encode_to_latent(audio.unsqueeze(0))[0]


def teacher_audio(torch, model, mimi, voice, text: str, seed: int):
    from pocket_tts.modules.stateful_module import init_states

    torch.manual_seed(seed)
    max_frames = int(MAX_SECONDS * mimi.frame_rate)
    with torch.no_grad():
        tokens = torch.tensor(model.flow_lm.conditioner.tokenizer.encode(text), dtype=torch.long)
        latent = model.generate([tokens], [voice], max_frames=max_frames, temp=TEMPERATURE,
                                n_steps=TEACHER_STEPS, cfg_coef=TEACHER_CFG, eos_threshold=-1.0,
                                eos_countdown=1)[0]
        if latent.shape[0] < 8 or not torch.isfinite(latent).all():
            raise RuntimeError("Generation produced empty or non-finite latents")
        ratio = round(mimi.encoder_frame_rate / mimi.frame_rate)
        state = init_states(mimi, 1, (latent.shape[0] + 8) * ratio)
        audio = mimi.decode_from_latent(latent[None], state)[0, 0].float().cpu()
    return audio.numpy(), {"frames": int(latent.shape[0]), "hit_frame_cap": bool(latent.shape[0] >= max_frames)}


def build_teacher(torch, config_path: Path, from_export: bool):
    from training.args import TrainArgs
    from training.modules.builders import build_models

    args = TrainArgs(model_config=str(config_path), compile=False, start_from_pretrained=from_export,
                     text_dropout=0, voice_dropout=0)
    model, mimi, _ = build_models(args)
    return model.eval(), mimi.eval()


def teacher_build_config(args, work: Path) -> Path:
    """The selected-teacher export's build YAML with an absolute tokenizer path."""
    import yaml

    base = args.teacher_build_config
    raw = yaml.safe_load(base.read_text(encoding="utf-8-sig"))
    raw["flow_lm"]["lookup_table"]["tokenizer_path"] = str(args.tokenizer)
    raw["flow_lm"]["dtype"] = raw["mimi"]["dtype"] = "float32"
    if raw["flow_lm"]["transformer"]["num_layers"] != 24:
        raise ValueError("Teacher build config must be the 24-layer architecture")
    destination = work / "teacher-build.yaml"
    destination.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    return destination


def relocated_export_config(export: Path, work: Path, layers: int, name: str) -> Path:
    """Private rebased copy of an export's YAML (the export itself stays untouched)."""
    import yaml

    raw = yaml.safe_load((export / "inference.yaml").read_text(encoding="utf-8-sig"))
    if raw["flow_lm"]["transformer"]["num_layers"] != layers:
        raise ValueError(f"{export} is not a {layers}-layer export")
    raw["weights_path"] = str((export / "model.safetensors").resolve(strict=True))
    raw["weights_path_without_voice_cloning"] = None
    raw["flow_lm"]["weights_path"] = None
    raw["mimi"]["weights_path"] = None
    raw["flow_lm"]["lookup_table"]["tokenizer_path"] = str((export / "tokenizer.json").resolve(strict=True))
    raw["flow_lm"]["dtype"] = raw["mimi"]["dtype"] = "float32"
    destination = work / name
    destination.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    return destination


def references(out: Path) -> dict[str, Path]:
    result = {}
    for key, relative in CHARACTERS.items():
        source = ROOT / relative
        if not source.is_file():
            raise FileNotFoundError(source)
        destination = out / f"{key}__reference.wav"
        if not destination.exists():
            shutil.copyfile(source, destination)
        result[key] = destination
    return result


def write_wav(path: Path, audio, rate: int) -> float:
    import numpy as np
    import soundfile as sf

    if not np.isfinite(audio).all():
        raise RuntimeError("Non-finite PCM")
    peak = float(np.abs(audio).max())
    sf.write(str(path) + ".tmp.wav", np.clip(audio, -1.0, 1.0), rate, format="WAV", subtype="PCM_16")
    os.replace(str(path) + ".tmp.wav", path)
    return peak


def synthesize(args) -> None:
    torch = import_stack(args.threads)
    import numpy as np  # noqa: F401  (fail early if missing)

    out, work = args.out, args.out / "work"
    work.mkdir(parents=True, exist_ok=True)
    refs = references(out)
    specs = model_specs(args)
    manifest_path = out / "samples.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"samples": {}}
    manifest.update(seed_base=SEED, temperature=TEMPERATURE, teacher_cfg=TEACHER_CFG,
                    teacher_decode_steps=TEACHER_STEPS, lines=LINES,
                    references={k: str(CHARACTERS[k]) for k in CHARACTERS},
                    models={k: {kk: str(vv) for kk, vv in v.items() if kk != "kind"} | {"kind": v["kind"]}
                            for k, v in specs.items()})
    for model_id in args.models:
        spec = specs[model_id]
        todo = [(c, i) for c in args.characters for i in range(len(LINES[c]))
                if args.force or not (out / f"{c}__{i + 1}__{model_id}.wav").exists()]
        if not todo:
            print(json.dumps({"model": model_id, "status": "already complete"}), flush=True)
            continue
        started = time.monotonic()
        if spec["kind"] == "teacher":
            ckpt = Path(spec["checkpoint"])
            if spec.get("sha256") and sha256_file(ckpt) != spec["sha256"]:
                raise ValueError(f"{ckpt} does not match its expected SHA-256")
            model, mimi = build_teacher(torch, teacher_build_config(args, work), from_export=False)
            payload = torch.load(ckpt, map_location="cpu", weights_only=True, mmap=True)
            if payload.get("step") != spec["step"] or payload["runner"].get("input_identity") != args.teacher_input_identity:
                raise ValueError("Checkpoint is not the expected step/run")
            state = dict(payload["model"])
            if spec["weights"] == "ema":
                if not payload.get("ema"):
                    raise ValueError("Checkpoint has no EMA weights")
                state.update(payload["ema"])
            elif payload.get("ema") is not None:
                raise ValueError("Raw checkpoint unexpectedly carries EMA weights")
            model.load_state_dict(state, strict=True)
            del payload, state
            generate = lambda v, t, s: teacher_audio(torch, model, mimi, v, t, s)  # noqa: E731
        elif spec["kind"] == "teacher_export":
            export = Path(spec["export"])
            if sha256_file(export / "model.safetensors") != spec["model_sha256"]:
                raise ValueError("Earlier teacher export differs from its accepted identity")
            config = relocated_export_config(export, work, 24, "earlier-teacher.yaml")
            model, mimi = build_teacher(torch, config, from_export=True)
            generate = lambda v, t, s: teacher_audio(torch, model, mimi, v, t, s)  # noqa: E731
        else:
            from pocket_tts import TTSModel

            export = Path(spec["export"])
            if sha256_file(export / "model.safetensors") != spec["model_sha256"]:
                raise ValueError("Student export differs from the runtime student identity")
            config = relocated_export_config(export, work, 6, "student.yaml")
            model = TTSModel.load_model(config=config, temp=TEMPERATURE, sampler_decode_steps=1,
                                        eos_threshold=-1.0, noise_clamp=None)
            mimi = model.mimi
            model.eval()
            states = {}

            def generate(reference, text, seed, _model=model):
                torch.manual_seed(seed)
                chunks = [c.detach().cpu().float().numpy().reshape(-1)
                          for c in _model.generate_audio_stream(states[reference], text, frames_after_eos=1,
                                                                copy_state=True)]
                return np.concatenate(chunks), {}
        print(json.dumps({"model": model_id, "loaded_seconds": round(time.monotonic() - started, 1)}), flush=True)
        voices = {}
        for character in args.characters:
            if spec["kind"] == "student":
                states[character] = model.get_state_for_audio_prompt(refs[character], truncate=False)
                voices[character] = character
            else:
                voices[character] = voice_latent(torch, mimi, refs[character])
        for character, index in todo:
            text = LINES[character][index]
            began = time.monotonic()
            audio, extra = generate(voices[character], text, SEED + index)
            path = out / f"{character}__{index + 1}__{model_id}.wav"
            peak = write_wav(path, audio, 24000)
            record = {"model": model_id, "character": character, "line": index + 1, "text": text,
                      "seed": SEED + index, "audio_seconds": round(len(audio) / 24000, 3),
                      "generation_seconds": round(time.monotonic() - began, 1), "peak": round(peak, 4), **extra}
            manifest["samples"][path.name] = record
            atomic_json(manifest_path, manifest)
            print(json.dumps(record), flush=True)
        del model
    atomic_json(manifest_path, manifest)


# --------------------------------------------------------------------- page

def assignment(out: Path, models: list[str], characters: list[str]) -> dict:
    """Stable per-character shuffle: a rerun never reveals or reshuffles."""
    path = out / "blind-key.json"
    key = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    rng = random.SystemRandom()
    for character in characters:
        if character not in key or sorted(key[character]) != sorted(models):
            order = list(models)
            rng.shuffle(order)
            key[character] = order
    atomic_json(path, key)
    return key


def page(args) -> None:
    import html

    out = args.out
    specs = model_specs(args)
    models = args.models
    key = assignment(out, models, args.characters)
    labels = "ABCDEFGH"
    rows = []
    for character in args.characters:
        cells = [f'<td><div class="cap">Real game clip</div><audio controls preload="none" '
                 f'src="{character}__reference.wav"></audio></td>']
        for slot, model_id in enumerate(key[character]):
            players = "".join(
                f'<div class="cap">Line {i + 1}</div><audio controls preload="none" '
                f'src="{character}__{i + 1}__{model_id}.wav"></audio>'
                for i in range(len(LINES[character])))
            cells.append(f"<td><div class=\"tag\">{labels[slot]}</div>{players}</td>")
        said = "".join(f"<li>{html.escape(t)}</li>" for t in LINES[character])
        rows.append(f"<tr><th scope=\"row\">{html.escape(character.replace('-', ' ').title())}"
                    f"<ol class=\"lines\">{said}</ol></th>{''.join(cells)}</tr>")
    head = "".join(f"<th>{c}</th>" for c in ["Real voice"] + [f"Sample {labels[i]}" for i in range(len(models))])
    keys = []
    for character in args.characters:
        mapping = ", ".join(f"{labels[i]} = {html.escape(specs[m]['label'])}" for i, m in enumerate(key[character]))
        keys.append(f"<li><b>{html.escape(character)}</b>: {mapping}</li>")
    document = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pocket voice listening test</title>
<style>
body{{font:15px/1.4 system-ui,sans-serif;margin:24px;max-width:1500px;color:#222;background:#fafafa}}
table{{border-collapse:collapse;width:100%}}
th,td{{border:1px solid #ccc;padding:8px;vertical-align:top;background:#fff}}
thead th{{background:#eee}}
tbody th{{text-align:left;min-width:190px}}
audio{{width:230px;display:block}}
.cap{{font-size:12px;color:#666;margin-top:6px}}
.tag{{font-weight:700;font-size:18px}}
.lines{{font-weight:400;font-size:12px;color:#555;padding-left:18px;margin:6px 0 0}}
details{{margin-top:28px}}
</style></head><body>
<h1>Does it sound like the character?</h1>
<p>Each row is one character. The first column is a real game recording of that voice. Samples A-D are the same
two new lines from four different models in a random order for each row, so listen blind. Judge whether the voice
sounds like the real one, not the wording.</p>
<table><thead><tr><th>Character</th>{head}</tr></thead><tbody>
{''.join(rows)}
</tbody></table>
<details><summary>Show which model is which (reveals the answer)</summary><ul>
{''.join(keys)}
</ul></details>
</body></html>
"""
    (out / "index.html").write_text(document, encoding="utf-8")
    print(json.dumps({"page": str(out / "index.html")}), flush=True)


# --------------------------------------------------------------- similarity

def similarity(args) -> None:
    """WavLM-base-plus-sv cosine (same model as scripts/Evaluate-VoiceSamples.py)."""
    torch = import_stack(args.threads)
    if args.extra_libs:
        sys.path.insert(0, str(args.extra_libs))
    os.environ["HF_HOME"] = str(ROOT / "vendor/voice-models")
    from transformers import AutoFeatureExtractor, AutoModelForAudioXVector
    import numpy as np
    import soundfile as sf
    from pocket_tts.data.audio_utils import convert_audio

    models = json.loads((ROOT / "runtime/voice-training/evaluation-models.json").read_text(encoding="utf-8"))
    path = models["microsoft/wavlm-base-plus-sv"]["path"]
    features = AutoFeatureExtractor.from_pretrained(path, local_files_only=True)
    model = AutoModelForAudioXVector.from_pretrained(path, local_files_only=True).eval()

    def embed(wav: Path):
        data, rate = sf.read(str(wav), dtype="float32", always_2d=True)
        tensor = torch.from_numpy(data.mean(axis=1))[None]
        mono = convert_audio(tensor, int(rate), 16000, 1)[0].numpy()
        batch = features(mono, sampling_rate=16000, return_tensors="pt", padding=True)
        with torch.inference_mode():
            return torch.nn.functional.normalize(model(**batch).embeddings, dim=-1)[0]

    result = {"model": "microsoft/wavlm-base-plus-sv", "scores": {}, "by_model": {}}
    for character in args.characters:
        reference = embed(args.out / f"{character}__reference.wav")
        for model_id in args.models:
            scores = []
            for i in range(len(LINES[character])):
                wav = args.out / f"{character}__{i + 1}__{model_id}.wav"
                if wav.exists():
                    scores.append(float(torch.dot(reference, embed(wav))))
            if scores:
                result["scores"].setdefault(character, {})[model_id] = [round(s, 4) for s in scores]
    for model_id in args.models:
        values = [s for c in result["scores"].values() for s in c.get(model_id, [])]
        if values:
            result["by_model"][model_id] = round(float(np.mean(values)), 4)
    atomic_json(args.out / "similarity.json", result)
    print(json.dumps(result, indent=1), flush=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=ROOT / "runtime/listening-20261005")
    parser.add_argument("--synthesize", action="store_true")
    parser.add_argument("--page", action="store_true")
    parser.add_argument("--similarity", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--models", nargs="+", default=["teacher-u1000-raw", "teacher-u5000-ema",
                        "student-runtime", "teacher-earlier-u500-ema"])
    parser.add_argument("--characters", nargs="+", default=list(CHARACTERS))
    parser.add_argument("--teacher1000", type=Path, default=ROOT / "runtime/voice-data-expansion-20261005/student-a1000/teacher/step000001000-raw.pt")
    parser.add_argument("--teacher1000-sha256", default="733c6ced3fb3261f1fc393202bfdd0a190cc9a6f117f1c591c70b658acf5b5d6")
    parser.add_argument("--teacher5000", type=Path, default=ROOT / "runtime/listening-20261005/checkpoints/step005000-last.pt")
    parser.add_argument("--teacher5000-sha256", default="efcc85d664715ae785bf287fc632cfb2ec278d9296adbb8ee18d13ba04d63f60")
    parser.add_argument("--teacher-input-identity", default="03e89124733a88ac5d869f0df5c79f0d2d60cc88a77a67bbc32d444a59ffc22c")
    parser.add_argument("--teacher-build-config", type=Path, default=ROOT / "runtime/voice-data-expansion-20261005/student-a1000/teacher/teacher-export-build.yaml")
    parser.add_argument("--tokenizer", type=Path, default=ROOT / "runtime/voice-data-expansion-20261005/student-a1000/teacher/export/tokenizer.json")
    parser.add_argument("--student-export", type=Path, default=ROOT / "runtime/kaggle-pocket-student-transfer-ddb133ba-output/student-transfer-results/distill/export")
    parser.add_argument("--earlier-teacher-export", type=Path, default=ROOT / "runtime/kaggle-pocket-teacher-improve-retry-output/teacher-improve-results/teacher/export")
    parser.add_argument("--extra-libs", type=Path, help="Directory with transformers for --similarity")
    args = parser.parse_args(argv)
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=True)
    if args.synthesize:
        synthesize(args)
    if args.page:
        page(args)
    if args.similarity:
        similarity(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
