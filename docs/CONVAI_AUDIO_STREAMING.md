# Convai voice streaming

## Why this path exists

The SDK exposes a live decoded audio track. The original adapter captured it
until the whole utterance ended, encoded a WAV, and only then gave Audioware
the file. This added approximately the full spoken duration to first playback.
Streaming now publishes actual captured PCM while that remote track is still
playing. Provider time before the first audio packet is a separate delay and
is not removed by this change.

No audio normalization, filters, resampling, fades, or voice regeneration are
added. PCM uses the same mono PCM16 conversion as the preceding full-WAV path.
The offline byte comparison reconstructs the original converted samples from
all emitted segments and requires exact equality.

## Ownership and API

The main bridge owns the current request, native files, and first `reply.json`
publication. A browser page may emit only through the host's current random
capability token. Each callback checks that exact page, token, host epoch,
abort signal, sequence number, and cumulative audio clock before and after the
awaited native callback. Existing session bindings still prevent moving a
session between characters, users, save branches, audiences, or TTS routes.

```js
const stream = new ConvaiAudioStream({
  input, streamId: randomUUID(), slots, readState, writeManifest,
  current, signal, buildFace: buildFacialTimeline,
});
try {
  const result = await realtime.reply(config, {
    signal,
    onAudioChunk: async chunk => {
      const row = await stream.append(chunk);
      if (chunk.index === 1) {
        await publishFirstReply({
          text: chunk.text, audio: row.audio, face: row.face,
          stream: stream.descriptor(),
        });
      }
    },
  });
  await stream.finish(result);
  // Do not publish a second ordinary reply: result.streamed is true and its
  // audio is intentionally absent. Store the final text/session as usual.
} catch (error) {
  await stream.fail(error);
  // If the first reply was published, preserve the partial stream. Do not
  // replace it with an ordinary error reply or replay its audio.
}
```

Text-only and speculative preparation calls cannot acquire a native audio
sink. The ordinary full-reply method remains available when no callback is
provided. Microphone capture retains its existing full-reply behavior; its
stop operation can refresh silent context on the same verified connection,
without reconnecting or changing its identity.

## Native stream version 2

Version 1 local voice phrase streams remain unchanged. Convai uses version 2:

- Descriptor: `version`, `id`, `total: null`, `captionMode: "utterance"`,
  `firstText`, `textComplete`, and `bufferedDuration`.
- Manifest: the exact request/entity/generation owner, `streamId`,
  `version: 2`, `complete`, `total`, `text`, `textComplete`,
  `captionMode: "utterance"`, `bufferedDuration`, and ordered `chunks`.
- Each chunk has `index`, contiguous `startSeconds`, cumulative/current
  `text`, its native `audio` descriptor, chunk-local `face` timeline,
  chunk-local spoken caption events, `timing`, and `readyAt`.
- An open stream has `total: null`. Only final completion provides its exact
  count. A short reply may contain one segment. A failed partial stream ends
  with its available count and an `error`; it cannot prove full delivery.
- Audio duration and native completion, not the producer's final response,
  determine when group conversation can advance and when a delivery receipt
  is eligible. The native implementation owns those checks.

The transport segments are about one second each, including the second
segment. A one-second first segment followed by a two-second segment would
unnecessarily underrun when the input arrives at real time. A small 50 ms
sample tail is held until finalization so a tiny last packet cannot become an
invalid native WAV; every captured sample is retained unchanged.
When available, a real waveform zero crossing within the preceding 12 ms is
used for the file cut. This only moves the boundary; it does not add/remove
samples or apply an audio fade.

These segments are not subtitle phrases. One utterance caption survives file
boundaries. Updated text and the final total duration revise that caption at
the global native audio cursor. Neurosync frames are sliced at the same sample
clock, with interpolated boundary poses; missing frame gaps are not stretched.

Facial continuation uses producer-owned `speechSegment` metadata:
`{version: 1, index, startSeconds, first, last}`. `last` becomes true only on
the final captured tail, not because a network packet or current file ended.
The generated native facial timeline carries the same fields in `segment`.
Only the first segment eases in from neutral and only the last eases out;
intermediate frames retain their actual boundary poses. Audio-envelope
fallback also treats a file edge as a continuation, not a new silent frame.
Real silence inside each segment still closes the mouth.

Native pose handoff must match the same request, entity, generation, and exact
next segment/time. Missing or invalid replacement timelines, pauses, cancelled
or replaced requests, lost targets, and final completion retain neutral cleanup.
A long buffer underrun must not leave a held open mouth indefinitely. These
rules affect facial controls only; no speech samples are processed.

The final complete text is `result.text` from `RealtimeHost.reply()`. Calling
`stream.finish(result)` puts it in the final manifest `text` with
`textComplete: true`. The first `reply.json` may contain partial text, so group
history must adopt that final text for the matching request at actual playback
completion. Rewriting `reply.json` or playing the first chunk again is not a
valid way to update history; failed partial streams cannot claim the full line
was heard.

## Bounds and recovery

- Maximum utterance: 120 seconds and 128 segments.
- Browser PCM queue: at most 12 seconds, including an awaiting callback.
- Native producer: one playing segment and at most two ready segments.
- Native file leases are reused only after exact consumer acknowledgement.
- Callback acknowledgement is bounded to 15 seconds.
- The original no-first-audio timeout remains 60 seconds; a started stream
  may run up to the utterance limit plus a bounded completion allowance.
- WebRTC cannot be paused by the native game's menu. If a long pause fills the
  bounded queue, the stream fails explicitly instead of silently losing words
  or keeping unbounded PCM. A later request starts a new stream.
- Cancellation, target/world loss, changed identity, stale consumer state,
  changed SDK face timeline, and host close prevent later publication.

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

## Timing and qualification

`firstAudioMs` measures provider/transport time to the first captured signal.
`firstChunkMs` measures time to the first publishable PCM segment; it is not a
native playback measurement. `streamSinkWaitMs` and `streamDrainMs` expose local
consumer delay separately from `audioEncodeMs`. No user identifier is copied
from the warm registration receipt into these latency fields.

Offline coverage includes early emission while the provider is still speaking,
byte-identical PCM reconstruction, caption/face clocks, bounded read-ahead,
pause/cancellation/errors, exact page/session ownership, and real producer
manifests replayed through the Lua consumer. Facial boundary tests use the real
PCM producer and prove nonzero adjacent poses continue, with neutral poses only
at genuine utterance edges or real silent sections. A browser bundle also builds
without Node-only dependencies. These checks do not establish audible in-game
seamlessness, absence of visible rig interpolation artifacts, or measured
first-native-playback improvement; those require the installed game test.

Warm results additionally expose `registration: {verified, endUserId,
characterId}` for the memory registration worker. `endUserId` is the SDK's
server-response state; `characterId` is its public connected-configuration
getter. Missing or mismatched echoes remain unverified, including anonymous
connections. No credentials or registration metadata are added to speech logs.
