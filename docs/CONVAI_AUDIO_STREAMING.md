# Convai speech transport

## September 30 audit: direct PCM, one native clip

Convai receives one submitted player turn and generates its own speech. Local
OmniVoice alone divides reply text into separately generated phrases. The retired
Convai adapter instead captured the browser's real-time playback and divided
that recording into native WAV files. Measured native handoffs left micro-gaps.

The replacement requests the documented LiveKit data-only output. It collects
original PCM16LE packets in reliable arrival order and writes one WAV header
around those unchanged samples. One native Audioware clip represents the entire
reply. There is no browser audio recapture, resampling, gain processing, silence
removal, fade, or per-packet native playback.

NeuroSync frames use the provider's actual `fps` and `start_frame_index`; the
requested rate is not treated as a measured rate. The source trial returned
60 FPS despite a 30 FPS request. Audio and facial playback follow the same
native cursor. Valid quiet articulation is not gated to neutral by RMS.

### Completion and ownership

- Each connection permits one submitted turn at a time. Existing player,
  character, world, reset-epoch, audience and session guards remain in force.
- Accept reliable data from the verified current room participant. The browser
  adapter owns sender validation; the pure collector owns format and turn checks.
- Audio packets have no response ID or offset. Preserve arrival order, including
  repeated identical silence; never deduplicate PCM by content.
- Match indexed metadata ownership, final byte statistics and clean turn
  completion. Statistics or TTS-stop alone are not proof that all audio arrived.
- Require the exact declared PCM byte total. Format changes, interruption,
  inconsistent ownership, oversized output and missing data fail the turn.
- Cancellation or failed collection discards the page before another turn.
  This prevents untagged late audio entering a new conversation.
- Bounds: 120 seconds, 24 MB PCM, reliable wire messages below 1 MB.
- A malformed/incomplete facial timeline is reported and omitted while valid,
  complete audio is retained. Existing facial fallback and final reset apply.
- Phone text turns retain their exact scoped connection; no audio is requested.
- The pinned SDK does not serialize `audio_config`. The host adds it only to
  its own exact `/connect` POST after matching the admitted character/user.
  Existing fields and headers are preserved.

### Measured evidence and limits

One isolated Judy research request returned 3.05 seconds of mono 24 kHz PCM:
31 packets, 146,400 sample bytes and 183 facial frames. Audio arrived over 1.062
seconds (2.872 times playback rate); first audio was 2.287 seconds and complete
audio 3.349 seconds after submission. This is one provider observation, not a
latency guarantee. It used the existing research identity, no microphone and
no player memory.

Offline replay through the production collector recreated the saved source WAV
byte for byte (SHA-256
`0585deb6adcf1ec048c269f5942a242c7df291ca9512dfa9db561488c139ecf5`).
Statistics arrived before the PCM tail, and lifecycle sequence numbers arrived
out of order. Tests cover both cases, malformed faces, owner changes, cancellation,
interleaved stereo, silence and exact sample extrema.

Collecting one complete clip removes native stitches, but delays playback until
the full source audio is ready. Faster-than-playback delivery made that tradeoff
promising in this trial; long replies or service/network stalls can still delay
onset. The build/install/live status is recorded in
[the development audit](DEVELOPMENT_AUDIT_2026-09-30.md). Byte equality does not
establish audible or visual game acceptance.

The former PCM-split module and its offline fixtures remain as historical
regression evidence; production no longer calls it. A quiet-boundary-cut
experiment was set aside without installation because it retained file handoffs.
Omni's separate phrase producer and bounded read-ahead remain active.

The final real production-host smoke also passed after correcting the provider's
mixed event envelopes and unlabelled owned terminal. It returned one 3.05-second
WAV and 183 frames at 60 FPS; collection completed 3.046 seconds after submission.
Cold connection setup took 3.909 seconds separately. No microphone, game playback
or player memory participated in that isolated research request.

### Provider references

- [Convai audio data channel](https://github.com/Conv-AI/Convai-Documentation/blob/main/api-reference/core-api-reference/live-apis-beta/audio-data-via-data-channel.md)
- [Convai Connect API](https://github.com/Conv-AI/Convai-Documentation/blob/main/api-reference/core-api-reference/live-apis-beta/connect-api.md)

## Microphone finish ownership

The game owns the normal 30-second recording limit. Its explicit finish
refreshes verified current-world context on the original connection before
the SDK's normal microphone-disable operation submits the end of input.
The browser does not submit at 30 seconds. If a finish never arrives, its
35-second fallback cancels the turn, starts transport shutdown, and stops the
local microphone track without invoking that submission path. Cancellation
and identity rejection use the same rule. Captured resource references and
turn ownership checks keep a delayed shutdown or queued timeout from stopping
a newer recording. The fallback is a resource ceiling, not another reply.

Offline timer tests cover no submission at 30/32 seconds, context-before-submit
ordering for a valid finish, cancellation at 35 seconds, and delayed old
shutdown/finish callbacks while a new recording exists. These do not replace
an actual microphone and service check.


## Historical capture-route measurements (superseded)

These describe the retired browser-capture implementation, not the direct PCM route.

### Installed timing check, September 30

The first v2 Convai reply completed eight native segments. The user reported
that onset still felt slow. Its existing cursor-based onset estimate was
5.05 seconds from bridge admission: first source audio 2.16 seconds, first
PCM chunk 3.26 seconds, publication 4.80 seconds. Subsequent segment gaps were
19–27 ms. The onset estimate can run late by the age of the sampled speech-state
file; it is not an acoustic measurement.

The accepted request contained 516 KB, mostly historical journal entries.
`current()` reparsed it and computed two identities, each revalidating the
complete input. Ten such checks occurred before first publication. On the
captured request, 24 warmed offline trials measured 73.39 ms median for the old
guard versus 2.63 ms for reading and comparing its exact accepted bytes.

The bridge now validates the request at admission and compares exact original
bytes during playback, while retaining reaction, world, owner and cancellation
checks. Any replacement, including changed context under the same request ID,
invalidates the old request. The one-second PCM buffer and original audio are
unchanged. New metrics separately record pre-transport preparation and native
preparation of the first chunk.

Two subsequent live Judy replies estimated onset at 4.06 and 3.70 seconds,
with warm connections and first provider audio at 2.24 and 2.07 seconds.
First-chunk native preparation took 93 and 103 ms. The user confirmed that it
felt better. This is an installed before/after observation, not a controlled
provider benchmark or a guarantee for future network conditions.
