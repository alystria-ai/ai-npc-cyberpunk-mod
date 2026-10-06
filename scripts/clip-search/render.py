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

    def __init__(self, steps: int = 16):
        self.steps = steps
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
        import numpy as np
        import soundfile as sf
        torch, results = self.torch, []
        for job in jobs:
            began = time.perf_counter()
            try:
                torch.manual_seed(int(job["seed"]))
                with torch.inference_mode():
                    wav = self.backend.generate(job["text"], ref_audio=job["ref"], ref_text=job["transcript"], language="English",
                                                num_step=self.steps, guidance_scale=2.0, speed=1, denoise=False,
                                                postprocess_output=False)
                torch.cuda.synchronize()
                values = np.asarray(wav.detach().float().cpu() if hasattr(wav, "detach") else wav).reshape(-1)
                if not values.size or not np.isfinite(values).all():
                    raise ValueError("OmniVoice produced empty or non-finite audio")
                out = Path(job["out"])
                out.parent.mkdir(parents=True, exist_ok=True)
                temporary = out.with_name(out.name + ".part")
                sf.write(str(temporary), values, self.backend.sample_rate, format="WAV", subtype="PCM_16")
                os.replace(temporary, out)
                results.append({"ok": True, "seconds": values.size / self.backend.sample_rate,
                                "tookMs": round((time.perf_counter() - began) * 1000), "error": None})
            except Exception as error:  # one bad render must not end a night's run
                results.append({"ok": False, "seconds": 0.0, "tookMs": round((time.perf_counter() - began) * 1000),
                                "error": f"{type(error).__name__}: {error}"[:300]})
        return results

    def close(self):
        try:
            self.backend.unload()
        except Exception:
            pass


class PocketWorker:
    def __init__(self, export: Path, threads: int):
        self.child = subprocess.Popen(
            [str(POCKET_PYTHON), "-B", str(Path(__file__).resolve().parent / "pocket_worker.py"), "--export", str(export), "--threads", str(threads)],
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

    def __init__(self, export: Path = common.OLD_POCKET_EXPORT, workers: int = 3, threads: int = 4):
        self.export = Path(export)
        self.workers = [PocketWorker(self.export, threads) for _ in range(workers)]
        self.tag = f"pocket-{self.export.name}"

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
