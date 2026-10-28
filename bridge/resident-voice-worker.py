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
import faulthandler
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

# The application directory is where this script is spelled to be. Inside USVFS (see USVFS_VARIABLE below) the resolved place of a file is the mod that holds
# it, which is not where the folder the bridge handed over resolves to (a merged folder answers with the winning mod's), and the bridge compares the
# `applicationDirectory` this worker reports with the folder it launched the worker from: the script's path as it was given, made absolute, never resolved.
# Outside USVFS the resolved place decides, exactly as before.
ROOT = (Path(os.path.abspath(__file__)) if os.environ.get('CYBERPUNK_CONVAI_USVFS') == '1' else Path(__file__).resolve()).parents[1]
LEGACY_KEYS = ('johnny-silverhand', 'judy-alvarez', 'panam-palmer')
MAX_PROFILES = 1024
MAX_CACHED_PROFILES = 8
MAX_INPUT = 48_000
MAX_CONFIG_BYTES = 4 * 1024 * 1024
MAX_SECONDS = 120
# The exit code of a worker whose PyTorch has no CUDA (an AMD or Intel card, or an NVIDIA driver that does not work). The same on every try, so the bridge
# (bridge/resident-voice.mjs NO_CUDA_EXIT_CODE) reads this code, not the message, and does not start the worker again.
NO_CUDA_EXIT_CODE = 78
MAX_REFERENCE_SECONDS = 20
MAX_REFERENCE_BYTES = 32 * 1024 * 1024
WARM_PHRASE = 'Ready when you are, V.'
MODEL_REVISION = 'c5fdb5ccb189668d56333f77ba2629f4cd7535f4'
ADAPTER_REVISION = '08a1592e3cb9b4c36beef5fa3185ec2313bb1fea'
# A player's own clip for a character lives in the player's data folder (`playerVoiceDirectory` in the configuration), never beside the
# shipped references: a descriptor naming this fixed second namespace resolves only inside that folder.
PLAYER_PREFIX = 'runtime/player-voices'
PLAYER_REFERENCE = re.compile(r'runtime/player-voices/[a-z0-9][a-z0-9-]{0,79}\.wav')
# A multilingual pack's clip (docs/VOICE_LANGUAGE_PACKS.md) is a reference of the shipped namespace, in a folder of its own: a request may name one to clone from
# in place of its profile's English reference (`languageReference`). Nothing else is accepted by that field.
LANGUAGE_REFERENCE = re.compile(r'runtime/voice-references/multilingual/[a-z]{2}(?:-[a-z]{2})?/(?:picked|archetypes|v-voice)/[a-z0-9][a-z0-9._-]{0,79}\.wav')
MAX_LANGUAGE_REFERENCES = 32
PATH_OVERRIDES = {
    'modelDirectory': 'CYBERPUNK_CONVAI_OMNI_MODEL',
    'adapterDirectory': 'CYBERPUNK_CONVAI_OMNI_ADAPTER',
    'referenceDirectory': 'CYBERPUNK_CONVAI_OMNI_REFERENCES',
    'cacheDirectory': 'CYBERPUNK_CONVAI_OMNI_CACHE',
}


# Mod Organizer 2 runs the game, and every process it starts, inside USVFS (a virtual file system); the service sets USVFS_VARIABLE to "1" in each
# (packaging/runtime/usvfs-compat.mjs). A folder of the app is then the merge of several mod folders, and Path.resolve() of a file answers with the
# real place of that one file, the mod that holds it. The OmniVoice pack is usually a mod of its own, so its model and adapter really live outside
# the Runtime's folder, and a file may live in another mod than its folder's real place. Inside USVFS the paths are therefore compared as spelled
# (absolute, normalised, never resolved), the pack's folder is a second approved root (the service names it in PACK_VARIABLE), and every component
# of every path is still refused when it is a symlink or junction. Outside USVFS none of this applies and the checks are exactly as before.
USVFS_VARIABLE = 'CYBERPUNK_CONVAI_USVFS'
PACK_VARIABLE = 'CYBERPUNK_CONVAI_OMNI_PACK'
# The player's own Python (bridge/omni-own-python.mjs): set to '1' by the bridge, with the pack's OmniVoice source folder beside it.
OWN_PYTHON_VARIABLE = 'CYBERPUNK_CONVAI_OMNI_OWN_PYTHON'
OMNI_SOURCE_VARIABLE = 'CYBERPUNK_CONVAI_OMNI_SOURCE'
# On a ROCm PyTorch only (docs/OMNIVOICE_AMD.md): '1' keeps MIOpen's convolutions (the default turns them off, PyTorch's own path is faster and steadier there).
ROCM_MIOPEN_VARIABLE = 'CYBERPUNK_CONVAI_ROCM_MIOPEN'
# MIOpen's find mode and find enforcement on ROCm (2 = FAST, 1 = NONE), unless the player set their own (bridge/omni-own-python.mjs MIOPEN_DEFAULTS).
MIOPEN_DEFAULTS = {'MIOPEN_FIND_MODE': '2', 'MIOPEN_FIND_ENFORCE': '1'}
# The worker's process priority (docs/PROCESS_PRIORITY.md): the bridge names the level here ('high' by default on both routes, 'below' or nothing otherwise) and sets the
# child it spawned too; the worker sets itself because a venv's python.exe is a launcher, so the child's pid is not the worker's. Never REALTIME.
PRIORITY_VARIABLE = 'CYBERPUNK_CONVAI_WORKER_PRIORITY'
PRIORITY_CLASSES = {'high': 0x00000080, 'below': 0x00004000}


def usvfs_active(environ=None):
    return (os.environ if environ is None else environ).get(USVFS_VARIABLE) == '1'


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


def link_inside_app(candidate, app, usvfs):
    """(the first link, True) from `candidate` up to (not including) the app folder, or (candidate, False) when only a path outside it is itself a link, or None. Links at or above the app folder are the player's own layout
    (a junctioned Steam library, a moved Documents, OneDrive, MO2) and are accepted. A path outside the app folder (the player's data) only has itself
    checked; one that is outside by spelling but really leads into the app folder is refused. Inside USVFS the comparison is by spelling."""
    chain = (candidate, *candidate.parents)
    app_real = Path(os.path.abspath(app)) if usvfs else app.resolve()
    def is_app(part):
        return (Path(os.path.abspath(part)) if usvfs else part.resolve()) == app_real
    for depth, part in enumerate(chain):
        if is_app(part):
            return next(((link, True) for link in chain[:depth] if linked_path(link)), None)
    if not usvfs and candidate.resolve().is_relative_to(app_real):
        return next(((link, True) for link in chain if linked_path(link)), (candidate, True))
    return (candidate, False) if linked_path(candidate) else None


def checked_absolute_directory(value, name, *, usvfs=None, app=None):
    """Explicit package paths must be absolute and cannot redirect through links inside the application directory."""
    if (not isinstance(value, str) or not value or value != value.strip()
            or re.search(r'[\x00-\x1f\x7f]', value) or not Path(value).is_absolute()):
        raise ValueError(f'{name} must be an absolute filesystem path')
    candidate = Path(value)
    usvfs = usvfs_active() if usvfs is None else usvfs
    linked = link_inside_app(candidate, ROOT if app is None else app, usvfs)
    if linked:
        raise ValueError('Linked directories inside the application directory are not supported' if linked[1] else 'Linked runtime directories are not supported')
    # Inside USVFS the folder stays as spelled: its resolved form is only where one mod happens to hold it.
    resolved = Path(os.path.abspath(candidate)) if usvfs else candidate.resolve()
    if resolved.exists() and not resolved.is_dir():
        raise ValueError('Expected a runtime directory')
    return resolved


def approved_roots(paths):
    """The folders the packaged assets may live in: the application directory, and inside USVFS also the OmniVoice pack's own folder."""
    return [base for base in (paths['applicationDirectory'], paths.get('packDirectory')) if base is not None]


def validate_portable_source(paths):
    """An editable developer install is not a portable OmniVoice dependency."""
    if not paths['portable']:
        return
    spec = importlib.util.find_spec('omnivoice')
    origin = getattr(spec, 'origin', None)
    if not isinstance(origin, str) or not Path(origin).is_absolute():
        raise RuntimeError('The packaged OmniVoice source is unavailable')
    package = checked_absolute_directory(str(Path(origin).parent), 'OmniVoice source directory')
    if not any(package.is_relative_to(base) for base in approved_roots(paths)):
        raise RuntimeError('The packaged OmniVoice source is outside the application directory')
    asset_file(package, Path(origin).name)
    asset_file(package, 'models/omnivoice.py')


class PackagedOmniVoice:
    """Imports `omnivoice` (and its submodules, through the package's own path) from one folder of the pack, whatever the running Python has."""

    def __init__(self, folder):
        self.folder = folder

    def find_spec(self, name, path=None, target=None):
        if name != 'omnivoice':
            return None
        return importlib.util.spec_from_file_location('omnivoice', self.folder / '__init__.py', submodule_search_locations=[str(self.folder)])


def use_packaged_omnivoice(paths, environ=None):
    """The player's own Python (docs/OMNIVOICE_AMD.md): its PyTorch and libraries, but OmniVoice's code from the pack, never the player's copy.

    Only with OWN_PYTHON_VARIABLE set by the bridge. The folder must be a plain absolute folder holding the packaged source and, in a package, inside the
    application directory or the named pack (approved_roots), so validate_portable_source then checks the same folder as for the Runtime's Python.
    Returns the folder, or None without the override.
    """
    environ = os.environ if environ is None else environ
    if environ.get(OWN_PYTHON_VARIABLE) != '1':
        return None
    folder = checked_absolute_directory(environ.get(OMNI_SOURCE_VARIABLE), OMNI_SOURCE_VARIABLE)
    if paths['portable'] and not any(folder.is_relative_to(base) for base in approved_roots(paths)):
        raise RuntimeError('The packaged OmniVoice source is outside the application directory')
    asset_file(folder, '__init__.py')
    asset_file(folder, 'models/omnivoice.py')
    sys.meta_path.insert(0, PackagedOmniVoice(folder))
    return folder


def gpu_backend_line(torch):
    """One stderr line naming what PyTorch runs on: ROCm (HIP) or CUDA, the card and its memory. Never raises."""
    try:
        hip, cuda = getattr(torch.version, 'hip', None), getattr(torch.version, 'cuda', None)
        build = f'ROCm/HIP {hip}' if hip else f'CUDA {cuda}' if cuda else 'no GPU build'
        card = ''
        if torch.cuda.is_available():
            properties = torch.cuda.get_device_properties(0)
            card = f', {properties.name}, {properties.total_memory // 1048576} MiB'
        own = ' (own Python, experimental)' if os.environ.get(OWN_PYTHON_VARIABLE) == '1' else ''
        return f'[gpu] PyTorch {torch.__version__}, {build}{card}{own}'
    except Exception as error:  # noqa: BLE001 - a diagnostic never stops the worker.
        return f'[gpu] backend unknown ({str(error)[:120]})'


def cuda_graph_wanted(torch, environ=None):
    """The CUDA graph replay: on unless turned off, and off by default on a ROCm PyTorch (graphs through HIP are untested here); '1' turns it on there."""
    environ = os.environ if environ is None else environ
    hip = getattr(getattr(torch, 'version', None), 'hip', None)
    return environ.get('CYBERPUNK_CONVAI_CUDA_GRAPH', '0' if hip else '1') != '0'


def rocm_build(torch):
    """The ROCm/HIP version of this PyTorch, or None for a CUDA or CPU build (NVIDIA behaviour is never touched)."""
    hip = getattr(getattr(torch, 'version', None), 'hip', None)
    return hip if isinstance(hip, str) and hip else None


def tune_rocm(torch, environ=None):
    """ROCm only (torch.version.hip set): the MIOpen settings an RX 9070 XT player found fast and steady (docs/OMNIVOICE_AMD.md).

    MIOpen runs the convolutions by default (the game's "MIOpen convolutions (AMD)" choice, on), with MIOPEN_FIND_MODE=2 and MIOPEN_FIND_ENFORCE=1.
    ROCM_MIOPEN_VARIABLE=0 (the choice off) runs PyTorch's own convolutions instead (torch.backends.cudnn.enabled = False), with MIOPEN_FIND_MODE=2.
    A value the player already set stays theirs. All of it is read when the first convolution runs, so this is called before any model is loaded. Returns
    the one log line, or None on a CUDA or CPU build.
    """
    environ = os.environ if environ is None else environ
    hip = rocm_build(torch)
    if not hip:
        return None
    on = environ.get(ROCM_MIOPEN_VARIABLE) != '0'
    names = ['MIOPEN_FIND_MODE', 'MIOPEN_FIND_ENFORCE'] if on else ['MIOPEN_FIND_MODE']
    shown = []
    for name in names:
        if environ.get(name):
            shown.append(f'{name}={environ[name]} (already set)')
        else:
            environ[name] = MIOPEN_DEFAULTS[name]
            shown.append(f'{name}={environ[name]}')
    if on:
        convolutions = 'MIOpen'
    else:
        torch.backends.cudnn.enabled = False
        convolutions = "PyTorch's own, MIOpen off"
    return f"[rocm] HIP {hip}: {', '.join(shown)}; convolutions: {convolutions}"


def keep_rocm_convolutions(torch, environ=None):
    """After the model is loaded: a library that switched MIOpen back on is told off again. Returns a log line when it had to, else None."""
    environ = os.environ if environ is None else environ
    if not rocm_build(torch) or environ.get(ROCM_MIOPEN_VARIABLE) != '0' or not torch.backends.cudnn.enabled:
        return None
    torch.backends.cudnn.enabled = False
    return '[rocm] MIOpen convolutions were switched on while the model loaded: off again'


def set_process_priority_class(priority_class):
    """Sets this process's Windows priority class; returns (done, last error). The handle is declared pointer-sized: GetCurrentProcess() returns the pseudo-handle
    -1 and ctypes' default 32-bit int conversion turns it into 0xFFFFFFFF, which a 64-bit Windows refuses with ERROR_INVALID_HANDLE (6). That was the live
    `[priority] could not be set to high` of 27 Oct 2026."""
    import ctypes
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    kernel32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel32.SetPriorityClass.restype = ctypes.c_int
    done = bool(kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), priority_class))
    return done, (0 if done else ctypes.get_last_error())


def apply_own_priority(environ=None, apply=None):
    """The process priority class the bridge asks for (PRIORITY_VARIABLE = 'high' or 'below'; HIGH_PRIORITY_CLASS, never REALTIME). Best effort on Windows;
    returns a log line, or None when nothing was asked, the value is anything else or this is not Windows. `apply(class)` returns done or (done, error)."""
    environ = os.environ if environ is None else environ
    level = environ.get(PRIORITY_VARIABLE)
    if level not in PRIORITY_CLASSES:
        return None
    name = 'high' if level == 'high' else 'below normal'
    try:
        if apply is None:
            if os.name != 'nt':
                return None
            result = set_process_priority_class(PRIORITY_CLASSES[level])
        else:
            result = apply(PRIORITY_CLASSES[level])
        done, error = result if isinstance(result, tuple) else (bool(result), 0)
        if done:
            return f'[priority] {name}'
        return f'[priority] could not be set to {name}' + (f' (Windows error {error})' if error else '')
    except Exception as error:  # noqa: BLE001 - a priority is an optimisation, never a failure.
        return f'[priority] could not be set to {name} ({str(error)[:80]})'


def apply_requested_priority(request, apply=None):
    """The bridge's one command to raise this worker after the title screen ({'op': 'priority', 'level': 'high'}; docs/PROCESS_PRIORITY.md "Start-up"): a worker started
    while the game was still loading starts at normal, and takes HIGH here once the game has a world. Only 'high' is accepted (never 'below', never REALTIME). Returns the
    log line in the style of the start-up `[priority]` note, or None for any other level. The bridge sends it once; a repeat is the caller's to ignore."""
    if request.get('level') != 'high':
        return None
    note = apply_own_priority({PRIORITY_VARIABLE: 'high'}, apply)
    return f'{note} (after the title screen)' if note else None


def resolve_worker_paths(root=ROOT, environ=None):
    """Separate immutable package assets from the user's persistent voice data.

    Configuration references keep their existing logical namespace. Supplying
    a package layout changes only where those verified bytes are resolved.
    """
    environ = os.environ if environ is None else environ
    values = {field: environ.get(name) for field, name in PATH_OVERRIDES.items()}
    supplied = [value is not None for value in values.values()]
    usvfs = usvfs_active(environ)
    root = Path(os.path.abspath(root)) if usvfs else root.resolve()
    if not any(supplied):
        return {'portable': False, 'applicationDirectory': root,
                'modelDirectory': None,
                'adapterDirectory': root / 'vendor/reference-voicestudio/backend',
                'referenceDirectory': None, 'cacheDirectory': root / 'runtime/voice-studio-data',
                'hfDirectory': root / 'vendor/voice-models'}
    if not all(supplied):
        raise ValueError('Portable OmniVoice requires model, adapter, reference and cache paths together')
    # The pack's own folder (USVFS only): where the service says the pack is. The model and the adapter must be inside it, as they otherwise
    # must be inside the application directory; it never overlaps the persistent data either. Links above the pack are accepted like links above
    # the application directory, links inside it are not.
    pack = None
    if usvfs and environ.get(PACK_VARIABLE):
        pack = checked_absolute_directory(environ[PACK_VARIABLE], PACK_VARIABLE, usvfs=True, app=root)
    paths = {}
    for field, value in values.items():
        base = pack if pack is not None and isinstance(value, str) and Path(value).is_absolute() and Path(value).is_relative_to(pack) else root
        paths[field] = checked_absolute_directory(value, PATH_OVERRIDES[field], usvfs=usvfs, app=base)
    bases = [root] if pack is None else [root, pack]
    for field in ('modelDirectory', 'adapterDirectory'):
        if any(paths[field] == base for base in bases) or not any(paths[field].is_relative_to(base) for base in bases):
            raise ValueError('Portable voice assets must remain in the application directory')
    for field in ('referenceDirectory', 'cacheDirectory'):
        if any(paths[field].is_relative_to(base) or base.is_relative_to(paths[field]) for base in bases):
            raise ValueError('Persistent voice data must be separate from application files')
    if (paths['referenceDirectory'].is_relative_to(paths['cacheDirectory'])
            or paths['cacheDirectory'].is_relative_to(paths['referenceDirectory'])):
        raise ValueError('Voice references and cache must use separate directories')
    # Fail before importing any fallback adapter or allocating CUDA. The
    # complete module/dependency/hash closure is checked by the package launcher.
    asset_file(paths['adapterDirectory'], 'services/tts_backend.py')
    return {'portable': True, 'applicationDirectory': root, 'packDirectory': pack, **paths,
            'hfDirectory': checked_absolute_directory(str(paths['cacheDirectory'] / 'huggingface'), 'voice hub cache', usvfs=usvfs)}


def asset_file(root, relative, prefix=''):
    """Resolve a prevalidated relative asset without following linked children."""
    usvfs = usvfs_active()
    root = Path(os.path.abspath(root)) if usvfs else root.resolve()
    candidate = root
    for part in PurePosixPath(relative).parts:
        # Inside USVFS containment is by spelling (see USVFS_VARIABLE), so no part may step out of the folder.
        if usvfs and (part in ('', '.', '..') or re.search(r'[\\/:\x00-\x1f\x7f]', part)):
            raise ValueError('Local asset is outside its approved directory')
        candidate /= part
        if linked_path(candidate):
            raise ValueError('Linked local assets are not supported')
    resolved = candidate.resolve()
    if not usvfs:
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


def player_reference(relative):
    return isinstance(relative, str) and relative.startswith(PLAYER_PREFIX + '/')


def checked_player_directory(value, root, paths):
    """The optional folder of the player's own clips: absolute, no links, and never mixed with application files, shipped references or cache.

    A missing folder is fine (those profiles are then unavailable); an overlap would let a clip resolve through, or be written over by,
    another tree, so it fails the configuration like the other path overlaps do.
    """
    if value is None:
        return None
    player = checked_absolute_directory(value, 'playerVoiceDirectory')
    others = []
    if paths:
        others = [paths[field] for field in ('referenceDirectory', 'cacheDirectory') if paths.get(field) is not None]
        # A development checkout keeps its data under the application directory; a package must not.
        if paths['portable']:
            others.extend(approved_roots(paths))
    if any(player.is_relative_to(other) or other.is_relative_to(player) for other in others):
        raise ValueError('Player voice clips must be separate from application files, references and cache')
    return player


def validate_reference(root, descriptor, *, reference_root=None, player_root=None):
    if not isinstance(descriptor, dict) or not valid_transcript(descriptor.get('transcript')):
        raise ValueError('Invalid local reference transcript')
    if not isinstance(descriptor.get('sha256'), str) or not re.fullmatch(r'[a-f0-9]{64}', descriptor['sha256']):
        raise ValueError('Invalid local reference hash')
    relative = descriptor.get('reference')
    if player_reference(relative):
        # One plain <key>.wav inside the player's own folder, nothing else; without that folder the profile is unavailable, not an error.
        if not PLAYER_REFERENCE.fullmatch(relative):
            raise ValueError('Invalid local asset path')
        if player_root is None:
            raise ReferenceUnavailable('No player voice folder is configured')
        try:
            path = asset_file(checked_absolute_directory(str(player_root), 'player voice directory'), relative[len(PLAYER_PREFIX) + 1:])
        except ReferenceUnavailable:
            raise
        except ValueError as error:
            # The folder is the player's own: a link or an escape in it withdraws that one character, it never takes every voice down.
            raise ReferenceUnavailable('Player voice clip is linked or outside its folder') from error
    else:
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
    player_root = checked_player_directory(config.get('playerVoiceDirectory'), root, paths)
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
            refs[key] = validate_reference(root, descriptor, reference_root=paths['referenceDirectory'] if paths else None,
                                           player_root=player_root)
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
            'paths': paths, 'referenceRoot': paths['referenceDirectory'] if paths else None, 'playerRoot': player_root,
            'referenceHashes': {key: descriptors[key]['sha256'] for key in refs},
            'transcriptHashes': {key: hashlib.sha256(descriptors[key]['transcript'].encode('utf-8')).hexdigest() for key in refs},
            'configuredProfiles': sorted(voices), 'unavailableProfiles': unavailable,
            'startupProfiles': [key for key in startup if key in refs], 'maxCachedProfiles': limit, 'mode': mode,
            'model': model_file.parent, 'version': config.get('version', 1)}


MAX_VOICE_CHANGES = 24


def refresh_identity(registry):
    """The (file, words) -> (file hash, words hash) table the prompt-cache key reads (install_cache_identity)."""
    registry['identity'] = {(os.path.abspath(ref[0]), ref[1]): (registry['referenceHashes'][key], registry['transcriptHashes'][key])
                            for key, ref in registry['refs'].items()}
    # The language pack clips a request named stay known to the prompt cache (ProfileSession.language_reference).
    registry['identity'].update(registry.get('languageIdentity', {}))


def apply_voice_change(registry, request):
    """Changes some voices of a running worker without reloading the model (a player gave a character a clip, or took it away).

    `request` is {"set": {key: descriptor}, "remove": [key, ...], "playerVoiceDirectory": absolute folder or None}. Everything is checked
    before anything changes, so a refused change leaves the registry exactly as it was. A descriptor is checked like the configuration's
    (the same `validate_reference`: the file, its hash, its length); a file that is gone or changed withdraws only that voice. Returns
    (changed keys, [(file, words, file hash, words hash) of each reference that was replaced or removed]) so the caller can drop those
    prompts from the model's cache.
    """
    voices, removed = request.get('set', {}), request.get('remove', [])
    if (not isinstance(voices, dict) or not isinstance(removed, list) or len(voices) + len(removed) > MAX_VOICE_CHANGES
            or len(set(registry['descriptors']) | set(registry['unavailableProfiles']) | set(voices)) > MAX_PROFILES
            or any(not valid_key(key) for key in (*voices, *removed)) or set(voices) & set(removed)):
        raise ValueError('Invalid local voice change')
    folder, paths, player_root = request.get('playerVoiceDirectory'), registry.get('paths'), registry.get('playerRoot')
    if folder is not None:
        wanted = checked_player_directory(folder, registry['root'], paths)
        if player_root not in (None, wanted):
            raise ValueError('The player voice folder cannot change while running')
        player_root = wanted
    reference_root = registry.get('referenceRoot')
    checked = {}
    for key, descriptor in voices.items():
        if not isinstance(descriptor, dict):
            raise ValueError('Invalid local voice profile')
        status = descriptor.get('status', 'ready')
        if status not in ('ready', 'unprepared', 'unavailable'):
            raise ValueError('Invalid local voice profile status')
        if status != 'ready':
            checked[key] = (None, None, status)
            continue
        try:
            ref = validate_reference(registry['root'], descriptor, reference_root=reference_root, player_root=player_root)
            checked[key] = ({name: descriptor[name] for name in ('reference', 'sha256', 'transcript')}, ref, 'ready')
        except ReferenceUnavailable:
            checked[key] = ({name: descriptor[name] for name in ('reference', 'sha256', 'transcript')}, None, 'unavailable')
    registry['playerRoot'] = player_root
    changed, dropped = [], []

    def forget(key):
        ref, old = registry['refs'].pop(key, None), registry['descriptors'].pop(key, None)
        registry['referenceHashes'].pop(key, None)
        registry['transcriptHashes'].pop(key, None)
        known = ref is not None or old is not None or registry['unavailableProfiles'].pop(key, None) is not None
        registry['unavailableProfiles'].pop(key, None)
        if ref is not None and old is not None:
            dropped.append((os.path.abspath(ref[0]), ref[1], old['sha256'], hashlib.sha256(old['transcript'].encode('utf-8')).hexdigest()))
        return known

    for key in removed:
        if forget(key):
            changed.append(key)
    for key, (descriptor, ref, status) in checked.items():
        forget(key)
        if descriptor is not None:
            registry['descriptors'][key] = descriptor
            if ref is not None:
                registry['refs'][key] = ref
                registry['referenceHashes'][key] = descriptor['sha256']
                registry['transcriptHashes'][key] = hashlib.sha256(descriptor['transcript'].encode('utf-8')).hexdigest()
        if status != 'ready':
            registry['unavailableProfiles'][key] = status
        changed.append(key)
    registry['configuredProfiles'] = sorted(set(registry['descriptors']) | set(registry['unavailableProfiles']))
    registry['startupProfiles'] = [key for key in registry['startupProfiles'] if key in registry['refs']]
    refresh_identity(registry)
    return changed, dropped


class ProfileSession:
    """Serial handler with a bounded LRU of requested, prepared profile keys.

    Exact reference/transcript aliases can share one physical prompt. Logical
    readiness stays bounded and is removed when that actual prompt is evicted;
    no unrequested alias is advertised merely because another key prepared it.
    """
    def __init__(self, registry, render, encode, send, model_info, memory_info, prepared_snapshot=None, evict=None, warm_prompt=None, apply_priority=None):
        self.registry, self.render, self.encode, self.send = registry, render, encode, send
        # apply_priority(class) -> done or (done, error): sets this process's priority class (a test injects one); `priority_raised` keeps the raise to one.
        self.apply_priority, self.priority_raised = apply_priority, False
        # warm_prompt(file, words) -> milliseconds: builds a reference's conditioning prompt into the prompt cache without rendering anything.
        self.warm_prompt = warm_prompt
        self.model_info, self.memory_info = model_info, memory_info
        self.prepared_snapshot = prepared_snapshot
        self.evict = evict
        self.prepared = OrderedDict()
        # Multilingual pack clips that requests named: (reference, sha256, transcript) -> (file, words, file size, file time), at most MAX_LANGUAGE_REFERENCES.
        self.language_references = OrderedDict()

    def language_reference(self, descriptor):
        """The clip a request wants to clone from in place of the profile's English reference, as (file, words), or None for the English one.

        The descriptor is checked like any reference (the same `validate_reference`: the file inside the references folder, its hash, its length of at most
        20 s) and must name a multilingual pack clip. A refused clip is not an error: the request is spoken from the English reference and the answer says
        so. A clip that was checked is not read again until its file changes. Its prompt enters the prompt cache under its own file and words, so an English
        and a Mandarin reference of one character never share a prepared state.
        """
        try:
            if (not isinstance(descriptor, dict) or set(descriptor) != {'reference', 'sha256', 'transcript'}
                    or not isinstance(descriptor['reference'], str) or not LANGUAGE_REFERENCE.fullmatch(descriptor['reference'])):
                raise ValueError('Invalid language reference')
            token = (descriptor['reference'], descriptor['sha256'], descriptor['transcript'])
            known = self.language_references.get(token)
            if known is not None:
                status = os.stat(known[0])
                if (status.st_size, status.st_mtime_ns) == known[2:]:
                    self.language_references.move_to_end(token)
                    return known[0], known[1]
                self.language_references.pop(token)
            path, transcript = validate_reference(self.registry['root'], descriptor, reference_root=self.registry.get('referenceRoot'))
            status = os.stat(path)
            self.language_references[token] = (path, transcript, status.st_size, status.st_mtime_ns)
            fingerprints = (descriptor['sha256'], hashlib.sha256(transcript.encode('utf-8')).hexdigest())
            identity = self.registry.setdefault('languageIdentity', {})
            identity[(os.path.abspath(path), transcript)] = fingerprints
            if 'identity' in self.registry:
                self.registry['identity'][(os.path.abspath(path), transcript)] = fingerprints
            while len(self.language_references) > MAX_LANGUAGE_REFERENCES:
                _, (old_path, old_words, *_rest) = self.language_references.popitem(last=False)
                identity.pop((os.path.abspath(old_path), old_words), None)
                if 'identity' in self.registry:
                    self.registry['identity'].pop((os.path.abspath(old_path), old_words), None)
            return path, transcript
        except (ReferenceUnavailable, ValueError, OSError) as error:
            print(f'Language reference refused: {type(error).__name__}: {error}', file=sys.stderr, flush=True)
            return None

    def apply_voices(self, request):
        """One voice change (apply_voice_change); the changed voices leave the prepared list and, when a reference was replaced or
        removed, its prompt leaves the model's cache. Every other voice stays prepared."""
        changed, dropped = apply_voice_change(self.registry, request)
        for key in changed:
            self.prepared.pop(key, None)
        if self.evict is not None:
            for entry in dropped:
                self.evict(*entry)
        self.sync_prepared()
        return changed

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
                               reference_root=self.registry.get('referenceRoot'), player_root=self.registry.get('playerRoot'))
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
        if request.get('op') == 'priority':
            # Not a request: no id, no frame back (the bridge reads only answers to its requests), no state of the session touched. One line on stderr, once.
            if not self.priority_raised:
                note = apply_requested_priority(request, self.apply_priority)
                if note:
                    self.priority_raised = True
                    print(note, file=sys.stderr, flush=True)
            return True
        request_id, key = request.get('id'), request.get('profile')
        if request.get('op') == 'voices':
            try:
                if type(request_id) is not int or not 0 < request_id <= 2**53 - 1:
                    raise ValueError('Invalid local voice selection')
                changed = self.apply_voices(request)
                self.send({'op': 'voices', 'id': request_id, 'changed': changed, 'profiles': sorted(self.registry['refs']),
                           'configuredProfiles': self.registry['configuredProfiles'],
                           'unavailableProfiles': self.registry['unavailableProfiles'],
                           'referenceHashes': self.registry['referenceHashes'],
                           'transcriptHashes': self.registry['transcriptHashes'],
                           'preparedProfiles': list(self.prepared), **self.model_info, **self.memory_info()})
            except Exception as error:
                print(f'Local voice change refused: {type(error).__name__}: {error}', file=sys.stderr, flush=True)
                self.send({'op': 'error', 'id': request_id, 'message': 'Local voices could not be changed.',
                           'profiles': sorted(self.registry['refs']), 'preparedProfiles': list(self.prepared)})
            return True
        try:
            if (type(request_id) is not int or not 0 < request_id <= 2**53 - 1
                    or not isinstance(key, str) or key not in self.registry['refs']):
                raise ValueError('Invalid local voice selection')
            if request.get('op') == 'prepare' and request.get('languageReference') is not None:
                # A multilingual pack's clip, prepared ahead of the reply that will be cloned from it (no render, no prepared-list change): its checks,
                # its conditioning prompt in the cache. 'fallback' when the clip was refused (the English reference speaks that reply).
                reference = self.language_reference(request['languageReference'])
                elapsed = 0
                if reference is not None and self.warm_prompt is not None:
                    try:
                        elapsed = self.warm_prompt(*reference)
                    except Exception as error:  # noqa: BLE001 - the render builds the prompt itself, the preparation was only ahead of it
                        print(f'Language reference preparation failed: {type(error).__name__}: {error}', file=sys.stderr, flush=True)
                self.send({'op': 'prepared', 'id': request_id, 'profile': key, 'generationMs': elapsed, 'preparedProfiles': list(self.prepared),
                           'languageReference': 'used' if reference is not None else 'fallback', **self.model_info, **self.memory_info()})
            elif request.get('op') == 'prepare':
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
                # A multilingual pack's clip in place of the profile's English one (docs/VOICE_LANGUAGE_PACKS.md): 'used', or 'fallback' when the clip
                # was refused and the English reference spoke.
                reference = outcome = None
                if request.get('languageReference') is not None:
                    reference = self.language_reference(request['languageReference'])
                    outcome = 'used' if reference is not None else 'fallback'
                if reference is None:
                    self.validate_profile_reference(key)
                    values, elapsed = (self.render(key, text, steps, language) if language
                                       else self.render(key, text, steps))
                else:
                    values, elapsed = self.render(key, text, steps, language, reference)
                audio = self.encode(values)
                # The profile's own prepared state is not the language clip's: it stays as it was.
                if reference is None:
                    self.remember(key)
                self.send({'op': 'audio', 'id': request_id, 'profile': key, 'steps': steps,
                           'audio': audio, 'generationMs': elapsed, 'preparedProfiles': list(self.prepared),
                           **({'languageReference': outcome} if outcome else {}),
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
    refresh_identity(registry)
    def fingerprinted(ref_audio, ref_text, preprocess_prompt=True, *, passage=None):
        key = original(ref_audio, ref_text, preprocess_prompt, passage=passage)
        # Read from the registry on every call: a voice the player changed while the worker runs is registered there (apply_voice_change).
        fingerprints = registry['identity'].get((os.path.abspath(ref_audio), ref_text))
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


# A game restarted fast ends the old bridge's whole process tree and starts the new bridge a second later: the old worker's lock is released by the OS
# only when that process has really gone, so a slot that is owned right at the start is polled for a few seconds before it counts as owned.
# A real second worker stays alive and still gets the error after the wait.
MODEL_SLOT_WAIT_S = 9.0
MODEL_SLOT_POLL_S = 1.0


def _lock_model_slot(handle):
    """True when this handle now holds the slot, False when another process does."""
    handle.seek(0)
    try:
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return False
    return True


def _unlock_model_slot(handle):
    handle.seek(0)
    if os.name == 'nt':
        import msvcrt
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle, fcntl.LOCK_UN)


@contextmanager
def model_admission(root=ROOT, *, cache_root=None, wait_s=0.0, poll_s=MODEL_SLOT_POLL_S, sleep=time.sleep, clock=time.monotonic):
    """One OS-owned admission slot shared by bridge and audition workers.

    `wait_s` is how long an owned slot is polled (every `poll_s`) before it is reported as owned; 0 reports it at once.
    """
    root = root.resolve()
    relative = 'resident-model.lock' if cache_root is not None else 'runtime/voice-studio-data/resident-model.lock'
    candidate = cache_root if cache_root is not None else root
    for part in relative.split('/'):
        candidate /= part
        if linked_path(candidate):
            raise ValueError('Linked model-admission paths are not supported')
    approved = cache_root if cache_root is not None else root / 'runtime'
    # Every part of the path was checked for links above; the folder is compared resolved on both sides, never the lock file itself: a sandboxed
    # parent process (a packaged app's file virtualization) redirects a changed file to its own copy, so the file alone can resolve elsewhere.
    if not candidate.parent.resolve().is_relative_to(approved.resolve()):
        raise ValueError('Model-admission path escaped the runtime')
    candidate.parent.mkdir(parents=True, exist_ok=True)
    with candidate.open('a+b') as handle:
        if os.fstat(handle.fileno()).st_size == 0:
            handle.write(b'0')
            handle.flush()
        deadline = clock() + max(0.0, wait_s)
        waited = False
        while not _lock_model_slot(handle):
            if clock() >= deadline:
                raise RuntimeError('Another resident voice worker owns the shared model slot')
            if not waited:
                waited = True
                print('The shared model slot is still owned (a worker that is exiting?): waiting for it.', file=sys.stderr, flush=True)
            sleep(max(0.0, min(poll_s, deadline - clock())))
        try:
            yield
        finally:
            _unlock_model_slot(handle)


def main():
    # A native fault (an access violation in a library, exit 3221225477) used to leave no trace: with this the Python stack of every thread goes to
    # stderr, which the bridge keeps the tail of and names in the failure.
    try:
        faulthandler.enable(file=sys.stderr, all_threads=True)
    except Exception:  # noqa: BLE001 - a diagnostic never stops the worker.
        pass
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    # The bridge's choice for a session whose replies are all in a language with a voice pack: the English warm-up renders of the startup profiles
    # would only delay the first line, so the worker is ready as soon as the model is loaded (every profile still prepares when it is first asked).
    parser.add_argument('--skip-startup-warm', action='store_true')
    args = parser.parse_args()
    paths = resolve_worker_paths()
    registry = validate_config(read_config(args.config), paths=paths)
    if args.skip_startup_warm:
        registry['startupProfiles'] = []
    with model_admission(cache_root=paths['cacheDirectory'] if paths['portable'] else None, wait_s=MODEL_SLOT_WAIT_S):
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
    note = apply_own_priority()
    if note:
        print(note, file=sys.stderr, flush=True)
    send({'op': 'state', 'state': 'loading'})
    sys.path.insert(0, str(paths['adapterDirectory']))
    use_packaged_omnivoice(paths)
    validate_portable_source(paths)
    import numpy as np
    import soundfile as sf
    import torch
    from services import tts_backend
    if paths['portable'] and Path(tts_backend.__file__).resolve() != asset_file(paths['adapterDirectory'], 'services/tts_backend.py'):
        raise RuntimeError('The voice adapter does not belong to the application directory')
    print(gpu_backend_line(torch), file=sys.stderr, flush=True)
    if not torch.cuda.is_available():
        print('[no-cuda] OmniVoice requires a graphics card its PyTorch can use: CUDA on an NVIDIA card, or ROCm through omni-python.txt (docs/OMNIVOICE_AMD.md)', file=sys.stderr, flush=True)
        raise SystemExit(NO_CUDA_EXIT_CODE)
    note = tune_rocm(torch)
    if note:
        print(note, file=sys.stderr, flush=True)
    # Progress marks. The bridge's startup limit restarts at every frame it receives, so a start that is slow
    # (a throttled CPU while the game loads) is told apart from one that is stuck. Same frame, no protocol change.
    send({'op': 'state', 'state': 'loading'})
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
        note = keep_rocm_convolutions(torch)
        if note:
            print(note, file=sys.stderr, flush=True)
        if not (backend.execution_device or '').startswith('cuda'):
            raise RuntimeError('OmniVoice did not load on CUDA')
        if backend.dtype != 'torch.float16':
            raise RuntimeError('OmniVoice did not load with the expected FP16 weights')
        send({'op': 'state', 'state': 'loading'})
        if cuda_graph_wanted(torch):
            spec = importlib.util.spec_from_file_location('voice_cuda_graph', ROOT / 'bridge/voice-cuda-graph.py')
            replay = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(replay)
            graph = replay.VoiceGraph(backend._model).install()
        send({'op': 'state', 'state': 'loading'})
        model_info = {'device': backend.execution_device, 'dtype': backend.dtype,
                      'runtime': 'pytorch', 'tensorrt': False, 'compiled': False}
        def memory_info():
            return {'cudaAllocatedMiB': torch.cuda.memory_allocated() / 1024**2,
                    'cudaReservedMiB': torch.cuda.memory_reserved() / 1024**2,
                    'cudaPeakReservedMiB': torch.cuda.max_memory_reserved() / 1024**2,
                    'acceleration': graph.snapshot()['mode'] if graph else 'eager',
                    'cudaGraph': graph.snapshot() if graph else None}

        def render(key, text, steps, language=None, reference=None):
            ref, transcript = reference or registry['refs'][key]
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

        def warm_prompt(ref, transcript):
            """The reference's conditioning prompt (its audio read and encoded by the codec) into the adapter's prompt cache, the call the first render would make."""
            started = time.perf_counter()
            with torch.inference_mode():
                tts_backend._get_clone_prompt(backend._model, ref, transcript, True)
            torch.cuda.synchronize()
            return (time.perf_counter() - started) * 1000

        def encode(values):
            audio = io.BytesIO()
            sf.write(audio, values, backend.sample_rate, format='WAV', subtype='PCM_16')
            return base64.b64encode(audio.getvalue()).decode('ascii')

        def evict(path, transcript, reference_hash, transcript_hash):
            """Drops one replaced or removed reference's prompt from the adapter's memory cache (its disk copy is keyed by the same
            hashes, so a new reference never reads it)."""
            with tts_backend._prompt_cache_lock:
                for cache_key in list(tts_backend._prompt_cache):
                    if (isinstance(cache_key, tuple) and len(cache_key) >= 4 and (cache_key[0], cache_key[2]) == (path, transcript)
                            and tuple(cache_key[-2:]) == (reference_hash, transcript_hash)):
                        tts_backend._prompt_cache.pop(cache_key, None)

        session = ProfileSession(registry, render, encode, send, model_info, memory_info,
                                 prepared_snapshot=lambda: cached_profiles(tts_backend, registry), evict=evict, warm_prompt=warm_prompt)
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
