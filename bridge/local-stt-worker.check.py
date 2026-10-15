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
    """A voiced sound: 140 Hz and its harmonics, swelling and fading about four times a second like syllables."""
    t = np.arange(RATE * ms // 1000) / RATE
    voice = sum(np.sin(2 * np.pi * 140 * k * t) / k for k in range(1, 8))
    return (voice / 2.2 * (0.55 + 0.45 * np.sin(2 * np.pi * 4 * t)) * 9000).astype(np.int16)


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
        self.always = None   # a model that makes words out of anything (a breath, a click, a dead input)
        self.decodes = 0

    def create_stream(self):
        return Stream()

    def decode_stream(self, stream):
        audio = stream.samples
        self.decodes += 1
        if self.always is not None:
            stream.result.text = self.always
            return
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
check(engine.read(lead)[0] == WORDS, "a decode no longer fails on a long quiet before the words")

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


# --- Words made out of nothing (live record 2026-10-15: V lines nobody said or typed, shown as V's subtitle) -------------------------------
def breath(ms):
    n = RATE * ms // 1000
    return (np.convolve(rng.standard_normal(n) * 5000, np.ones(6) / 6, mode="same") * np.hanning(n)).astype(np.int16)


def keyboard():
    return np.concatenate([np.concatenate([click(30), quiet(120)]) for _ in range(6)])


proof = w.evidence(np.concatenate([quiet(300), speech(900), quiet(300)]))
check(proof["voicedMs"] >= 300 and proof["soundMs"] >= 600 and -40 < proof["peakDb"] < 0, "a voiced sound is measured as voiced: %s" % proof)
for name, sound in (("a breath", breath(500)), ("a click", click(120)), ("keys", keyboard())):
    proof = w.evidence(np.concatenate([quiet(400), sound, quiet(400)]))
    check(proof["voicedMs"] == 0 and w.acoustic(proof) is not None, "%s is not a voice: %s" % (name, proof))
check(w.evidence(quiet(1000))["soundMs"] == 0, "quiet has no sound")


def recording(*parts, partial=False):
    worker.begin("same")
    for part in parts:
        push("same", part)
    if partial:
        worker.partial("same")
    worker.finish("same")
    return last("final")


recognizer.always = "Thank you."
for name, parts in (("a breath", (quiet(500), breath(600), quiet(500))), ("a click", (quiet(300), click(200), quiet(600))),
                    ("keys", (quiet(300), keyboard(), quiet(500)))):
    recognizer.decodes = 0
    done = recording(*parts, partial=True)
    check(last("partial")["text"] == "" and last("partial").get("rejected"), "%s: the live words are never shown (%s)" % (name, last("partial")))
    check(done["text"] == "" and done.get("rejected"), "%s: the final is empty and says why: %s" % (name, done))
    check(recognizer.decodes == 0, "%s: sound that cannot be a voice is not even decoded" % name)
    # the level reported is what the input gave, not -120: a loud non-voice must never be reported as a silent device
    check(done["peakDb"] > -55, "%s: a recording that held sound reports its level, not silence: %s" % (name, done))
# a dead input: nothing reaches the gate, the model is never asked, and the level is reported for the log
recognizer.decodes = 0
done = recording(quiet(1500), (speech(900) * 0.0004).astype(np.int16), quiet(500))
check(done["text"] == "" and done["peakDb"] < -55 and recognizer.decodes == 0, "a dead input gives nothing and reports its level: %s" % done)
# a stock phrase on a short weak voiced sound is dropped; the same words said clearly and for a while are kept
done = recording(quiet(400), speech(200), quiet(400))
check(done["text"] == "" and done.get("rejected") == "stock-phrase", "'Thank you.' on a 200 ms sound is a hallucination: %s" % done)
done = recording(quiet(400), speech(1600), quiet(400))
check(done["text"] == "Thank you." and not done.get("rejected"), "'Thank you.' said clearly is kept: %s" % done)
# looping text and an impossible word rate
recognizer.always = "go go go go go go"
done = recording(quiet(400), speech(1600), quiet(400))
check(done["text"] == "" and done.get("rejected") == "repeating", "looping words are dropped: %s" % done)
recognizer.always = "one two three four five six seven eight nine ten eleven twelve"
done = recording(quiet(400), speech(900), quiet(400))
check(done["text"] == "" and done.get("rejected") == "too-many-words", "twelve words in under a second are dropped: %s" % done)
# a rejected live decode does not become the words a later empty final falls back on
recognizer.always = "go go go go go go"
worker.begin("same")
push("same", quiet(400)); push("same", speech(1600)); push("same", quiet(400))
worker.partial("same")
check(worker.last_words == "" and worker.last_partial is None, "a rejected partial is not kept as the live words")
worker.cancel("same")
recognizer.always = None
# normal speech reports what the microphone gave and carries no rejection
done = recording(quiet(300), speech(1200), quiet(400))
check(done["text"] == WORDS and "rejected" not in done and done["voicedMs"] >= 300 and done["soundMs"] >= 900 and -40 < done["peakDb"] < 0,
      "a normal final reports its levels: %s" % done)
# live record 2026-10-15 (a Bluetooth hands-free microphone, ~7 s of sound, ~2 s of it voiced): both decodes were loops of one word
good = {"peakDb": -9.0, "soundMs": 5000, "spanMs": 6000, "voicedMs": 3600}
for text in ("Destiny, destiny, destiny, What fear I will defeat", "Interesting. Just into the stenny. One tooth tooth on tooth tooth.",
             "go go go go go", "see you see you see you", "tooth on tooth tooth and tooth"):
    check(w.judge(text, good) == "repeating", "a looping decode is dropped: %s" % text)
for text in ("no no no", "Go to the market and buy the red one", "I said no, no, never again", "very very good", "yeah yeah okay"):
    check(w.judge(text, good) is None, "ordinary words stand: %s" % text)
# a long piece of sound that is mostly not voiced (a headset's hiss with a few vowels in it) is not speech; the same length of speech is
hiss = {"peakDb": -9.0, "soundMs": 7000, "spanMs": 9000, "voicedMs": 2200}
check(w.judge("Interesting just into the", hiss) == "not-voiced" and w.acoustic(hiss) == "not-voiced", "7 s of sound with 2.2 s voiced is not speech")
check(w.judge("Interesting just into the", {**hiss, "voicedMs": 4300}) is None, "7 s of sound with 4.3 s voiced is speech")
print("ok")
