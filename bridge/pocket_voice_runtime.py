"""Verified, local-only Pocket student assets and a bounded reference cache.

This module deliberately imports neither Torch nor Pocket. Source/protocol tests
can exercise identity and cancellation without loading a neural model.
"""
from __future__ import annotations

from collections import OrderedDict
import copy
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import struct
import time

PROTOCOL_VERSION = 1
SOURCE_REVISION = "41cbc84af539ea78a804ffca5f9c6edc1a22ce44"
SOURCE_SHA256 = "b86f98955b6c4776bb24a748b321408aba89d3b66f6b911f415ef4f4191a7666"
# __folder_managed_by_vortex: Vortex drops this marker file into folders it creates in the game folder (one 0.2.2 report: the Pocket source "differs
# from the pinned official revision" on a Vortex install, with that file in the Runtime's folders), so it is not part of the source.
SOURCE_IGNORES = {".git", "__pycache__", ".pytest_cache", ".ruff_cache", "__folder_managed_by_vortex"}
ASSETS = {"model.safetensors": "sha256", "inference.yaml": "configSha256",
          "tokenizer.json": "tokenizerSha256", "receipt.json": "receiptSha256"}
MAX_TEXT = 12_000
MAX_AUDIO_SECONDS = 120
MAX_CACHED_PROFILES = 8
MAX_PROFILES = 1024
MAX_COMMAND_BYTES = 65_536
MAX_REFERENCE_BYTES = 24_000_000
# A player's own clip for a character (docs/CHARACTER_EDITOR.md) lives in the player's data folder, never beside the shipped references:
# its descriptor names this second, fixed namespace, and it resolves only inside runtime.playerVoiceDirectory (never a general path).
REFERENCE_PREFIX = "runtime/voice-references/"
PLAYER_PREFIX = "runtime/player-voices/"
PLAYER_REFERENCE = re.compile(r"runtime/player-voices/[a-z0-9][a-z0-9-]{0,79}\.wav")


def digest_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def digest_source(root):
    root = Path(root)
    paths = sorted((path for path in root.rglob("*") if path.is_file()
                    and not set(path.relative_to(root).parts) & SOURCE_IGNORES),
                   key=lambda path: path.relative_to(root).as_posix())
    digest = hashlib.sha256()
    for path in paths:
        if path.is_symlink():
            raise ValueError("Pocket source must contain ordinary local files")
        digest.update(path.relative_to(root).as_posix().encode("utf-8") + b"\0")
        digest.update(bytes.fromhex(digest_file(path)) + b"\n")
    return digest.hexdigest()


def read_json(path, maximum=1_000_000):
    path = Path(path)
    if not path.is_file() or path.stat().st_size > maximum:
        raise ValueError("Pocket configuration/receipt is missing or oversized")
    return json.loads(path.read_text(encoding="utf-8-sig"))


def sha(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def plain_absolute(value, label):
    if (not isinstance(value, str) or not value or value != value.strip()
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise ValueError(f"Pocket {label} must be an absolute local path")
    path = Path(value)
    if not path.is_absolute():
        raise ValueError(f"Pocket {label} must be an absolute local path")
    # Check ancestors too: a symlink/junction must not mix one export with
    # another owner's references or move writes into an immutable asset tree.
    for candidate in (path, *path.parents):
        if candidate.is_symlink() or (hasattr(candidate, "is_junction") and candidate.is_junction()):
            raise ValueError(f"Pocket {label} must not use linked directories")
    return path.resolve()


def local_asset(root, name):
    root = Path(root).resolve()
    path = root / name
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root):
        raise ValueError("Pocket export asset is missing or linked")
    return path


def text_valid(value):
    return (isinstance(value, str) and 0 < len(value.strip()) <= MAX_TEXT
            and not re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value))


def profile_key_valid(value):
    return (isinstance(value, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", value)
            and value not in {"constructor", "prototype", "__proto__"})


def player_reference(reference):
    return isinstance(reference, str) and reference.startswith(PLAYER_PREFIX)


def descriptor_valid(descriptor):
    reference = descriptor.get("reference") if isinstance(descriptor, dict) else None
    return (isinstance(reference, str) and len(reference) <= 512
            and (reference.startswith(REFERENCE_PREFIX) or PLAYER_REFERENCE.fullmatch(reference) is not None)
            and reference.endswith(".wav")
            and not re.search(r"[\\\x00-\x1f\x7f:]", reference)
            and not any(part in ("", ".", "..") for part in reference.split("/"))
            and sha(descriptor.get("sha256")) and text_valid(descriptor.get("transcript")))


def inspect_reference(path):
    """Read WAV structure without resampling/normalizing the source recording."""
    path = Path(path)
    if path.stat().st_size > MAX_REFERENCE_BYTES:
        raise ValueError("Pocket reference is oversized")
    with path.open("rb") as stream:
        header = stream.read(12)
        if len(header) != 12 or header[:4] != b"RIFF" or header[8:] != b"WAVE":
            raise ValueError("Pocket reference must be a RIFF WAV")
        remaining = struct.unpack_from("<I", header, 4)[0] - 4
        if remaining < 0 or remaining + 12 != path.stat().st_size:
            raise ValueError("Pocket reference has an invalid RIFF size")
        fmt = None
        data_size = None
        while remaining:
            chunk = stream.read(8)
            if len(chunk) != 8:
                raise ValueError("Pocket reference has a truncated chunk")
            name, size = chunk[:4], struct.unpack_from("<I", chunk, 4)[0]
            length = size + (size % 2)
            if length + 8 > remaining:
                raise ValueError("Pocket reference chunk exceeds its file")
            if name == b"fmt ":
                if fmt is not None or size < 16 or size > 4096:
                    raise ValueError("Pocket reference has an invalid format")
                raw = stream.read(length)
                fmt = struct.unpack_from("<HHIIHH", raw)
            else:
                if name == b"data":
                    if data_size is not None:
                        raise ValueError("Pocket reference has duplicate audio")
                    data_size = size
                stream.seek(length, 1)
            remaining -= 8 + length
    if fmt is None or data_size is None:
        raise ValueError("Pocket reference lacks PCM audio")
    codec, channels, rate, byte_rate, align, bits = fmt
    if (codec not in (1, 3) or channels not in (1, 2) or not 8000 <= rate <= 96000
            or bits not in (16, 24, 32) or (codec == 3 and bits != 32)
            or align != channels * bits // 8 or byte_rate != rate * align
            or data_size <= 0 or data_size % align):
        raise ValueError("Pocket reference has an unsupported PCM format")
    duration = data_size / (rate * align)
    if not .1 <= duration <= 30:
        raise ValueError("Pocket reference must contain 0.1 to 30 seconds")
    return {"sampleRate": rate, "channels": channels, "duration": duration}


def validate_profile(root, descriptor, player_root=None):
    """The file a descriptor names, checked. A player reference resolves ONLY inside `player_root` (a profile without one is unavailable)."""
    if not descriptor_valid(descriptor):
        raise ValueError("Invalid Pocket reference descriptor")
    reference = descriptor["reference"]
    if player_reference(reference):
        if player_root is None:
            raise ValueError("Pocket reference is unavailable")
        root, prefix = Path(player_root), PLAYER_PREFIX
    else:
        prefix = REFERENCE_PREFIX
    # The configured root replaces only the established reference (or player) directory;
    # the descriptor never chooses a general filesystem path.
    tail = PurePosixPath(reference).relative_to(prefix.rstrip("/"))
    path = Path(root).joinpath(*tail.parts)
    resolved = plain_absolute(str(path), "reference")
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise ValueError("Pocket reference is unavailable")
    if digest_file(resolved) != descriptor["sha256"]:
        raise ValueError("Pocket reference identity changed")
    inspect_reference(resolved)
    return resolved


def resolve_reference(paths, descriptor):
    """Every lookup of a reference file (configuration and the later preparation) goes through here, so both use the same roots."""
    return validate_profile(paths["referenceDirectory"], descriptor, paths.get("playerVoiceDirectory"))


def inspect_student_export(directory, expected, *, yaml_load=None):
    """Verify the selected six-layer export before importing any neural code."""
    if not isinstance(expected, dict) or any(not sha(expected.get(field)) for field in ASSETS.values()):
        raise ValueError("Pocket needs hashes for every export asset")
    if not sha(expected.get("inputIdentity")) or type(expected.get("selectedStep")) is not int or expected["selectedStep"] <= 0:
        raise ValueError("Pocket needs the selected training identity")
    assets = {name: local_asset(directory, name) for name in ASSETS}
    for name, field in ASSETS.items():
        if digest_file(assets[name]) != expected[field]:
            raise ValueError("Pocket export asset differs from its selected identity")
    receipt = read_json(assets["receipt.json"])
    if (not isinstance(receipt, dict) or receipt.get("source_revision") != SOURCE_REVISION
            or receipt.get("weights") not in ("ema", "raw") or receipt.get("sample_cfg") != 1.0
            or receipt.get("selected_step") != expected["selectedStep"]
            or receipt.get("input_identity") != expected["inputIdentity"]
            or receipt.get("model_sha256") != expected["sha256"]):
        raise ValueError("Pocket receipt does not identify the selected student export")
    config_path = assets["inference.yaml"]
    if config_path.stat().st_size > 65_536:
        raise ValueError("Pocket inference config is oversized")
    if yaml_load is None:
        from yaml import safe_load
        yaml_load = safe_load
    config = yaml_load(config_path.read_text(encoding="utf-8-sig"))
    try:
        flow, mimi = config["flow_lm"], config["mimi"]
        if (flow["transformer"]["num_layers"] != 6 or flow["dtype"] != "float32"
                or mimi["dtype"] != "float32" or mimi["sample_rate"] != 24000 or mimi["channels"] != 1):
            raise ValueError("Pocket runtime accepts only the CPU six-layer student")
    except (KeyError, TypeError) as error:
        raise ValueError("Pocket inference config is incomplete") from error
    # The upstream loader resolves YAML paths from CWD. Make a private copy;
    # never mutate downloaded configs/receipts or load another remote asset.
    config = copy.deepcopy(config)
    config["weights_path"] = str(assets["model.safetensors"])
    config["weights_path_without_voice_cloning"] = None
    config["flow_lm"]["weights_path"] = None
    config["mimi"]["weights_path"] = None
    config["flow_lm"]["lookup_table"]["tokenizer_path"] = str(assets["tokenizer.json"])
    return config


def checked_player_directory(value, paths):
    """The player's own clips (optional): a folder of the player's data. It may be missing (those profiles are then unavailable), but it
    must not overlap the work folder (which the worker writes) nor any shipped asset, so a clip never resolves through either."""
    player = plain_absolute(value, "playerVoiceDirectory")
    if any(player.is_relative_to(other) or other.is_relative_to(player)
           for other in (paths["workDirectory"], paths["sourceDirectory"], paths["exportDirectory"], paths["referenceDirectory"])):
        raise ValueError("Pocket player voices must be separate from the work folder and the shipped assets")
    return player


def validate_config(raw, *, yaml_load=None, source_hasher=digest_source):
    if (not isinstance(raw, dict) or type(raw.get("version")) is not int or raw.get("version") != 1
            or raw.get("engine") != "pocket-tts" or raw.get("provider") != "pocket"):
        raise ValueError("Expected a Pocket student runtime configuration")
    runtime = raw.get("runtime", {})
    paths = {key: plain_absolute(runtime.get(key), key) for key in
             ("sourceDirectory", "exportDirectory", "referenceDirectory", "workDirectory")}
    if (not paths["sourceDirectory"].is_dir() or not paths["exportDirectory"].is_dir()
            or not paths["referenceDirectory"].is_dir()):
        raise ValueError("Pocket runtime assets are missing")
    work = paths["workDirectory"]
    if any(work.is_relative_to(paths[key]) or paths[key].is_relative_to(work)
           for key in ("sourceDirectory", "exportDirectory", "referenceDirectory")):
        raise ValueError("Pocket work and immutable assets must remain separate")
    # The player's own clips (optional): a folder of the player's data. It may be missing (those profiles are then unavailable), but it
    # must not overlap the work folder (which the worker writes) nor any shipped asset, so a clip never resolves through either.
    if runtime.get("playerVoiceDirectory") is not None:
        paths["playerVoiceDirectory"] = checked_player_directory(runtime.get("playerVoiceDirectory"), paths)
    if source_hasher(paths["sourceDirectory"]) != SOURCE_SHA256:
        raise ValueError("Pocket source differs from the pinned official revision")
    cpu = raw.get("cpu", {})
    threads = cpu.get("threads", 2)
    if type(threads) is not int or not 1 <= threads <= 4:
        raise ValueError("Pocket CPU threads must be between one and four")
    sampling = raw.get("sampling", {})
    temperature = sampling.get("temperature", .3)
    if (type(temperature) not in (int, float) or not math.isfinite(temperature)
            or not .1 <= temperature <= 1 or type(sampling.get("decodeSteps", 1)) is not int
            or sampling.get("decodeSteps", 1) != 1):
        raise ValueError("Pocket student requires one sampler step and a valid temperature")
    inference = inspect_student_export(paths["exportDirectory"], raw.get("model"), yaml_load=yaml_load)
    voices = raw.get("voices", {})
    if not isinstance(voices, dict) or len(voices) > MAX_PROFILES:
        raise ValueError("Invalid Pocket voice registry")
    refs, unavailable, descriptors = {}, {}, {}
    for key, descriptor in voices.items():
        if not profile_key_valid(key) or not isinstance(descriptor, dict):
            raise ValueError("Invalid Pocket voice profile")
        status = descriptor.get("status", "ready")
        if status not in ("ready", "unprepared", "unavailable"):
            raise ValueError("Invalid Pocket voice profile status")
        if status != "ready":
            unavailable[key] = status
            continue
        # Malformed descriptors fail configuration. A disappeared or changed
        # actual recording instead withdraws that exact profile from routing.
        if not descriptor_valid(descriptor):
            raise ValueError("Invalid Pocket reference descriptor")
        descriptors[key] = dict(descriptor)
        try:
            refs[key] = resolve_reference(paths, descriptor)
        except ValueError:
            unavailable[key] = "unavailable"
    preparation = raw.get("preparation", {})
    startup = preparation.get("startupProfiles", [])
    limit = preparation.get("maxCachedProfiles", MAX_CACHED_PROFILES)
    if (not isinstance(startup, list) or len(startup) > 3 or len(set(startup)) != len(startup)
            or any(key not in descriptors for key in startup) or type(limit) is not int
            or not 1 <= limit <= MAX_CACHED_PROFILES or len(startup) > limit):
        raise ValueError("Invalid Pocket reference cache policy")
    return {"raw": raw, "paths": paths, "inference": inference, "refs": refs,
            "descriptors": descriptors, "unavailable": unavailable, "threads": threads,
            "temperature": temperature, "startup": [key for key in startup if key in refs],
            "cacheLimit": limit}


MAX_VOICE_CHANGES = 24


def apply_voices(registry, change, cache=None):
    """Changes some voices of a running worker without reloading anything (a player gave a character a clip, or took it away).

    `change` is {"set": {key: descriptor}, "remove": [key, ...], "playerVoiceDirectory": absolute folder or None}. Everything is checked
    before anything changes, so a refused change leaves the registry exactly as it was. A descriptor is checked like the configuration's
    (shape, then the file and its hash through the one resolver); a file that is gone or changed withdraws only that voice. Each changed
    voice leaves the prepared-state cache (and the saved setup of a clip that is replaced or removed); no other voice is touched.
    Returns the changed keys."""
    if not isinstance(change, dict):
        raise ValueError("Invalid Pocket voice change")
    voices, removed = change.get("set", {}), change.get("remove", [])
    if (not isinstance(voices, dict) or not isinstance(removed, list) or len(voices) + len(removed) > MAX_VOICE_CHANGES
            or len(set(registry["descriptors"]) | set(registry["unavailable"]) | set(voices)) > MAX_PROFILES
            or any(not profile_key_valid(key) for key in (*voices, *removed)) or set(voices) & set(removed)):
        raise ValueError("Invalid Pocket voice change")
    paths = registry["paths"]
    folder = change.get("playerVoiceDirectory")
    if folder is not None:
        wanted = checked_player_directory(folder, paths)
        if paths.get("playerVoiceDirectory") not in (None, wanted):
            raise ValueError("Pocket player voice folder cannot change while running")
    else:
        wanted = paths.get("playerVoiceDirectory")
    checked = {}
    for key, descriptor in voices.items():
        if not isinstance(descriptor, dict):
            raise ValueError("Invalid Pocket voice profile")
        status = descriptor.get("status", "ready")
        if status not in ("ready", "unprepared", "unavailable"):
            raise ValueError("Invalid Pocket voice profile status")
        if status != "ready":
            checked[key] = (None, None, status)
            continue
        if not descriptor_valid(descriptor):
            raise ValueError("Invalid Pocket reference descriptor")
        try:
            path = resolve_reference({**paths, **({"playerVoiceDirectory": wanted} if wanted is not None else {})}, descriptor)
        except ValueError:
            path = None
        checked[key] = (dict(descriptor), path, "ready" if path is not None else "unavailable")
    if wanted is not None:
        paths["playerVoiceDirectory"] = wanted
    changed = []
    for key in removed:
        old = registry["descriptors"].pop(key, None)
        known = key in registry["refs"] or key in registry["unavailable"] or old is not None
        registry["refs"].pop(key, None)
        registry["unavailable"].pop(key, None)
        if cache is not None:
            cache.forget(key, old["sha256"] if old and player_reference(old.get("reference")) else None)
        if known:
            changed.append(key)
    for key, (descriptor, path, status) in checked.items():
        old = registry["descriptors"].get(key)
        registry["refs"].pop(key, None)
        registry["unavailable"].pop(key, None)
        registry["descriptors"].pop(key, None)
        if descriptor is not None:
            registry["descriptors"][key] = descriptor
            if path is not None:
                registry["refs"][key] = path
        if status != "ready":
            registry["unavailable"][key] = status
        if cache is not None:
            cache.forget(key, old["sha256"] if old and player_reference(old.get("reference"))
                         and (descriptor is None or old["sha256"] != descriptor["sha256"]) else None)
        changed.append(key)
    registry["startup"] = [key for key in registry["startup"] if key in registry["refs"]]
    return changed


PREPARED_FORMAT = "pocket-prepared-voice-v1"
MAX_PREPARED_FILES = 160


class PreparedVoiceStore:
    """Saved voice setups: one file per voice, keyed by voice + reference + model.

    The prepared state of a voice is a pure function of its reference audio, the student export and the pinned
    Pocket source, so a saved copy is exactly what encoding the reference again would produce, minus 0.5 to 1.4 s
    of Mimi encoding and prompting. Saving and loading are injected (the worker uses safetensors); this module
    stays free of Torch. A file that is missing, damaged or written for another identity is simply a miss.
    """
    def __init__(self, directory, model_sha256, source_sha256, save_state, load_state,
                 max_files=MAX_PREPARED_FILES):
        self.directory = Path(directory)
        self.model_sha256, self.source_sha256 = model_sha256, source_sha256
        self.save_state, self.load_state, self.max_files = save_state, load_state, max_files

    def identity(self, key, reference_sha256):
        text = json.dumps({"format": PREPARED_FORMAT, "voice": key, "reference": reference_sha256,
                           "model": self.model_sha256, "source": self.source_sha256}, sort_keys=True)
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def path(self, key, reference_sha256):
        return self.directory / f"{key}-{self.identity(key, reference_sha256)[:24]}.safetensors"

    def load(self, key, reference_sha256):
        path = self.path(key, reference_sha256)
        if not path.is_file() or path.is_symlink():
            return None
        try:
            state = self.load_state(path, self.identity(key, reference_sha256))
        except Exception:
            state = None
        if state is None:
            try:
                path.unlink()
            except OSError:
                pass
            return None
        try:
            os.utime(path, None)
        except OSError:
            pass
        return state

    def save(self, key, reference_sha256, state):
        """Atomic write; never raises (a full disk must not break a reply)."""
        path = self.path(key, reference_sha256)
        temporary = path.with_name(path.name + ".tmp")
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            self.save_state(temporary, state, self.identity(key, reference_sha256))
            os.replace(temporary, path)
        except Exception:
            try:
                temporary.unlink()
            except OSError:
                pass
            return False
        self.prune(keep=path)
        return True

    def prune(self, keep):
        """Drop this voice's files for older references/models, then the oldest beyond the file limit."""
        try:
            files = [file for file in self.directory.glob("*.safetensors") if file.is_file()]
            prefix = keep.name.rsplit("-", 1)[0] + "-"
            for file in files:
                if file != keep and file.name.startswith(prefix) and file.name[len(prefix):-12].isalnum():
                    file.unlink()
            files = sorted((file for file in self.directory.glob("*.safetensors") if file.is_file()),
                           key=lambda file: file.stat().st_mtime)
            for file in files[:max(0, len(files) - self.max_files)]:
                file.unlink()
        except OSError:
            pass

    def forget(self, key, reference_sha256):
        """Removes the saved setup of one voice for one reference (a player's clip that was replaced or removed)."""
        for path in (self.path(key, reference_sha256), self.path(key, reference_sha256).with_suffix(".safetensors.tmp")):
            try:
                path.unlink()
            except OSError:
                pass

    def clear(self):
        removed = 0
        for file in self.directory.glob("*.safetensors*") if self.directory.is_dir() else ():
            try:
                file.unlink()
                removed += 1
            except OSError:
                pass
        return removed


class ReferenceCache:
    """One shared model with a bounded LRU of exact acoustic prompt states.

    With a PreparedVoiceStore and keep=True, a voice that is not in memory is loaded from its saved setup before
    the reference is encoded again, and a freshly encoded one is saved. `last_source` says which happened.
    """
    def __init__(self, registry, encode, now=time.perf_counter, store=None):
        self.registry, self.encode, self.now, self.store = registry, encode, now, store
        self.states = OrderedDict()
        self.last_source = "memory"

    def prepared(self):
        return list(self.states)

    def forget(self, key, reference_sha256=None):
        """This voice's prepared state leaves memory (and, for a clip the player replaced, its saved setup leaves the disk): the next
        reply prepares it again from whatever the registry now names. Other voices are not touched."""
        self.states.pop(key, None)
        if reference_sha256 and self.store is not None:
            self.store.forget(key, reference_sha256)

    def prepare(self, key, keep=False):
        if key not in self.registry["refs"]:
            raise ValueError("This character has no available Pocket voice")
        try:
            path = resolve_reference(self.registry["paths"], self.registry["descriptors"][key])
        except ValueError:
            self.states.pop(key, None)
            self.registry["refs"].pop(key, None)
            self.registry["unavailable"][key] = "unavailable"
            raise
        if key in self.states:
            self.states.move_to_end(key)
            self.last_source = "memory"
            return self.states[key], 0.0
        started = self.now()
        saving = keep and self.store is not None
        reference_sha256 = self.registry["descriptors"][key]["sha256"]
        state = self.store.load(key, reference_sha256) if saving else None
        self.last_source = "disk"
        if state is None:
            self.last_source = "computed"
            state = self.encode(path)
            if saving:
                self.store.save(key, reference_sha256, state)
        self.states[key] = state
        while len(self.states) > self.registry["cacheLimit"]:
            self.states.popitem(last=False)
        return state, (self.now() - started) * 1000


def cpu_environment(threads):
    environment = dict(os.environ)
    environment.update(CUDA_VISIBLE_DEVICES="-1", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                       HF_HUB_DISABLE_TELEMETRY="1", PYTHONDONTWRITEBYTECODE="1",
                       TOKENIZERS_PARALLELISM="false", OMP_NUM_THREADS=str(threads),
                       MKL_NUM_THREADS=str(threads), OPENBLAS_NUM_THREADS=str(threads))
    for key in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "KAGGLE_API_TOKEN"):
        environment.pop(key, None)
    return environment
