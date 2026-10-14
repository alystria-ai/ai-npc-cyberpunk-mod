"""Checks of bridge/local-stt-worker.py that need numpy but not the model (run by local-stt-worker.test.mjs).

The model is replaced by a stand-in that behaves like Moonshine does on the recordings that broke live tests: it reads nothing
at all when the audio holds more than a second of quiet (before the words, after a key click, between two bursts of speech), and
it reads nothing from a short click on its own. Exit code 0 and the line "ok" when every check holds.
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
WORDS = "hey there friend"


def quiet(ms):
    return (rng.standard_normal(RATE * ms // 1000) * 8).astype(np.int16)


def speech(ms):
    return np.where(np.arange(RATE * ms // 1000) % 2, 7000, -7000).astype(np.int16)


def click(ms=200):
    return (rng.standard_normal(RATE * ms // 1000) * 4000).astype(np.int16)


def longest_quiet_ms(audio):
    run = best = 0
    for flag in np.abs(audio) < 200:
        run = run + 1 if flag else 0
        best = max(best, run)
    return best * 1000 / RATE


def loud_ms(audio):
    return int(np.count_nonzero(np.abs(audio) > 1000)) * 1000 / RATE


class Stream:
    def __init__(self):
        self.samples = None
        self.result = type("R", (), {"text": ""})()

    def accept_waveform(self, rate, floats):
        self.samples = (floats * 32768.0).astype(np.int16)


class Recognizer:
    """Moonshine stand-in. `refuse_over` samples makes long decodes empty too."""

    def __init__(self):
        self.refuse_over = None

    def create_stream(self):
        return Stream()

    def decode_stream(self, stream):
        audio = stream.samples
        too_long = self.refuse_over is not None and len(audio) > self.refuse_over
        heard = longest_quiet_ms(audio) <= 1000 and loud_ms(audio) >= 400 and not too_long
        stream.result.text = WORDS if heard else ""


sent = []
w.send = sent.append
w.log = lambda message: None
recognizer = Recognizer()
engine = w.Engine.__new__(w.Engine)
engine.recognizer = recognizer
worker = w.Worker(engine)


def push(request_id, audio):
    worker.audio(request_id, base64.b64encode(audio.astype("<i2").tobytes()).decode())


def last(kind):
    return [m for m in sent if m["type"] == kind][-1]


def finals():
    return [m for m in sent if m["type"] == "final"]


def check(condition, message):
    if not condition:
        print("FAILED:", message)
        sys.exit(1)


def ms(audio):
    return len(audio) * 1000 // RATE


# speech_groups: sound keeps a pre-roll, the quiet between sounds goes, nothing else changes
lead = np.concatenate([quiet(2000), speech(800), quiet(300)])
groups = w.speech_groups(lead)
check(len(groups) == 1 and 1000 <= ms(groups[0]) <= 1400, "2 s of leading quiet is cut down to the pre-roll")
check(len(w.speech_groups(np.concatenate([quiet(300), speech(500), quiet(300)]))) == 1, "ordinary audio is one piece")
check(w.speech_groups(quiet(1500)) == [], "a recording with no sound has no pieces")
clicked = np.concatenate([quiet(300), click(), quiet(8000), speech(900), quiet(300)])
groups = w.speech_groups(clicked)
check(len(groups) == 2 and all(longest_quiet_ms(g) < 1000 for g in groups), "a click, 8 s of quiet and the words are two pieces")
check(sum(len(g) for g in groups) < RATE * 3, "the long quiet is not decoded")
two = w.speech_groups(np.concatenate([quiet(300), speech(900), quiet(3000), speech(900), quiet(300)]))
check(len(two) == 2, "two bursts of speech 3 s apart are two pieces")
near = w.speech_groups(np.concatenate([quiet(300), speech(900), quiet(500), speech(900), quiet(300)]))
check(len(near) == 1, "a short pause inside a sentence keeps the sentence in one piece")
check(engine.read(lead) == WORDS, "a decode no longer fails on a long quiet before the words")

# 1. a pause before the first word: the live decode and the final both read the words
worker.begin("same")
push("same", quiet(1600))
worker.partial("same")
check(last("partial")["text"] == "", "nothing heard yet is answered with an empty partial, not silence")
check(not finals(), "an empty partial answer is never taken for a final")
push("same", speech(900))
push("same", quiet(500))
worker.partial("same")
check(last("partial")["text"] == WORDS, "the live decode reads the words after the quiet")
worker.finish("same")
check(last("final")["text"] == WORDS and last("final")["speech"], "final after a pause before speaking")

# 2. the same id again straight away, with no words: an empty final, and the worker is clean afterwards
worker.begin("same")
push("same", quiet(1200))
worker.partial("same")
worker.finish("same")
check(last("final")["text"] == "" and last("final")["speech"] is False, "a recording with no speech ends empty")

# 3. the live regression of 2026-10-15: key click, 8 s of quiet, the words, a recording over 12 s. The live decode reads the newest
#    8 s, which holds the words; the full recording used to decode to nothing, and the fallback could not apply because the click
#    sat in the part of the recording the live decode left out.
worker.begin("same")
push("same", quiet(300))
push("same", click(200))
push("same", quiet(8000))
worker.partial("same")
check(last("partial")["text"] == "", "8 s of quiet after a click: nothing to read yet")
push("same", speech(900))
push("same", quiet(500))
worker.partial("same")
check(last("partial")["text"] == WORDS, "the live decode of the newest 8 s reads the words")
push("same", quiet(2000))  # the player waits a moment before releasing the key: the live decode did not hear all of this quiet
worker.finish("same")
done = last("final")
check(done["seconds"] > 11.5, "the recording is longer than the 8 s live window")
check(done["text"] == WORDS and done["speech"], "the final of a click, a long quiet and the words is the words")

# 3b. the same without any live decode in between (the final decodes the whole recording itself), and with a pause inside
worker.begin("same")
push("same", quiet(300))
push("same", click(150))
push("same", quiet(6000))
push("same", speech(900))
push("same", quiet(3000))
push("same", speech(900))
push("same", quiet(400))
worker.finish("same")
check(last("final")["text"] == WORDS + " " + WORDS and last("final")["reused"] is False, "both bursts of speech are read, and not the quiet or the click")

# 4. a partial that is late (the recording was cancelled): nothing is sent for it; the next recording is read
before = len(sent)
worker.begin("old")
worker.cancel("old")
worker.partial("old")
check(len(sent) == before, "a late partial for a cancelled recording is dropped")
worker.begin("same")
push("same", quiet(300))
push("same", speech(900))
push("same", quiet(400))
worker.finish("same")
check(last("final")["text"] == WORDS, "a recording after a cancelled one is read")

# 5. the live words stand when the full decode comes back empty although speech was heard
recognizer.refuse_over = RATE * 2
worker.begin("same")
push("same", quiet(700))
push("same", speech(1200))
worker.partial("same")
check(last("partial")["text"] == WORDS, "the live decode of a short recording works")
push("same", speech(1500))  # more speech arrives after the live decode, so it cannot be reused as is
worker.finish("same")
final = last("final")
check(final["text"] == WORDS and final["speech"], "an empty full decode does not erase the words the live decode read")
recognizer.refuse_over = None

# 6. the live words stand even when the live decode left an early part of the recording out
recognizer.refuse_over = RATE * 2
worker.begin("same")
push("same", quiet(300))
push("same", click(200))
push("same", quiet(3000))
push("same", quiet(6000))
push("same", speech(1200))
worker.partial("same")
check(last("partial")["text"] == WORDS, "the live decode of the newest 8 s reads the later words")
push("same", speech(2500))
worker.finish("same")
check(last("final")["text"] == WORDS and last("final")["reused"], "an empty final still falls back to the live words when the decode left early audio out")
recognizer.refuse_over = None

# 7. the next recording does not inherit the old live words
worker.begin("same")
push("same", quiet(800))
worker.finish("same")
check(last("final")["text"] == "", "words from an earlier recording never come back")
print("ok")
