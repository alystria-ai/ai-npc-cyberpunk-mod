"""Offline, resumable official Pocket TTS adaptation and depth distillation.

The account owner stages inputs and launches this script in a private notebook.
This script has no account API, credentials, network fetches, or game integration.
Run ``python Pocket-KaggleTrain.py --help`` for the local entry points.
"""

from __future__ import annotations

import os
import sys

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
os.environ.setdefault("OMP_NUM_THREADS", "2")

from pocket_training.runner import main


if __name__ == "__main__":
    raise SystemExit(main())
