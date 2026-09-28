"""Local OmniVoice LoRA pilot using the pinned official model/trainer.

Small cached token datasets and single-process loading avoid upstream Windows
spawn/lambda and space-separated manifest-path problems. Original WAVs and base
weights are read-only. This script never activates a voice in the game.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import random
import time

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("HF_HOME", str(ROOT / "vendor/voice-models"))
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import numpy as np
import torch

SOURCE_REVISION = "08be0b4ccbac3e13e374e86fbfead4b4cac343e2"
MODEL_REVISION = "c5fdb5ccb189668d56333f77ba2629f4cd7535f4"
MODEL = ROOT / "vendor/voice-models/hub/models--k2-fsa--OmniVoice/snapshots" / MODEL_REVISION
DATA_ROOT = ROOT / "runtime/voice-references/training"
RUN_ROOT = ROOT / "runtime/voice-training"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_rows(key, split):
    path = DATA_ROOT / key / f"{split}.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def configure_device():
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise RuntimeError("The bounded pilot requires a CUDA GPU with bf16 support")
    torch.set_num_threads(4)
    torch.set_num_interop_threads(2)
    free, total = torch.cuda.mem_get_info()
    budget = min(total * .52, free - 1024**3)
    if budget < 4 * 1024**3:
        raise RuntimeError("Fewer than 4 GiB safely available for this pilot")
    torch.cuda.set_per_process_memory_fraction(budget / total)
    print(json.dumps({"gpu": torch.cuda.get_device_name(), "budgetMiB": round(budget / 1024**2),
                      "freeMiB": round(free / 1024**2)}), flush=True)


def token_path(key, row):
    return RUN_ROOT / key / "tokens" / f'{row["id"]}.npy'


def tokenize(key):
    from transformers import AutoFeatureExtractor, HiggsAudioV2TokenizerModel
    from omnivoice.utils.audio import load_audio
    # The exact codec shipped with the pinned base checkpoint is reused.
    codec_path = MODEL / "audio_tokenizer"
    feature = AutoFeatureExtractor.from_pretrained(str(codec_path), local_files_only=True)
    codec = HiggsAudioV2TokenizerModel.from_pretrained(str(codec_path), device_map="cuda", local_files_only=True)
    rows = read_rows(key, "train") + read_rows(key, "dev") + read_rows(key, "test")
    started = time.monotonic()
    for i, row in enumerate(rows):
        audio_path = Path(row["audio_path"])
        if hashlib.sha256(audio_path.read_bytes()).hexdigest() != row["sha256"]:
            raise ValueError("Changed source audio: " + row["id"])
        path = token_path(key, row)
        receipt_path = path.with_suffix(".json")
        expected = {"audioSha256": row["sha256"], "modelRevision": MODEL_REVISION,
                    "sourceRevision": SOURCE_REVISION, "rate": 24000,
                    "processing": "Model-required mono downmix/resample only; no normalization or denoising"}
        if path.exists() and receipt_path.exists() and read_json(receipt_path) == expected:
            continue
        audio = load_audio(str(audio_path), 24000)
        inputs = feature(raw_audio=audio.squeeze(0), sampling_rate=24000, return_tensors="pt").to(codec.device)
        with torch.inference_mode():
            encoded = codec.encode(inputs["input_values"]).audio_codes.squeeze(0).cpu().numpy().astype(np.int16)
        if encoded.ndim != 2 or encoded.shape[0] != 8 or encoded.min() < 0 or encoded.max() > 1023:
            raise ValueError("Unexpected codec output")
        path.parent.mkdir(parents=True, exist_ok=True)
        np.save(path, encoded, allow_pickle=False)
        write_json(receipt_path, expected)
        if (i + 1) % 16 == 0 or i + 1 == len(rows):
            print(json.dumps({"key": key, "tokenized": i + 1, "total": len(rows),
                              "elapsedSeconds": round(time.monotonic() - started, 2)}), flush=True)
    write_json(RUN_ROOT / key / "tokenization.json", {"clips": len(rows), "seconds": time.monotonic() - started,
        "peakAllocatedMiB": torch.cuda.max_memory_allocated() / 1024**2, "modelRevision": MODEL_REVISION})


class CachedTokenDataset(torch.utils.data.IterableDataset):
    def __init__(self, key, split):
        self.key, self.split, self.epoch = key, split, 0
        self.rows = read_rows(key, split)

    def set_epoch(self, epoch):
        self.epoch = epoch

    def __iter__(self):
        rows = self.rows.copy()
        if self.split == "train":
            random.Random(42 + self.epoch).shuffle(rows)
        for row in rows:
            data = np.load(token_path(self.key, row), allow_pickle=False)
            yield {"audio_tokens": torch.from_numpy(data), "label": row}


def build_loaders(key, config, tokenizer):
    from omnivoice.data.batching import StreamLengthGroupDataset
    from omnivoice.data.collator import PaddingDataCollator
    from omnivoice.data.processor import OmniVoiceSampleProcessor
    processor = OmniVoiceSampleProcessor(text_tokenizer=tokenizer, num_channels=config.num_audio_codebook,
        audio_mask_id=config.audio_mask_id, prompt_ratio_range=config.prompt_ratio_range,
        mask_ratio_range=config.mask_ratio_range, drop_cond_ratio=config.drop_cond_ratio,
        language_ratio=config.language_ratio, use_pinyin_ratio=0, instruct_ratio=0, only_instruct_ratio=0)
    loaders = []
    for split in ("train", "dev"):
        dataset = StreamLengthGroupDataset(CachedTokenDataset(key, split), batch_duration=config.batch_tokens,
            min_length=config.min_sample_tokens, max_length=config.max_sample_tokens,
            max_sample=config.max_batch_size, processor=processor, length_fn=lambda sample: sample["length"])
        loaders.append(torch.utils.data.DataLoader(dataset, batch_size=None, num_workers=0,
            collate_fn=PaddingDataCollator(processor, config.batch_tokens), pin_memory=True))
    return loaders


@contextmanager
def fixed_eval_randomness():
    # Compare checkpoints against identical dev masks without disturbing training.
    python_state, numpy_state = random.getstate(), np.random.get_state()
    with torch.random.fork_rng(devices=[0]):
        random.seed(7321); np.random.seed(7321); torch.manual_seed(7321)
        try:
            yield
        finally:
            random.setstate(python_state); np.random.set_state(numpy_state)


def train(key, steps, label, resume=None):
    from accelerate.utils import set_seed
    from omnivoice.training.builder import build_model_and_tokenizer
    from omnivoice.training.config import TrainingConfig
    from omnivoice.training.trainer import OmniTrainer
    run_dir = RUN_ROOT / key / label
    if run_dir.exists() and not resume:
        raise ValueError("Use a new run label or an explicit resume checkpoint")
    config = TrainingConfig(init_from_checkpoint=str(MODEL), use_lora=True, lora_r=16, lora_alpha=32,
        lora_dropout=.05, learning_rate=5e-5, steps=steps, warmup_ratio=.05, seed=42,
        attn_implementation="sdpa", max_sample_tokens=1000, min_sample_tokens=50, max_batch_size=1,
        batch_tokens=1024, gradient_accumulation_steps=4, num_workers=0,
        mixed_precision="bf16", allow_tf32=True, logging_steps=10, eval_steps=50,
        save_steps=50, keep_last_n_checkpoints=-1, use_pinyin_ratio=0, instruct_ratio=0,
        only_instruct_ratio=0, output_dir=str(run_dir), resume_from_checkpoint=resume)
    set_seed(config.seed)
    model, tokenizer = build_model_and_tokenizer(config)
    train_loader, dev_loader = build_loaders(key, config, tokenizer)
    class PilotTrainer(OmniTrainer):
        def evaluate(self):
            with fixed_eval_randomness():
                metrics = super().evaluate()
            metrics.update({"step": self.global_step, "peakAllocatedMiB": torch.cuda.max_memory_allocated() / 1024**2,
                            "peakReservedMiB": torch.cuda.max_memory_reserved() / 1024**2})
            with (run_dir / "evaluation.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(metrics) + "\n")
            return metrics
    trainer = PilotTrainer(model=model, config=config, train_dataloader=train_loader,
                           eval_dataloader=dev_loader, tokenizer=tokenizer)
    write_json(run_dir / "provenance.json", {"sourceRevision": SOURCE_REVISION, "modelRevision": MODEL_REVISION,
        "dataset": read_json(DATA_ROOT / key / "dataset-report.json"),
        "trainManifestSha256": hashlib.sha256((DATA_ROOT / key / "train.jsonl").read_bytes()).hexdigest(),
        "purpose": "Private local fine-tuning pilot; not an accepted or deployed voice"})
    if not resume:
        trainer.evaluate()
    started = time.monotonic()
    trainer.train()
    write_json(run_dir / "completed.json", {"step": trainer.global_step, "seconds": time.monotonic() - started,
        "peakAllocatedMiB": torch.cuda.max_memory_allocated() / 1024**2,
        "peakReservedMiB": torch.cuda.max_memory_reserved() / 1024**2})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("tokenize", "train"))
    parser.add_argument("--key", choices=("judy-alvarez", "johnny-silverhand", "panam-palmer"), required=True)
    parser.add_argument("--steps", type=int, default=250)
    parser.add_argument("--label", default="pilot-v1")
    parser.add_argument("--resume")
    args = parser.parse_args()
    import re
    if not re.fullmatch(r"[a-z0-9-]{1,40}", args.label) or not 1 <= args.steps <= 2000:
        parser.error("Invalid run label or bounded step count")
    configure_device()
    if args.phase == "tokenize":
        tokenize(args.key)
    else:
        train(args.key, args.steps, args.label, args.resume)


if __name__ == "__main__":
    main()
