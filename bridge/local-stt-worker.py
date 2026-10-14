"""Local speech-to-text worker: Moonshine Tiny (English, MIT) through sherpa-onnx, on the CPU.

Started by bridge/local-stt.mjs only while the Mistral text provider needs the microphone. It speaks JSON lines on
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
MAX_SECONDS = 60          # a recording is cut here (the game finishes one at 30 s)
PARTIAL_WINDOW = 8.0      # seconds decoded for a partial, newest audio only
SEGMENT_TARGET = 18.0     # a longer final decode is split at the quietest point near here
SEGMENT_LIMIT = 24.0
FRAME = 480               # 30 ms
GATE_DB = -52.0           # a recording whose loudest 30 ms frames never reach this holds no speech
SPEECH_FRAMES = 5         # 150 ms above the gate


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def send(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


PRIORITY_CLASSES = {"normal": 0x00000020, "below": 0x00004000, "idle": 0x00000040}


def lower_priority(level: str = "below") -> None:
    """Below-normal priority on Windows (best effort), so a decode never competes with the game's threads."""
    try:
        if level == "normal":
            return
        if os.name == "nt":
            import ctypes
            kernel32 = ctypes.windll.kernel32
            kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), PRIORITY_CLASSES[level])
        else:
            os.nice(5)
    except Exception as error:  # noqa: BLE001
        log(f"priority not lowered: {error}")


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


def tidy(text: str) -> str:
    text = " ".join(text.replace("\u0000", " ").split())
    return text


class Engine:
    def __init__(self, model: str, threads: int):
        import sherpa_onnx
        for name in MODEL_FILES:
            if not os.path.isfile(os.path.join(model, name)):
                raise FileNotFoundError(f"model file missing: {name}")
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_moonshine(
            preprocessor=os.path.join(model, "preprocess.onnx"),
            encoder=os.path.join(model, "encode.int8.onnx"),
            uncached_decoder=os.path.join(model, "uncached_decode.int8.onnx"),
            cached_decoder=os.path.join(model, "cached_decode.int8.onnx"),
            tokens=os.path.join(model, "tokens.txt"),
            num_threads=threads,
        )

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
        text = self.engine.decode(samples)
        if request_id == self.id:
            # A partial that decoded the entire recording (up to the window) can stand as the final text when only
            # silence follows it, so the key press does not wait for a second decode of the same words. A recording
            # longer than the window counts too when what the window left out holds no speech (a pause before the
            # first word): its words are all in the partial.
            left_out = whole[: len(whole) - len(samples)]
            covers = len(left_out) == 0 or not has_speech(left_out)
            self.last_partial = (len(whole), text) if covers else None
            send({"type": "partial", "id": request_id, "text": text, "ms": round((time.perf_counter() - started) * 1000)})

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
        if speech:
            held = self.last_partial
            if held and held[1] and tail_is_quiet(samples, held[0]):
                text, reused = held[1], True
            else:
                text = " ".join(part for part in (self.engine.decode(piece) for piece in split_points(samples)) if part)
        self.id, self.chunks, self.total, self.last_partial = None, [], 0, None
        send({"type": "final", "id": request_id, "text": text, "ms": round((time.perf_counter() - started) * 1000),
              "seconds": round(seconds, 2), "speech": speech, "reused": reused,
              "cpuMs": round(time.process_time() * 1000)})

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
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--priority", choices=sorted(PRIORITY_CLASSES), default="below")
    args = parser.parse_args()
    threads = max(1, min(4, args.threads))
    lower_priority(args.priority)
    started = time.perf_counter()
    try:
        import numpy as np
        engine = Engine(args.model, threads)
        # The first decode pays for the runtime's one-off set-up; do it before the first recording needs it.
        engine.decode((np.random.default_rng(1).standard_normal(SAMPLE_RATE) * 600).astype(np.int16))
    except Exception as error:  # noqa: BLE001
        send({"type": "error", "message": f"load failed: {type(error).__name__}: {error}"})
        return 3
    worker = Worker(engine)
    send({"type": "ready", "engine": ENGINE, "threads": threads, "loadMs": round((time.perf_counter() - started) * 1000)})
    messages: "queue.Queue[dict | None]" = queue.Queue()
    threading.Thread(target=reader, args=(messages,), daemon=True).start()
    while True:
        first = messages.get()
        if first is None:
            return 0
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
