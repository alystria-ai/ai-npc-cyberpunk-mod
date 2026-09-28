"""Same-character listening comparison; one isolated GPU engine per process.

Use VoiceStudio's Python for OmniVoice/VoxCPM2 and the Chatterbox environment
for Turbo/Nano. Preserve prior receipts and leave production settings unchanged.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
MODELS = {
    "omnivoice": ("k2-fsa/OmniVoice", "c5fdb5ccb189668d56333f77ba2629f4cd7535f4"),
    "voxcpm2": ("openbmb/VoxCPM2", "32279effe8c19989596f05d353d1447f51d9e915"),
    "chatterbox-turbo": ("ResembleAI/chatterbox-turbo", "749d1c1a46eb10492095d68fbcf55691ccf137cd"),
    "chatterbox-nano": ("ResembleAI/chatterbox-nano", "71ccd1d0081b430592cea481f4307e764e07bc64"),
}
TEXT = "Hey V, slow down a second. We have been running all over Night City, and you still have not told me what is on your mind."


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=MODELS, required=True)
    parser.add_argument("--key", default="johnny-silverhand")
    parser.add_argument("--label", default="five-options-johnny")
    parser.add_argument("--original-line", help="Verified game line to reproduce; must differ from the cloning reference")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9-]{1,40}", args.label):
        parser.error("Invalid comparison label")
    selected = json.loads((ROOT / "runtime/voice-references/selected-benchmark.json").read_text("utf-8"))
    ref = next(r for r in selected["clips"] if r["key"] == args.key)
    if not ref["source"]["sha1Verified"] or hashlib.sha256(Path(ref["wavPath"]).read_bytes()).hexdigest() != ref["wav"]["sha256"]:
        raise ValueError("Changed or unverified reference recording")
    def clean_transcript(value):
        # Older metadata was read as Windows-1252 although it contained UTF-8.
        # Reverse only a lossless, recognizable mojibake conversion.
        if "â" in value:
            try:
                return value.encode("cp1252").decode("utf-8")
            except UnicodeError:
                pass
        return value
    ref_text = clean_transcript(ref["transcript"])
    text = TEXT
    original = None
    if args.original_line:
        catalog = json.loads((ROOT / "runtime/voice-references/extracted/manifest.json").read_text("utf-8"))
        original = next(r for r in catalog["candidates"] if r["key"] == args.key and r["stringId"] == args.original_line)
        if original["stringId"] == ref["stringId"]:
            raise ValueError("Use a different original line from the cloning reference")
        if not original["source"]["sha1Verified"] or hashlib.sha256(Path(original["wavPath"]).read_bytes()).hexdigest() != original["wav"]["sha256"]:
            raise ValueError("Changed or unverified original recording")
        text = clean_transcript(original["transcript"])
    directory = ROOT / "runtime/voice-comparison" / args.label / args.engine
    directory.mkdir(parents=True, exist_ok=True)
    report_path = directory / "report.json"
    if report_path.exists():
        raise FileExistsError("Use a new label to preserve earlier results")
    repo, revision = MODELS[args.engine]
    checkpoint = ROOT / "vendor/voice-models/hub" / ("models--" + repo.replace("/", "--")) / "snapshots" / revision
    if not checkpoint.is_dir():
        raise FileNotFoundError("The pinned model must already be downloaded")
    os.environ.update({
        "HF_HOME": str(ROOT / "vendor/voice-models"), "HF_HUB_OFFLINE": "1",
        "OMNIVOICE_DATA_DIR": str(ROOT / "runtime/voice-studio-data"),
        "OMNIVOICE_MODEL": str(ROOT / "vendor/voice-models/hub/models--k2-fsa--OmniVoice/snapshots" / MODELS["omnivoice"][1]),
        "OMNIVOICE_TTS_BACKEND": args.engine, "OMNIVOICE_GPU_WORKERS": "1",
        "OMNIVOICE_PRELOAD_TTS_ASR": "0", "OMNIVOICE_ASR_BACKEND": "pytorch-whisper",
        "OMNIVOICE_VOXCPM2_DIR": str(ROOT / "vendor/voxcpm2-runtime"),
        "OMNIVOICE_VOXCPM_MODEL": str(checkpoint), "TORCH_COMPILE_DISABLE": "1",
        "PYTHONUTF8": "1",
    })
    import psutil
    process = psutil.Process()
    samples = []
    finished = threading.Event()

    def sample_ram():
        while not finished.is_set():
            rss = private = 0
            for proc in [process] + process.children(recursive=True):
                try:
                    memory = proc.memory_info()
                    rss += memory.rss
                    private += getattr(memory, "private", 0)
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            samples.append({"time": time.perf_counter(), "rssMiB": rss / 1024**2,
                            "privateMiB": private / 1024**2})
            finished.wait(.2)

    monitor = threading.Thread(target=sample_ram, daemon=True)
    monitor.start()
    backend = None
    report = {"engine": args.engine, "key": args.key, "text": text,
              "model": {"repo": repo, "revision": revision},
              "referencePath": ref["wavPath"], "referenceSha256": ref["wav"]["sha256"],
              "referenceTranscript": ref_text, "referenceTranscriptEncodingRepaired": ref_text != ref["transcript"],
              "originalLine": {"stringId": original["stringId"], "path": original["wavPath"], "sha256": original["wav"]["sha256"]} if original else None,
              "clips": [], "warmups": [],
              "conditions": "Same original reference and text; one engine resident; CUDA; no added voice effects, mastering or denoising. VoiceStudio adapters preserve their reference preparation; Chatterbox reference loudness normalization disabled and stock watermark retained.",
              "ramMetric": "Sum of process-tree working sets sampled every 200 ms; shared library pages may be counted more than once. Private commit is separate from resident RAM.",
              "latencyMetric": "Complete waveform after warmup, including the adapter's reference handling; excludes Convai, HTTP and in-game playback.",
              "listeningAccepted": False}

    def save():
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    try:
        import numpy as np
        import soundfile as sf
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA unavailable; refusing a CPU fallback")
        report["gpu"] = torch.cuda.get_device_name()
        report["torch"] = torch.__version__
        is_chatterbox = args.engine.startswith("chatterbox")
        if is_chatterbox:
            torch.set_num_threads(4)
            from chatterbox.tts_turbo import ChatterboxTurboTTS
            begin = time.perf_counter()
            model = ChatterboxTurboTTS.from_local(str(checkpoint), "cuda", nano=args.engine.endswith("nano"))
            torch.cuda.synchronize()
            report["modelLoadSeconds"] = time.perf_counter() - begin
            begin = time.perf_counter()
            model.prepare_conditionals(ref["wavPath"], norm_loudness=False)
            torch.cuda.synchronize()
            report["referencePreparationSeconds"] = time.perf_counter() - begin
            sample_rate = model.sr
            options = [(args.engine, None)]

            def generate(steps):
                return model.generate(text, norm_loudness=False)
        else:
            sys.path.insert(0, str(ROOT / "vendor/reference-voicestudio/backend"))
            from services.tts_backend import get_backend_class
            logging.basicConfig(level=logging.INFO, stream=sys.stderr)
            backend = get_backend_class(args.engine)()
            report["voiceStudioRevision"] = "08a1592e3cb9b4c36beef5fa3185ec2313bb1fea"
            if args.engine == "omnivoice":
                begin = time.perf_counter()
                backend._ensure_loaded()
                torch.cuda.synchronize()
                report["modelLoadSeconds"] = time.perf_counter() - begin
                report["executionDevice"] = backend.execution_device
                if not report["executionDevice"].startswith("cuda"):
                    raise RuntimeError("OmniVoice did not load on CUDA")
                options = [("omnivoice-32", 32), ("omnivoice-16", 16)]
            else:
                options = [("voxcpm2-10", 10)]
                report["seedNote"] = "The unmodified VoiceStudio VoxCPM2 adapter does not forward the seed to its isolated engine"
            sample_rate = backend.sample_rate

            def generate(steps):
                return backend.generate(text, ref_audio=ref["wavPath"], ref_text=ref_text,
                                        language="English", num_step=steps, guidance_scale=2.0,
                                        speed=1, denoise=False, postprocess_output=False)
        report["cpuThreads"] = torch.get_num_threads()
        for variant, steps in options:
            # One warmup followed by two recorded runs. Same seed for each
            # in-process render; independent engines do not share RNG semantics.
            for run in range(3):
                own_cuda = args.engine != "voxcpm2"
                if own_cuda:
                    torch.manual_seed(1042)
                    torch.cuda.reset_peak_memory_stats()
                    torch.cuda.synchronize()
                begin = time.perf_counter()
                with torch.inference_mode():
                    wav = generate(steps)
                if own_cuda:
                    torch.cuda.synchronize()
                end = time.perf_counter()
                values = np.asarray(wav.detach().float().cpu() if hasattr(wav, "detach") else wav).reshape(-1)
                if not values.size or not np.isfinite(values).all():
                    raise ValueError("Invalid audio from engine")
                during = [s for s in samples if begin <= s["time"] <= end]
                row = {"key": args.key, "variant": variant, "name": "conversation", "run": run,
                       "text": text, "steps": steps, "generationSeconds": end - begin,
                       "seconds": values.size / sample_rate, "sampleRate": sample_rate,
                       "peakAbsolute": float(np.abs(values).max()),
                       "fullScaleSamples": int(np.count_nonzero(np.abs(values) >= 32766/32768)),
                       "processTreeRssPeakMiB": max(s["rssMiB"] for s in during),
                       "processTreePrivatePeakMiB": max(s["privateMiB"] for s in during)}
                if own_cuda:
                    row.update({"cudaPeakAllocatedMiB": torch.cuda.max_memory_allocated()/1024**2,
                                "cudaPeakReservedMiB": torch.cuda.max_memory_reserved()/1024**2})
                else:
                    backend.health_check()
                    row["cudaResidentAllocatedMiB"] = backend._vram_mb
                if run:
                    path = directory / f"{variant}-run{run}.wav"
                    sf.write(path, values, sample_rate, subtype="PCM_16")
                    row.update({"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
                    report["clips"].append(row)
                else:
                    report["warmups"].append(row)
                print(json.dumps(row), flush=True)
                save()
        report.update({"completed": True, "wholeProcessTreeRssPeakMiB": max(s["rssMiB"] for s in samples),
                       "wholeProcessTreePrivatePeakMiB": max(s["privateMiB"] for s in samples)})
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        finished.set()
        monitor.join(timeout=2)
        save()
        if backend is not None:
            backend.unload()


if __name__ == "__main__":
    main()
