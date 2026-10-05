# Pocket streaming facial timing

> **October 5:** local voices and continuous Convai speech now use a model trained on the game's own JALI dialogue lipsync when local weights exist; see [GAME_LIPSYNC_MODEL.md](GAME_LIPSYNC_MODEL.md). The paths below remain the fallback.

## October 3 correction

Pocket returns 24 kHz mono float PCM in short decoder packets. Its Cyberpunk
speech pose table shares the existing local-voice calibration, but its live
envelope and analysis scheduling need a separate continuous implementation.

The previous implementation normalized each 80 ms packet independently. On
the same loud-then-quiet PCM, the quiet jaw weight was 0.3455 through the stream
and 0.1038 through the whole-WAV builder. This changed syllable effort and
smoothed over the loudness contrast. The corrected stream carries fixed 30 Hz
RMS bins across every packet, uses the shared utterance-prefix effort reference
and smoothing, and interpolates those levels on the 60 Hz facial clock. Both
paths now produce 0.1038 at the same sample. Short final packets contribute too.
The accepted renderer prefix alone supplies the reference; generated-ahead
samples cannot influence an earlier accepted prefix.

The old source flag became `local-phonetic` after any window completed, even
if that window was already heard. The new production call passes the browser's
actual `positionSeconds`. A result can qualify only its still-unheard suffix;
fully late work is discarded. Per-interval coverage and the active source label
describe the actual audible point. The receipt includes analysis start/end,
received and audible cursors at start/finish, usable seconds and failure/late
status. Ownership, generation, prefix duration and neutral completion remain
checked. Diagnostic-write failures cannot take down speech.

One Rhubarb job runs at a time. There is no queue of eight obsolete windows.
Already-heard context is bounded to 400 ms and is never re-admitted. A growing
window may use that context with its available unheard audio, rather than
requiring 800 ms entirely ahead and starving early analysis. A job overtaken by
playback is cancelled; the next one targets the available unheard prefix.

No PCM gain, normalization, silence trimming, resampling or added playback
delay is introduced. The stream never waits for facial analysis or complete
audio. The existing native shape table, whole-WAV mapping and Convai retarget
are unchanged.

## Evidence and remaining limit

Four new causal regressions failed on the old implementation before the fix.
The expanded suite also covers irregular/sub-50 ms packet boundaries, partial
on-time results, future-window selection, forged coverage and diagnostic
rejections. The real JavaScript timeline still passes the Lua native consumer
and its cancellation, rate, owner and neutral-reset gates.

An actual muted browser/audio-device replay used saved Pocket student PCM with
the real installed Rhubarb executable. PCM was unchanged, audio played before
source completion, and device drain/cleanup succeeded. At a paced 0.95 real-time
factor, the old implementation claimed 6.72 seconds of phonetic coverage but
provided zero seconds of non-jaw shapes at the heard positions. The corrected
implementation admitted about 0.40 seconds of an initial rest interval, with
zero seconds of varied shapes. This is a near-real-time scheduling stress case,
not a fresh model latency measurement or visual game acceptance. It shows that
this recognizer can fail to deliver useful shapes when the generator supplies
too little lookahead. No final source flag is treated as proof of lip quality.

The existing English recognizer was checked as an alternative. On retained
Johnny speech, 1.6 seconds of audio took about 1.63 seconds with phonetic,
2.99 seconds with PocketSphinx and 3.35 seconds with its dialogue hint. At
2.4 seconds the times were 1.41, 5.04 and 4.64 seconds. Short silent prefixes
returned quickly but do not establish speech recognition throughput. Rhubarb's
[official recognizer documentation](https://github.com/DanielSWolf/rhubarb-lip-sync#recognizers)
describes PocketSphinx as English-only and more precise, not as a streaming
latency guarantee. The faster measured existing choice remains phonetic.

Ignored evidence is under `runtime/verification/pocket-lips-stream-20261003`:
recognizer benchmark, paced real-browser replay, original failed scheduler
receipt and source hashes. The separate independent audit/reproductions remain
under `runtime/verification/inference-parity-20261003`. Future qualification
must count actual varied poses during audible speech at the production packet
cadence; a passing envelope or completed analysis alone does not close it.
