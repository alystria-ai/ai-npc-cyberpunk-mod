"""Matched pilot entry used by its supervisor and every distributed worker.

Final portable member: candidate/scripts/Pocket-KaggleTrain.py.
The common immutable input's original entry remains unchanged.
"""
from __future__ import annotations

import importlib.util
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
for key, value in {'HF_HUB_OFFLINE':'1', 'TRANSFORMERS_OFFLINE':'1', 'HF_HUB_DISABLE_TELEMETRY':'1',
                   'TOKENIZERS_PARALLELISM':'false', 'PYTORCH_CUDA_ALLOC_CONF':'expandable_segments:True',
                   'OMP_NUM_THREADS':'2'}.items():
    os.environ.setdefault(key, value)

def main():
    candidate = Path(__file__).resolve().parents[1]
    stage = candidate.parent
    verifier = stage / 'expanded-verifier/bootstrap.py'
    entry_args = argparse.ArgumentParser(add_help=False)
    entry_args.add_argument('--spec', type=Path)
    args, _ = entry_args.parse_known_args()
    if args.spec is not None:
        specification = args.spec.resolve()
        raw = json.loads(specification.read_text(encoding='utf-8-sig'))
        descriptor = raw['expanded_verifier_sources']['bootstrap']
        declared = Path(descriptor['path'])
        verifier = declared if declared.is_absolute() else specification.parent / declared
        if hashlib.sha256(verifier.read_bytes()).hexdigest() != descriptor['sha256']:
            raise ValueError('Pilot bootstrap differs from the explicit input source binding')
    if not verifier.is_file():
        raise ValueError('The exact expanded verifier is absent beside the pilot source')
    spec = importlib.util.spec_from_file_location('matched_pilot_expanded_bootstrap', verifier)
    bootstrap = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bootstrap)
    bootstrap.install(candidate)
    from scripts.pocket_training.runner import main as runner_main
    return runner_main()

if __name__ == '__main__':
    raise SystemExit(main())
