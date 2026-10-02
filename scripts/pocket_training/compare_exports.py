"""Offline listening and resource measurements for selected EMA exports.

The default sampler exactly follows the cloud comparison: teacher CFG2,
distilled student CFG1, seed 1337, temperature 0.3 and one decode step. The
public inference API has no CFG2 argument, so its optional streaming student
measurement is a separate sample, not a substitute for the teacher comparison.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import threading
import time
from typing import Any

from pocket_training.runner import (
    PINNED_REVISION, atomic_json, local_path, read_json, relocate_export,
    sha256_file, source_digest,
)

PROCESS_STARTED = time.perf_counter()
ROOT = Path(__file__).resolve().parents[2]
PINNED_SOURCE_DIGEST = "b86f98955b6c4776bb24a748b321408aba89d3b66f6b911f415ef4f4191a7666"
TEXT = "My man, Dex DeShawn. How's that quiet life workin' out for you now, choom?"
SEED = 1337
TEMPERATURE = 0.3
ASSETS = ("model.safetensors", "tokenizer.json", "inference.yaml", "receipt.json")


def cpu_environment(threads: int) -> dict[str, str]:
    """Only local assets are used; a CUDA-capable wheel is allowed on CPU."""
    env = dict(os.environ)
    env.update(CUDA_VISIBLE_DEVICES="-1", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
               HF_HUB_DISABLE_TELEMETRY="1", HF_HUB_DISABLE_PROGRESS_BARS="1",
               PYTHONDONTWRITEBYTECODE="1", TOKENIZERS_PARALLELISM="false",
               OMP_NUM_THREADS=str(threads), MKL_NUM_THREADS=str(threads),
               OPENBLAS_NUM_THREADS=str(threads))
    for name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "KAGGLE_API_TOKEN"):
        env.pop(name, None)
    return env


def inspect_export(directory: Path, role: str, weight_kind: str = "ema") -> dict[str, Any]:
    """Check identity before any model import or configuration mutation."""
    import yaml

    if role not in ("teacher", "student"):
        raise ValueError("Export role must be teacher or student")
    if weight_kind not in ("ema", "raw") or (weight_kind == "raw" and role != "student"):
        raise ValueError("Raw comparison is an explicit student-only choice")
    directory = directory.resolve()
    for name in ASSETS:
        if not local_path(directory, name).is_file():
            raise ValueError(f"Export asset is not a file: {name}")
    receipt = read_json(directory / "receipt.json")
    if not isinstance(receipt, dict):
        raise ValueError("Export receipt must be an object")
    step = receipt.get("selected_step" if weight_kind == "ema" else "checkpoint_step")
    if not isinstance(step, int) or isinstance(step, bool) or step <= 0:
        raise ValueError("A selected trained checkpoint with a positive step is required")
    cfg = 2.0 if role == "teacher" else 1.0
    if (receipt.get("weights") != weight_kind or receipt.get("sample_cfg") != cfg
            or receipt.get("source_revision") != PINNED_REVISION):
        raise ValueError("Export must identify the pinned source and expected weight/CFG selection")
    if weight_kind == "raw":
        digest = receipt.get("source_checkpoint_sha256", "")
        if (not isinstance(digest, str) or len(digest) != 64
                or any(c not in "0123456789abcdef" for c in digest)
                or type(receipt.get("validated_probe_count")) is not int
                or receipt["validated_probe_count"] < 2):
            raise ValueError("Raw student export needs checkpoint provenance and validated termination probes")
    identity = receipt.get("input_identity", "")
    if not isinstance(identity, str) or len(identity) != 64:
        raise ValueError("Export lacks its training input identity")
    try:
        if len(bytes.fromhex(identity)) != 32:
            raise ValueError("Input identity must decode to 32 bytes")
    except ValueError as exc:
        raise ValueError("Export input identity is not SHA256") from exc
    weights = directory / "model.safetensors"
    weight_hash = sha256_file(weights)
    if receipt.get("model_sha256") != weight_hash:
        raise ValueError("Export weights do not match the selected-checkpoint receipt")
    config = yaml.safe_load((directory / "inference.yaml").read_text(encoding="utf-8-sig"))
    expected_layers = 24 if role == "teacher" else 6
    if config["flow_lm"]["transformer"]["num_layers"] != expected_layers:
        raise ValueError(f"Expected {expected_layers} layers for {role}")
    return {
        "role": role, "directory": str(directory), "selected_step": step, "weights": weight_kind,
        "input_identity": identity, "sample_cfg": cfg, "layers": expected_layers,
        "weights_bytes": weights.stat().st_size, "weights_sha256": weight_hash,
        "export_bytes": sum((directory / name).stat().st_size for name in ASSETS),
        "tokenizer_sha256": sha256_file(directory / "tokenizer.json"),
        "quality_parity_qualified": False,
    }


def make_plan(args: argparse.Namespace) -> dict[str, Any]:
    source = args.source.resolve()
    actual_digest = source_digest(source)
    if actual_digest != PINNED_SOURCE_DIGEST:
        raise ValueError("Local Pocket source differs from the pinned official source")
    exports = [inspect_export(args.teacher_export, "teacher"),
               inspect_export(args.student_export, "student", getattr(args, "student_weight_kind", "ema"))]
    if exports[0]["input_identity"] != exports[1]["input_identity"]:
        raise ValueError("Teacher and student belong to different training inputs")
    if args.expected_input_identity and exports[0]["input_identity"] != args.expected_input_identity:
        raise ValueError("Exports do not match the requested training run")
    for path in (args.reference, args.original, args.omni32):
        if not path.resolve().is_file():
            raise FileNotFoundError(f"Required local audio is missing: {path}")
    return {
        "schema": 1, "status": "planned", "device": "cpu", "gpu_vram_bytes": 0,
        "source": str(source), "source_revision": PINNED_REVISION,
        "source_digest": actual_digest, "models": exports, "text": TEXT,
        "seed": SEED, "temperature": TEMPERATURE, "decode_steps": 1,
        "threads": args.threads, "warm_runs": args.warm_runs,
        "max_audio_seconds": args.max_audio_seconds,
        "worker_timeout_seconds": args.worker_timeout,
        "public_student_stream": args.public_student_stream,
        "reference": str(args.reference.resolve()),
        "reference_sha256": sha256_file(args.reference),
        "original": str(args.original.resolve()), "omni32": str(args.omni32.resolve()),
        "output": str(args.output.resolve()), "model_execution": False,
        "cold_definition": "Fresh Python worker; local assets and OS disk cache are not flushed",
        "scope": "CPU sample/resource comparison; no game-FPS or perceptual-quality qualification",
    }


class ProcessMeter:
    def __init__(self) -> None:
        import psutil

        self.process = psutil.Process()
        self.peak_rss = self.process.memory_info().rss
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._sample, daemon=True)
        self.thread.start()

    def _sample(self) -> None:
        while not self.stop.wait(0.02):
            self.peak_rss = max(self.peak_rss, self.process.memory_info().rss)

    def rss(self) -> int:
        value = self.process.memory_info().rss
        self.peak_rss = max(self.peak_rss, value)
        return value

    def finish(self) -> dict[str, Any]:
        self.stop.set()
        self.thread.join()
        result = {"sampled_peak_rss_bytes": max(self.peak_rss, self.rss()),
                  "rss_sample_interval_seconds": 0.02}
        try:
            import resource

            raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            result["os_peak_rss_bytes"] = int(raw if sys.platform == "darwin" else raw * 1024)
        except ImportError:
            # Windows psutil exposes the process high-water mark separately.
            result["os_peak_rss_bytes"] = getattr(self.process.memory_info(), "peak_wset", None)
        return result


def stream_timing(timeline: list[dict[str, Any]]) -> dict[str, float]:
    if not timeline:
        raise ValueError("No PCM chunks were produced")
    first = timeline[0]["arrival_seconds"]
    minimum_start = max(row["arrival_seconds"] - row["audio_before_seconds"] for row in timeline)
    return {"first_pcm_seconds": first,
            "minimum_start_for_observed_no_underrun_seconds": minimum_start,
            "additional_buffer_after_first_pcm_seconds": max(0.0, minimum_start - first)}


def require_cpu(torch: Any, *modules: Any) -> dict[str, int]:
    if torch.cuda.is_available():
        raise RuntimeError("CUDA must be hidden for this CPU measurement")
    dtypes: dict[str, int] = {}
    for module in modules:
        for parameter in module.parameters():
            if parameter.device.type != "cpu":
                raise RuntimeError("Model parameter is not on CPU")
            key = str(parameter.dtype)
            dtypes[key] = dtypes.get(key, 0) + parameter.numel()
        if any(value.device.type != "cpu" for value in module.buffers()):
            raise RuntimeError("Model buffer is not on CPU")
    return dtypes


def worker(request_path: Path) -> int:
    request = read_json(request_path)
    environment = cpu_environment(request["threads"])
    os.environ.clear()
    os.environ.update(environment)
    sys.path.insert(0, request["source"])
    output = Path(request["worker_output"])
    result = {**request["model"], "status": "loading", "sampler": request["sampler"],
              "device": "cpu", "gpu_vram_bytes": 0, "generations": []}
    atomic_json(output / "measurements.json", result)
    meter = ProcessMeter()
    try:
        imported = time.perf_counter()
        import torch
        import numpy as np
        import soundfile as sf
        import pocket_tts

        if not Path(pocket_tts.__file__).resolve().is_relative_to(Path(request["source"]).resolve()):
            raise RuntimeError("Pocket import did not resolve to the pinned source")
        torch.set_num_threads(request["threads"])
        torch.set_num_interop_threads(1)
        public = request["sampler"] == "public_student_stream"
        if public:
            from pocket_tts import TTSModel
        else:
            from training.args import TrainArgs
            from training.modules.builders import build_models
            from training.dataloader.audio import _load_window
            from pocket_tts.modules.stateful_module import init_states
        result["dependency_import_seconds"] = time.perf_counter() - imported
        before = time.perf_counter()
        if public:
            model = TTSModel.load_model(config=request["config"], temp=TEMPERATURE,
                                       sampler_decode_steps=1, eos_threshold=-1.0, noise_clamp=None)
            if not model.has_voice_cloning:
                raise RuntimeError("The export does not support reference-conditioned voices")
            mimi = model.mimi
            inference_module = model.flow_lm
        else:
            model, mimi, _ = build_models(TrainArgs(model_config=request["config"],
                start_from_pretrained=True, compile=False, text_dropout=0, voice_dropout=0))
            inference_module = model.flow_lm
        model.eval()
        mimi.eval()
        result["model_load_seconds"] = time.perf_counter() - before
        result["parameter_dtypes"] = require_cpu(torch, model, *(() if public else (mimi,)))
        result.update(inference_parameters=sum(p.numel() for p in inference_module.parameters()),
                      codec_parameters=sum(p.numel() for p in mimi.parameters()),
                      resident_after_load_rss_bytes=meter.rss(),
                      python_version=platform.python_version(), torch_version=str(torch.__version__),
                      torch_cuda_build=torch.version.cuda, threads=torch.get_num_threads(),
                      interop_threads=torch.get_num_interop_threads())
        print(json.dumps({"stage": "loaded", "model": request["model"]["role"],
                          "sampler": request["sampler"], "rss_bytes": meter.rss()}), flush=True)
        before = time.perf_counter()
        reference = Path(request["reference"])
        info = sf.info(reference)
        if not 1 <= info.duration <= 30:
            raise ValueError("Comparison reference must contain 1 to 30 seconds of original speech")
        with torch.no_grad():
            if public:
                voice = model.get_state_for_audio_prompt(reference)
            else:
                wave = _load_window(str(reference), 0, info.duration, mimi.sample_rate)
                voice = mimi.encode_to_latent(torch.from_numpy(wave)[None, None])[0]
                tokens = torch.tensor(model.flow_lm.conditioner.tokenizer.encode(TEXT), dtype=torch.long)
        result.update(reference_preparation_seconds=time.perf_counter() - before,
                      reference_seconds=info.duration, reference_sha256=request["reference_sha256"],
                      resident_ready_rss_bytes=meter.rss(), status="generating")
        atomic_json(output / "measurements.json", result)
        for index in range(request["warm_runs"] + 1):
            torch.manual_seed(SEED)
            before = time.perf_counter()
            cpu_before = sum(meter.process.cpu_times()[:2])
            timing: dict[str, Any] = {}
            with torch.no_grad():
                if public:
                    chunks, timeline, samples = [], [], 0
                    stop = threading.Event()
                    timer = threading.Timer(request["worker_timeout_seconds"], stop.set)
                    timer.daemon = True
                    timer.start()
                    try:
                        for chunk in model.generate_audio_stream(voice, TEXT, frames_after_eos=1,
                                                                 copy_state=True, stop=stop):
                            arrived = time.perf_counter() - before
                            part = chunk.detach().cpu().float().numpy().reshape(-1).copy()
                            if not part.size:
                                continue
                            if not np.isfinite(part).all():
                                raise RuntimeError("Non-finite generated PCM")
                            timeline.append({"arrival_seconds": arrived,
                                             "audio_before_seconds": samples / model.sample_rate})
                            samples += part.size
                            if samples > request["max_audio_seconds"] * model.sample_rate:
                                stop.set()
                                raise RuntimeError("Public inference exceeded the comparison audio cap")
                            chunks.append(part)
                    finally:
                        timer.cancel()
                        stop.set()
                    audio = np.concatenate(chunks) if chunks else np.empty(0, dtype=np.float32)
                    timing = {**stream_timing(timeline), "chunk_count": len(timeline)}
                else:
                    max_frames = int(request["max_audio_seconds"] * mimi.frame_rate)
                    latent = model.generate([tokens], [voice], max_frames=max_frames, temp=TEMPERATURE,
                            n_steps=1, cfg_coef=request["model"]["sample_cfg"],
                            eos_threshold=-1.0, eos_countdown=1)[0]
                    if latent.shape[0] < 8 or latent.shape[0] >= max_frames or not torch.isfinite(latent).all():
                        raise RuntimeError("Generated latents are empty, non-finite, or reached the audio cap")
                    state = init_states(mimi, 1, (latent.shape[0] + 8)
                                        * round(mimi.encoder_frame_rate / mimi.frame_rate))
                    audio = mimi.decode_from_latent(latent[None], state)[0, 0].float().cpu().numpy()
            elapsed = time.perf_counter() - before
            if not np.isfinite(audio).all() or len(audio) < mimi.sample_rate:
                raise RuntimeError("Generated PCM is non-finite or shorter than one second")
            duration = len(audio) / mimi.sample_rate
            audio_ready = time.perf_counter()
            generation = {"run": "first" if index == 0 else f"warm-{index}",
                "generation_seconds": elapsed, "audio_seconds": duration,
                "real_time_factor": elapsed / duration, "rss_bytes": meter.rss(),
                "cpu_seconds": sum(meter.process.cpu_times()[:2]) - cpu_before,
                "seed": SEED, "temperature": TEMPERATURE, "decode_steps": 1,
                "cfg": request["model"]["sample_cfg"], "postprocessing": "none", **timing}
            if index == 0:
                sample = Path(request["sample"])
                # Preserve source amplitude. FLOAT avoids clipping or normalizing the waveform.
                sf.write(sample, audio, mimi.sample_rate, format="WAV", subtype="FLOAT")
                generation.update(audio=str(sample), audio_sha256=sha256_file(sample),
                                  worker_start_to_full_audio_seconds=audio_ready - PROCESS_STARTED,
                                  peak_absolute_pcm=float(np.abs(audio).max()))
                if public:
                    generation["worker_start_to_first_pcm_seconds"] = (
                        before - PROCESS_STARTED + generation["first_pcm_seconds"])
            result["generations"].append(generation)
            atomic_json(output / "measurements.json", result)
            print(json.dumps({"stage": "generated", "role": request["model"]["role"],
                              "run": generation["run"], "generation_seconds": elapsed,
                              "audio_seconds": duration}), flush=True)
        result.update(status="completed", memory=meter.finish(), sample_rate=mimi.sample_rate,
                      model_execution=True, quality_parity_qualified=False)
        atomic_json(output / "measurements.json", result)
        return 0
    except BaseException as exc:
        result.update(status="failed", error_type=type(exc).__name__, error=str(exc), memory=meter.finish())
        atomic_json(output / "measurements.json", result)
        raise


def run_worker(entry: Path, request_path: Path, output: Path, threads: int, timeout: int) -> None:
    kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    with (output / "worker.log").open("w", encoding="utf-8") as log:
        subprocess.run([sys.executable, "-X", "utf8", str(entry), "--worker-request", str(request_path)],
            env=cpu_environment(threads), stdout=log, stderr=subprocess.STDOUT,
            timeout=timeout, check=True, **kwargs)


def suite(plan: dict[str, Any], entry: Path) -> dict[str, Any]:
    output = Path(plan["output"])
    output.mkdir(parents=True, exist_ok=False)
    listen = output / "listen"
    listen.mkdir()
    result = {**plan, "status": "running", "results": [], "reference_samples": []}
    for field, name in (("original", "00-Johnny-original.wav"), ("omni32", "01-Johnny-OmniVoice32.wav")):
        destination = listen / name
        shutil.copyfile(plan[field], destination)
        result["reference_samples"].append({"role": field, "audio": str(destination),
                                             "sha256": sha256_file(destination)})
    atomic_json(output / "comparison.json", result)
    specs = [(model, "official_training") for model in plan["models"]]
    if plan["public_student_stream"]:
        specs.append((plan["models"][1], "public_student_stream"))
    try:
        for number, (model, sampler) in enumerate(specs, 2):
            folder = output / f"{model['role']}-{sampler}"
            folder.mkdir()
            relocated = relocate_export(Path(model["directory"]))
            sample = listen / f"{number:02d}-Johnny-{model['role']}-{sampler}-cfg{int(model['sample_cfg'])}.wav"
            request = {**plan, "model": model, "sampler": sampler, "config": relocated["config"],
                       "worker_output": str(folder), "sample": str(sample)}
            request_path = folder / "request.json"
            atomic_json(request_path, request)
            run_worker(entry, request_path, folder, plan["threads"], plan["worker_timeout_seconds"])
            measured = read_json(folder / "measurements.json")
            if measured.get("status") != "completed" or not sample.is_file():
                raise RuntimeError("Worker did not complete a validated sample")
            result["results"].append(measured)
            atomic_json(output / "comparison.json", result)
    except BaseException as exc:
        result.update(status="failed", error_type=type(exc).__name__, error=str(exc))
        atomic_json(output / "comparison.json", result)
        raise
    result.update(status="completed", model_execution=True)
    atomic_json(output / "comparison.json", result)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker-request", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--teacher-export", type=Path)
    parser.add_argument("--student-export", type=Path)
    parser.add_argument("--student-weight-kind", choices=("ema", "raw"), default="ema")
    parser.add_argument("--expected-input-identity")
    parser.add_argument("--source", type=Path, default=ROOT / "vendor/pocket-tts-training/source")
    parser.add_argument("--reference", type=Path,
                        default=ROOT / "runtime/pocket-reference-test-20261002/Johnny-reference-22s.wav")
    parser.add_argument("--original", type=Path,
                        default=ROOT / "runtime/pocket-tts-comparison-20261002/listen/00-Johnny-original.wav")
    parser.add_argument("--omni32", type=Path,
                        default=ROOT / "runtime/pocket-tts-comparison-20261002/listen/02-Johnny-OmniVoice32.wav")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--warm-runs", type=int, default=1)
    parser.add_argument("--max-audio-seconds", type=int, default=30)
    parser.add_argument("--worker-timeout", type=int, default=900)
    parser.add_argument("--public-student-stream", action="store_true")
    parser.add_argument("--plan-only", action="store_true")
    args = parser.parse_args(argv)
    if args.worker_request:
        return worker(args.worker_request)
    if not args.teacher_export or not args.student_export or not args.output:
        parser.error("--teacher-export, --student-export and --output are required")
    if not 1 <= args.threads <= 8 or not 0 <= args.warm_runs <= 5:
        parser.error("threads must be 1..8 and warm-runs 0..5")
    if not 5 <= args.max_audio_seconds <= 60 or not 60 <= args.worker_timeout <= 1800:
        parser.error("audio cap must be 5..60 seconds and worker timeout 60..1800 seconds")
    plan = make_plan(args)
    if args.plan_only:
        print(json.dumps(plan, indent=2), flush=True)
        return 0
    result = suite(plan, ROOT / "scripts/Pocket-CompareExports.py")
    compact = [{"role": row["role"], "sampler": row["sampler"],
                "selected_step": row["selected_step"], "weights_bytes": row["weights_bytes"],
                "load_seconds": row["model_load_seconds"], "memory": row["memory"],
                "generations": row["generations"]} for row in result["results"]]
    print(json.dumps({"status": result["status"], "output": result["output"], "results": compact}, indent=2))
    return 0
