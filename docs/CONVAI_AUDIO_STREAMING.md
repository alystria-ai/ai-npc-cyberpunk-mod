# Convai speech transport

## Current implementation: continuous original Convai PCM

Convai and Omni have separate playback producers, and since 2026-10-22 both feed the same continuous renderer:

| Provider | Generation | Playback start | Renderer |
| --- | --- | --- | --- |
| Convai | One player request; original PCM16 and indexed NeuroSync packets | At least 400 ms of source audio, reply text, and the exact game actor's admission | One continuous AudioWorklet ring for the entire reply |
| Local OmniVoice | Convai text, then local phrase synthesis at the captured 16/32-step setting | After the first complete phrase and its facial analysis; later phrases generate during playback | The same continuous AudioWorklet renderer as Convai: each phrase is synthesized on its own and fed as Float32 24 kHz PCM packets under one lease, with the same pan, distance gain, dialogue makeup and Voice volume, and its face from the streaming face model (as with Pocket). Before 2026-10-22 it was a native Audioware phrase queue. |

Omni does not currently play samples from an unfinished individual phrase.
Convai does not use Omni's text splitter, local model, phrase queue, browser
recapture, WAV handoffs, or a complete-file wait. The complete-WAV compatibility
route that used to cover a Lua adapter without continuous support is gone
(2026-10-22): a game session whose Lua adapter does not advertise continuous
playback shows the reply as text only. A failure never replays a whole WAV over
continuous audio.

### Boundaries and ownership

`realtime-client.mjs` accepts the original reliable packets through
`convai-data-audio.mjs`. `continuous-pcm-player.mjs` owns one source-rate audio
context, gain and pan; `continuous-pcm-worklet.mjs` feeds the bounded PCM16 ring
implemented in `continuous-pcm-core.mjs`. Packet boundaries never become sound
boundaries. There is no EQ, silence trimming or custom resampling. Since October 8
a calibrated dialogue-level makeup gain, peak limiter and distance low-pass follow
the panner ([dialogue level](DIALOGUE_LEVEL.md); `enabled: false` restores unity).
The operating system/browser still performs its normal output-device mixing.

`ConvaiContinuousSpeech` is the bridge-to-game boundary, separate from local
`SpeechStream`. It publishes the exact request, generation, entity and UUID to
`reply.json` once. `mod/continuous-speech.lua` validates the living actor and
player and grants a fresh, sequence-numbered lease before any sound can play.
The lease carries native Master/Dialogue volume, camera-relative pan and
distance gain. Missing volume access reports an error condition and stays muted.
The browser is a separate Windows audio session; it is not the game's own spatial
audio, so native occlusion/reverb is not claimed.

The bridge polls at 40 ms. The reader pauses on a stale heartbeat, menu pause,
or an underrun, without advancing the source clock. A stale lease eventually
cancels. Replacement requests, actor loss, death, unload and cancellation retire
the exact old stream. Buffers are bounded to 120 seconds and 24 MB of source PCM.
Short complete replies can begin below the 400 ms threshold.

The output device opens at turn start, not at the first packet. A new AudioContext
and worklet only start rendering 120-230 ms after `open()` returns, which used to
sit between the game's admission and the first sound. The turn therefore opens a
*standby* player (`open({standby: true})`, 24 kHz mono): silent, no game lease, no
audio accepted, controls ignored, bounded by a 70 s ceiling. The first audio packet
arms it (`arm()`), which starts the ordinary 2 s lease at that moment; admission
still needs the game's allowing control. A standby that failed, was replaced by a
device change or does not match the real source format is discarded and a player
opens at the first audio as before. Cancellation, a failed send or finish, and the
60 s no-audio timeout stop it. Measured first packet to first rendered samples:
about 300 to 140 ms on a warm page and about 270 to 135 ms on a page's first turn.

**A voice that never starts (owner decision 2026-10-27, error signature `915fca1c3ded7234`).** The turn waits for the reply's whole text and the voice's end (60 s ceiling,
`COLLECT_TIMEOUT_ERROR`). If the text is complete (the SDK's end of the LLM message, not thinking) and not one audio packet has arrived 5 s later
(`TEXT_WITHOUT_AUDIO_MS` in `bridge/realtime-client.mjs`, counted from the moment the text became complete), the reply is returned as a written reply:
`audioError` "Convai's voice did not arrive; showing the written reply.", `timing.convaiVoiceTimedOut`, no `continuous` flag, so the bridge publishes it through the same path as a
text-only reply. The standby device is released and the connection is retired, so a late packet of that response cannot play over the next turn (the next turn opens a fresh
connection). The bridge writes one line `[Convai] voice did not arrive in N s; the reply is shown as text (profile=...)`. It is a success: no failed turn, no error report. Audio that
has started (any packet) keeps the 60 s rule, and so does text that is still streaming. Only Convai's own voice is affected; a local voice never reaches this code and no cloud voice
stands in. The clock is the existing 50 ms poll of the wait (no new timer). Ordinary turns record `timing.textToFirstAudioMs` (text end to the first audio packet, 0 when the audio
started first) so the 5 s can be checked against real turns.

Device-correlated output timestamps map through the reader's actual consumed
samples. Native subtitles and growing NeuroSync timelines follow that clock;
they do not advance through buffering gaps. Final provider text and exact PCM
count must validate, and the device tail must drain, before a delivered receipt
or the next group speaker is allowed. F9 includes the recognized microphone
prompt in its initial descriptor and retains the original submitted memory
receipt when completion refreshes quest context.

NeuroSync maps to the managed character's supported facial feature. The
`arkit61-native-v10` calibration keeps bounded jaw/opening curves and maps
mouth-corner stretch and lower-lip roll to the appropriate native deformation
controls. Actual provider cadence is preserved up to 60 Hz. The game samples
the face each frame from a confirmed already-heard cursor, with a small bounded
past lag instead of future audio prediction. The accepted jaw curve is retained.
Round/wide shapes, lip contact and upper lift now use separately rendered native
ranges; upper lift is limited to 0.06 with reduced aggregate aperture after the
earlier distortion report. Only the two lip-contact tracks admit up to 0.85.
The user reports v6 improved and v7 "not bad, keep improving." V7's recorded
reply shows visible closure and reset; final naturalness remains open.
V8 adds the previously discarded upper-lip roll signal, capped at 0.06. Its
paired native replay shows restrained contour change and final reset; the
continuous provider/audio path is unchanged.
V9 adds independent lower-lip depression/retraction, confirmed against the
actual bone hierarchy and a native directional probe. V10 preserves JawOpen
independently of MouthClose: the rig's together controls close the lips over
the open jaw. Both paired spoken comparisons reset normally. Jaw size/cap,
source timing, PCM and the local Omni path are preserved.
Source-frame correctness is not visual acceptance.
See [native calibration](NATIVE_FACIAL_RETARGET_CALIBRATION.md).

### Browser snapshot transport

The same public continuous snapshot crosses Playwright as one bounded JSON
string, then is parsed in the host. Returning every pose/number as a nested
object caused a large recursive-serialization cost. A paired GPU-disabled
browser test with 481 poses × 61 channels measured about 315 ms median for
the old transfer versus 13 ms through the new host helper, with exact data
equality. These are local transport measurements, not Convai inference speed.

The encoded response is limited to 32 MiB in UTF-8 before parsing; ordinary
utterance, coefficient, token, generation, current-input and audible-drain
validation is unchanged. All asynchronous/synchronous ownership guards remain.
The existing 40 ms poll schedule is retained for this isolated correction.
Final collected reply serialization remains a separate one-time cost.

The passive game capture preceding this correction recorded 25 publication
changes over a 6.8-second source, with median update gaps around 317 ms. It
contained 206 face-sync calls but only 43 applications, despite game delta
around 33 ms. No autosave pause was observed. After activation, the second
capture recorded 160 native applications over four seconds of speech, with
48 publication changes and a median gap of 91 ms. All sampled positions stayed
behind the verified heard cursor. The user confirmed smoother motion, while
describing the shapes as mostly jaw movement; shape calibration is therefore
tracked separately from this accepted temporal improvement.

### Research and development method

The official [data-channel documentation](https://github.com/Conv-AI/Convai-Documentation/blob/main/api-reference/core-api-reference/live-apis-beta/audio-data-via-data-channel.md)
supports consuming original PCM packets. The
[Web SDK guide](https://docs.convai.com/api-docs/plugins-and-integrations/web-plugins/convai-web-sdk)
describes audio rendering and timed blendshapes. This implementation keeps the
existing verified LiveKit identity/session transport and requests data-only
speech from that same connection.

The reference audit inspected Dawnwalker v0.5.6 at
[`eec0ce7`](https://github.com/alystria-ai/AI-Companion-Mod-For-Blood-of-Dawnwalker/blob/eec0ce7df58718e98a2a62a67eb8e6d9e5769000/bridge/reply-audio.ts):
its private first speaker plays the live remote track; prefetched group speech
uses a continuous worklet with a source-sample clock. Its buffers and spatial
policy were not copied blindly. Cyberpunk needs its own actor admission, game
pause, native volume, face mapping and delivery receipts. The Audioware
API (then installed, and no longer used by the mod) had no append-PCM entry point;
appending a WAV does not turn its fixed-length native decoder into a safe streaming sink.

Tests execute the pure ring, real browser worklet, bridge pump and Lua adapter.
They cover sample identity/order, pause/underrun clocks, stale ownership, final
drain, group progression and independent local voice routing. Real-browser
tests explicitly mute output and use zero or retained test PCM. Live latency,
audible quality and facial quality remain separate acceptance gates; see the
[development audit](DEVELOPMENT_AUDIT_2026-09-30.md) for the latest results.

## Earlier September 30 checkpoint: direct PCM, one native clip

Convai receives one submitted player turn and generates its own speech. Local
OmniVoice alone divides reply text into separately generated phrases. The retired
Convai adapter instead captured the browser's real-time playback and divided
that recording into native WAV files. Measured native handoffs left micro-gaps.

That checkpoint requested the documented LiveKit data-only output. It collected
original PCM16LE packets in reliable arrival order and writes one WAV header
around those unchanged samples. One native Audioware clip represented the entire
reply (this path was removed on 2026-10-22). There is no browser audio recapture, resampling, gain processing, silence
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
- A response that ends cleanly with no audio and no statistics (a microphone turn
  whose first response is empty, then a second one carries the speech: four
  installs, 25 Oct 2026) is closed when another owner arrives. That owner is
  judged like the first of a turn: adopted unless it is a retired or closed owner.
  The closed owner joins the retired ones at the end of the turn, so a late
  message of it is ignored in this turn and in the next, never adopted. Every
  other owner change still fails the turn: before the active response ended, after
  it had audio or statistics, after three empty responses. Interruption and
  cancellation still fail. An empty response alone never completes a turn; only
  the collection timeout ends it.
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

## The hidden browser's sandbox

The hidden Chromium (Edge, Chrome or another Chromium browser) runs with its renderer sandbox on, so a bug in the code that decodes remote WebRTC audio and data stays inside the sandbox (security review 2026-10-22, finding 8; Playwright adds `--no-sandbox` unless `chromiumSandbox: true`). `RealtimeHost.launchWithSandbox` in `bridge/realtime-host.mjs` starts it that way and trusts it only after one blank page has opened and run a line (`probeBrowser`, 8 s at most, once per start, nothing per turn):

- A browser that will not start (20 s limit, not Playwright's 180 s), hangs, or whose first page crashes (Wine or Proton, a browser on exFAT, FAT32 or a network drive, security software that injects into renderers) is closed and started again without the sandbox. The reason is logged (`runtime/bridge.stderr.log`).
- The result is remembered by every host in the process (the bridge has three) and in `browser-sandbox.json` in the state folder, per browser program, for 30 days, so such a PC does not pay for the attempt at every start. Delete the file to try the sandbox again.
- A browser that is not installed is not retried.
- `CYBERPUNK_CONVAI_NO_BROWSER_SANDBOX=1` starts it without the sandbox and without a probe (for support).

**Known limit.** A sandboxed audio service can be silenced by audio-enhancement software that hooks audio processes (Nahimic, Sonic Studio and similar). The browser then starts, the page works, and the replies play no sound; nothing raises an error, so this cannot be detected cheaply and is not. The log says once per process that the browser runs with its sandbox. The variable above is a developer's switch for reproducing it (players are not asked to set environment variables); a fix for such a PC would need a setting. The first-sound time on the stage clock should be compared with and without the sandbox on a live test.
