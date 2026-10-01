"""One resident OmniVoice model with verified, data-driven character profiles.

The bridge owns this hidden process through its input pipe. Commands are handled
serially, including lazy profile preparation; EOF releases the one model. A
profile is a recording and transcript, never another trained model.
"""
from collections import OrderedDict
from pathlib import Path, PurePosixPath
import argparse
import base64
import hashlib
import io
import importlib.util
import json
import os
import re
import stat
import sys
import time
import wave

ROOT = Path(__file__).resolve().parents[1]
LEGACY_KEYS = ('johnny-silverhand', 'judy-alvarez', 'panam-palmer')
MAX_PROFILES = 128
MAX_CACHED_PROFILES = 8
MAX_INPUT = 48_000
MAX_CONFIG_BYTES = 4 * 1024 * 1024
MAX_SECONDS = 120
MAX_REFERENCE_SECONDS = 20
MAX_REFERENCE_BYTES = 32 * 1024 * 1024
WARM_PHRASE = 'Ready when you are, V.'
MODEL_REVISION = 'c5fdb5ccb189668d56333f77ba2629f4cd7535f4'
ADAPTER_REVISION = '08a1592e3cb9b4c36beef5fa3185ec2313bb1fea'


class ReferenceUnavailable(ValueError):
    """A structurally valid reference cannot be used from this installation."""


def read_config(path):
    with path.open('rb') as handle:
        content = handle.read(MAX_CONFIG_BYTES + 1)
    if len(content) > MAX_CONFIG_BYTES:
        raise ValueError('Local voice configuration exceeded its byte limit')
    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate local voice configuration key')
            result[key] = value
        return result
    return json.loads(content.decode('utf-8-sig'), object_pairs_hook=unique_keys)


def valid_key(value):
    return (isinstance(value, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', value)
            and value not in ('constructor', 'prototype', '__proto__'))


def valid_transcript(value):
    return (isinstance(value, str) and bool(value.strip()) and len(value) <= 12_000
            and not re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', value))


def contained_file(root, relative, prefix, *, suffix=None):
    """Check spelling and resolved containment; reject symlinks and junctions."""
    if (not isinstance(relative, str) or len(relative) > 512
            or re.search(r'[\\:\x00-\x1f\x7f]', relative)
            or not relative.startswith(prefix + '/')
            or any(part in ('', '.', '..') for part in relative.split('/'))
            or (suffix and not relative.endswith(suffix))):
        raise ValueError('Invalid local asset path')
    root = root.resolve()
    candidate = root
    for part in PurePosixPath(relative).parts:
        candidate /= part
        attributes = getattr(candidate.lstat(), 'st_file_attributes', 0) if candidate.exists() else 0
        if (candidate.is_symlink() or attributes & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400)
                or (hasattr(candidate, 'is_junction') and candidate.is_junction())):
            raise ValueError('Linked local assets are not supported')
    resolved = candidate.resolve()
    approved = (root / prefix).resolve()
    if not approved.is_relative_to(root) or not resolved.is_relative_to(approved):
        raise ValueError('Local asset is outside its approved directory')
    if not resolved.is_file():
        raise ReferenceUnavailable('Local asset is missing')
    return resolved


def validate_reference(root, descriptor):
    if not isinstance(descriptor, dict) or not valid_transcript(descriptor.get('transcript')):
        raise ValueError('Invalid local reference transcript')
    if not isinstance(descriptor.get('sha256'), str) or not re.fullmatch(r'[a-f0-9]{64}', descriptor['sha256']):
        raise ValueError('Invalid local reference hash')
    path = contained_file(root, descriptor.get('reference'), 'runtime/voice-references', suffix='.wav')
    if not 44 <= path.stat().st_size <= MAX_REFERENCE_BYTES:
        raise ReferenceUnavailable('Local reference exceeded supported byte limits')
    with path.open('rb') as handle:
        encoded = handle.read(MAX_REFERENCE_BYTES + 1)
    if len(encoded) > MAX_REFERENCE_BYTES:
        raise ReferenceUnavailable('Local reference exceeded supported byte limits')
    if hashlib.sha256(encoded).hexdigest() != descriptor['sha256']:
        raise ReferenceUnavailable('Local reference hash did not match')
    # Above 20 seconds the adapter selects another passage/ASR. A supplied
    # verified transcript must stay below that branch. Stereo is supported.
    try:
        with wave.open(io.BytesIO(encoded), 'rb') as wav:
            rate, frames = wav.getframerate(), wav.getnframes()
            if (rate <= 0 or frames <= 0 or frames / rate > MAX_REFERENCE_SECONDS
                    or wav.getnchannels() not in (1, 2) or wav.getsampwidth() not in (2, 3, 4)):
                raise ReferenceUnavailable('Unsupported local reference WAV')
            if len(wav.readframes(frames)) != frames * wav.getnchannels() * wav.getsampwidth():
                raise ReferenceUnavailable('Local reference WAV was truncated')
    except (wave.Error, EOFError) as error:
        raise ReferenceUnavailable('Local reference WAV is invalid') from error
    return (str(path), descriptor['transcript'])


def validate_config(config, root=ROOT):
    """Configuration boundary: no heavyweight imports, inference or writes."""
    if (not isinstance(config, dict) or config.get('provider') != 'hybrid'
            or config.get('engine') != 'omnivoice' or type(config.get('version', 1)) is not int
            or config.get('version', 1) not in (1, 2) or config.get('steps', 32) not in (16, 32)
            or type(config.get('steps', 32)) is not int):
        raise ValueError('Expected an OmniVoice local configuration')
    voices = config.get('voices')
    if not isinstance(voices, dict) or len(voices) > MAX_PROFILES:
        raise ValueError('Invalid local voice registry')
    if config.get('version', 1) == 1 and set(voices) != set(LEGACY_KEYS):
        raise ValueError('New cast profiles require configuration version2')
    refs, unavailable, descriptors = {}, {}, {}
    for key, descriptor in voices.items():
        if not valid_key(key) or not isinstance(descriptor, dict):
            raise ValueError('Invalid local voice profile')
        status = descriptor.get('status', 'ready')
        if status not in ('ready', 'unprepared', 'unavailable'):
            raise ValueError('Invalid local voice profile status')
        if status != 'ready':
            unavailable[key] = status
            continue
        try:
            refs[key] = validate_reference(root, descriptor)
        except ReferenceUnavailable:
            unavailable[key] = 'unavailable'
        descriptors[key] = {name: descriptor[name] for name in ('reference', 'sha256', 'transcript')}
    policy = config.get('preparation')
    if 'preparation' in config and (not isinstance(policy, dict) or policy.get('mode') not in ('eager', 'lazy')):
        raise ValueError('Invalid voice preparation policy')
    mode = (policy or {}).get('mode', 'eager' if len(voices) <= 3 else 'lazy')
    startup = (policy or {}).get('startupProfiles', sorted(descriptors) if mode == 'eager'
                               else [key for key in LEGACY_KEYS if key in descriptors])
    limit = (policy or {}).get('maxCachedProfiles', MAX_CACHED_PROFILES)
    if (not isinstance(startup, list) or len(startup) > 3
            or any(not isinstance(key, str) or key not in descriptors for key in startup)
            or len(set(startup)) != len(startup)
            or (mode == 'eager' and set(startup) != set(descriptors))
            or type(limit) is not int or not 1 <= limit <= MAX_CACHED_PROFILES or len(startup) > limit):
        raise ValueError('Invalid voice startup profiles/cache limit')
    relative = config.get('model')
    model_file = contained_file(root, relative + '/model.safetensors'
                                if isinstance(relative, str) else None, 'vendor/voice-models')
    if config.get('revision') != MODEL_REVISION or model_file.parent.name != MODEL_REVISION:
        raise ValueError('Expected the pinned base OmniVoice model')
    return {'refs': refs, 'descriptors': descriptors, 'root': root,
            'referenceHashes': {key: descriptors[key]['sha256'] for key in refs},
            'transcriptHashes': {key: hashlib.sha256(descriptors[key]['transcript'].encode('utf-8')).hexdigest() for key in refs},
            'configuredProfiles': sorted(voices), 'unavailableProfiles': unavailable,
            'startupProfiles': [key for key in startup if key in refs], 'maxCachedProfiles': limit, 'mode': mode,
            'model': model_file.parent, 'version': config.get('version', 1)}


class ProfileSession:
    """Serial handler with a bounded, successful-preparation LRU.

    Eviction never switches the speaker. Reusing an evicted profile prepares its
    own recording again through the adapter's bounded memory/disk prompt cache.
    """
    def __init__(self, registry, render, encode, send, model_info, memory_info, prepared_snapshot=None):
        self.registry, self.render, self.encode, self.send = registry, render, encode, send
        self.model_info, self.memory_info = model_info, memory_info
        self.prepared_snapshot = prepared_snapshot
        self.prepared = OrderedDict()

    def sync_prepared(self):
        if self.prepared_snapshot is not None:
            self.prepared = OrderedDict((key, True) for key in self.prepared_snapshot())

    def remember(self, key):
        if self.prepared_snapshot is not None:
            self.sync_prepared()
            if key not in self.prepared:
                raise RuntimeError('Selected reference conditioning did not enter the prompt cache')
            return
        self.prepared[key] = True
        self.prepared.move_to_end(key)
        while len(self.prepared) > self.registry['maxCachedProfiles']:
            self.prepared.popitem(last=False)

    def prepare(self, key):
        # Revalidate before a cache hit as well, so a file edit cannot appear
        # ready while the adapter is still retaining another conditioning prompt.
        validate_reference(self.registry['root'], self.registry['descriptors'][key])
        self.sync_prepared()
        if key in self.prepared:
            # A cache hit performs no adapter operation, so it must not refresh
            # only the diagnostic LRU and disagree with the physical prompt LRU.
            return 0
        _, elapsed = self.render(key, WARM_PHRASE, 32)
        self.remember(key)
        return elapsed

    def startup(self):
        for key in self.registry['startupProfiles']:
            self.send({'op': 'state', 'state': 'warming', 'profile': key})
            self.prepare(key)
        self.send({'op': 'ready', 'protocolVersion': 2, 'profiles': sorted(self.registry['refs']),
                   'configuredProfiles': self.registry['configuredProfiles'],
                   'unavailableProfiles': self.registry['unavailableProfiles'],
                   'referenceHashes': self.registry['referenceHashes'],
                   'transcriptHashes': self.registry['transcriptHashes'],
                   'preparedProfiles': list(self.prepared), **self.model_info, **self.memory_info()})

    def handle(self, request):
        if not isinstance(request, dict):
            raise ValueError('Invalid voice command')
        if request.get('op') == 'shutdown':
            return False
        request_id, key = request.get('id'), request.get('profile')
        try:
            if (type(request_id) is not int or not 0 < request_id <= 2**53 - 1
                    or not isinstance(key, str) or key not in self.registry['refs']):
                raise ValueError('Invalid local voice selection')
            if request.get('op') == 'prepare':
                elapsed = self.prepare(key)
                self.send({'op': 'prepared', 'id': request_id, 'profile': key,
                           'generationMs': elapsed, 'preparedProfiles': list(self.prepared),
                           **self.model_info, **self.memory_info()})
            elif request.get('op') == 'synthesize':
                text, steps = request.get('text'), request.get('steps')
                if type(steps) is not int or steps not in (16, 32) or not valid_transcript(text):
                    raise ValueError('Invalid local speech text/quality')
                validate_reference(self.registry['root'], self.registry['descriptors'][key])
                values, elapsed = self.render(key, text, steps)
                audio = self.encode(values)
                self.remember(key)
                self.send({'op': 'audio', 'id': request_id, 'profile': key, 'steps': steps,
                           'audio': audio, 'generationMs': elapsed, 'preparedProfiles': list(self.prepared),
                           **self.model_info, **self.memory_info()})
            else:
                raise ValueError('Invalid local voice command')
        except Exception as error:
            self.sync_prepared()
            if isinstance(key, str):
                self.prepared.pop(key, None)
            print(f'Local speech failed: {type(error).__name__}: {error}', file=sys.stderr, flush=True)
            self.send({'op': 'error', 'id': request_id, 'message': 'Local voice could not generate this reply.',
                       'preparedProfiles': list(self.prepared)})
        return True


def install_cache_identity(adapter, registry):
    """Version2 adds immutable conditioning identity to the existing cache key.

    The pinned adapter hashes arbitrary key tuples for disk storage. Appending
    identity leaves reference processing/generation unchanged while preventing
    same-path/same-mtime updates from reviving another approved recording.
    """
    original = adapter._clone_prompt_key
    if registry['version'] < 2:
        return original
    identity = {(os.path.abspath(ref[0]), ref[1]): (registry['referenceHashes'][key], registry['transcriptHashes'][key])
                for key, ref in registry['refs'].items()}
    def fingerprinted(ref_audio, ref_text, preprocess_prompt=True, *, passage=None):
        key = original(ref_audio, ref_text, preprocess_prompt, passage=passage)
        fingerprints = identity.get((os.path.abspath(ref_audio), ref_text))
        if fingerprints is None:
            raise ValueError('Unregistered reference cannot enter the prompt cache')
        return (*key, 'cyberpunk-voice-profile-v2', MODEL_REVISION, ADAPTER_REVISION, *fingerprints)
    adapter._clone_prompt_key = fingerprinted
    return original


def cached_profiles(adapter, registry):
    """Read only the adapter's actual conditioning LRU after serial GPU work."""
    identity = {(os.path.abspath(ref[0]), ref[1]): key for key, ref in registry['refs'].items()}
    with adapter._prompt_cache_lock:
        keys = list(adapter._prompt_cache)
    profiles = []
    for cache_key in keys:
        if not isinstance(cache_key, tuple) or len(cache_key) < 4:
            continue
        profile = identity.get((cache_key[0], cache_key[2]))
        if profile is not None:
            if registry['version'] >= 2 and tuple(cache_key[-5:]) != ('cyberpunk-voice-profile-v2', MODEL_REVISION, ADAPTER_REVISION,
                                      registry['referenceHashes'][profile], registry['transcriptHashes'][profile]):
                continue
            if profile in profiles:
                profiles.remove(profile)
            profiles.append(profile)
    return profiles[-registry['maxCachedProfiles']:]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    registry = validate_config(read_config(args.config))
    # Native libraries can write directly to fd 1. Isolate the JSON protocol
    # before imports and redirect Python/native logging to stderr.
    output = os.fdopen(os.dup(1), 'w', encoding='utf-8', buffering=1)
    os.dup2(2, 1)
    def send(value):
        output.write(json.dumps(value, separators=(',', ':')) + '\n')
        output.flush()
    cache_root = ROOT / 'runtime/voice-studio-data'
    if registry['version'] >= 2:
        cache_root /= f'{MODEL_REVISION[:12]}-{ADAPTER_REVISION[:12]}'
    os.environ.update(HF_HOME=str(ROOT / 'vendor/voice-models'), HF_HUB_OFFLINE='1',
        OMNIVOICE_DATA_DIR=str(cache_root), OMNIVOICE_MODEL=str(registry['model']),
        OMNIVOICE_TTS_BACKEND='omnivoice', OMNIVOICE_GPU_WORKERS='1',
        OMNIVOICE_PRELOAD_TTS_ASR='0', OMNIVOICE_ASR_BACKEND='pytorch-whisper',
        TORCH_COMPILE_DISABLE='1', PYTHONUTF8='1')
    send({'op': 'state', 'state': 'loading'})
    sys.path.insert(0, str(ROOT / 'vendor/reference-voicestudio/backend'))
    import numpy as np
    import soundfile as sf
    import torch
    from services import tts_backend
    if not torch.cuda.is_available():
        raise RuntimeError('OmniVoice requires CUDA in this installation')
    backend = tts_backend.get_backend_class('omnivoice')()
    graph = None
    original_cache_key = tts_backend._clone_prompt_key
    try:
        # Preserve the existing disk ceiling; the requested memory ceiling can
        # only shrink the adapter's verified eight-profile prompt LRU.
        if tts_backend._PROMPT_CACHE_MAX != MAX_CACHED_PROFILES or tts_backend._PROMPT_DISK_CACHE_MAX != 32:
            raise RuntimeError('Unexpected OmniVoice adapter prompt-cache bounds')
        tts_backend._PROMPT_CACHE_MAX = registry['maxCachedProfiles']
        original_cache_key = install_cache_identity(tts_backend, registry)
        backend._ensure_loaded()
        if not (backend.execution_device or '').startswith('cuda'):
            raise RuntimeError('OmniVoice did not load on CUDA')
        if backend.dtype != 'torch.float16':
            raise RuntimeError('OmniVoice did not load with the expected FP16 weights')
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
            ref, transcript = registry['refs'][key]
            torch.manual_seed(1042)
            if graph:
                graph.begin_request()
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

        def encode(values):
            audio = io.BytesIO()
            sf.write(audio, values, backend.sample_rate, format='WAV', subtype='PCM_16')
            return base64.b64encode(audio.getvalue()).decode('ascii')

        session = ProfileSession(registry, render, encode, send, model_info, memory_info,
                                 prepared_snapshot=lambda: cached_profiles(tts_backend, registry))
        session.startup()
        while True:
            line = sys.stdin.readline(MAX_INPUT + 1)
            if not line:
                break
            if len(line) > MAX_INPUT:
                raise ValueError('Oversized voice command')
            if not session.handle(json.loads(line)):
                break
    finally:
        try:
            if graph:
                graph.close()
        finally:
            try:
                backend.unload()
            finally:
                tts_backend._clone_prompt_key = original_cache_key
                output.close()


if __name__ == '__main__':
    main()
