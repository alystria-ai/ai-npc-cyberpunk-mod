"""One owned CPU student; incremental PCM, serial turns and cancellable prompts.

Start only through PocketVoice with a fully hashed, operator-selected export.
This entry point never finds a development model or downloads missing assets.
"""
from __future__ import annotations

import argparse
import base64
from collections import OrderedDict
from contextlib import redirect_stdout
import gc
import json
import os
from pathlib import Path
import queue
import re
import sys
import tempfile
import threading
import time

from pocket_voice_runtime import (
    MAX_AUDIO_SECONDS, MAX_COMMAND_BYTES, PREPARED_FORMAT, PROTOCOL_VERSION, SOURCE_REVISION,
    SOURCE_SHA256, PreparedVoiceStore, ReferenceCache, add_language_voices, apply_voices, cpu_environment, inspect_language_export,
    language_valid, new_language_registry, read_json, spelled_inside, text_valid, usvfs_active, validate_config,
)


def safetensors_state_io():
    """Save/load a voice's prepared state with its identity in the file header (no pickle)."""
    from safetensors import safe_open
    from safetensors.torch import save_file

    def save_state(path, state, identity):
        flat = {f"{module}/{name}": tensor.detach().contiguous().cpu()
                for module, values in state.items() for name, tensor in values.items()}
        save_file(flat, str(path), metadata={"format": PREPARED_FORMAT, "identity": identity})

    def load_state(path, identity):
        state = {}
        with safe_open(str(path), framework="pt", device="cpu") as handle:
            header = handle.metadata() or {}
            if header.get("format") != PREPARED_FORMAT or header.get("identity") != identity:
                return None
            for key in handle.keys():
                module, name = key.rsplit("/", 1)
                state.setdefault(module, {})[name] = handle.get_tensor(key)
        return state or None

    return save_state, load_state


class Cancelled(RuntimeError):
    pass


def skip_decoding_when_stopped(mimi, stop):
    """A cancelled reply must stop quickly, and the pinned upstream decoder does not: it decodes every latent frame that is queued before it
    says it is done, and on a busy computer that backlog is seconds of audio (the 2 s cancel deadline of the bridge killed the worker for it:
    "Pocket worker did not stop its cancelled request"). While `stop` is set the decode of a chunk is replaced by one silent sample of the
    right shape: nothing is heard (the chunk is thrown away by the cancelled request), the decoder thread's bookkeeping and its end sentinel
    work as before, and it empties its queue in milliseconds. The decoder state belongs to the request, so the next reply starts fresh."""
    original = mimi.decode_from_latent
    if getattr(original, "stops_when_cancelled", False):
        return original

    def decode(latent, *args, **kwargs):
        if stop.is_set():
            return latent.new_zeros(latent.shape[0], 1, 1)
        return original(latent, *args, **kwargs)

    decode.stops_when_cancelled = True
    mimi.decode_from_latent = decode
    return decode


# The longest the worker waits for the bridge to acknowledge one PCM packet. The bridge gives its consumer 30 s for the first packet (a
# cold renderer) and 10 s for the others, so this is longer than either.
ACK_WAIT_SECONDS = 45


class CommandPipe:
    """Bounded UTF-8 lines from a raw owned pipe.

    Controlled Windows probes stalled NumPy extension loading while a reader
    blocked in either TextIOWrapper or raw ReadFile. Poll pipe availability
    before a bounded read; early EOF/cancellation remains available throughout
    dependency loading. The precise native-lock mechanism is unconfirmed.
    """
    def __init__(self, read_bytes):
        self.read_bytes = read_bytes
        self.buffer = bytearray()
        self.eof = False

    def readline(self, maximum):
        while True:
            end = self.buffer.find(b"\n")
            if end >= 0:
                if end + 1 > maximum:
                    raise ValueError("Pocket command exceeds its byte limit")
                value = bytes(self.buffer[:end + 1])
                del self.buffer[:end + 1]
                return value.decode("utf-8", errors="strict")
            if len(self.buffer) >= maximum:
                raise ValueError("Pocket command exceeds its byte limit")
            if self.eof:
                value = bytes(self.buffer)
                self.buffer.clear()
                return value.decode("utf-8", errors="strict")
            value = self.read_bytes()
            if not isinstance(value, bytes):
                raise ValueError("Pocket command pipe returned invalid data")
            if value:
                self.buffer.extend(value)
            else:
                self.eof = True


def command_pipe(stream):
    fd = stream.fileno()
    stopped = threading.Event()
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        import msvcrt

        handle = msvcrt.get_osfhandle(fd)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.ReadFile.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                                   ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
        kernel.ReadFile.restype = wintypes.BOOL
        kernel.PeekNamedPipe.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                                        ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
                                        ctypes.POINTER(wintypes.DWORD)]
        kernel.PeekNamedPipe.restype = wintypes.BOOL

        def read_bytes():
            while not stopped.is_set():
                available = wintypes.DWORD()
                if not kernel.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):
                    error = ctypes.get_last_error()
                    if error in (38, 109, 232):
                        return b""
                    raise OSError(error, "Pocket command pipe readiness failed")
                if not available.value:
                    stopped.wait(.005)
                    continue
                buffer = ctypes.create_string_buffer(min(4096, available.value))
                count = wintypes.DWORD()
                if not kernel.ReadFile(handle, buffer, len(buffer), ctypes.byref(count), None):
                    error = ctypes.get_last_error()
                    if error in (38, 109, 232):
                        return b""
                    raise OSError(error, "Pocket command pipe read failed")
                return buffer.raw[:count.value]
            return b""
    else:
        def read_bytes():
            return os.read(fd, 4096)
    pipe = CommandPipe(read_bytes)
    pipe.stop = stopped.set
    return pipe


class Commands:
    """The stdin reader can stop generation while the main thread is yielding.

    At most one ordinary command may wait. PCM acknowledgements do not enter
    that queue: they bound copied output while cancellation remains immediate.
    """
    def __init__(self, stream, owner):
        self.stream, self.owner = stream, owner
        self.queue = queue.Queue(maxsize=1)
        self.shutdown = threading.Event()
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.ack = threading.Event()
        self.active = self.pending = None
        self.expected_ack = None
        self.last_id = 0
        self.error = None
        self.cancelled = set()
        # Called from the reader thread when the active (or the queued) request is cancelled: the worker goes to normal priority at once so a
        # cancelled warm-up that was running below normal under a busy game stops in time (main sets it).
        self.on_cancel = None
        self.thread = threading.Thread(target=self.read, name="pocket-command-reader", daemon=True)

    def finish_input(self, error=None):
        with self.lock:
            self.error = self.error or error
            self.shutdown.set()
            self.stop.set()
            self.ack.set()
            if callable(getattr(self.stream, "stop", None)):
                self.stream.stop()

    def read(self):
        try:
            while not self.shutdown.is_set():
                line = self.stream.readline(MAX_COMMAND_BYTES + 1)
                if not line:
                    break
                if len(line.encode("utf-8")) > MAX_COMMAND_BYTES or not line.endswith("\n"):
                    raise ValueError("Pocket command is oversized or incomplete")
                value = json.loads(line)
                if not isinstance(value, dict) or value.get("owner") != self.owner:
                    raise ValueError("Pocket command owner changed")
                op = value.get("op")
                if op == "shutdown":
                    break
                request_id = value.get("id")
                if type(request_id) is not int or not 0 < request_id <= 2**53 - 1:
                    raise ValueError("Pocket command lacks its request identity")
                with self.lock:
                    if op == "cancel":
                        if request_id in (self.active, self.pending):
                            self.cancelled.add(request_id)
                            if request_id == self.active:
                                self.stop.set()
                                self.ack.set()
                            if callable(self.on_cancel):
                                try:
                                    self.on_cancel()
                                except Exception:  # noqa: BLE001 - a priority is an optimisation, never a failure.
                                    pass
                        elif request_id > self.last_id:
                            raise ValueError("Pocket cancellation has no owner")
                    elif op == "ack":
                        if request_id == self.active:
                            if type(value.get("index")) is not int or value["index"] != self.expected_ack:
                                raise ValueError("Pocket PCM acknowledgement is out of order")
                            self.ack.set()
                        elif request_id > self.last_id:
                            raise ValueError("Pocket acknowledgement has no owner")
                    elif op in ("prepare", "stream", "voices", "language"):
                        if request_id <= self.last_id or self.active is not None or self.pending is not None:
                            raise ValueError("Pocket accepts one serial command at a time")
                        self.pending = request_id
                        self.queue.put_nowait(value)
                    else:
                        raise ValueError("Unknown Pocket command")
        except Exception as error:
            self.finish_input(error)
        finally:
            self.finish_input()

    def begin(self, request_id):
        with self.lock:
            self.pending = None
            self.active = request_id
            self.expected_ack = None
            self.stop.clear()
            if request_id in self.cancelled or self.shutdown.is_set():
                self.stop.set()

    def finish(self, request_id):
        with self.lock:
            self.last_id = max(self.last_id, request_id)
            self.cancelled.discard(request_id)
            self.active = None
            self.expected_ack = None
            self.ack.clear()

    def check(self):
        if self.error:
            raise self.error
        if self.stop.is_set() or self.shutdown.is_set():
            raise Cancelled("Pocket request cancelled")

    def expect_ack(self, index):
        with self.lock:
            self.expected_ack = index
            self.ack.clear()
        self.check()

    def await_ack(self, seconds=None):
        """Waits for the bridge to take a packet. The bridge owns this deadline (POCKET_LIMITS.sinkFirstMs / sinkMs, and it cancels the
        request when its own limit passes); this one is only a backstop for a bridge that went quiet, longer than both so it never
        fires first, and it ends the request, not the worker: a cold hidden renderer under game load used to take the whole worker
        down ("generation stopped") and cost a 19 to 47 s reload."""
        if not self.ack.wait(ACK_WAIT_SECONDS if seconds is None else seconds):
            raise Cancelled("Pocket PCM consumer did not acknowledge output")
        self.check()
        with self.lock:
            self.expected_ack = None


def acquire_lock(work):
    """Hold an OS lock, never terminate another process by name or PID file."""
    work.mkdir(parents=True, exist_ok=True)
    path = work / "pocket-worker.lock"
    if path.is_symlink():
        raise ValueError("Pocket lock must be an ordinary file")
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        if os.name == "nt":
            import msvcrt
            if os.fstat(fd).st_size == 0:
                os.write(fd, b"\0")
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except Exception:
        os.close(fd)
        raise RuntimeError("Another Pocket worker owns this runtime") from None


def require_cpu_float32(torch, model):
    dtypes = {}
    for module in (model.flow_lm, model.mimi):
        for parameter in module.parameters():
            if parameter.device.type != "cpu" or parameter.dtype != torch.float32:
                raise RuntimeError("Pocket student parameters must stay on CPU in float32")
            key = str(parameter.dtype)
            dtypes[key] = dtypes.get(key, 0) + parameter.numel()
        if any(buffer.device.type != "cpu" for buffer in module.buffers()):
            raise RuntimeError("Pocket student buffers moved away from CPU")
    return dtypes


# The longest single PCM packet (one second at 24 kHz); the bridge accepts up to four seconds in a packet.
PACKET_FRAMES = 24000


def stream_request(model, state, text, commands, send, request_id, key, encode_pcm,
                   now=time.perf_counter):
    """Publish every copied chunk before asking the generator for its next one.

    The injectable PCM copier makes this actual command path testable without
    importing a neural framework or pretending a completed WAV was streamed.
    """
    started = now()
    total, index = 0, 0
    first_yield = first_ready = None
    # Match the public-stream samples used to accept/select the student. Letting
    # upstream guess this tail from text gives live replies different endings.
    generator = model.generate_audio_stream(state, text, frames_after_eos=1,
                                            copy_state=True, stop=commands.stop)
    try:
        for chunk in generator:
            yielded_ms = (now() - started) * 1000
            commands.check()
            payload, frames = encode_pcm(chunk)
            # The decoder turns every latent frame that is queued by the time it runs into ONE chunk. On a busy computer it falls
            # behind and one chunk can hold seconds of speech (0.2.4: "Pocket returned PCM outside its frame limit" ended V's voice
            # for the whole session). A long chunk is valid audio: it goes out as consecutive packets of at most PACKET_FRAMES, in
            # order, each acknowledged like any other. Only a chunk that is not PCM at all, or that would pass the whole reply
            # limit, is refused.
            if (not isinstance(payload, bytes) or type(frames) is not int
                    or frames < 1 or len(payload) != frames * 4
                    or total + frames > 24000 * MAX_AUDIO_SECONDS):
                raise ValueError("Pocket returned PCM outside its frame limit")
            copied_ms = (now() - started) * 1000
            first_yield = yielded_ms if first_yield is None else first_yield
            first_ready = copied_ms if first_ready is None else first_ready
            for begin in range(0, frames, PACKET_FRAMES):
                piece = min(PACKET_FRAMES, frames - begin)
                index += 1
                commands.expect_ack(index)
                send({"op": "pcm", "id": request_id, "profile": key, "index": index,
                      "offsetFrames": total, "frames": piece, "sampleRate": 24000,
                      "channels": 1, "format": "f32le",
                      "pcm": base64.b64encode(payload[begin * 4:(begin + piece) * 4]).decode("ascii"),
                      "yieldMs": yielded_ms, "copiedReadyMs": copied_ms})
                total += piece
                commands.await_ack()
    except BaseException:
        # Closing the upstream generator at a yield skips its decoder.join().
        # Set the native stop event and drain to its real EOF first. The owned
        # host deadline kills this child if upstream cleanup itself hangs; a
        # later turn never races the old decoder on the shared Mimi instance.
        commands.stop.set()
        for _ in generator:
            pass
        raise
    finally:
        generator.close()
    commands.check()
    if not total:
        raise ValueError("Pocket returned no complete speech")
    return {"frames": total, "chunks": index, "sampleRate": 24000, "channels": 1,
            "firstPcmYieldMs": first_yield, "firstPcmCopiedReadyMs": first_ready,
            "generationMs": (now() - started) * 1000}


NORMAL_PRIORITY_CLASS = 0x00000020
BELOW_NORMAL_PRIORITY_CLASS = 0x00004000


def set_priority_class(priority_class):
    """Sets this process's Windows priority class. Best effort; False when it was not set."""
    try:
        import ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel32.SetPriorityClass.restype = ctypes.c_int
        return bool(kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), priority_class))
    except Exception:  # noqa: BLE001 - priority is advisory only.
        return False


def lower_priority():
    """Once the worker is ready, while nothing is being voiced (preparing voices ahead of a reply, waiting), the game's own
    threads win any contested core: BelowNormal priority class on Windows, nice +5 elsewhere. Best effort. Starting up is
    not included: a start under a loading game starves at below normal (see main)."""
    try:
        if os.name == "nt":
            return set_priority_class(BELOW_NORMAL_PRIORITY_CLASS)
        os.nice(5)
        return True
    except Exception:  # noqa: BLE001 - priority is advisory only.
        return False


def raise_priority():
    """Normal priority class, for the time a reply is being voiced. Only Windows can go back up (a raised nice
    value needs privileges elsewhere), so nothing changes there."""
    return os.name == "nt" and set_priority_class(NORMAL_PRIORITY_CLASS)


class PriorityGate:
    """A reply being voiced is a person waiting: the whole request (preparing the voice, the text, every chunk of audio) runs at
    normal priority. A game that keeps every core busy otherwise starves a below-normal worker for seconds (Windows gives the
    foreground game longer time slices on top), which showed as 5 to 7 s before the first sound until the player switched
    windows. The worker goes back to below normal `hold` seconds after the last request, so it does not flap between the
    sentences of one reply, and never raises for a request that only prepares a voice ahead of time. Nothing here runs per
    frame: two system calls per reply."""

    def __init__(self, raise_to=raise_priority, lower_to=lower_priority, hold=3.0, clock=time.monotonic):
        self.raise_to, self.lower_to, self.hold, self.clock = raise_to, lower_to, hold, clock
        self.raised = False
        self.last = 0.0

    def request(self):
        """A reply's request starts or ends: normal priority now, and the hold starts over."""
        self.last = self.clock()
        if not self.raised and self.raise_to():
            self.raised = True

    def settle(self):
        """Called while the worker waits for a command: back to below normal once the hold has passed."""
        if self.raised and self.clock() - self.last >= self.hold:
            self.lower_to()
            self.raised = False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--owner", required=True)
    args = parser.parse_args()
    if re.fullmatch(r"[a-f0-9]{32}", args.owner) is None:
        raise ValueError("Invalid Pocket worker owner")
    # Starting up (the heavy imports, loading the student, warming voices) runs at NORMAL priority and the worker goes below normal only
    # when it is ready (below). Lowered from the first instruction it was starved by a game that was loading and every core busy: three
    # installs (0.2.7, 2026-10-21) saw `import pocket_tts` take under 3 s of CPU in 240 s (the worker got about 1% of a core) and the start
    # timed out, while the retry a minute later (the game in the world) imported in seconds. A start is a few seconds of one or two threads
    # (the thread count is capped, cpu_environment) and the game is loading, not rendering, so the same trade as the model server's load.
    raise_priority()
    gate = PriorityGate()
    output = sys.stdout
    output_lock = threading.Lock()

    def send(frame):
        with output_lock:
            output.write(json.dumps({"owner": args.owner, **frame}, ensure_ascii=False, allow_nan=False) + "\n")
            output.flush()

    # Startup progress for the bridge's stall watchdog: how much CPU this process has used (a slow import under a virus scan or a busy
    # disk still creeps forward; a hung one uses none), once every two seconds while starting, and a mark after each heavy import. It
    # stops when the worker is ready, so a worker that is serving never beats.
    started = threading.Event()

    def beat(step=None):
        frame = {"op": "heartbeat", "cpuMs": int(time.process_time() * 1000)}
        if step is not None:
            frame["step"] = step
        send(frame)

    def heartbeats():
        while not started.wait(2.0):
            try:
                beat()
            except Exception:
                return

    threading.Thread(target=heartbeats, name="pocket-start-heartbeat", daemon=True).start()
    commands = Commands(command_pipe(sys.stdin), args.owner)
    commands.on_cancel = gate.request
    commands.thread.start()
    cleaned = threading.Event()

    def watchdog():
        commands.shutdown.wait()
        if not cleaned.wait(5):
            # Windows venv python.exe may be a redirector with this interpreter
            # as its child. Self-exit is owner-bound even if the redirector is
            # terminated while a native import/load ignores ordinary EOF.
            os._exit(70)

    threading.Thread(target=watchdog, name="pocket-owned-exit", daemon=True).start()
    lock = None
    try:
        send({"op": "state", "state": "loading"})
        registry = validate_config(read_json(args.config))
        if registry.get("sourceNote"):
            print(registry["sourceNote"], file=sys.stderr, flush=True)
        send({"op": "state", "state": "loading", "phase": "assets-verified"})
        if commands.shutdown.is_set():
            return 0
        environment = cpu_environment(registry["threads"])
        os.environ.clear()
        os.environ.update(environment)
        lock = acquire_lock(registry["paths"]["workDirectory"])
        source = registry["paths"]["sourceDirectory"]
        sys.path.insert(0, str(source))
        send({"op": "state", "state": "loading", "phase": "importing-dependencies"})
        with redirect_stdout(sys.stderr):
            import numpy as np
            beat("numpy")
            import torch
            beat("torch")
            import yaml
            beat("yaml")
            import pocket_tts
            from pocket_tts import TTSModel
            beat("pocket_tts")

            # Inside Mod Organizer 2's USVFS the package is looked at where the virtual source folder shows it (pocket_voice_runtime.USVFS_VARIABLE).
            if not (spelled_inside(pocket_tts.__file__, source) if usvfs_active()
                    else Path(pocket_tts.__file__).resolve().is_relative_to(source)):
                raise RuntimeError("Pocket import did not resolve to the pinned local source")
            torch.set_num_threads(registry["threads"])
            torch.set_num_interop_threads(1)
            send({"op": "state", "state": "loading", "phase": "loading-student"})
            # Temporary relocated YAML belongs only to this worker. Downloaded
            # inference files and receipts remain byte-for-byte unchanged.
            with tempfile.TemporaryDirectory(prefix=f"pocket-{args.owner}-",
                                             dir=registry["paths"]["workDirectory"]) as temporary:
                relocated = Path(temporary) / "inference.yaml"
                relocated.write_text(yaml.safe_dump(registry["inference"], sort_keys=False), encoding="utf-8")
                model = TTSModel.load_model(config=relocated, temp=registry["temperature"],
                                           sampler_decode_steps=1, eos_threshold=-1.0, noise_clamp=None)
            if not model.has_voice_cloning or model.sample_rate != 24000:
                raise RuntimeError("Pocket export lacks the expected reference-conditioned audio")
            dtypes = require_cpu_float32(torch, model)
            skip_decoding_when_stopped(model.mimi, commands.stop)
        send({"op": "state", "state": "loading", "phase": "student-loaded"})

        # Saved voice setups live beside the worker's other mutable files (runtime, never the immutable assets).
        save_state, load_state = safetensors_state_io()
        store = PreparedVoiceStore(registry["paths"]["workDirectory"] / "prepared-voices",
                                   registry["raw"]["model"]["sha256"], SOURCE_SHA256, save_state, load_state)
        cache = ReferenceCache(registry, lambda path: model.get_state_for_audio_prompt(path, truncate=False),
                               store=store)
        for key in registry["startup"]:
            if commands.shutdown.is_set():
                return 0
            send({"op": "state", "state": "warming", "profile": key})
            with redirect_stdout(sys.stderr):
                cache.prepare(key)

        identity = {"protocolVersion": PROTOCOL_VERSION, "engine": "pocket-tts", "device": "cpu",
                    "dtype": "torch.float32", "runtime": "pytorch", "layers": 6, "decodeSteps": 1,
                    "sampleCfg": 1.0, "threads": registry["threads"], "gpuVramBytes": 0,
                    "parameterDtypes": dtypes, "sourceRevision": SOURCE_REVISION,
                    "sourceSha256": SOURCE_SHA256, "model": registry["raw"]["model"]}

        # Language models (docs/POCKET_LANGUAGE_MODELS.md). One model is resident at a time: the English student, or the model of one language, swapped
        # in place by the `language` command. The English registry and its prepared voices are kept while a language is active (a prepared state is
        # plain tensors of the English weights, which are loaded again from the same file), so going back costs the model load and nothing else.
        lang = {"tag": None, "registry": None, "cache": None, "sha256": None}
        # The prepared voices (plain tensors, tied to the language model's weights and the clip's hash) of the last languages left, so going back to one does not encode its
        # clips again. Bounded: a few states of the last LANGUAGE_STASH languages, and nothing else of a language survives a swap.
        stash = OrderedDict()
        LANGUAGE_STASH = 2

        def view():
            return (lang["registry"], lang["cache"]) if lang["tag"] else (registry, cache)

        def profiles():
            reg, held = view()
            return {"profiles": sorted(reg["refs"]), "preparedProfiles": held.prepared(),
                    "unavailableProfiles": dict(reg["unavailable"]), "language": lang["tag"]}

        def english_profiles():
            return {"profiles": sorted(registry["refs"]), "preparedProfiles": cache.prepared(),
                    "unavailableProfiles": dict(registry["unavailable"]), "language": lang["tag"]}

        def load_model(config):
            # The relocated YAML belongs to this load only (the same way the student was loaded at start).
            with tempfile.TemporaryDirectory(prefix=f"pocket-{args.owner}-", dir=registry["paths"]["workDirectory"]) as temporary:
                relocated_path = Path(temporary) / "inference.yaml"
                relocated_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
                loaded = TTSModel.load_model(config=relocated_path, temp=registry["temperature"],
                                             sampler_decode_steps=1, eos_threshold=-1.0, noise_clamp=None)
            if not loaded.has_voice_cloning or loaded.sample_rate != 24000:
                raise RuntimeError("Pocket export lacks the expected reference-conditioned audio")
            require_cpu_float32(torch, loaded)
            skip_decoding_when_stopped(loaded.mimi, commands.stop)
            return loaded

        def switch_language(request):
            """Makes request["language"] (None: the English student) the resident model, or adds voices to the language already resident.
            The files are verified before anything is dropped, so a refused model leaves the resident one as it was. The old model is released
            before the new one is read, so the process never holds two (a swap measured flat at about 0.9 GB; deleting a model frees little to the
            operating system, but its memory is reused by the next one)."""
            nonlocal model
            target = request.get("language")
            if target is not None and not language_valid(target):
                raise ValueError("Pocket has no model for this language")
            if target == lang["tag"]:
                if target:
                    add_language_voices(lang["registry"], request.get("voices", {}))
                return 0.0
            started_at = time.perf_counter()
            config = None
            if target:
                config = inspect_language_export(registry["paths"], target, request.get("expected"), yaml_load=yaml.safe_load)
            if lang["tag"] and lang["cache"].states:
                stash[lang["tag"]] = (lang["sha256"], {key: (lang["registry"]["descriptors"][key]["sha256"], state)
                                                       for key, state in lang["cache"].states.items() if key in lang["registry"]["descriptors"]})
                stash.move_to_end(lang["tag"])
                while len(stash) > LANGUAGE_STASH:
                    stash.popitem(last=False)
            model = None
            lang["tag"] = None
            lang["registry"] = lang["cache"] = lang["sha256"] = None
            gc.collect()
            try:
                model = load_model(config if target else registry["inference"])
            except Exception:
                if target:
                    # The student is put back: a language that would not load never leaves the worker without a voice.
                    model = None
                    gc.collect()
                    model = load_model(registry["inference"])
                raise
            if target:
                lang["tag"], lang["sha256"] = target, request["expected"]["sha256"]
                lang["registry"] = new_language_registry(registry, target, lang["sha256"])
                lang_store = PreparedVoiceStore(registry["paths"]["workDirectory"] / "prepared-voices" / f"lang-{target}", lang["sha256"],
                                                SOURCE_SHA256, save_state, load_state)
                lang["cache"] = ReferenceCache(lang["registry"], lambda path: model.get_state_for_audio_prompt(path, truncate=False), store=lang_store)
                add_language_voices(lang["registry"], request.get("voices", {}))
                kept = stash.pop(target, None)
                if kept and kept[0] == lang["sha256"]:
                    for key, (reference_sha256, state) in kept[1].items():
                        descriptor = lang["registry"]["descriptors"].get(key)
                        if key in lang["registry"]["refs"] and descriptor and descriptor["sha256"] == reference_sha256:
                            lang["cache"].states[key] = state
            return (time.perf_counter() - started_at) * 1000

        started.set()
        lower_priority()   # ready: from now on the game's own threads win any contested core, except while a reply is being voiced (PriorityGate)
        send({"op": "ready", **identity, **profiles(),
              "workerPaths": {key: str(value) for key, value in registry["paths"].items()},
              "referenceHashes": {key: registry["descriptors"][key]["sha256"] for key in registry["refs"]}})

        while not commands.shutdown.is_set():
            try:
                request = commands.queue.get(timeout=.1)
            except queue.Empty:
                gate.settle()
                continue
            request_id, key = request["id"], request.get("profile")
            if request["op"] == "language":
                # Serial like every other command, so it never lands in the middle of a reply. Urgent when a reply waits on it.
                commands.begin(request_id)
                if request.get("urgent") is True:
                    gate.request()
                try:
                    with redirect_stdout(sys.stderr):
                        load_ms = switch_language(request)
                    commands.finish(request_id)
                    reg, _held = view()
                    send({"op": "language", "id": request_id, "loadMs": load_ms, **profiles(),
                          "referenceHashes": {name: reg["descriptors"][name]["sha256"] for name in reg["refs"]}})
                except Exception as error:
                    print(f"Pocket language change refused: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
                    commands.finish(request_id)
                    if model is None:
                        raise
                    reason = f"{type(error).__name__}: {str(error).splitlines()[0] if str(error) else ''}"[:200]
                    send({"op": "error", "id": request_id, "message": "Pocket language model could not be loaded.",
                          "terminal": False, "reason": reason, **profiles()})
                finally:
                    commands.finish(request_id)
                    if request.get("urgent") is True:
                        gate.request()
                continue
            if request["op"] == "voices":
                # A change to the voices of a running worker (bridge/pocket-voice.mjs setVoices): serial like every other command, so it
                # never lands in the middle of a reply. Checked as a whole first; a refused change leaves everything as it was.
                commands.begin(request_id)
                try:
                    with redirect_stdout(sys.stderr):
                        changed = apply_voices(registry, request, cache)
                    commands.finish(request_id)
                    send({"op": "voices", "id": request_id, "changed": changed, **english_profiles(),
                          "referenceHashes": {name: registry["descriptors"][name]["sha256"] for name in registry["refs"]}})
                except Exception as error:
                    print(f"Pocket voice change refused: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
                    commands.finish(request_id)
                    send({"op": "error", "id": request_id, "message": "Pocket voices could not be changed.",
                          "terminal": False, **english_profiles()})
                finally:
                    commands.finish(request_id)
                continue
            commands.begin(request_id)
            urgent = request["op"] == "stream" or request.get("urgent") is True
            if urgent:
                gate.request()
            synthesis_started = False
            timer = threading.Timer(MAX_AUDIO_SECONDS, commands.stop.set)
            timer.daemon = True
            timer.start()
            try:
                commands.check()
                active_registry, active_cache = view()
                if not isinstance(key, str) or key not in active_registry["refs"]:
                    raise ValueError("Pocket voice is unavailable for this character")
                # "keep" is the player's "Keep prepared voices" setting; absent means off (no disk cache).
                with redirect_stdout(sys.stderr):
                    state, preparation_ms = active_cache.prepare(key, keep=request.get("keep") is True)
                commands.check()
                if request["op"] == "prepare":
                    commands.finish(request_id)
                    send({"op": "prepared", "id": request_id, "profile": key,
                          "preparationMs": preparation_ms, "preparationSource": active_cache.last_source,
                          **profiles()})
                    continue
                text = request.get("text")
                if not text_valid(text):
                    raise ValueError("Invalid Pocket reply text")
                # Pocket owns its necessary acoustic decoding. There is no
                # sentence splitter here and no gain, denoising, silence trim,
                # speed adjustment, resampling, fade or crossfade of output.
                def encode_pcm(chunk):
                    if chunk.device.type != "cpu" or chunk.dtype != torch.float32:
                        raise ValueError("Pocket PCM did not preserve CPU float32")
                    pcm = chunk.detach().numpy().reshape(-1).astype("<f4", copy=True)
                    if not np.isfinite(pcm).all():
                        raise ValueError("Pocket returned non-finite PCM")
                    return pcm.tobytes(), int(pcm.size)

                with redirect_stdout(sys.stderr), torch.no_grad():
                    synthesis_started = True
                    result = stream_request(model, state, text, commands, send, request_id, key, encode_pcm)
                commands.finish(request_id)
                send({"op": "done", "id": request_id, "profile": key,
                      "preparationMs": preparation_ms, "preparationSource": active_cache.last_source,
                      **result, **profiles()})
            except Cancelled:
                commands.finish(request_id)
                send({"op": "cancelled", "id": request_id, "profile": key, **profiles()})
            except Exception as error:
                commands.stop.set()
                print(f"Pocket request failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
                commands.finish(request_id)
                send({"op": "error", "id": request_id, "profile": key,
                      "message": "Pocket voice could not prepare this reply.",
                      "terminal": synthesis_started, **profiles()})
                if synthesis_started:
                    # The pinned upstream generator can start its decoder
                    # before text prefill throws. An exhausted generator does
                    # not prove that thread joined. Retire this owned process
                    # instead of reusing Mimi after an uncertain failure.
                    commands.finish_input()
                    return 1
            finally:
                timer.cancel()
                commands.finish(request_id)
                if urgent:
                    gate.request()
        if commands.error:
            raise commands.error
        return 0
    except Exception as error:
        print(f"Pocket worker failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        # The reason travels with the frame (class and first line, short), so the bridge's log line and an error report name it instead of
        # only the generic text; the bridge cuts it to a few words and a report removes any folder from it.
        reason = f"{type(error).__name__}: {str(error).splitlines()[0] if str(error) else ''}".rstrip(": ")[:300]
        send({"op": "fatal", "message": "Pocket student runtime is unavailable.", "reason": reason})
        return 1
    finally:
        started.set()
        commands.finish_input()
        if lock is not None:
            os.close(lock)
        cleaned.set()


if __name__ == "__main__":
    raise SystemExit(main())
