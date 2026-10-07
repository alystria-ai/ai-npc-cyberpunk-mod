"""One resident OmniVoice model with verified, data-driven character profiles.

The bridge owns this hidden process through its input pipe. Commands are handled
serially, including lazy profile preparation; EOF releases the one model. A
profile is a recording and transcript, never another trained model.
"""
from collections import OrderedDict
from contextlib import contextmanager
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
PATH_OVERRIDES = {
    'modelDirectory': 'CYBERPUNK_CONVAI_OMNI_MODEL',
    'adapterDirectory': 'CYBERPUNK_CONVAI_OMNI_ADAPTER',
    'referenceDirectory': 'CYBERPUNK_CONVAI_OMNI_REFERENCES',
    'cacheDirectory': 'CYBERPUNK_CONVAI_OMNI_CACHE',
}


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


def validate_asset_path(relative, prefix, *, suffix=None):
    if (not isinstance(relative, str) or len(relative) > 512
            or re.search(r'[\\:\x00-\x1f\x7f]', relative)
            or not relative.startswith(prefix + '/')
            or any(part in ('', '.', '..') for part in relative.split('/'))
            or (suffix and not relative.endswith(suffix))):
        raise ValueError('Invalid local asset path')


def linked_path(path):
    attributes = getattr(path.lstat(), 'st_file_attributes', 0) if path.exists() else 0
    return (path.is_symlink() or attributes & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400)
            or (hasattr(path, 'is_junction') and path.is_junction()))


def checked_absolute_directory(value, name):
    """Explicit package paths must be absolute and cannot redirect through links."""
    if (not isinstance(value, str) or not value or value != value.strip()
            or re.search(r'[\x00-\x1f\x7f]', value) or not Path(value).is_absolute()):
        raise ValueError(f'{name} must be an absolute filesystem path')
    candidate = Path(value)
    for part in reversed((candidate, *candidate.parents)):
        if linked_path(part):
            raise ValueError('Linked runtime directories are not supported')
    resolved = candidate.resolve()
    if resolved.exists() and not resolved.is_dir():
        raise ValueError('Expected a runtime directory')
    return resolved


def validate_portable_source(paths):
    """An editable developer install is not a portable OmniVoice dependency."""
    if not paths['portable']:
        return
    spec = importlib.util.find_spec('omnivoice')
    origin = getattr(spec, 'origin', None)
    if not isinstance(origin, str) or not Path(origin).is_absolute():
        raise RuntimeError('The packaged OmniVoice source is unavailable')
    package = checked_absolute_directory(str(Path(origin).parent), 'OmniVoice source directory')
    if not package.is_relative_to(paths['applicationDirectory']):
        raise RuntimeError('The packaged OmniVoice source is outside the application directory')
    asset_file(package, Path(origin).name)
    asset_file(package, 'models/omnivoice.py')


def resolve_worker_paths(root=ROOT, environ=None):
    """Separate immutable package assets from the user's persistent voice data.

    Configuration references keep their existing logical namespace. Supplying
    a package layout changes only where those verified bytes are resolved.
    """
    environ = os.environ if environ is None else environ
    values = {field: environ.get(name) for field, name in PATH_OVERRIDES.items()}
    supplied = [value is not None for value in values.values()]
    root = root.resolve()
    if not any(supplied):
        return {'portable': False, 'applicationDirectory': root,
                'modelDirectory': None,
                'adapterDirectory': root / 'vendor/reference-voicestudio/backend',
                'referenceDirectory': None, 'cacheDirectory': root / 'runtime/voice-studio-data',
                'hfDirectory': root / 'vendor/voice-models'}
    if not all(supplied):
        raise ValueError('Portable OmniVoice requires model, adapter, reference and cache paths together')
    paths = {field: checked_absolute_directory(value, PATH_OVERRIDES[field])
             for field, value in values.items()}
    for field in ('modelDirectory', 'adapterDirectory'):
        if paths[field] == root or not paths[field].is_relative_to(root):
            raise ValueError('Portable voice assets must remain in the application directory')
    for field in ('referenceDirectory', 'cacheDirectory'):
        if paths[field].is_relative_to(root) or root.is_relative_to(paths[field]):
            raise ValueError('Persistent voice data must be separate from application files')
    if (paths['referenceDirectory'].is_relative_to(paths['cacheDirectory'])
            or paths['cacheDirectory'].is_relative_to(paths['referenceDirectory'])):
        raise ValueError('Voice references and cache must use separate directories')
    # Fail before importing any fallback adapter or allocating CUDA. The
    # complete module/dependency/hash closure is checked by the package launcher.
    asset_file(paths['adapterDirectory'], 'services/tts_backend.py')
    return {'portable': True, 'applicationDirectory': root, **paths,
            'hfDirectory': checked_absolute_directory(str(paths['cacheDirectory'] / 'huggingface'), 'voice hub cache')}


def asset_file(root, relative, prefix=''):
    """Resolve a prevalidated relative asset without following linked children."""
    root = root.resolve()
    candidate = root
    for part in PurePosixPath(relative).parts:
        candidate /= part
        if linked_path(candidate):
            raise ValueError('Linked local assets are not supported')
    resolved = candidate.resolve()
    approved = (root / prefix).resolve()
    if not approved.is_relative_to(root) or not resolved.is_relative_to(approved):
        raise ValueError('Local asset is outside its approved directory')
    if not resolved.is_file():
        raise ReferenceUnavailable('Local asset is missing')
    return resolved


def contained_file(root, relative, prefix, *, suffix=None):
    """Check spelling and resolved containment; reject symlinks and junctions."""
    validate_asset_path(relative, prefix, suffix=suffix)
    return asset_file(root, relative, prefix)


def validate_reference(root, descriptor, *, reference_root=None):
    if not isinstance(descriptor, dict) or not valid_transcript(descriptor.get('transcript')):
        raise ValueError('Invalid local reference transcript')
    if not isinstance(descriptor.get('sha256'), str) or not re.fullmatch(r'[a-f0-9]{64}', descriptor['sha256']):
        raise ValueError('Invalid local reference hash')
    relative = descriptor.get('reference')
    validate_asset_path(relative, 'runtime/voice-references', suffix='.wav')
    if reference_root is not None:
        reference_root = checked_absolute_directory(str(reference_root), 'voice reference directory')
    path = (asset_file(reference_root, relative[len('runtime/voice-references/'):])
            if reference_root is not None else contained_file(root, relative, 'runtime/voice-references', suffix='.wav'))
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


def validate_config(config, root=ROOT, *, paths=None):
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
            refs[key] = validate_reference(root, descriptor, reference_root=paths['referenceDirectory'] if paths else None)
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
    model_relative = relative + '/model.safetensors' if isinstance(relative, str) else None
    validate_asset_path(model_relative, 'vendor/voice-models')
    if config.get('revision') != MODEL_REVISION or PurePosixPath(relative).name != MODEL_REVISION:
        raise ValueError('Expected the pinned base OmniVoice model')
    model_file = (asset_file(paths['modelDirectory'], 'model.safetensors')
                  if paths and paths['portable'] else contained_file(root, model_relative, 'vendor/voice-models'))
    return {'refs': refs, 'descriptors': descriptors, 'root': root,
            'paths': paths, 'referenceRoot': paths['referenceDirectory'] if paths else None,
            'referenceHashes': {key: descriptors[key]['sha256'] for key in refs},
            'transcriptHashes': {key: hashlib.sha256(descriptors[key]['transcript'].encode('utf-8')).hexdigest() for key in refs},
            'configuredProfiles': sorted(voices), 'unavailableProfiles': unavailable,
            'startupProfiles': [key for key in startup if key in refs], 'maxCachedProfiles': limit, 'mode': mode,
            'model': model_file.parent, 'version': config.get('version', 1)}


class ProfileSession:
    """Serial handler with a bounded LRU of requested, prepared profile keys.

    Exact reference/transcript aliases can share one physical prompt. Logical
    readiness stays bounded and is removed when that actual prompt is evicted;
    no unrequested alias is advertised merely because another key prepared it.
    """
    def __init__(self, registry, render, encode, send, model_info, memory_info, prepared_snapshot=None):
        self.registry, self.render, self.encode, self.send = registry, render, encode, send
        self.model_info, self.memory_info = model_info, memory_info
        self.prepared_snapshot = prepared_snapshot
        self.prepared = OrderedDict()

    def sync_prepared(self):
        if self.prepared_snapshot is not None:
            resident = set(self.prepared_snapshot())
            self.prepared = OrderedDict((key, True) for key in self.prepared if key in resident)
            return resident

    def remember(self, key):
        if self.prepared_snapshot is not None:
            if key not in self.sync_prepared():
                raise RuntimeError('Selected reference conditioning did not enter the prompt cache')
        self.prepared[key] = True
        self.prepared.move_to_end(key)
        while len(self.prepared) > self.registry['maxCachedProfiles']:
            self.prepared.popitem(last=False)

    def validate_profile_reference(self, key):
        try:
            validate_reference(self.registry['root'], self.registry['descriptors'][key],
                               reference_root=self.registry.get('referenceRoot'))
        except Exception:
            # A changed/missing recording invalidates every logical alias of
            # that file. Leave the actual adapter cache under its normal owner.
            path = self.registry['refs'][key][0]
            for prepared_key in list(self.prepared):
                if self.registry['refs'][prepared_key][0] == path:
                    self.prepared.pop(prepared_key)
            raise

    def prepare(self, key, steps=32):
        # `steps` is the hidden warm-up render's step count. The conditioning prompt does not depend on it, so a
        # player on 16 steps can warm in half the time ("Keep prepared voices"); 32 is the original behaviour.
        # Revalidate before a cache hit as well, so a file edit cannot appear
        # ready while the adapter is still retaining another conditioning prompt.
        self.validate_profile_reference(key)
        resident = self.sync_prepared()
        if key in self.prepared:
            # A cache hit performs no adapter operation, so it must not refresh
            # only the diagnostic LRU and disagree with the physical prompt LRU.
            return 0
        if resident is not None and key in resident:
            self.remember(key)
            return 0
        _, elapsed = self.render(key, WARM_PHRASE, steps)
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
                   'preparedProfiles': list(self.prepared),
                   **({'workerPaths': {key: str(paths[key]) for key in ('applicationDirectory', *PATH_OVERRIDES)}}
                      if (paths := self.registry.get('paths')) and paths['portable'] else {}),
                   **self.model_info, **self.memory_info()})

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
                steps = request.get('steps', 32)
                if type(steps) is not int or steps not in (16, 32):
                    raise ValueError('Invalid local warm-up quality')
                elapsed = self.prepare(key, steps)
                self.send({'op': 'prepared', 'id': request_id, 'profile': key,
                           'generationMs': elapsed, 'preparedProfiles': list(self.prepared),
                           **self.model_info, **self.memory_info()})
            elif request.get('op') == 'synthesize':
                text, steps = request.get('text'), request.get('steps')
                # Multilingual conversations: the reply's ISO 639-1 code when it is not English. OmniVoice
                # clones the English reference into that language; without one the request is unchanged.
                language = request.get('language')
                if type(steps) is not int or steps not in (16, 32) or not valid_transcript(text):
                    raise ValueError('Invalid local speech text/quality')
                if language is not None and (not isinstance(language, str) or not re.fullmatch(r'[a-z]{2,3}', language)):
                    raise ValueError('Invalid local speech language')
                self.validate_profile_reference(key)
                values, elapsed = (self.render(key, text, steps, language) if language
                                   else self.render(key, text, steps))
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
    """All keys eligible through actual prompts; ProfileSession bounds reports.

    One physical prompt can match many exact aliases. Truncating this snapshot
    by logical key count would hide a valid alias before it can be requested.
    """
    identity = {}
    for key, ref in registry['refs'].items():
        identity.setdefault((os.path.abspath(ref[0]), ref[1]), []).append(key)
    with adapter._prompt_cache_lock:
        keys = list(adapter._prompt_cache)
    profiles = []
    for cache_key in keys:
        if not isinstance(cache_key, tuple) or len(cache_key) < 4:
            continue
        for profile in identity.get((cache_key[0], cache_key[2]), []):
            if registry['version'] >= 2 and tuple(cache_key[-5:]) != ('cyberpunk-voice-profile-v2', MODEL_REVISION, ADAPTER_REVISION,
                                      registry['referenceHashes'][profile], registry['transcriptHashes'][profile]):
                continue
            if profile in profiles:
                profiles.remove(profile)
            profiles.append(profile)
    return profiles


@contextmanager
def model_admission(root=ROOT, *, cache_root=None):
    """One OS-owned admission slot shared by bridge and audition workers."""
    root = root.resolve()
    relative = 'resident-model.lock' if cache_root is not None else 'runtime/voice-studio-data/resident-model.lock'
    candidate = cache_root if cache_root is not None else root
    for part in relative.split('/'):
        candidate /= part
        if linked_path(candidate):
            raise ValueError('Linked model-admission paths are not supported')
    approved = cache_root if cache_root is not None else root / 'runtime'
    if not candidate.resolve().is_relative_to(approved):
        raise ValueError('Model-admission path escaped the runtime')
    candidate.parent.mkdir(parents=True, exist_ok=True)
    with candidate.open('a+b') as handle:
        if os.fstat(handle.fileno()).st_size == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise RuntimeError('Another resident voice worker owns the shared model slot') from error
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    paths = resolve_worker_paths()
    registry = validate_config(read_config(args.config), paths=paths)
    with model_admission(cache_root=paths['cacheDirectory'] if paths['portable'] else None):
        run_worker(registry)


def voice_environment(registry):
    paths = registry.get('paths') or resolve_worker_paths(environ={})
    cache_root = paths['cacheDirectory']
    if registry['version'] >= 2:
        cache_root /= f'{MODEL_REVISION[:12]}-{ADAPTER_REVISION[:12]}'
    if paths['portable']:
        cache_root = checked_absolute_directory(str(cache_root), 'voice conditioning cache')
    environment = {'HF_HOME': str(paths['hfDirectory']), 'HF_HUB_OFFLINE': '1',
        'OMNIVOICE_DATA_DIR': str(cache_root), 'OMNIVOICE_MODEL': str(registry['model']),
        'OMNIVOICE_TTS_BACKEND': 'omnivoice', 'OMNIVOICE_GPU_WORKERS': '1',
        'OMNIVOICE_PRELOAD_TTS_ASR': '0', 'OMNIVOICE_ASR_BACKEND': 'pytorch-whisper',
        'TORCH_COMPILE_DISABLE': '1', 'PYTHONUTF8': '1'}
    if paths['portable']:
        # An inherited cache override cannot redirect mutable state to another
        # installation. Source imports must not write pyc into package assets.
        environment.update(PYTHONDONTWRITEBYTECODE='1')
        for name, relative in (('HF_HUB_CACHE', 'huggingface/hub'), ('HUGGINGFACE_HUB_CACHE', 'huggingface/hub'),
                               ('TRANSFORMERS_CACHE', 'huggingface/hub'), ('HF_ASSETS_CACHE', 'huggingface/assets'),
                               ('TORCH_HOME', 'torch')):
            environment[name] = str(checked_absolute_directory(str(paths['cacheDirectory'] / relative), name))
    return environment


def run_worker(registry):
    # Native libraries can write directly to fd 1. Isolate the JSON protocol
    # before imports and redirect Python/native logging to stderr.
    output = os.fdopen(os.dup(1), 'w', encoding='utf-8', buffering=1)
    os.dup2(2, 1)
    def send(value):
        output.write(json.dumps(value, separators=(',', ':')) + '\n')
        output.flush()
    paths = registry.get('paths') or resolve_worker_paths(environ={})
    if paths['portable']:
        sys.dont_write_bytecode = True
    os.environ.update(voice_environment(registry))
    send({'op': 'state', 'state': 'loading'})
    sys.path.insert(0, str(paths['adapterDirectory']))
    validate_portable_source(paths)
    import numpy as np
    import soundfile as sf
    import torch
    from services import tts_backend
    if paths['portable'] and Path(tts_backend.__file__).resolve() != asset_file(paths['adapterDirectory'], 'services/tts_backend.py'):
        raise RuntimeError('The voice adapter does not belong to the application directory')
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

        def render(key, text, steps, language=None):
            ref, transcript = registry['refs'][key]
            torch.manual_seed(1042)
            if graph:
                graph.begin_request()
            started = time.perf_counter()
            with torch.inference_mode():
                wav = backend.generate(text, ref_audio=ref, ref_text=transcript,
                    language=language or 'English', num_step=steps, guidance_scale=2.0,
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
