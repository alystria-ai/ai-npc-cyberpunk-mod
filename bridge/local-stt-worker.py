"""Local speech-to-text worker: Moonshine Tiny (English, MIT) through sherpa-onnx, on the CPU.

With --kind it loads one of the optional multilingual packs instead (bridge/speech-language.mjs LOCAL_PACKS): `nemo-transducer`
(NVIDIA Parakeet TDT 0.6B v3 int8: ru, uk, pl, cs, hu, de, fr, es, it, pt) or `sense-voice` (SenseVoice Small int8: zh, ja, ko). The
protocol, the sound gate and the refusal of words that are not speech are the same for every kind; docs/LOCAL_STT.md, "Other languages".

Started by bridge/local-stt.mjs only while a text provider needs the microphone. It speaks JSON lines on
stdin/stdout (one object per line) and never touches the network:

    in   {"op":"begin","id":"r1"}                         start a recording (drops any earlier one)
         {"op":"audio","id":"r1","pcm":"<base64 int16 LE, 16 kHz mono>"}
         {"op":"partial","id":"r1"}                       decode what has been heard so far (live words)
         {"op":"finish","id":"r1"}                        decode everything and end the recording
         {"op":"cancel","id":"r1"} / {"op":"quit"}
    out  {"type":"ready","engine":"moonshine-tiny-en-int8","threads":1,"loadMs":1800}
         {"type":"partial","id":"r1","text":"hey judy","ms":90}
         {"type":"final","id":"r1","text":"Hey Judy, ...","ms":210,"seconds":4.6,"speech":true,"reused":false,"cpuMs":5400}
                                                          (reused: a live-words decode already covered the whole recording;
                                                           cpuMs: the worker's total CPU time so far, for the benchmark)
         {"type":"error","id":"r1","message":"..."}

CPU politeness: one thread by default (at most 4: onnxruntime's thread pools spin-wait, so each extra thread costs
far more CPU than it saves time), below-normal process priority, and the model only runs
for a partial (at most one at a time, only on the newest 8 s) and for the final decode.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import queue
import sys
import threading
import time

SAMPLE_RATE = 16000
ENGINE = "moonshine-tiny-en-int8"
MODEL_FILES = ("preprocess.onnx", "encode.int8.onnx", "uncached_decode.int8.onnx", "cached_decode.int8.onnx", "tokens.txt")
PACK_FILES = {
    "nemo-transducer": ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"),
    "sense-voice": ("model.int8.onnx", "tokens.txt"),
}
KINDS = ("moonshine",) + tuple(PACK_FILES)
MAX_SECONDS = 60          # a recording is cut here (the game finishes one at 30 s)
PARTIAL_WINDOW = 8.0      # seconds decoded for a partial, newest audio only
SEGMENT_TARGET = 18.0     # a longer final decode is split at the quietest point near here
SEGMENT_LIMIT = 24.0
FRAME = 480               # 30 ms
GATE_DB = -52.0           # a recording whose loudest 30 ms frames never reach this holds no speech
SPEECH_FRAMES = 5         # 150 ms above the gate
PRE_ROLL_FRAMES = 8       # 240 ms of quiet stay around each piece of sound that is decoded
MERGE_FRAMES = 24         # sounds less than 720 ms apart are decoded together
QUIET_PEAK_DB = -50.0     # no sound reached this: a dead or wrong input (or a muted one), not a person speaking
MIN_SOUND_MS = 150        # fewer 30 ms frames of sound than this (5) are a click or a breath
MIN_VOICED_MS = 60        # and at least 2 of them must carry a voice pitch
VOICED_LAG_MIN, VOICED_LAG_MAX = 40, 230   # 400 Hz down to 70 Hz at 16 kHz
VOICED_LEVEL = 0.4
LONG_SOUND_MS = 3000      # a piece of sound this long is speech only if a good share of it is voiced
MIN_VOICED_SHARE = 0.35   # speech measured 0.51 and up (clean, -30 dB, loud room, 150-level noise); a hands-free headset's hiss and a fan far less
MAX_WORDS_PER_SECOND = 7.5
# What a speech model says on sound that holds no speech, whatever the model (heard from Whisper, Moonshine and the like).
HALLUCINATIONS = frozenset(["you", "thank you", "thanks for watching", "thank you for watching", "thank you very much", "bye",
                            "bye bye", "so", "the", "i", "uh", "um", "hmm", "mm", "mhm", "oh", "ah", "huh"])
FILLER = frozenset(["the", "a", "an", "and", "to", "of", "i", "you", "it", "is", "in", "that", "this", "we", "my", "me", "so", "but", "or", "on"])
MAX_GROUPS = 12         # more pieces than this are joined (a noisy room), so a final stays a few decodes


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def use_utf8() -> None:
    """The protocol is UTF-8 JSON. The process runs with -I, which ignores PYTHONUTF8 / PYTHONIOENCODING, so on Windows the standard streams
    would be the console code page and a transcript in Russian, Japanese or Korean would crash `send` (found with the real multilingual
    models, 2026-10-19). Reconfigure them here, before anything is read or written."""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass


def send(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# "high" is HIGH_PRIORITY_CLASS (never REALTIME): the bridge asks for it unless the player chose otherwise (docs/PROCESS_PRIORITY.md).
PRIORITY_CLASSES = {"normal": 0x00000020, "below": 0x00004000, "idle": 0x00000040, "high": 0x00000080}


def lower_priority(level: str = "below") -> None:
    """The worker's own priority: below normal on Windows (best effort) so a decode never competes with the game's threads, or high when the bridge asks for it
    (the speech of V is on the path to the reply). "normal" changes nothing."""
    try:
        if level == "normal":
            return
        if level == "high" and os.name != "nt":
            return
        if os.name == "nt":
            import ctypes
            kernel32 = ctypes.windll.kernel32
            kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), PRIORITY_CLASSES[level])
        else:
            os.nice(5)
    except Exception as error:  # noqa: BLE001
        log(f"priority not lowered: {error}")


class PriorityGate:
    """The recording being decoded is a player waiting: from `begin` until `hold` seconds after the last message the worker runs at
    normal priority (Windows only: a raised nice value needs privileges elsewhere), and goes back to `base` while it waits for
    the next recording. A game that keeps every core busy starves a below-normal decode for seconds, which is the wait after the
    key is let go. Two system calls per recording, nothing per frame. With --priority normal or high it never changes anything
    (high is the bridge's default: the worker is high from its start and for good, an idle one costs nothing)."""

    def __init__(self, base="below", hold=3.0, clock=time.monotonic, apply=None):
        self.base, self.hold, self.clock = base, hold, clock
        self.apply = apply or (lambda level: set_priority(level))
        self.raised = False
        self.last = 0.0

    def active(self):
        self.last = self.clock()
        if self.base not in ("normal", "high") and not self.raised and self.apply("normal"):
            self.raised = True

    def settle(self):
        if self.raised and self.clock() - self.last >= self.hold:
            self.apply(self.base)
            self.raised = False

    def timeout(self):
        """How long the worker may wait for a message before settle() is due (None: forever)."""
        return max(0.05, self.hold - (self.clock() - self.last)) if self.raised else None


def set_priority(level: str) -> bool:
    """Sets this process's Windows priority class to a PRIORITY_CLASSES level. Best effort; False off Windows or when refused."""
    try:
        if os.name != "nt":
            return False
        import ctypes
        kernel32 = ctypes.windll.kernel32
        return bool(kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), PRIORITY_CLASSES[level]))
    except Exception:  # noqa: BLE001
        return False


def frame_levels(samples):
    """dBFS of every 30 ms frame."""
    import numpy as np
    count = len(samples) // FRAME
    if count == 0:
        return np.zeros(0, dtype=np.float32)
    frames = samples[: count * FRAME].reshape(count, FRAME).astype(np.float32) / 32768.0
    rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
    return 20.0 * np.log10(rms)


def speech_gate(levels) -> float:
    import numpy as np
    return max(GATE_DB, float(np.percentile(levels, 10)) + 9.0)


def has_speech(samples) -> bool:
    import numpy as np
    levels = frame_levels(samples)
    if levels.size < SPEECH_FRAMES:
        return False
    return int(np.count_nonzero(levels > speech_gate(levels))) >= SPEECH_FRAMES


def evidence(samples) -> dict:
    """What the audio itself says about whether a person spoke: how loud the loudest sound was, how long the sound lasted,
    and how much of it was voiced (a pitch between 70 and 400 Hz repeating inside the 30 ms frame: vowels have one, a breath,
    a click, a fan and a key press do not). The words are judged against this (judge()), so a decode of noise is never shown."""
    import numpy as np
    levels = frame_levels(samples)
    result = {"peakDb": -120.0, "soundMs": 0, "spanMs": 0, "voicedMs": 0}
    if levels.size == 0:
        return result
    above = levels > speech_gate(levels)
    result["peakDb"] = round(float(levels.max()), 1)
    if not above.any():
        return result
    indexes = np.nonzero(above)[0]
    result["soundMs"] = int(indexes.size * FRAME * 1000 // SAMPLE_RATE)
    result["spanMs"] = int((indexes[-1] - indexes[0] + 1) * FRAME * 1000 // SAMPLE_RATE)
    result["peakDb"] = round(float(levels[above].max()), 1)
    frames = samples[: levels.size * FRAME].reshape(levels.size, FRAME)[above].astype(np.float32)
    frames -= frames.mean(axis=1, keepdims=True)
    spectrum = np.fft.rfft(frames, n=1024, axis=1)
    autocorrelation = np.fft.irfft(spectrum * np.conj(spectrum), n=1024, axis=1)
    energy = autocorrelation[:, 0] + 1e-9
    best = (autocorrelation[:, VOICED_LAG_MIN:VOICED_LAG_MAX] / energy[:, None]).max(axis=1)
    result["voicedMs"] = int(np.count_nonzero(best >= VOICED_LEVEL) * FRAME * 1000 // SAMPLE_RATE)
    return result


def acoustic(proof: dict):
    """None when the sound could be a person speaking, else why it could not."""
    if proof["peakDb"] < QUIET_PEAK_DB:
        return "quiet"
    if proof["soundMs"] < MIN_SOUND_MS:
        return "short"
    if proof["voicedMs"] < MIN_VOICED_MS:
        return "not-voiced"
    if proof["soundMs"] >= LONG_SOUND_MS and proof["voicedMs"] < proof["soundMs"] * MIN_VOICED_SHARE:
        return "not-voiced"
    return None


def looping(words) -> bool:
    """A decoder stuck in a loop: one word three times in a row among others, a 2-3 word chunk three times in a row, or one word
    making up much of a longer text ("tooth tooth on tooth tooth"). A person saying "no no no" or "very very good" is not caught."""
    count = len(words)
    for size in (1, 2, 3):
        for start in range(0, count - size * 3 + 1):
            chunk = words[start: start + size]
            if not all(words[start + size * i: start + size * (i + 1)] == chunk for i in range(3)):
                continue
            if size > 1 or count >= 5:
                return True
    if count >= 6:
        best = max((words.count(word) for word in set(words) - FILLER), default=0)
        if best >= 4 and best * 3 >= count:
            return True
    return False


def judge(text: str, proof: dict):
    """None when the words may stand, else why they may not. Moonshine can put words on a breath, a key press, a fan or a dead input;
    those never reach the screen, the voice or the model."""
    words = [word for word in "".join(c.lower() if c.isalnum() or c == "'" else " " for c in text).split() if word]
    if not words:
        return None
    why = acoustic(proof)
    if why:
        return why
    if proof["spanMs"] and len(words) * 1000 / proof["spanMs"] > MAX_WORDS_PER_SECOND and len(words) > 3:
        return "too-many-words"
    if looping(words):
        return "repeating"
    if " ".join(words) in HALLUCINATIONS and (proof["voicedMs"] < 240 or proof["peakDb"] < -36.0):
        return "stock-phrase"
    return None


def tail_is_quiet(samples, start: int) -> bool:
    """True when the audio after `start` holds no speech (judged against the whole recording's noise floor)."""
    import numpy as np
    levels = frame_levels(samples)
    if levels.size < SPEECH_FRAMES:
        return False
    first = start // FRAME
    return int(np.count_nonzero(levels[first:] > speech_gate(levels))) < 3


def split_points(samples):
    """Cut a long recording into pieces of at most SEGMENT_LIMIT seconds at the quietest 90 ms near SEGMENT_TARGET."""
    import numpy as np
    limit, target = int(SEGMENT_LIMIT * SAMPLE_RATE), int(SEGMENT_TARGET * SAMPLE_RATE)
    pieces, start = [], 0
    while len(samples) - start > limit:
        lo, hi = start + target - 4 * SAMPLE_RATE, start + target + 4 * SAMPLE_RATE
        window = samples[lo:hi].astype(np.float32) / 32768.0
        width = int(0.09 * SAMPLE_RATE)
        energy = np.convolve(window * window, np.ones(width, dtype=np.float32), mode="valid")
        cut = lo + int(np.argmin(energy)) + width // 2
        pieces.append(samples[start:cut])
        start = cut
    pieces.append(samples[start:])
    return pieces


def speech_groups(samples, merge_frames=MERGE_FRAMES):
    """The sound in a recording as separate pieces, each with PRE_ROLL_FRAMES of quiet around it: [] when there is none.

    Moonshine returns NO text, or only a fragment, for speech that sits among a second or more of quiet, and a key click or breath
    right before the words upsets it too (measured: 29 of 36 synthetic clips empty at 1.5 s of leading quiet; click, 8 s of quiet,
    then the words: the live decode of the newest 8 s read them, the decode of the whole recording came back empty). A player
    presses the key (a click in the microphone), thinks, and speaks. So every run of 3 frames above the gate is sound, sounds less
    than `merge_frames` apart belong together, and each group is decoded on its own, never with the long quiet between groups.
    """
    import numpy as np
    levels = frame_levels(samples)
    count = levels.size
    if count < SPEECH_FRAMES:
        return []
    above = levels > speech_gate(levels)
    runs, run = [], 0
    for index in range(count + 1):
        if index < count and above[index]:
            run += 1
            continue
        if run >= 3:
            runs.append((index - run, index))
        run = 0
    while True:
        groups = []
        for first, last in runs:
            if groups and first - groups[-1][1] <= merge_frames:
                groups[-1][1] = last
            else:
                groups.append([first, last])
        if len(groups) <= MAX_GROUPS:
            break
        merge_frames *= 2
    pieces = []
    for first, last in groups:
        end = min(count, last + PRE_ROLL_FRAMES)
        pieces.append(samples[max(0, first - PRE_ROLL_FRAMES) * FRAME: len(samples) if end == count else end * FRAME])
    return pieces


def tidy(text: str) -> str:
    text = " ".join(text.replace("\u0000", " ").split())
    return text


class Engine:
    def __init__(self, model: str, threads: int, kind: str = "moonshine"):
        import sherpa_onnx
        self.kind = kind
        files = MODEL_FILES if kind == "moonshine" else PACK_FILES[kind]
        for name in files:
            if not os.path.isfile(os.path.join(model, name)):
                raise FileNotFoundError(f"model file missing: {name}")
        path = lambda name: os.path.join(model, name)  # noqa: E731
        if kind == "moonshine":
            self.recognizer = sherpa_onnx.OfflineRecognizer.from_moonshine(
                preprocessor=path("preprocess.onnx"),
                encoder=path("encode.int8.onnx"),
                uncached_decoder=path("uncached_decode.int8.onnx"),
                cached_decoder=path("cached_decode.int8.onnx"),
                tokens=path("tokens.txt"),
                num_threads=threads,
            )
        elif kind == "nemo-transducer":
            # Parakeet TDT: a transducer with automatic language detection over 25 European languages; the feature size is read from the model.
            self.recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
                encoder=path("encoder.int8.onnx"),
                decoder=path("decoder.int8.onnx"),
                joiner=path("joiner.int8.onnx"),
                tokens=path("tokens.txt"),
                num_threads=threads,
                decoding_method="greedy_search",
                model_type="nemo_transducer",
            )
        else:
            # SenseVoice: zh, en, ja, ko, yue. "auto" picks the language; inverse text normalisation writes numbers as digits.
            self.recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=path("model.int8.onnx"),
                tokens=path("tokens.txt"),
                num_threads=threads,
                language="auto",
                use_itn=True,
            )

    def read(self, samples):
        """(words, proof, why): the words in a recording or its newest window, each piece of sound decoded on its own (see
        speech_groups). A piece that cannot be a person speaking (a click, a breath, a dead input) is not even decoded; `why` says what
        kept the words back (judge, acoustic), and the words are then ''. `proof` is the sound that was read."""
        pieces = [part for group in (speech_groups(samples) or [samples]) for part in split_points(group)]
        kept, texts, blocked, decoded, peaks = [], [], None, 0, []
        for piece in pieces:
            proof = evidence(piece)
            peaks.append(proof["peakDb"])
            why = acoustic(proof)
            if why:
                blocked = blocked or why
                continue
            decoded += 1
            text = self.decode(piece)
            if text and any(c.isalnum() for c in text):
                kept.append(proof)
                texts.append(text)
        # Nothing kept: the level is still what the input gave (a quiet recording is a dead or wrong device, a loud one is not), not -120.
        total = {"peakDb": max((p["peakDb"] for p in kept), default=max(peaks, default=-120.0)), "soundMs": sum(p["soundMs"] for p in kept),
                 "spanMs": sum(p["spanMs"] for p in kept), "voicedMs": sum(p["voicedMs"] for p in kept)}
        text = " ".join(texts)
        # Nothing passed the acoustic test: that is the reason. Something was decoded and came back empty: no reason, just no words.
        why = judge(text, total) if text else (None if decoded else blocked)
        return ("" if why else text), total, why, (text if why else "")

    def decode(self, samples) -> str:
        import numpy as np
        stream = self.recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples.astype(np.float32) / 32768.0)
        self.recognizer.decode_stream(stream)
        return tidy(stream.result.text)


class Worker:
    def __init__(self, engine: Engine):
        import numpy as np
        self.np = np
        self.engine = engine
        self.id = None
        self.chunks = []
        self.total = 0
        self.last_partial = None   # (samples covered, text) of the newest partial that decoded the whole recording
        self.last_words = ""       # newest non-empty partial text of this recording, the last resort when the final decode is empty
        self.last_proof = None     # the sound that partial read (what the log reports when the partial stands as the final)

    def samples(self):
        np = self.np
        if not self.chunks:
            return np.zeros(0, dtype=np.int16)
        if len(self.chunks) > 1:
            self.chunks = [np.concatenate(self.chunks)]
        return self.chunks[0]

    def begin(self, request_id):
        self.id, self.chunks, self.total = request_id, [], 0
        self.last_partial = None
        self.last_words = ""
        self.last_proof = None

    def audio(self, request_id, pcm):
        if request_id != self.id or self.total >= MAX_SECONDS * SAMPLE_RATE:
            return
        np = self.np
        data = np.frombuffer(base64.b64decode(pcm), dtype="<i2")
        room = MAX_SECONDS * SAMPLE_RATE - self.total
        data = data[:room]
        self.chunks.append(data)
        self.total += len(data)

    def partial(self, request_id):
        if request_id != self.id:
            return
        started = time.perf_counter()
        whole = self.samples()
        samples = whole[-int(PARTIAL_WINDOW * SAMPLE_RATE):]
        if len(samples) < SAMPLE_RATE // 4 or not has_speech(samples):
            # Nothing to decode yet. Say so: the bridge keeps one live-words decode in flight at a time and would wait for this
            # answer for the rest of the recording (a pause before the first word used to switch the live words off).
            send({"type": "partial", "id": request_id, "text": "", "ms": 0})
            return
        text, proof, why, ignored = self.engine.read(samples)
        if request_id == self.id:
            # A partial that decoded the entire recording (up to the window) can stand as the final text when only
            # silence follows it, so the key press does not wait for a second decode of the same words. A recording
            # longer than the window counts too when what the window left out holds no speech (a pause before the
            # first word): its words are all in the partial.
            left_out = whole[: len(whole) - len(samples)]
            covers = len(left_out) == 0 or not has_speech(left_out)
            self.last_partial = (len(whole), text) if covers and text else None
            if text:
                self.last_words = text   # kept even when it left out an early word: better than ending the turn empty
                self.last_proof = proof
            message = {"type": "partial", "id": request_id, "text": text, "ms": round((time.perf_counter() - started) * 1000)}
            if why:
                message["rejected"] = why   # words (or sound) that were not a person speaking: never shown
            send(message)

    def finish(self, request_id):
        if request_id != self.id:
            send({"type": "error", "id": request_id, "message": "no such recording"})
            return
        started = time.perf_counter()
        samples = self.samples()
        seconds = len(samples) / SAMPLE_RATE
        speech = has_speech(samples)
        text = ""
        reused = False
        why = ignored = None
        if speech:
            held = self.last_partial
            if held and held[1] and tail_is_quiet(samples, held[0]):
                text, reused = held[1], True
            else:
                text, _, why, ignored = self.engine.read(samples)
                if not text and not why and self.last_words:
                    # Speech was heard and the live words already read it: an empty full decode must not erase them.
                    log("final decode was empty after speech; used the live words")
                    text, reused = self.last_words, True
        # What the microphone gave, for the bridge's log (a wrong or dead input shows here). A live decode that stands as the final already
        # measured its sound; anything else measures the recording (about 2 ms per second of audio).
        proof = self.last_proof if reused and self.last_proof else evidence(samples)
        self.id, self.chunks, self.total, self.last_partial, self.last_words = None, [], 0, None, ""
        message = {"type": "final", "id": request_id, "text": text, "ms": round((time.perf_counter() - started) * 1000),
                   "seconds": round(seconds, 2), "speech": speech, "reused": reused,
                   "peakDb": proof["peakDb"], "soundMs": proof["soundMs"], "voicedMs": proof["voicedMs"],
                   "cpuMs": round(time.process_time() * 1000)}
        if why:
            message["rejected"] = why
            message["ignored"] = (ignored or "")[:200]
        send(message)

    def cancel(self, request_id):
        if request_id == self.id:
            self.id, self.chunks, self.total = None, [], 0


def reader(messages: "queue.Queue[dict | None]") -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            messages.put(json.loads(line))
        except ValueError:
            log("ignored a malformed line")
    messages.put(None)  # parent closed the pipe


def settle(batch):
    """Audio first, then control messages in order; stale partial requests are dropped."""
    result = []
    for message in batch:
        op = message.get("op")
        if op == "partial":
            result = [m for m in result if not (m.get("op") == "partial" and m.get("id") == message.get("id"))]
        elif op in ("finish", "cancel", "begin"):
            result = [m for m in result if not (m.get("op") == "partial" and m.get("id") == message.get("id"))]
        result.append(message)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--kind", choices=KINDS, default="moonshine")
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--priority", choices=sorted(PRIORITY_CLASSES), default="below")
    args = parser.parse_args()
    use_utf8()
    threads = max(1, min(4, args.threads))
    lower_priority(args.priority)
    started = time.perf_counter()
    try:
        import numpy as np
        engine = Engine(args.model, threads, args.kind)
        # The first decode pays for the runtime's one-off set-up; do it before the first recording needs it.
        engine.decode((np.random.default_rng(1).standard_normal(SAMPLE_RATE) * 600).astype(np.int16))
    except Exception as error:  # noqa: BLE001
        send({"type": "error", "message": f"load failed: {type(error).__name__}: {error}"})
        return 3
    worker = Worker(engine)
    send({"type": "ready", "engine": ENGINE if args.kind == "moonshine" else os.path.basename(os.path.normpath(args.model)), "kind": args.kind, "threads": threads, "loadMs": round((time.perf_counter() - started) * 1000)})
    messages: "queue.Queue[dict | None]" = queue.Queue()
    threading.Thread(target=reader, args=(messages,), daemon=True).start()
    gate = PriorityGate(args.priority)
    while True:
        try:
            first = messages.get(timeout=gate.timeout())
        except queue.Empty:
            gate.settle()
            continue
        if first is None:
            return 0
        gate.active()
        batch = [first]
        while True:
            try:
                batch.append(messages.get_nowait())
            except queue.Empty:
                break
        for message in settle([m for m in batch if m is not None]):
            op, request_id = message.get("op"), message.get("id")
            try:
                if op == "begin":
                    worker.begin(request_id)
                elif op == "audio":
                    worker.audio(request_id, message.get("pcm", ""))
                elif op == "partial":
                    worker.partial(request_id)
                elif op == "finish":
                    worker.finish(request_id)
                elif op == "cancel":
                    worker.cancel(request_id)
                elif op == "quit":
                    return 0
            except Exception as error:  # noqa: BLE001
                send({"type": "error", "id": request_id, "message": f"{op} failed: {type(error).__name__}: {error}"})
        if None in batch:
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
