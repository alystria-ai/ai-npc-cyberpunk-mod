"""Isolated CPU voice-cloning experiment; never starts the game or mod bridge.

Use a CPU-only Torch environment. The suite downloads once, exports Johnny's
conditioning state, then starts a fresh process for one cold and three warm
generations. All samples and machine receipts belong in an ignored directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import threading
import time

PROCESS_STARTED = time.perf_counter()
ROOT = Path(__file__).resolve().parents[1]
TEXT = "My man, Dex DeShawn. How's that quiet life workin' out for you now, choom?"
LANGUAGE = "english_2026-09"


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def cpu_environment(offline: bool) -> None:
    os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
    os.environ["HF_HOME"] = str(ROOT / "vendor" / "pocket-tts-cache")
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    if offline:
        os.environ["HF_HUB_OFFLINE"] = "1"
    else:
        os.environ.pop("HF_HUB_OFFLINE", None)
    token_file = ROOT / "runtime" / "huggingface-token.txt"
    if token_file.is_file():
        token = token_file.read_text(encoding="utf-8-sig").strip()
        if not token.startswith("hf_") or any(char.isspace() for char in token):
            raise ValueError("The local Hugging Face credential file is invalid")
        os.environ["HF_TOKEN"] = token


class ProcessMeter:
    """Sample resident working set; CPU time includes inference threads."""

    def __init__(self) -> None:
        import psutil

        self.process = psutil.Process()
        self.stop = threading.Event()
        self.peak_rss = self.process.memory_info().rss
        self.start_cpu = sum(self.process.cpu_times()[:2])
        self.started = time.perf_counter()
        self.thread = threading.Thread(target=self._sample, daemon=True)
        self.thread.start()

    def _sample(self) -> None:
        while not self.stop.wait(0.02):
            self.peak_rss = max(self.peak_rss, self.process.memory_info().rss)

    def finish(self) -> dict:
        self.stop.set()
        self.thread.join()
        self.peak_rss = max(self.peak_rss, self.process.memory_info().rss)
        cpu_s = sum(self.process.cpu_times()[:2]) - self.start_cpu
        wall_s = time.perf_counter() - self.started
        return {
            "peak_rss_bytes": self.peak_rss,
            "cpu_seconds": cpu_s,
            "average_cpu_cores": cpu_s / wall_s if wall_s else 0,
            "wall_seconds": wall_s,
        }


def load_cpu_model(offline: bool):
    cpu_environment(offline)
    import torch
    from pocket_tts import TTSModel

    if torch.version.cuda is not None:
        raise RuntimeError("Use a CPU-only Torch wheel for this experiment")
    model = TTSModel.load_model(language=LANGUAGE)
    if not model.has_voice_cloning:
        raise RuntimeError("Cloning weights unavailable; generic fallback is not a Johnny test")
    if str(model.device) != "cpu" or any(p.device.type != "cpu" for p in model.parameters()):
        raise RuntimeError("Pocket TTS must remain entirely on CPU")
    return torch, model


def prepare(output: Path) -> None:
    meter = ProcessMeter()
    started = time.perf_counter()
    torch, model = load_cpu_model(offline=False)
    loaded = time.perf_counter()
    registry = json.loads((ROOT / "runtime" / "local-voices.json").read_text(encoding="utf-8"))
    reference = (ROOT / registry["voices"]["johnny-silverhand"]["reference"]).resolve()
    voice_state = model.get_state_for_audio_prompt(reference)
    conditioned = time.perf_counter()
    from pocket_tts import export_model_state

    state_file = output / "johnny-state.safetensors"
    export_model_state(voice_state, state_file)
    import importlib.metadata
    import pocket_tts

    config_file = Path(pocket_tts.__file__).parent / "config" / f"{LANGUAGE}.yaml"
    config_text = config_file.read_text(encoding="utf-8")
    model_weights = [line.removeprefix("weights_path: ").strip()
                     for line in config_text.splitlines() if line.startswith("weights_path: ")]
    cached_weights = sorted((ROOT / "vendor" / "pocket-tts-cache" / "hub").glob(
        "models--kyutai--pocket-tts/snapshots/**/model.safetensors"))
    parameter_dtypes: dict[str, int] = {}
    for parameter in model.parameters():
        dtype = str(parameter.dtype)
        parameter_dtypes[dtype] = parameter_dtypes.get(dtype, 0) + parameter.numel()
    receipt = {
        "schema": 1,
        "package_version": importlib.metadata.version("pocket-tts"),
        "python_version": platform.python_version(),
        "torch_version": torch.__version__,
        "cuda_build": torch.version.cuda,
        "device": str(model.device),
        "language": LANGUAGE,
        "sample_rate": model.sample_rate,
        "sampler_decode_steps": model.sampler_decode_steps,
        "temperature": model.temp,
        "parameter_dtypes": parameter_dtypes,
        "torch_threads": torch.get_num_threads(),
        "torch_interop_threads": torch.get_num_interop_threads(),
        "text": TEXT,
        "reference": str(reference.relative_to(ROOT)).replace("\\", "/"),
        "reference_sha256": sha256(reference),
        "conditioning_state_bytes": state_file.stat().st_size,
        "conditioning_state_sha256": sha256(state_file),
        "model_weight_sources": model_weights,
        "cached_model_weights": [{"bytes": path.stat().st_size, "sha256": sha256(path)}
                                  for path in cached_weights],
        "config_sha256": sha256(config_file),
        "model_load_with_download_seconds": loaded - started,
        "reference_preparation_seconds": conditioned - loaded,
        "memory": meter.finish(),
    }
    write_json(output / "preparation.json", receipt)
    print("Cloning model and cached Johnny state prepared on CPU", flush=True)


def generate(torch, model, state, output: Path, label: str) -> dict:
    import numpy as np
    import soundfile as sf

    torch.manual_seed(1337)
    stop = threading.Event()
    timer = threading.Timer(120.0, stop.set)
    timer.daemon = True
    meter = ProcessMeter()
    started = time.perf_counter()
    chunks = []
    timeline = []
    total_samples = 0
    timer.start()
    try:
        for chunk in model.generate_audio_stream(state, TEXT, copy_state=True, stop=stop):
            arrived = time.perf_counter() - started
            chunk_array = chunk.detach().cpu().numpy().reshape(-1).copy()
            if not chunk_array.size:
                continue
            if not np.isfinite(chunk_array).all():
                raise RuntimeError("Non-finite PCM in generated output")
            timeline.append({
                "arrival_seconds": arrived,
                "samples": int(chunk_array.size),
                "audio_before_seconds": total_samples / model.sample_rate,
            })
            total_samples += int(chunk_array.size)
            chunks.append(chunk_array)
        generation_s = time.perf_counter() - started
    finally:
        timer.cancel()
        meter_result = meter.finish()
    if stop.is_set():
        raise RuntimeError("Generation cancelled at the experiment time limit")
    if not chunks:
        raise RuntimeError("No audio returned")
    pcm = np.concatenate(chunks)
    wav_file = output / f"Johnny-PocketTTS-{label}.wav"
    sf.write(wav_file, pcm, model.sample_rate, subtype="PCM_16")
    audio_duration = len(pcm) / model.sample_rate
    above_threshold = np.flatnonzero(np.abs(pcm) > 0.01)
    signal_onset = float(above_threshold[0] / model.sample_rate) if above_threshold.size else None
    required_start = max(entry["arrival_seconds"] - entry["audio_before_seconds"]
                         for entry in timeline)
    result = {
        "label": label,
        "first_pcm_seconds": timeline[0]["arrival_seconds"],
        "generation_seconds": generation_s,
        "audio_seconds": audio_duration,
        "first_sample_above_1_percent_seconds": signal_onset,
        "estimated_first_pcm_start_to_threshold_wall_seconds": (
            timeline[0]["arrival_seconds"] + signal_onset if signal_onset is not None else None
        ),
        "real_time_factor": generation_s / audio_duration,
        "minimum_start_for_observed_no_underrun_seconds": required_start,
        "additional_buffer_after_first_pcm_seconds": max(0, required_start - timeline[0]["arrival_seconds"]),
        "chunk_count": len(chunks),
        "peak_absolute_pcm": float(np.max(np.abs(pcm))),
        "out_of_pcm16_range_samples": int(np.sum(np.abs(pcm) > 1.0)),
        "wav": wav_file.name,
        "wav_sha256": sha256(wav_file),
        "memory": meter_result,
        "chunk_timeline": timeline,
    }
    print(f"{label}: first PCM {result['first_pcm_seconds']:.3f}s; "
          f"full generation {generation_s:.3f}s; audio {audio_duration:.2f}s", flush=True)
    return result


def worker(output: Path) -> None:
    meter = ProcessMeter()
    torch, model = load_cpu_model(offline=True)
    loaded = time.perf_counter()
    state = model.get_state_for_audio_prompt(output / "johnny-state.safetensors")
    ready = time.perf_counter()
    results = []
    for label in ("cold", "warm-1", "warm-2", "warm-3"):
        result = generate(torch, model, state, output, label)
        if label == "cold":
            result["worker_start_to_first_pcm_seconds"] = ready - PROCESS_STARTED + result["first_pcm_seconds"]
            result["worker_start_to_full_generation_seconds"] = ready - PROCESS_STARTED + result["generation_seconds"]
        results.append(result)
        write_json(output / "worker-results.json", {"generations": results})
    receipt = {
        "schema": 1,
        "cold_definition": "Fresh Python worker, cached downloads/state; OS disk cache not flushed",
        "imports_and_model_load_seconds": loaded - PROCESS_STARTED,
        "cached_voice_load_seconds": ready - loaded,
        "worker_start_to_ready_seconds": ready - PROCESS_STARTED,
        "memory": meter.finish(),
        "generations": results,
    }
    write_json(output / "worker-results.json", receipt)


def suite(output: Path) -> None:
    if (output / "results.json").exists():
        raise FileExistsError("Use a fresh --output directory to preserve completed results")
    output.mkdir(parents=True, exist_ok=True)
    timings = {}
    for phase in ("prepare", "worker"):
        started = time.perf_counter()
        with (output / f"{phase}.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                [sys.executable, "-u", str(Path(__file__).resolve()), "--phase", phase,
                 "--output", str(output)],
                stdout=log, stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            try:
                code = process.wait(timeout=900 if phase == "prepare" else 600)
            except BaseException:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                raise
        if code:
            raise RuntimeError(f"CPU experiment {phase} failed; inspect its local log")
        timings[f"{phase}_process_wall_seconds"] = time.perf_counter() - started
        print(f"{phase} completed", flush=True)
    import psutil

    results = {
        "schema": 1,
        "measured_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "host": {"platform": platform.platform(), "physical_cores": psutil.cpu_count(logical=False),
                 "logical_cores": psutil.cpu_count(), "system_ram_bytes": psutil.virtual_memory().total},
        "text": TEXT,
        "conditions": "Standalone CPU experiment; not a controlled live-game comparison",
        "process_timings": timings,
        "preparation": json.loads((output / "preparation.json").read_text(encoding="utf-8")),
        "benchmark": json.loads((output / "worker-results.json").read_text(encoding="utf-8")),
    }
    write_json(output / "results.json", results)
    print("CPU cloning comparison saved", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=("suite", "prepare", "worker"), default="suite")
    parser.add_argument("--output", type=Path, default=ROOT / "runtime" / "pocket-tts-comparison-20261002")
    args = parser.parse_args()
    output = args.output.resolve()
    if ROOT / "runtime" not in output.parents:
        parser.error("Experiment output must stay inside the project's ignored runtime directory")
    {"suite": suite, "prepare": prepare, "worker": worker}[args.phase](output)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not dump environment, request headers, or credentials on failure.
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
