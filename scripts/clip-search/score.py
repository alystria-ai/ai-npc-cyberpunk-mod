"""Scoring for the clip search: ECAPA speaker similarity (primary) and the PLS components (secondary).

Run inside vendor/reference-voicestudio/.venv (speechbrain, torchaudio).  No WER (Whisper) on purpose.

ECAPA is the VoxCeleb model in E:/.../likeness-phase1/ecapa-src, the same one the likeness study used.  For a generated
line the primary number is the cosine to the centroid of the voice's OTHER held-out real clips (leave-one-out over the
holdout H of common.split_voice, so no reference clip is ever part of the target and the target does not depend on the
candidate).  The secondary ECAPA number is the cosine to the original recording of the same line.

PLS follows scripts/pocket_training/likeness.py (fd_mfcc, mcd, ltas_hi) against the voice's held-out clips, mapped with
the anchors stored by the October 5 study (stock Pocket = 60, OmniVoice 32 = 90, macro over 67 voices).  Per-voice
absolute values are not comparable with the study's macro numbers; they only rank sets of one voice against each other.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

ECAPA_DIR = common.ECAPA_DIR
PLS_ANCHORS_FILE = common.PLS_ANCHORS_FILE


class Scorer:
    def __init__(self, device: str = "cuda", with_pls: bool = True):
        import torch
        from speechbrain.inference.speaker import EncoderClassifier
        from speechbrain.utils.fetching import LocalStrategy
        self.torch = torch
        self.device = device if (device != "cuda" or torch.cuda.is_available()) else "cpu"
        self.ecapa = EncoderClassifier.from_hparams(
            source=str(ECAPA_DIR), savedir=str(common.WORK / "ecapa"), overrides={"pretrained_path": str(ECAPA_DIR)},
            local_strategy=LocalStrategy.COPY, run_opts={"device": self.device})
        self.analyzer = None
        self.with_pls = with_pls
        self._cache: dict[str, object] = {}
        self._fcache: dict[str, object] = {}

    # ---- ECAPA ----
    def _wav16(self, path):
        import soundfile as sf
        import torchaudio.functional as AF
        data, rate = sf.read(str(path), dtype="float32", always_2d=True)
        wav = self.torch.from_numpy(data.mean(axis=1))
        return AF.resample(wav, rate, 16000) if rate != 16000 else wav

    def embed(self, path):
        torch = self.torch
        wav = self._wav16(path)
        if len(wav) < 1600:
            wav = torch.nn.functional.pad(wav, (0, 1600 - len(wav)))
        with torch.inference_mode():
            e = self.ecapa.encode_batch(wav[None].to(self.device)).reshape(-1)
        return torch.nn.functional.normalize(e, dim=0).cpu()

    def embed_cached(self, path):
        key = str(path)
        if key not in self._cache:
            self._cache[key] = self.embed(path)
        return self._cache[key]

    def load_embeddings(self, file: Path):
        if file.is_file():
            self._cache.update({k: self.torch.tensor(v) for k, v in json.loads(file.read_text(encoding="utf-8")).items()})

    def save_embeddings(self, file: Path, keys=None):
        file.parent.mkdir(parents=True, exist_ok=True)
        temporary = file.with_name(file.name + ".part")
        temporary.write_text(json.dumps({k: [round(float(x), 6) for x in v] for k, v in self._cache.items() if keys is None or k in keys}), encoding="utf-8")
        temporary.replace(file)

    def targets(self, pool: common.VoicePool, split: dict) -> dict:
        """Per holdout clip: its own embedding and the leave-one-out centroid of the rest of the holdout."""
        torch = self.torch
        embeddings = {cid: self.embed_cached(pool.clip(cid)["path"]) for cid in split["holdout"]}
        total = torch.stack(list(embeddings.values())).sum(0)
        result = {}
        for cid, emb in embeddings.items():
            rest = torch.nn.functional.normalize(total - emb, dim=0)
            result[cid] = {"own": emb, "centroid": rest}
        centroid_all = torch.nn.functional.normalize(total, dim=0)
        return {"lines": result, "centroid": centroid_all}

    def score_line(self, wav_path, line_target) -> dict:
        emb = self.embed(wav_path)
        return {"ec": float(emb @ line_target["centroid"]), "et": float(emb @ line_target["own"])}

    # ---- PLS ----
    def _analyzer(self):
        if self.analyzer is None:
            from pocket_training import likeness
            self.analyzer = likeness.Analyzer("cpu")
        return self.analyzer

    def features(self, path, start=0.0, duration=None):
        from pocket_training import likeness
        key = f"{path}|{start}|{duration}"
        if key not in self._fcache:
            self._fcache[key] = self._analyzer().features(likeness.load_audio(path, likeness.SR, start, duration))
        return self._fcache[key]

    def voice_stats(self, pool: common.VoicePool, split: dict):
        from pocket_training import likeness
        feats = [self.features(pool.clip(cid)["path"]) for cid in split["holdout"]]
        return likeness.voice_reference_stats(feats)

    def pls_components(self, voice: str, lines: list[tuple[str, str]], stats) -> dict:
        """lines: (generated wav, original wav) pairs.  Returns fd_mfcc, mcd, ltas_hi, dur_err for one set."""
        from pocket_training import likeness
        rows = [(voice, self.features(gen), self.features(orig)) for gen, orig in lines]
        return likeness.condition_metrics(rows, {voice: stats})


def pls_from_components(components: dict) -> float:
    """Map fd_mfcc, mcd and ltas_hi with the study's anchors (stock Pocket 60, OmniVoice 32 = 90)."""
    study = json.loads(PLS_ANCHORS_FILE.read_text(encoding="utf-8"))["conditions"]
    low, high = study["base6-2609__cfg1"], study["omni__s32_g2"]
    parts = [60 + 30 * (low[k] - components[k]) / (low[k] - high[k]) for k in ("fd_mfcc", "mcd", "ltas_hi")
             if components.get(k) is not None and low[k] != high[k]]
    return sum(parts) / len(parts) if parts else float("nan")
