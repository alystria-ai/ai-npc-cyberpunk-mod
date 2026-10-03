"""Small CPU streaming example for Pocket TTS v3.3.0 / pinned 41cbc84.

This is a local API example, not a Convai endpoint or a production worker.
Use a custom YAML whose weight/tokenizer paths identify the intended model.
"""
from __future__ import annotations

import argparse
import json
import os
import threading
import time
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="english_2026-09")
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.threads <= 8:
        parser.error("--threads must be between 1 and 8")
    if args.output.exists():
        parser.error("Choose a new output file; existing audio is preserved.")
    if not args.reference.is_file():
        parser.error("Reference recording is missing.")

    os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
    os.environ["OMP_NUM_THREADS"] = str(args.threads)
    os.environ["MKL_NUM_THREADS"] = str(args.threads)
    setup_started = time.perf_counter()
    import torch
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    import soundfile as sf
    from pocket_tts import TTSModel
    with torch.inference_mode():
        model = TTSModel.load_model(config=args.config, temp=0.3,
                                   sampler_decode_steps=1,
                                   eos_threshold=-1.0, noise_clamp=None)
        if not model.has_voice_cloning:
            raise RuntimeError("The loaded model does not enable voice cloning.")
        # Reuse this state for the same model/reference version. Prepare a new
        # state after changing weights; do not reuse stock named voice states.
        state = model.get_state_for_audio_prompt(args.reference)
        setup_seconds = time.perf_counter() - setup_started
        stop = threading.Event()
        started = time.perf_counter()
        first_yield = first_copy = None
        frames = 0
        args.output.parent.mkdir(parents=True, exist_ok=True)
        try:
            with sf.SoundFile(args.output, mode="x", samplerate=model.sample_rate,
                              channels=1, subtype="FLOAT") as sink:
                for chunk in model.generate_audio_stream(
                        state, args.text, copy_state=True, stop=stop):
                    if chunk.numel() == 0:
                        continue
                    if first_yield is None:
                        first_yield = time.perf_counter() - started
                    pcm = chunk.detach().cpu().float().numpy().copy()
                    if first_copy is None:
                        first_copy = time.perf_counter() - started
                    # A service can enqueue this owned PCM copy immediately.
                    # Writing it here lets a reader audit unchanged output.
                    sink.write(pcm)
                    frames += pcm.size
        except KeyboardInterrupt:
            stop.set()
            raise
        print(json.dumps({"setup_seconds": setup_seconds,
                          "first_pcm_yield_seconds": first_yield,
                          "first_copied_pcm_ready_seconds": first_copy,
                          "generation_seconds": time.perf_counter() - started,
                          "audio_seconds": frames / model.sample_rate,
                          "sample_rate": model.sample_rate,
                          "device": "cpu", "additional_audio_processing": "none",
                          "boundary": "Excludes API transport and audio-device playback"}))


if __name__ == "__main__":
    main()
