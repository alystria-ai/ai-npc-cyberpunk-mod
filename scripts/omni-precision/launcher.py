"""Measurement launcher: the bridge's own resident OmniVoice worker with one numeric-precision variant.

Usage (spawned by scripts/Measure-OmniPrecision.mjs in place of bridge/resident-voice-worker.py):
    python launcher.py <project> <private cache dir> --config <voice config>
Environment:
    OMNI_PRECISION  fp16 (default, identical to the bridge) | bf16 | int8wo | int8dyn | fp8wo | fp8dyn | bf16int8wo (bf16, then int8wo)
    OMNI_SEED_OFFSET  added to the worker's fixed sampling seed (1042): noise-floor renders of the same model
    OMNI_TORCHAO    directory holding a separate `pip install --target` torchao (the live venv stays untouched)

Nothing in bridge/ is edited. After the bridge's normal FP16 load, the denoiser (Qwen3 backbone `llm`, the audio
embeddings and the audio head) is converted in place; the audio tokenizer/codec and the sampler stay as they are.
The worker's "expects torch.float16" guard is satisfied by a patched `dtype` property; the true dtype and the
VRAM before/after conversion are written to stderr as one `PRECISION {...}` line.
"""
import contextlib, importlib.abc, importlib.machinery, importlib.util, json, os, sys
from pathlib import Path

project, cache = Path(sys.argv[1]), Path(sys.argv[2])
mode = os.environ.get('OMNI_PRECISION', 'fp16')
torchao_dir = os.environ.get('OMNI_TORCHAO')
if torchao_dir and mode not in ('fp16', 'bf16', 'int8wo-none'):
    sys.path.insert(0, torchao_dir)

spec = importlib.util.spec_from_file_location('resident_voice_worker', project / 'bridge/resident-voice-worker.py')
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)
# Same isolation as Measure-MultirefLatency: private prompt cache, no shared admission lock.
worker.model_admission = lambda *a, **k: contextlib.nullcontext()
environment = worker.voice_environment
def isolated(registry):
    values = environment(registry)
    values['OMNIVOICE_DATA_DIR'] = str(cache / f'{worker.MODEL_REVISION[:12]}-{worker.ADAPTER_REVISION[:12]}')
    return values
worker.voice_environment = isolated


def quantization_config():
    from torchao.quantization import (Float8DynamicActivationFloat8WeightConfig, Float8WeightOnlyConfig,
                                      Int8DynamicActivationInt8WeightConfig, Int8WeightOnlyConfig, PerTensor)
    return {'int8wo': Int8WeightOnlyConfig, 'bf16int8wo': Int8WeightOnlyConfig, 'int8dyn': Int8DynamicActivationInt8WeightConfig,
            'fp8wo': Float8WeightOnlyConfig,
            'fp8dyn': lambda: Float8DynamicActivationFloat8WeightConfig(granularity=PerTensor())}[mode]()


def convert(model):
    import torch
    def mib():
        return {'allocatedMiB': round(torch.cuda.memory_allocated() / 1024**2, 1),
                'reservedMiB': round(torch.cuda.memory_reserved() / 1024**2, 1),
                'peakReservedMiB': round(torch.cuda.max_memory_reserved() / 1024**2, 1)}
    report = {'mode': mode, 'before': mib()}
    if mode in ('bf16', 'bf16int8wo'):
        for part in (model.llm, model.audio_embeddings, model.audio_heads):
            part.to(torch.bfloat16)
    if mode not in ('fp16', 'bf16'):
        from torchao.quantization import quantize_
        linears = 0
        def only_layer_linears(module, fqn):
            nonlocal linears
            keep = isinstance(module, torch.nn.Linear) and fqn.startswith('layers.')
            linears += keep
            return keep
        quantize_(model.llm, quantization_config(), filter_fn=only_layer_linears)
        report['quantizedLinears'] = linears
        import torchao; report['torchao'] = torchao.__version__
    import gc; gc.collect(); torch.cuda.empty_cache()
    report['after'] = mib()
    report['llmDtype'] = str(next(model.llm.parameters()).dtype)
    report['torch'] = torch.__version__
    torch.cuda.reset_peak_memory_stats()     # the reported runtime peak excludes the FP16 load transient
    print('PRECISION ' + json.dumps(report), file=sys.stderr, flush=True)


def patch(module):
    cls = module.OmniVoiceBackend
    original = cls._ensure_loaded
    def ensure_loaded(self):
        fresh = self._model is None
        original(self)
        if fresh:
            convert(self._model)
    cls._ensure_loaded = ensure_loaded
    if mode != 'fp16':
        cls.dtype = property(lambda self: 'torch.float16')   # worker guard only; see module docstring


class Hook(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name != 'services.tts_backend':
            return None
        found = importlib.machinery.PathFinder.find_spec(name, path)
        loader, run = found.loader, found.loader.exec_module
        def exec_module(module):
            run(module); patch(module)
        loader.exec_module = exec_module
        return found


offset = int(os.environ.get('OMNI_SEED_OFFSET', '0'))
if offset:
    import torch
    _seed = torch.manual_seed
    torch.manual_seed = lambda value: _seed(value + offset)
sys.meta_path.insert(0, Hook())
sys.argv = ['resident-voice-worker.py'] + sys.argv[3:]
worker.main()
