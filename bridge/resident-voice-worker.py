"""One resident OmniVoice instance using the pinned VoiceStudio adapter.

The bridge owns this hidden process via its input pipe. EOF/shutdown releases
the model. Startup warms all three references before accepting speech. There
is no HTTP server, automatic microphone access, idle unload or model training.
"""
from pathlib import Path
import argparse
import base64
import hashlib
import io
import importlib.util
import json
import os
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
KEYS = {'johnny-silverhand', 'judy-alvarez', 'panam-palmer'}
MAX_INPUT = 48_000
MAX_SECONDS = 120


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    config = json.loads(args.config.read_text('utf-8'))
    if config.get('provider') != 'hybrid' or set(config.get('voices', {})) != KEYS:
        raise ValueError('Expected exactly the three configured local voices')
    model = (ROOT / config['model']).resolve()
    if not model.is_relative_to(ROOT / 'vendor/voice-models') or not (model / 'model.safetensors').is_file():
        raise ValueError('Expected the installed base OmniVoice model')
    refs = {}
    for key, ref in config['voices'].items():
        path = (ROOT / ref['reference']).resolve()
        if not path.is_relative_to(ROOT / 'runtime/voice-references') or not path.is_file():
            raise ValueError('Voice reference is missing')
        if hashlib.sha256(path.read_bytes()).hexdigest() != ref['sha256'] or not ref['transcript'].strip():
            raise ValueError('Voice reference verification failed')
        refs[key] = (str(path), ref['transcript'])

    # Libraries may write directly to fd 1, so keep the protocol on a private
    # descriptor and redirect both Python and native output to stderr.
    output = os.fdopen(os.dup(1), 'w', encoding='utf-8', buffering=1)
    os.dup2(2, 1)
    def send(value):
        output.write(json.dumps(value, separators=(',', ':')) + '\n')
        output.flush()
    os.environ.update(HF_HOME=str(ROOT / 'vendor/voice-models'), HF_HUB_OFFLINE='1',
        OMNIVOICE_DATA_DIR=str(ROOT / 'runtime/voice-studio-data'), OMNIVOICE_MODEL=str(model),
        OMNIVOICE_TTS_BACKEND='omnivoice', OMNIVOICE_GPU_WORKERS='1',
        OMNIVOICE_PRELOAD_TTS_ASR='0', OMNIVOICE_ASR_BACKEND='pytorch-whisper',
        TORCH_COMPILE_DISABLE='1', PYTHONUTF8='1')
    send({'op': 'state', 'state': 'loading'})
    sys.path.insert(0, str(ROOT / 'vendor/reference-voicestudio/backend'))
    import numpy as np
    import soundfile as sf
    import torch
    from services.tts_backend import get_backend_class
    if not torch.cuda.is_available():
        raise RuntimeError('OmniVoice requires CUDA in this installation')
    backend = get_backend_class('omnivoice')()
    graph = None
    try:
        backend._ensure_loaded()
        if not (backend.execution_device or '').startswith('cuda'):
            raise RuntimeError('OmniVoice did not load on CUDA')
        if backend.dtype != 'torch.float16':
            raise RuntimeError('OmniVoice did not load with the expected FP16 weights')
        # Reuse the existing model's CUDA work, retaining just one bounded
        # graph. This does not change weights, precision, sampling or audio.
        # The opt-out keeps rollback independent of the game installation.
        if os.environ.get('CYBERPUNK_CONVAI_CUDA_GRAPH', '1') != '0':
            spec = importlib.util.spec_from_file_location('voice_cuda_graph', ROOT / 'bridge/voice-cuda-graph.py')
            replay = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(replay)
            graph = replay.VoiceGraph(backend._model).install()
        model_info = {'device': backend.execution_device, 'dtype': backend.dtype,
                      'runtime': 'pytorch', 'tensorrt': False, 'compiled': False}
        def memory_info():
            return {'cudaAllocatedMiB': torch.cuda.memory_allocated() / 1024**2,
                    'cudaReservedMiB': torch.cuda.memory_reserved() / 1024**2,
                    'cudaPeakReservedMiB': torch.cuda.max_memory_reserved() / 1024**2,
                    'acceleration': graph.snapshot()['mode'] if graph else 'eager',
                    'cudaGraph': graph.snapshot() if graph else None}

        def render(key, text, steps):
            ref, transcript = refs[key]
            torch.manual_seed(1042)
            if graph: graph.begin_request()
            started = time.perf_counter()
            with torch.inference_mode():
                wav = backend.generate(text, ref_audio=ref, ref_text=transcript,
                    language='English', num_step=steps, guidance_scale=2.0,
                    speed=1, denoise=False, postprocess_output=False)
            torch.cuda.synchronize()
            values = np.asarray(wav.detach().float().cpu() if hasattr(wav, 'detach') else wav).reshape(-1)
            if not values.size or not np.isfinite(values).all() or values.size / backend.sample_rate > MAX_SECONDS:
                raise ValueError('Local speech exceeded the supported audio limits')
            return values, (time.perf_counter() - started) * 1000

        for key in sorted(KEYS):
            send({'op': 'state', 'state': 'warming', 'profile': key})
            render(key, 'Ready when you are, V.', 32)
        # No idle worker is started: the adapter and cached references stay
        # owned by this process until its parent closes the pipe.
        send({'op': 'ready', 'profiles': sorted(KEYS), **model_info, **memory_info()})
        for line in sys.stdin:
            if len(line) > MAX_INPUT:
                raise ValueError('Oversized voice command')
            request = json.loads(line)
            if request.get('op') == 'shutdown':
                break
            request_id = request.get('id')
            try:
                key, text, steps = request.get('profile'), request.get('text'), request.get('steps')
                if request.get('op') != 'synthesize' or key not in refs or steps not in (16, 32):
                    raise ValueError('Invalid local voice selection')
                if not isinstance(text, str) or not text.strip() or len(text) > 12_000:
                    raise ValueError('Invalid local speech text')
                values, elapsed = render(key, text, steps)
                audio = io.BytesIO()
                sf.write(audio, values, backend.sample_rate, format='WAV', subtype='PCM_16')
                send({'op': 'audio', 'id': request_id, 'profile': key, 'steps': steps,
                      'audio': base64.b64encode(audio.getvalue()).decode('ascii'),
                      'generationMs': elapsed, **model_info, **memory_info()})
            except Exception as error:
                print(f'Local speech failed: {type(error).__name__}: {error}', file=sys.stderr, flush=True)
                send({'op': 'error', 'id': request_id, 'message': 'Local voice could not generate this reply.'})
    finally:
        try:
            if graph: graph.close()
        finally:
            backend.unload()
            output.close()


if __name__ == '__main__':
    main()
