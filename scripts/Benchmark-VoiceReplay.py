"""Compare original 32-step FP16 synthesis to bounded CUDA replay, game open.

Run only with the conversation bridge stopped. Creates local evidence; does
not change the active voice configuration or publish audio to the game.
"""
from pathlib import Path
import argparse
import gc
import hashlib
import importlib.util
import json
import os
import sys
import time
import subprocess

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--power-profile', required=True, choices=['balanced-user-confirmed', 'unknown'])
parser.add_argument('--stability-only', action='store_true')
args = parser.parse_args()
DEST = ROOT / 'runtime' / ('voice-replay-' + time.strftime('%Y%m%d-%H%M%S'))
DEST.mkdir(parents=True, exist_ok=False)
config = json.loads((ROOT / 'runtime/local-voices.json').read_text('utf-8'))
os.environ.update(HF_HOME=str(ROOT / 'vendor/voice-models'), HF_HUB_OFFLINE='1',
    OMNIVOICE_DATA_DIR=str(ROOT / 'runtime/voice-studio-data'), OMNIVOICE_MODEL=str(ROOT / config['model']),
    OMNIVOICE_TTS_BACKEND='omnivoice', OMNIVOICE_GPU_WORKERS='1', OMNIVOICE_PRELOAD_TTS_ASR='0',
    TORCH_COMPILE_DISABLE='1', PYTHONUTF8='1')
sys.path.insert(0, str(ROOT / 'vendor/reference-voicestudio/backend'))
import numpy as np
import soundfile as sf
import torch
from services.tts_backend import get_backend_class

spec = importlib.util.spec_from_file_location('voice_cuda_graph', ROOT / 'bridge/voice-cuda-graph.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
backend = get_backend_class('omnivoice')()
report = {'kind': 'live-game-controlled-voice-check', 'steps': 32, 'renders': [],
          'powerProfile': args.power_profile, 'directory': str(DEST),
          'note': 'Same process, reference, text and seed within each pair. Current game settings; not the earlier RT60 benchmark.'}
graph = None
text = 'Keep your eyes open, V. We can talk while we walk.'

def save():
    (DEST / 'results.json').write_text(json.dumps(report, indent=2), 'utf-8')

def device_sample():
    try:
        result = subprocess.run(['nvidia-smi', '--query-gpu=memory.used,clocks.gr,clocks.mem,power.draw,utilization.gpu',
            '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=5,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        return result.stdout.strip()
    except Exception:
        return None


def render(label, profile='judy-alvarez', line=text, steps=32):
    ref = config['voices'][profile]
    audio_path = ROOT / ref['reference']
    if hashlib.sha256(audio_path.read_bytes()).hexdigest() != ref['sha256']:
        raise ValueError('Reference hash changed')
    torch.manual_seed(1042)
    torch.cuda.synchronize()
    if graph: graph.begin_request()
    start = time.perf_counter()
    with torch.inference_mode():
        wav = backend.generate(line, ref_audio=str(audio_path), ref_text=ref['transcript'],
            language='English', num_step=steps, guidance_scale=2.0, speed=1, denoise=False, postprocess_output=False)
    torch.cuda.synchronize()
    elapsed = (time.perf_counter() - start) * 1000
    values = np.asarray(wav).reshape(-1)
    if not np.isfinite(values).all():
        raise ValueError('Non-finite output')
    path = DEST / (label + '.wav')
    sf.write(path, values, backend.sample_rate, subtype='PCM_16')
    row = {'label': label, 'profile': profile, 'steps': steps, 'ms': elapsed, 'seconds': values.size / backend.sample_rate,
           'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
           'allocatedMiB': torch.cuda.memory_allocated() / 1024**2,
           'reservedMiB': torch.cuda.memory_reserved() / 1024**2,
           'peakReservedMiB': torch.cuda.max_memory_reserved() / 1024**2,
           'cudaReportedUsedMiB': (torch.cuda.mem_get_info()[1]-torch.cuda.mem_get_info()[0]) / 1024**2,
           'graph': graph.snapshot() if graph else None,
           'deviceAfter': device_sample()}
    report['renders'].append(row); save()
    print(json.dumps(row), flush=True)
    return row


def identical(*rows):
    if len({row['sha256'] for row in rows}) != 1:
        raise AssertionError('WAV changed: ' + ', '.join(row['label'] for row in rows))

try:
    backend._ensure_loaded()
    report['gpu'] = torch.cuda.get_device_name()
    report['dtype'] = backend.dtype
    report['originalUseCache'] = backend._model.llm.config.use_cache
    render('warmup')
    for profile in ['judy-alvarez', 'johnny-silverhand', 'panam-palmer']:
        # Warm each reference separately; never charge reference encoding to
        # only one side of the comparison.
        if profile != 'judy-alvarez': render(profile + '-reference-warmup', profile)
        for steps in (32, 16):
            tag = f'{profile}-{steps}'
            before = render(tag + '-eager', profile, steps=steps)
            if args.stability_only: continue
            graph = module.VoiceGraph(backend._model).install()
            first = render(tag + '-capture', profile, steps=steps)
            warm = render(tag + '-replay', profile, steps=steps)
            graph.close(); graph = None
            after = render(tag + '-eager-after', profile, steps=steps)
            identical(before, first, warm, after)
    # Exercise shape changes, voice changes and bounded fallback without
    # allocating a deliberately huge tensor or another model.
    graph = module.VoiceGraph(backend._model).install()
    switches = []
    for cycle in range(4 if args.stability_only else 2):
        for profile in ['judy-alvarez', 'panam-palmer', 'johnny-silverhand']:
            steps = 16 if cycle % 2 else 32
            row = render('switch-' + str(graph.captures) + '-' + profile, profile, steps=steps)
            baseline = next(r for r in report['renders'] if r['label'] == f'{profile}-{steps}-eager')
            identical(row, baseline)
            switches.append(row)
    if len(switches) >= 12:
        growth = switches[-1]['allocatedMiB'] - switches[2]['allocatedMiB']
        report['sameShapeLiveAllocationGrowthMiB'] = growth
        if growth > 2: raise AssertionError('Live graph allocation grows across shape replacements')
    graph.max_tokens = 1
    fallback = render('bounded-fallback')
    identical(fallback, next(r for r in report['renders'] if r['label'] == 'judy-alvarez-32-eager'))
    if graph.entry is not None: raise AssertionError('Unsupported shape retained its graph')
    graph.close(); graph = None
    report['wavIdentityPassed'] = True
except Exception as error:
    report['error'] = f'{type(error).__name__}: {error}'
    print(report['error'], flush=True)
    raise
finally:
    if graph: graph.close()
    backend.unload(); gc.collect(); torch.cuda.empty_cache()
    report['finished'] = time.time(); save()
