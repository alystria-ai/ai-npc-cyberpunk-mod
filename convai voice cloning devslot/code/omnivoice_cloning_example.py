"""Public Omni cloning example; complete-wave timing, not PCM streaming.

Research pins: source08be0b4c, model c5fdb5cc. No execution was performed here.
"""
import argparse
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--reference-text", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--steps", type=int, choices=[16, 32], default=32)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Choose a new output file.")
    import torch
    import soundfile as sf
    from omnivoice import OmniVoice

    model = OmniVoice.from_pretrained(
        "k2-fsa/OmniVoice",
        revision="c5fdb5ccb189668d56333f77ba2629f4cd7535f4",
        device_map="cuda:0", dtype=torch.float16)
    # Cache this trusted prompt with model/reference version metadata in a service.
    prompt = model.create_voice_clone_prompt(
        ref_audio=str(args.reference), ref_text=args.reference_text)
    torch.cuda.synchronize()
    started = time.perf_counter()
    audio = model.generate(text=args.text, voice_clone_prompt=prompt,
                           num_step=args.steps)
    torch.cuda.synchronize()
    elapsed = time.perf_counter() - started
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(args.output, audio[0], 24000, subtype="FLOAT")
    print({"generation_seconds": elapsed, "steps": args.steps,
           "boundary": "Complete generation; excludes setup, writing and playback"})


if __name__ == "__main__":
    main()
