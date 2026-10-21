"""Speaker-consistency check with the ECAPA model the repo already uses for similarity (scripts/clip-search/score.py).

The model's weights (speechbrain/spkrec-ecapa-voxceleb) are read from the Hugging Face cache already on this machine; nothing is
downloaded. If they are not there the check is skipped (available() is False) and the report says so.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import vp_common as vp

SNAPSHOTS = Path.home() / ".cache/huggingface/hub/models--speechbrain--spkrec-ecapa-voxceleb/snapshots"
FILES = ("embedding_model.ckpt", "mean_var_norm_emb.ckpt", "classifier.ckpt", "label_encoder.txt")


def model_dir() -> Path | None:
    target = vp.WORK / "ecapa"
    if all((target / f).is_file() for f in FILES + ("hyperparams.yaml",)):
        return target
    snapshots = sorted(SNAPSHOTS.glob("*")) if SNAPSHOTS.is_dir() else []
    source = next((s for s in snapshots if all((s / f).exists() for f in FILES)), None)
    hyper = vp.ECAPA_DIR / "hyperparams.yaml"
    if source is None or not hyper.is_file():
        return None
    target.mkdir(parents=True, exist_ok=True)
    for f in FILES:
        shutil.copyfile((source / f).resolve(), target / f)
    shutil.copyfile(hyper, target / "hyperparams.yaml")
    return target


class Speaker:
    def __init__(self, threads: int = 4):
        import torch
        from speechbrain.inference.speaker import EncoderClassifier
        from speechbrain.utils.fetching import LocalStrategy
        torch.set_num_threads(threads)
        directory = model_dir()
        if directory is None:
            raise RuntimeError("ECAPA weights not available locally")
        self.torch = torch
        self.model = EncoderClassifier.from_hparams(source=str(directory), savedir=str(directory), overrides={"pretrained_path": str(directory)},
                                                    local_strategy=LocalStrategy.COPY, run_opts={"device": "cpu"})

    def embed(self, samples_24k):
        """Unit-length ECAPA embedding of a 24 kHz mono float array."""
        import torchaudio.functional as AF
        torch = self.torch
        wav = torch.from_numpy(samples_24k.astype("float32"))
        wav = AF.resample(wav, vp.RATE, 16000)
        if len(wav) < 1600:
            wav = torch.nn.functional.pad(wav, (0, 1600 - len(wav)))
        with torch.inference_mode():
            e = self.model.encode_batch(wav[None]).reshape(-1)
        return torch.nn.functional.normalize(e, dim=0)

    def cosine(self, a, b) -> float:
        return float((a * b).sum())


def available() -> bool:
    return model_dir() is not None
