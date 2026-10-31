"""Short line helpers of the Pocket voice (trimming, padding, fades, warm-up); no neural model, no numpy, no audio device."""
from __future__ import annotations

from array import array
import base64
import importlib.util
import io
import math
from pathlib import Path
import struct
import sys
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))
import pocket_voice_runtime as runtime

spec = importlib.util.spec_from_file_location('pocket_worker_short_lines', ROOT / 'bridge/pocket-voice-worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

RATE = 24000


def f32(values):
    """Values as the model's float32 samples have them."""
    return list(array('f', values))


def tone(milliseconds, level=.4, hertz=180):
    count = RATE * milliseconds // 1000
    return f32(level * math.sin(2 * math.pi * hertz * step / RATE) for step in range(count))


def quiet(milliseconds, level=.0005):
    """A pause: low hiss, not digital silence (the model's own pauses are not exact zeros)."""
    count = RATE * milliseconds // 1000
    return f32(level * (1 if step % 2 else -1) for step in range(count))


def line_with_carrier(real=500, pause=260, carrier=1000):
    """Silent lead-in, the line, a pause, the carrier, the model's silent tail. Returns the samples and the index where the pause starts."""
    lead = quiet(100)
    audio = lead + tone(real)
    pause_at = len(audio)
    return audio + quiet(pause) + tone(carrier, hertz=240) + [0.0] * 4800, pause_at


def chunks_of(samples, size):
    return [samples[begin:begin + size] for begin in range(0, len(samples), size)]


class Planning(unittest.TestCase):
    def test_words_are_counted_the_way_a_listener_would(self):
        self.assertEqual(runtime.word_count('Hey.'), 1)
        self.assertEqual(runtime.word_count("  Don't  you   know-it-all, V? "), 4)
        self.assertEqual(runtime.word_count('...'), 0)
        self.assertEqual(runtime.word_count('Wake up, Samurai: 2077!'), 4)
        self.assertEqual(runtime.word_count(''), 0)
        self.assertEqual(runtime.word_count(None), 0)

    def test_a_short_line_gets_its_carrier_after_a_full_stop_and_a_long_line_gets_nothing(self):
        carrier = runtime.SHORT_LINE_CARRIERS[None]
        self.assertEqual(runtime.plan_short_line('Hey')['text'], 'Hey. ' + carrier)
        self.assertEqual(runtime.plan_short_line('Hey you!')['text'], 'Hey you! ' + carrier)
        self.assertEqual(runtime.plan_short_line('Really?')['text'], 'Really? ' + carrier)
        self.assertEqual(runtime.plan_short_line('Well, ')['text'], 'Well. ' + carrier)
        self.assertEqual(runtime.plan_short_line('One\n two   three')['text'], 'One two three. ' + carrier)
        self.assertEqual(runtime.plan_short_line('One two three four five')['words'], 5)
        self.assertIsNone(runtime.plan_short_line('One two three four five six'))
        self.assertIsNone(runtime.plan_short_line('This line is clearly long enough on its own.'))

    def test_nothing_to_say_and_wrong_input_are_left_alone(self):
        for value in ('', '   ', '...', '?!', None, 5, ['Hey']):
            self.assertIsNone(runtime.plan_short_line(value), repr(value))

    def test_a_language_without_a_carrier_keeps_its_short_lines_as_they_are(self):
        self.assertIsNone(runtime.plan_short_line('Hey', language='de'))
        self.assertIsNotNone(runtime.plan_short_line('Hey', language=None))
        self.assertEqual(runtime.plan_short_line('Hey', language='de', carriers={'de': 'Na ja.'})['text'], 'Hey. Na ja.')

    def test_the_carrier_makes_a_short_line_longer_than_the_short_limit(self):
        for line in ('Hey', 'Hey you', 'One two three four five'):
            plan = runtime.plan_short_line(line)
            self.assertGreater(runtime.word_count(plan['text']), runtime.SHORT_LINE_MAX_WORDS, line)

    def test_the_estimate_grows_with_the_line_and_has_a_floor_per_word(self):
        one = runtime.plan_short_line('Hi')['estimateFrames']
        two = runtime.plan_short_line('Hi there')['estimateFrames']
        five = runtime.plan_short_line('Hello there my good friend')['estimateFrames']
        self.assertLess(one, two)
        self.assertLess(two, five)
        # Two letters would be 130 ms by the rate, one word is never under the floor.
        self.assertGreaterEqual(one, runtime.frames_of(runtime.LEAD_IN_MS + runtime.MIN_WORD_MS))


class Samples(unittest.TestCase):
    def test_pcm_bytes_and_samples_are_each_others_inverse(self):
        values = [0.0, .25, -.5, 1.0, -1.0]
        payload = struct.pack('<5f', *values)
        self.assertEqual(list(runtime.pcm_samples(payload)), values)
        self.assertEqual(runtime.pcm_bytes(runtime.pcm_samples(payload)), payload)
        self.assertEqual(runtime.pcm_bytes(values), payload)
        self.assertEqual(runtime.pcm_bytes([]), b'')

    def test_a_fade_ends_exactly_at_zero_leaves_the_front_alone_and_never_grows_a_sample(self):
        samples = [.5] * 1000
        faded = runtime.fade_out(samples, 288)
        self.assertTrue(faded[:712] == samples[:712])
        self.assertEqual(faded[-1], 0.0)
        self.assertTrue(all(0 <= faded[index] <= .5 for index in range(1000)))
        # Monotone down, so no overshoot or ripple, and no step bigger than the curve's own slope.
        ramp = faded[712:]
        self.assertTrue(all(ramp[index] >= ramp[index + 1] for index in range(len(ramp) - 1)))
        self.assertLess(max(abs(faded[index + 1] - faded[index]) for index in range(999)), .5 * math.pi / 288 * 1.05)
        self.assertEqual(samples, [.5] * 1000, 'the input is not changed')

    def test_a_fade_longer_than_the_audio_fades_all_of_it_and_zero_or_empty_changes_nothing(self):
        self.assertEqual(runtime.fade_out([.5] * 10, 100)[-1], 0.0)
        self.assertEqual(runtime.fade_out([.5] * 10, 0), [.5] * 10)
        self.assertEqual(runtime.fade_out([.5] * 10, -4), [.5] * 10)
        self.assertEqual(runtime.fade_out([], 50), [])

    def test_a_fade_of_pcm_bytes_matches_the_fade_of_the_samples(self):
        payload = struct.pack('<600f', *([.3] * 600))
        faded = runtime.fade_out_pcm(payload, 240)
        self.assertEqual(len(faded), len(payload))
        values = list(runtime.pcm_samples(faded))
        self.assertAlmostEqual(values[-1], 0.0)
        self.assertAlmostEqual(values[0], .3, places=6)

    def test_the_loudness_curve_is_the_peak_of_each_ten_milliseconds(self):
        curve = runtime.loudness_curve([.1] * 240 + [-.7] * 240 + [.2] * 100, hop=240)
        self.assertEqual([round(value, 6) for value in curve], [.1, .7, .2])


class FindCut(unittest.TestCase):
    def test_the_cut_is_in_the_pause_between_the_line_and_the_carrier(self):
        audio, pause_at = line_with_carrier()
        estimate = len(quiet(100)) + 500 * RATE // 1000   # a good guess: the line ends where the pause starts
        cut = runtime.find_cut(audio, estimate, loudest=.4)
        self.assertGreaterEqual(cut, pause_at)
        self.assertLessEqual(cut, pause_at + runtime.frames_of(runtime.PAUSE_KEEP_MS))

    def test_a_poor_guess_still_finds_the_pause(self):
        audio, pause_at = line_with_carrier()
        for guess in (pause_at * .65, pause_at * 1.4):
            cut = runtime.find_cut(audio, int(guess), loudest=.4)
            self.assertGreaterEqual(cut, pause_at, guess)
            self.assertLessEqual(cut, pause_at + runtime.frames_of(runtime.PAUSE_KEEP_MS), guess)

    def test_the_first_pause_after_the_start_of_the_window_ends_the_line_and_earlier_ones_are_its_own(self):
        # "Well" (pause) "I guess so" (pause) carrier. The estimate is the end of "I guess so".
        audio = quiet(100) + tone(250) + quiet(120) + tone(500) + quiet(300) + tone(800)
        comma = len(quiet(100) + tone(250))
        end = len(quiet(100) + tone(250) + quiet(120) + tone(500))
        cut = runtime.find_cut(audio, end, loudest=.4)
        self.assertGreaterEqual(cut, end, 'the comma is not the end of the line')
        self.assertLessEqual(cut, end + runtime.frames_of(runtime.PAUSE_KEEP_MS) + runtime.HOP_FRAMES)
        self.assertLess(comma, int(end * runtime.CUT_SEARCH_FROM))

    def test_the_silent_tail_of_the_model_is_not_the_pause_before_the_carrier(self):
        # The carrier is not there (or too short to count): the quiet that runs to the end of the audio is not a pause.
        audio = quiet(100) + tone(500) + [0.0] * 24000
        self.assertIsNone(runtime.find_cut(audio, len(quiet(100) + tone(500)), .4, final=False))

    def test_while_the_audio_may_still_grow_no_pause_means_no_answer_yet(self):
        audio = quiet(100) + tone(900)
        self.assertIsNone(runtime.find_cut(audio, len(quiet(100)) + 500 * RATE // 1000, .4, final=False))
        self.assertIsNotNone(runtime.find_cut(audio, len(quiet(100)) + 500 * RATE // 1000, .4, final=True))

    def test_the_cut_is_found_over_the_whole_range_of_lines_pauses_and_guesses_a_live_voice_can_give(self):
        # Lines of 150 ms to 1.2 s, pauses of 100 to 320 ms, a guess of 0.6 to 1.6 times the truth, any chunk size: the cut always lies in the pause.
        import random
        generator = random.Random(7)
        for _ in range(250):
            real, pause, carrier = generator.randint(150, 1200), generator.randint(100, 320), generator.randint(800, 1500)
            audio, pause_at = line_with_carrier(real, pause, carrier)
            estimate = int((len(quiet(100)) + real * RATE // 1000) * generator.uniform(.6, 1.6))
            trimmer = runtime.CarrierTrimmer(estimate)
            out = []
            for chunk in chunks_of(audio, generator.choice([480, 1920, 5000])):
                out.extend(trimmer.feed(chunk))
                if trimmer.done:
                    break
            if not trimmer.done:
                out.extend(trimmer.finish())
            label = (real, pause, carrier, estimate)
            self.assertGreaterEqual(len(out), pause_at, label)
            self.assertLessEqual(len(out), pause_at + runtime.frames_of(55), label)

    def test_a_pause_too_short_to_be_one_is_not_taken_while_a_longer_one_is_in_range(self):
        short = runtime.frames_of(runtime.MIN_PAUSE_MS) - 3 * runtime.HOP_FRAMES
        audio = tone(300) + [0.0] * short + tone(300) + quiet(300) + tone(800)
        second = len(tone(300)) + short + len(tone(300))
        cut = runtime.find_cut(audio, second, loudest=.4)
        self.assertGreaterEqual(cut, second)

    def test_with_no_pause_it_cuts_at_the_quietest_place_of_the_window(self):
        audio = tone(300) + [x * .2 for x in tone(40)] + tone(300) + tone(600)
        dip = len(tone(300)) + runtime.frames_of(10)
        cut = runtime.find_cut(audio, len(tone(300)) + len(tone(40)), loudest=.4)
        self.assertIsNotNone(cut)
        self.assertGreaterEqual(cut, len(tone(300)))
        self.assertLess(cut, len(tone(300)) + len(tone(40)) + runtime.HOP_FRAMES)
        self.assertGreater(dip, 0)

    def test_audio_too_short_to_hold_the_window_has_no_cut(self):
        self.assertIsNone(runtime.find_cut([], 5000, .4))
        self.assertIsNone(runtime.find_cut(tone(40), 48000, .4))
        # The window lies after the audio.
        self.assertIsNone(runtime.find_cut(tone(200), 480000, .4))

    def test_the_cut_never_comes_before_one_fade_from_the_start_of_the_window(self):
        audio = quiet(300) + tone(500)
        cut = runtime.find_cut(audio, 400, loudest=.4)
        self.assertGreaterEqual(cut, runtime.frames_of(runtime.FADE_MS))

    def test_a_start_offset_moves_the_window_with_it(self):
        audio, pause_at = line_with_carrier()
        estimate = len(quiet(100)) + 500 * RATE // 1000
        offset = 2400
        shifted = runtime.find_cut(audio[offset:], estimate, .4, start=offset)
        self.assertEqual(shifted + offset, runtime.find_cut(audio, estimate, .4))


class Trimmer(unittest.TestCase):
    def run_trimmer(self, audio, estimate, size):
        trimmer = runtime.CarrierTrimmer(estimate)
        out, firsts = [], []
        for chunk in chunks_of(audio, size):
            if trimmer.done:
                break
            released = trimmer.feed(chunk)
            firsts.append(len(released))
            out.extend(released)
        if not trimmer.done:
            out.extend(trimmer.finish())
        return trimmer, out, firsts

    def test_the_line_is_released_the_carrier_is_dropped_and_the_cut_is_faded(self):
        audio, pause_at = line_with_carrier()
        estimate = len(quiet(100)) + 500 * RATE // 1000
        trimmer, out, _ = self.run_trimmer(audio, estimate, 1920)
        self.assertTrue(trimmer.done)
        self.assertEqual(trimmer.cut, len(out))
        self.assertGreaterEqual(len(out), pause_at)
        self.assertLess(len(out), pause_at + runtime.frames_of(runtime.PAUSE_KEEP_MS) + 1)
        # The words are whole, sample for sample, up to the start of the fade.
        fade = runtime.frames_of(runtime.FADE_MS)
        self.assertTrue(out[:len(out) - fade] == audio[:len(out) - fade])
        self.assertEqual(out[-1], 0.0)
        self.assertLess(max(abs(out[index + 1] - out[index]) for index in range(len(out) - 1)), .05, 'no click anywhere in the audio')
        # Nothing of the carrier (a 240 Hz tone at .4) is left.
        self.assertLess(max(map(abs, out[pause_at + fade:])), .01)

    def test_the_result_does_not_depend_on_the_size_of_the_chunks(self):
        audio, _ = line_with_carrier()
        estimate = len(quiet(100)) + 500 * RATE // 1000
        reference = self.run_trimmer(audio, estimate, len(audio))[1]
        for size in (480, 1920, 3000, 7200):
            self.assertTrue(self.run_trimmer(audio, estimate, size)[1] == reference, size)

    def test_the_first_sound_is_not_held_back(self):
        audio, _ = line_with_carrier()
        estimate = len(quiet(100)) + 500 * RATE // 1000
        trimmer = runtime.CarrierTrimmer(estimate)
        first = trimmer.feed(audio[:1920])
        self.assertEqual(len(first), 1920, 'the first chunk goes out whole, before the model has made the next one')
        self.assertFalse(trimmer.done)

    def test_audio_before_the_search_window_is_released_at_once_and_only_the_window_waits(self):
        audio, _ = line_with_carrier()
        estimate = len(quiet(100)) + 500 * RATE // 1000
        trimmer = runtime.CarrierTrimmer(estimate)
        sent = 0
        for chunk in chunks_of(audio, 1920):
            sent += len(trimmer.feed(chunk))
            if trimmer.done:
                break
            # What is waiting is no more than the window and the lookahead, never the whole line.
            self.assertLessEqual(trimmer.received - sent, int(estimate * runtime.CUT_SEARCH_TO) + runtime.frames_of(runtime.CUT_LOOKAHEAD_MS))
        self.assertEqual(sent, trimmer.cut)

    def test_it_is_done_as_soon_as_the_window_is_passed_so_the_model_can_stop(self):
        audio, _ = line_with_carrier(carrier=3000)
        estimate = len(quiet(100)) + 500 * RATE // 1000
        trimmer = runtime.CarrierTrimmer(estimate)
        fed = 0
        for chunk in chunks_of(audio, 1920):
            trimmer.feed(chunk)
            fed += len(chunk)
            if trimmer.done:
                break
        self.assertTrue(trimmer.done)
        self.assertLess(fed, len(audio) // 2, 'most of the carrier is never asked for')
        self.assertEqual(trimmer.feed([.4] * 1920), [])
        self.assertEqual(trimmer.finish(), [])

    def test_the_line_is_released_as_soon_as_the_carrier_starts_to_sound_not_at_the_end_of_the_window(self):
        audio, pause_at = line_with_carrier(carrier=3000)
        estimate = len(quiet(100)) + 500 * RATE // 1000
        trimmer = runtime.CarrierTrimmer(estimate)
        fed = 0
        for chunk in chunks_of(audio, 480):
            trimmer.feed(chunk)
            fed += len(chunk)
            if trimmer.done:
                break
        onset = pause_at + runtime.frames_of(260)
        self.assertLessEqual(fed, onset + 2 * runtime.HOP_FRAMES + 480)
        self.assertLess(fed, int(estimate * runtime.CUT_SEARCH_TO))

    def test_a_model_that_stops_before_the_window_ends_is_cut_at_the_end_of_its_audio(self):
        audio, pause_at = line_with_carrier(carrier=100)
        audio = audio[:pause_at + 3000]
        estimate = len(quiet(100)) + 500 * RATE // 1000
        trimmer, out, _ = self.run_trimmer(audio, estimate, 1920)
        self.assertTrue(trimmer.done)
        self.assertGreaterEqual(len(out), pause_at)
        self.assertEqual(out[-1], 0.0)

    def test_audio_that_never_reaches_the_window_is_released_whole_and_unchanged(self):
        audio = tone(250)
        trimmer, out, _ = self.run_trimmer(audio, runtime.frames_of(2000), 1920)
        self.assertTrue(out == audio)
        self.assertIsNone(trimmer.cut)

    def test_an_empty_stream_gives_nothing(self):
        trimmer = runtime.CarrierTrimmer(7200)
        self.assertEqual(trimmer.finish(), [])
        self.assertTrue(trimmer.done)


class Model:
    """A stand-in for the model: streams a fixed signal in chunks, honours stop between chunks, remembers how it was asked."""
    def __init__(self, signal, size=1920):
        self.signal, self.size = signal, size
        self.calls, self.produced, self.closed = [], 0, False

    def generate_audio_stream(self, state, text, **options):
        self.calls.append((text, options))
        stop = options['stop']
        try:
            for chunk in chunks_of(self.signal, self.size):
                if stop.is_set():
                    break
                self.produced += len(chunk)
                yield chunk
        finally:
            self.closed = True


def encode(chunk):
    return struct.pack('<%df' % len(chunk), *chunk), len(chunk)


def run_stream(model, text='Hey.', plan=None, commands=None, **patches):
    commands = commands or worker.Commands(io.StringIO(''), 'a' * 32)
    commands.begin(1)
    sent = []

    def send(frame):
        sent.append(frame)
        commands.ack.set()
    result = worker.stream_request(model, {}, text, commands, send, 1, 'v', encode, plan=plan)
    samples = []
    for frame in sent:
        samples.extend(runtime.pcm_samples(base64.b64decode(frame['pcm'])))
    return result, sent, samples


class StreamRequest(unittest.TestCase):
    def setUp(self):
        self.signal, self.pause_at = line_with_carrier(carrier=3000)
        self.estimate = len(quiet(100)) + 500 * RATE // 1000

    def test_a_short_line_is_said_with_its_carrier_and_only_the_line_comes_out(self):
        plan = runtime.plan_short_line('Hey')
        plan['estimateFrames'] = self.estimate
        model = Model(self.signal)
        result, sent, samples = run_stream(model, 'Hey', plan)
        self.assertEqual(model.calls[0][0], plan['text'])
        self.assertIn(runtime.SHORT_LINE_CARRIERS[None], model.calls[0][0])
        self.assertGreaterEqual(len(samples), self.pause_at)
        self.assertLess(len(samples), self.pause_at + runtime.frames_of(runtime.PAUSE_KEEP_MS) + 1)
        self.assertEqual(result['frames'], len(samples))
        self.assertEqual(result['frames'], sum(frame['frames'] for frame in sent))
        self.assertEqual(result['shortLine']['cutFrames'], len(samples))
        self.assertEqual(samples[-1], 0.0)
        self.assertEqual([frame['offsetFrames'] for frame in sent], [sum(f['frames'] for f in sent[:index]) for index in range(len(sent))])
        self.assertLess(max(abs(samples[index + 1] - samples[index]) for index in range(len(samples) - 1)), .05)

    def test_the_model_is_stopped_when_the_line_is_cut_and_its_generator_is_closed(self):
        plan = runtime.plan_short_line('Hey')
        plan['estimateFrames'] = self.estimate
        model = Model(self.signal)
        run_stream(model, 'Hey', plan)
        self.assertLess(model.produced, len(self.signal) // 2)
        self.assertTrue(model.closed)

    def test_the_first_packet_is_the_first_chunk_so_the_latency_of_a_short_line_starts_where_it_always_did(self):
        plan = runtime.plan_short_line('Hey')
        plan['estimateFrames'] = self.estimate
        result, sent, _ = run_stream(Model(self.signal), 'Hey', plan)
        self.assertEqual(sent[0]['frames'], 1920)
        self.assertEqual(sent[0]['yieldMs'], result['firstPcmYieldMs'])
        self.assertEqual(sent[0]['copiedReadyMs'], result['firstPcmCopiedReadyMs'])

    def test_a_line_without_a_plan_takes_the_old_path_untouched(self):
        speech = tone(900)
        model = Model(speech)
        commands = worker.Commands(io.StringIO(''), 'a' * 32)
        result, sent, samples = run_stream(model, 'A longer line than five words, said plainly.', None, commands)
        self.assertEqual(model.calls[0][0], 'A longer line than five words, said plainly.')
        self.assertIs(model.calls[0][1]['stop'], commands.stop)
        self.assertNotIn('shortLine', result)
        self.assertEqual(len(samples), len(speech))
        self.assertTrue(samples == speech)
        self.assertEqual(result['chunks'], len(sent))

    def test_a_cancel_during_a_short_line_still_ends_the_request(self):
        plan = runtime.plan_short_line('Hey')
        plan['estimateFrames'] = self.estimate
        commands = worker.Commands(io.StringIO(''), 'a' * 32)
        sent = []

        def send(frame):
            sent.append(frame)
            commands.stop.set()
            commands.ack.set()
        commands.begin(1)
        with self.assertRaises(worker.Cancelled):
            worker.stream_request(Model(self.signal), {}, 'Hey', commands, send, 1, 'v', encode, plan=plan)
        self.assertEqual(len(sent), 1)

    def test_stop_either_follows_both_events(self):
        cancel, finished = threading.Event(), threading.Event()
        stop = worker.StopEither(cancel, finished)
        self.assertFalse(stop.is_set())
        finished.set()
        self.assertTrue(stop.is_set())
        finished.clear()
        cancel.set()
        self.assertTrue(stop.is_set())

    def test_a_tail_of_silence_cut_short_is_faded_out_and_a_whole_tail_is_not_touched(self):
        speech = tone(320)    # a whole number of 80 ms chunks, so the silence starts on a chunk
        # 4800 frames of digital silence after the speech: 960 are kept, the last of them faded (they are zero anyway, so the check is on a
        # quiet tail that is not zero).
        hiss = [.0004] * 4800
        result, sent, samples = run_stream(Model(speech + hiss), 'A longer line than five words, said plainly.')
        self.assertEqual(len(samples), len(speech) + worker.TAIL_SILENCE_FRAMES)
        self.assertEqual(samples[-1], 0.0)
        self.assertAlmostEqual(samples[len(speech)], .0004, places=6)
        whole = [.0004] * 480
        result, sent, samples = run_stream(Model(speech + whole), 'A longer line than five words, said plainly.')
        self.assertEqual(len(samples), len(speech) + 480)
        self.assertAlmostEqual(samples[-1], .0004, places=6)

    def test_peak_amplitude_of_bytes(self):
        self.assertEqual(worker.peak_amplitude(struct.pack('<3f', .1, -.5, .25)), .5)
        self.assertEqual(worker.peak_amplitude(b''), 0.0)


class WarmUp(unittest.TestCase):
    def test_every_line_is_said_and_thrown_away_and_the_short_one_has_its_carrier(self):
        model = Model(tone(200))
        stop = threading.Event()
        chunks = worker.warm_up(model, {'voice': 1}, ('Hey you.', 'A normal sentence of some length.'), stop)
        self.assertEqual(len(model.calls), 2)
        self.assertEqual(model.calls[0][0], 'Hey you. ' + runtime.SHORT_LINE_CARRIERS[None])
        self.assertEqual(model.calls[1][0], 'A normal sentence of some length.')
        self.assertEqual(chunks, 2 * len(chunks_of(tone(200), 1920)))
        for _text, options in model.calls:
            self.assertTrue(options['copy_state'])
            self.assertIs(options['stop'], stop)
            self.assertIsNone(options['frames_after_eos'])

    def test_the_shipped_warm_up_lines_cover_a_short_line_and_a_normal_one(self):
        self.assertEqual(len(worker.WARM_UP_LINES), 2)
        self.assertLessEqual(runtime.word_count(worker.WARM_UP_LINES[0]), runtime.SHORT_LINE_MAX_WORDS)
        self.assertGreater(runtime.word_count(worker.WARM_UP_LINES[1]), runtime.SHORT_LINE_MAX_WORDS)

    def test_a_language_without_a_carrier_warms_its_short_line_as_it_is(self):
        model = Model(tone(100))
        worker.warm_up(model, {}, ('Hey you.',), threading.Event(), language='de')
        self.assertEqual(model.calls[0][0], 'Hey you.')

    def test_a_failure_stops_and_drains_the_generator_then_is_raised(self):
        drained = []

        class Failing:
            def generate_audio_stream(self, state, text, **options):
                try:
                    yield [0.1]
                    raise RuntimeError('decoder failed')
                finally:
                    drained.append(options['stop'].is_set())
        stop = threading.Event()
        with self.assertRaisesRegex(RuntimeError, 'decoder failed'):
            worker.warm_up(Failing(), {}, ('Hey.',), stop)
        self.assertTrue(stop.is_set())
        self.assertEqual(len(drained), 1, 'the generator ran to its end once')

    def test_a_stop_before_the_first_line_makes_no_audio(self):
        stop = threading.Event()
        stop.set()
        model = Model(tone(200))
        self.assertEqual(worker.warm_up(model, {}, ('Hey.',), stop), 0)


if __name__ == '__main__':
    unittest.main()
