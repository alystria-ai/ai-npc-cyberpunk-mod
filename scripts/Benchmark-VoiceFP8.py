"""Isolated FP8 W8A8 feasibility check on the installed GPU, not a runtime option.

Uses PyTorch's native scaled GEMM, not TensorRT. Six calibration generations
cover the three existing voices; test text is separate. Attention, norms,
residuals, embeddings, audio head and codec keep their original precision.
Run only after stopping the conversation bridge. No packages/models change.
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

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--power-profile', required=True, choices=['balanced-user-confirmed', 'unknown'])
args = parser.parse_args()
DEST = ROOT / 'runtime' / ('voice-fp8-' + time.strftime('%Y%m%d-%H%M%S'))
DEST.mkdir(exist_ok=False)
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
replay = importlib.util.module_from_spec(spec); spec.loader.exec_module(replay)
backend = get_backend_class('omnivoice')()
report = {'kind': 'experimental-pytorch-fp8', 'productionEnabled': False, 'tensorrt': False,
          'powerProfile': args.power_profile, 'steps': 32, 'renders': [], 'directory': str(DEST),
          'protocol': 'Compare warm rows; FP16 first includes reference preparation, FP8 first reuses it. '
                      'In-process conversion can fragment reserved memory. No listening or ASR qualification.'}
graph = None
handles = []
profiles = ['judy-alvarez', 'johnny-silverhand', 'panam-palmer']
line = 'Keep your eyes open, V. We can talk while we walk.'
parts = ['self_attn.q_proj', 'self_attn.k_proj', 'self_attn.v_proj', 'self_attn.o_proj',
         'mlp.gate_proj', 'mlp.up_proj', 'mlp.down_proj']


def save():
    (DEST / 'results.json').write_text(json.dumps(report, indent=2), 'utf-8')


def render(label, profile, text=line, seed=1042):
    ref = config['voices'][profile]; path = ROOT / ref['reference']
    if hashlib.sha256(path.read_bytes()).hexdigest() != ref['sha256']:
        raise ValueError('Reference changed')
    graph.begin_request(); torch.manual_seed(seed); torch.cuda.synchronize()
    start = time.perf_counter()
    with torch.inference_mode():
        wav = backend.generate(text, ref_audio=str(path), ref_text=ref['transcript'], language='English',
            num_step=32, guidance_scale=2.0, speed=1, denoise=False, postprocess_output=False)
    torch.cuda.synchronize(); elapsed = (time.perf_counter() - start) * 1000
    values = np.asarray(wav).reshape(-1)
    if not values.size or not np.isfinite(values).all(): raise ValueError('Invalid audio')
    output = DEST / (label + '.wav'); sf.write(output, values, backend.sample_rate, subtype='PCM_16')
    row = {'label': label, 'profile': profile, 'ms': elapsed, 'seconds': values.size / backend.sample_rate,
           'peakSample': float(np.max(np.abs(values))), 'clippedFraction': float(np.mean(np.abs(values) >= 1)),
           'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'graph': graph.snapshot(),
           'allocatedMiB': torch.cuda.memory_allocated() / 1024**2,
           'reservedMiB': torch.cuda.memory_reserved() / 1024**2,
           'peakReservedMiB': torch.cuda.max_memory_reserved() / 1024**2}
    report['renders'].append(row); save(); print(json.dumps(row), flush=True)


class QuantizedLinear(torch.nn.Module):
    def __init__(self, original, activation_max):
        super().__init__()
        # Per-tensor E4M3 for both operands. Keep headroom beyond the small
        # calibration set; this is still a lossy experiment requiring listening.
        weight = original.weight.detach().float()
        scale_w = weight.abs().amax().clamp_min(1e-7) / 448
        self.register_buffer('weight8', (weight / scale_w).clamp(-448, 448).to(torch.float8_e4m3fn))
        self.register_buffer('scale_w', scale_w.reshape(1))
        self.register_buffer('scale_x', (activation_max.float().clamp_min(1e-7) * 1.10 / 448).reshape(1))
        self.register_buffer('bias', original.bias.detach().clone() if original.bias is not None else None)
        self.output_features = original.out_features

    def forward(self, x):
        matrix = x.reshape(-1, x.shape[-1]).float()
        quantized = (matrix / self.scale_x).clamp(-448, 448).to(torch.float8_e4m3fn)
        result = torch._scaled_mm(quantized, self.weight8.t(), scale_a=self.scale_x, scale_b=self.scale_w,
            bias=self.bias, out_dtype=x.dtype, use_fast_accum=False)
        return result.reshape(*x.shape[:-1], self.output_features)


try:
    backend._ensure_loaded(); model = backend._model
    report.update(gpu=torch.cuda.get_device_name(), capability=torch.cuda.get_device_capability(), torch=torch.__version__)
    graph = replay.VoiceGraph(model).install()
    for profile in profiles:
        render(profile + '-fp16-first', profile)
        render(profile + '-fp16-warm', profile)
    graph.close(); graph = None
    maxima = {}
    names = [f'{i}.{part}' for i in range(len(model.llm.layers)) for part in parts]
    if len(names) != 196: raise ValueError('This experiment expects the pinned 28-layer model')
    for name in names:
        module = model.llm.layers.get_submodule(name)
        if not isinstance(module, torch.nn.Linear): raise ValueError('Unexpected transformer layer')
        maxima[name] = torch.zeros(1, device='cuda', dtype=torch.float32)
        def observe(module, inputs, bound=maxima[name]):
            with torch.no_grad():
                bound.copy_(torch.maximum(bound, inputs[0].detach().float().abs().amax()))
        handles.append(module.register_forward_pre_hook(observe))
    graph = replay.VoiceGraph(model).install()
    for index, profile in enumerate(profiles):
        for n, text in enumerate(['There is a quiet place where we can talk for a moment.',
                                  'Watch the traffic, V. The city never slows down.']):
            render(f'{profile}-calibration-{n}', profile, text, seed=[42, 17, 123][index] + n)
    graph.close(); graph = None
    for handle in handles: handle.remove()
    handles.clear()
    report['activationCalibration'] = {name: float(value.item()) for name, value in maxima.items()}
    with torch.inference_mode():
        for name in names:
            parent_name, attr = name.rsplit('.', 1)
            parent = model.llm.layers.get_submodule(parent_name)
            setattr(parent, attr, QuantizedLinear(getattr(parent, attr), maxima[name]).eval())
    del module, parent
    gc.collect(); torch.cuda.empty_cache(); torch.cuda.reset_peak_memory_stats()
    report['fp8LinearCount'] = sum(isinstance(m, QuantizedLinear) for m in model.modules())
    report['fp8WeightMiB'] = sum(m.weight8.numel() for m in model.modules() if isinstance(m, QuantizedLinear)) / 1024**2
    graph = replay.VoiceGraph(model).install()
    for profile in profiles:
        render(profile + '-fp8-first', profile)
        render(profile + '-fp8-warm', profile)
    report['completed'] = True
except Exception as error:
    report['error'] = f'{type(error).__name__}: {error}'
    print(report['error'], flush=True)
    raise
finally:
    for handle in handles: handle.remove()
    if graph: graph.close()
    graph = None
    backend.unload(); gc.collect(); torch.cuda.empty_cache()
    report['finished'] = time.time(); save()
