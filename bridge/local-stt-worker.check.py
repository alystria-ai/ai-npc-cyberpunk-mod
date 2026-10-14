"""Checks of bridge/local-stt-worker.py that need numpy but not the model (run by local-stt-worker.test.mjs).

The model is replaced by a stand-in that behaves like Moonshine does on the recordings that broke a live test: it reads
nothing at all when the audio opens with more than a second of quiet. Exit code 0 and the line "ok" when every check holds.
"""
import base64
import importlib.util
import sys

import numpy as np

spec = importlib.util.spec_from_file_location("worker", sys.argv[1])
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

rng = np.random.default_rng(5)
RATE = w.SAMPLE_RATE


def quiet(ms):
    return (rng.standard_normal(RATE * ms // 1000) * 8).astype(np.int16)


def speech(ms):
    return np.where(np.arange(RATE * ms // 1000) % 2, 7000, -7000).astype(np.int16)


def lead_ms(audio):
    loud = np.nonzero(np.abs(audio) > 1000)[0]
    return 1e9 if loud.size == 0 else loud[0] * 1000 / RATE


class Stream:
    def __init__(self):
        self.samples = None
        self.result = type("R", (), {"text": ""})()

    def accept_waveform(self, rate, floats):
        self.samples = (floats * 32768.0).astype(np.int16)


class Recognizer:
    """Moonshine stand-in: no words after more than 1 s of leading quiet; `refuse_over` samples makes long decodes empty too."""

    def __init__(self):
        self.refuse_over = None

    def create_stream(self):
        return Stream()

    def decode_stream(self, stream):
        audio = stream.samples
        silent_lead = lead_ms(audio) > 1000
        too_long = self.refuse_over is not None and len(audio) > self.refuse_over
        stream.result.text = "" if silent_lead or too_long else "hey there friend"


sent = []
w.send = sent.append
recognizer = Recognizer()
engine = w.Engine.__new__(w.Engine)
engine.recognizer = recognizer
worker = w.Worker(engine)


def push(request_id, audio):
    worker.audio(request_id, base64.b64encode(audio.astype("<i2").tobytes()).decode())


def last(kind):
    return [m for m in sent if m["type"] == kind][-1]


def check(condition, message):
    if not condition:
        print("FAILED:", message)
        sys.exit(1)


# trim_lead: the quiet before the first word goes (a pre-roll stays), nothing else changes
audio = np.concatenate([quiet(2000), speech(800), quiet(300)])
trimmed = w.trim_lead(audio)
check(len(audio) - len(trimmed) >= RATE * 1700 // 1000, "2 s of leading quiet is cut down to the pre-roll")
check(len(audio) - len(trimmed) <= RATE * 1800 // 1000, "the pre-roll before the first word stays")
check(len(w.trim_lead(speech(500))) == RATE // 2, "audio that opens with speech is untouched")
check(len(w.trim_lead(quiet(1500))) == RATE * 3 // 2, "a recording with no speech is untouched")
check(engine.decode(audio) == "hey there friend", "a decode no longer fails on a long quiet before the words")

# 1. a pause before the first word: the live decode and the final both read the words
worker.begin("same")
push("same", quiet(1600))
worker.partial("same")
check(last("partial")["text"] == "", "nothing heard yet is answered with an empty partial, not silence")
check(not [m for m in sent if m["type"] == "final"], "an empty partial answer is never taken for a final")
push("same", speech(900))
push("same", quiet(500))
worker.partial("same")
check(last("partial")["text"] == "hey there friend", "the live decode reads the words after the quiet")
worker.finish("same")
check(last("final")["text"] == "hey there friend" and last("final")["speech"], "final after a pause before speaking")

# 2. the same id again straight away, with no words: an empty final, and the worker is clean afterwards
worker.begin("same")
push("same", quiet(1200))
worker.partial("same")
worker.finish("same")
check(last("final")["text"] == "" and last("final")["speech"] is False, "a recording with no speech ends empty")

# 3. and again with words and no live decode in between (the final decodes the whole recording itself)
worker.begin("same")
push("same", quiet(2500))
push("same", speech(900))
push("same", quiet(400))
worker.finish("same")
check(last("final")["text"] == "hey there friend" and last("final")["reused"] is False, "a full decode after 2.5 s of quiet reads the words")

# 4. a partial that is late (the recording was cancelled): nothing is sent for it; the next recording is read
before = len(sent)
worker.begin("old")
worker.cancel("old")
worker.partial("old")
check(len(sent) == before, "a late partial for a cancelled recording is dropped")
worker.begin("same")
push("same", speech(900))
push("same", quiet(400))
worker.finish("same")
check(last("final")["text"] == "hey there friend", "a recording after a cancelled one is read")

# 5. the live words stand when the full decode comes back empty although speech was heard
recognizer.refuse_over = RATE * 2
worker.begin("same")
push("same", quiet(700))
push("same", speech(1200))
worker.partial("same")
check(last("partial")["text"] == "hey there friend", "the live decode of a short recording works")
push("same", speech(1500))  # more speech arrives after the live decode, so it cannot be reused as is
worker.finish("same")
final = last("final")
check(final["text"] == "hey there friend" and final["speech"], "an empty full decode does not erase the words the live decode read")
recognizer.refuse_over = None

# 6. the next recording does not inherit the old live words
worker.begin("same")
push("same", quiet(800))
worker.finish("same")
check(last("final")["text"] == "", "words from an earlier recording never come back")
print("ok")
