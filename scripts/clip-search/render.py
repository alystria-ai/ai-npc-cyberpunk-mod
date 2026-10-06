"""Renderers for the clip search: OmniVoice (in this process, GPU) and a pool of Pocket workers (CPU subprocesses).

A job is {"ref": abs wav, "transcript": text, "text": text to speak, "seed": int, "out": abs wav}.  render(jobs) returns
one dict per job: {"ok": bool, "seconds": float, "tookMs": int, "error": str|None}.  Both follow the bridge's own
settings (see scripts/reference-picker/omni-worker.py and scripts/clip-search/pocket_worker.py); only the seed varies.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

POCKET_PYTHON = ROOT / "vendor/pocket-tts-env/Scripts/python.exe"
BELOW_NORMAL_PRIORITY = 0x00004000


class OmniRenderer:
    """OmniVoice FP16 on CUDA, English, guidance 2.0, speed 1, denoise off, no post-processing; steps 16 or 32."""
    name = "omni"

    def __init__(self, steps: int = 16, batch: int = 8):
        self.steps, self.batch = steps, batch
        config = json.loads((ROOT / "runtime/local-voices.json").read_text(encoding="utf-8-sig"))
        model_dir = ROOT / config["model"]
        if not (model_dir / "model.safetensors").is_file() or config.get("engine") != "omnivoice":
            raise FileNotFoundError("The configured OmniVoice snapshot is missing")
        self.revision = config.get("revision")
        cache = common.WORK / "omni-prompt-cache"
        cache.mkdir(parents=True, exist_ok=True)
        os.environ.update({
            "HF_HOME": str(ROOT / "vendor/voice-models"), "HF_HUB_OFFLINE": "1", "OMNIVOICE_DATA_DIR": str(cache),
            "OMNIVOICE_MODEL": str(model_dir), "OMNIVOICE_TTS_BACKEND": "omnivoice", "OMNIVOICE_GPU_WORKERS": "1",
            "OMNIVOICE_PRELOAD_TTS_ASR": "0", "OMNIVOICE_ASR_BACKEND": "pytorch-whisper",
            "TORCH_COMPILE_DISABLE": "1", "PYTHONUTF8": "1"})
        for name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "KAGGLE_API_TOKEN"):
            os.environ.pop(name, None)
        sys.path.insert(0, str(ROOT / "vendor/reference-voicestudio/backend"))
        import torch
        from services import tts_backend
        if not torch.cuda.is_available():
            raise RuntimeError("OmniVoice needs CUDA")
        self.torch = torch
        self.backend = tts_backend.get_backend_class("omnivoice")()
        self.backend._ensure_loaded()
        self.tag = f"omni{steps}"

    def render(self, jobs: list[dict]) -> list[dict]:
        """Jobs are grouped by seed and reference and sent through OmniVoice's native variable-length batch generation
        (`batch` items at a time, one seed per batch); a failed batch falls back to one render at a time."""
        results: list = [None] * len(jobs)
        order = sorted(range(len(jobs)), key=lambda at: (jobs[at]["seed"], jobs[at]["ref"]))
        batches, current = [], []
        for at in order:
            if current and (len(current) >= self.batch or jobs[current[0]]["seed"] != jobs[at]["seed"]):
                batches.append(current); current = []
            current.append(at)
        if current:
            batches.append(current)
        for indices in batches:
            began = time.perf_counter()
            try:
                outputs = self._generate([jobs[at] for at in indices])
                per_job_ms = round((time.perf_counter() - began) * 1000 / len(indices))
                for at, values in zip(indices, outputs):
                    results[at] = self._write(jobs[at], values, per_job_ms)
            except Exception as error:
                if len(indices) == 1:
                    results[indices[0]] = {"ok": False, "seconds": 0.0, "tookMs": 0, "error": f"{type(error).__name__}: {error}"[:300]}
                    continue
                for at in indices:                     # fall back to single renders for this batch
                    began = time.perf_counter()
                    try:
                        values = self._generate([jobs[at]])[0]
                        results[at] = self._write(jobs[at], values, round((time.perf_counter() - began) * 1000))
                    except Exception as single:
                        results[at] = {"ok": False, "seconds": 0.0, "tookMs": 0, "error": f"{type(single).__name__}: {single}"[:300]}
        return results

    def _generate(self, jobs: list[dict]):
        import numpy as np
        torch = self.torch
        torch.manual_seed(int(jobs[0]["seed"]))
        with torch.inference_mode():
            if len(jobs) == 1:
                wavs = [self.backend.generate(jobs[0]["text"], ref_audio=jobs[0]["ref"], ref_text=jobs[0]["transcript"], language="English",
                                              num_step=self.steps, guidance_scale=2.0, speed=1, denoise=False, postprocess_output=False)]
            else:
                wavs = self.backend.generate_batch([job["text"] for job in jobs], ref_audio=[job["ref"] for job in jobs],
                                                   ref_text=[job["transcript"] for job in jobs], language="English",
                                                   num_step=self.steps, guidance_scale=2.0, speed=1, denoise=False, postprocess_output=False)
        torch.cuda.synchronize()
        return [np.asarray(w.detach().float().cpu() if hasattr(w, "detach") else w).reshape(-1) for w in wavs]

    def _write(self, job, values, took_ms) -> dict:
        import numpy as np
        import soundfile as sf
        if not values.size or not np.isfinite(values).all():
            return {"ok": False, "seconds": 0.0, "tookMs": took_ms, "error": "OmniVoice produced empty or non-finite audio"}
        out = Path(job["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        temporary = out.with_name(out.name + ".part")
        sf.write(str(temporary), values, self.backend.sample_rate, format="WAV", subtype="PCM_16")
        os.replace(temporary, out)
        return {"ok": True, "seconds": values.size / self.backend.sample_rate, "tookMs": took_ms, "error": None}

    def close(self):
        try:
            self.backend.unload()
        except Exception:
            pass


class PocketWorker:
    def __init__(self, export: Path, threads: int, weights: Path | None = None):
        extra = ["--weights", str(weights)] if weights else []
        self.child = subprocess.Popen(
            [str(POCKET_PYTHON), "-B", str(Path(__file__).resolve().parent / "pocket_worker.py"), "--export", str(export), "--threads", str(threads), *extra],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8", cwd=str(ROOT),
            creationflags=BELOW_NORMAL_PRIORITY if os.name == "nt" else 0)
        ready = json.loads(self.child.stdout.readline())
        if ready.get("op") != "ready":
            raise RuntimeError(f"Pocket worker did not start: {ready}")
        self.ready = ready
        self.sequence = 0

    def render(self, job: dict) -> dict:
        self.sequence += 1
        self.child.stdin.write(json.dumps({"op": "render", "id": self.sequence, "ref": job["ref"], "text": job["text"],
                                           "seed": job["seed"], "out": job["out"]}) + "\n")
        self.child.stdin.flush()
        frame = json.loads(self.child.stdout.readline())
        if frame.get("op") == "done":
            return {"ok": True, "seconds": frame["seconds"], "tookMs": frame["tookMs"], "error": None}
        return {"ok": False, "seconds": 0.0, "tookMs": 0, "error": frame.get("message", "Pocket worker error")}

    def close(self):
        try:
            self.child.stdin.write('{"op":"exit"}\n')
            self.child.stdin.flush()
            self.child.wait(timeout=10)
        except Exception:
            self.child.kill()


class PocketRenderer:
    """N Pocket workers; jobs that share a reference go to the same worker so its prepared prompt state is reused."""
    name = "pocket"

    def __init__(self, export: Path = common.OLD_POCKET_EXPORT, workers: int = 3, threads: int = 4, weights: Path | None = None, tag: str | None = None):
        self.export = Path(export)
        self.workers = [PocketWorker(self.export, threads, weights) for _ in range(workers)]
        self.tag = tag or f"pocket-{self.export.name}"

    def render(self, jobs: list[dict]) -> list[dict]:
        results: list = [None] * len(jobs)
        groups: dict[str, list[int]] = {}
        for at, job in enumerate(jobs):
            groups.setdefault(job["ref"], []).append(at)
        work: queue.Queue = queue.Queue()
        for indices in sorted(groups.values(), key=len, reverse=True):
            work.put(indices)

        def run(worker: PocketWorker):
            while True:
                try:
                    indices = work.get_nowait()
                except queue.Empty:
                    return
                for at in indices:
                    try:
                        results[at] = worker.render(jobs[at])
                    except Exception as error:
                        results[at] = {"ok": False, "seconds": 0.0, "tookMs": 0, "error": f"{type(error).__name__}: {error}"[:300]}

        threads = [threading.Thread(target=run, args=(worker,)) for worker in self.workers]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        return results

    def close(self):
        for worker in self.workers:
            worker.close()
