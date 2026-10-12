# Mistral cloud voice (Voxtral)

Added 2026-10-12. An optional Companion voice that speaks a reply with Mistral's text-to-speech (`voxtral-mini-tts-latest`),
cloned from the character's own reference clip (the OmniVoice long set first; see "Which clip is cloned"), on the player's free Mistral key. It works with any
conversation provider (Convai free tier, Mistral, Groq or Local), because it only needs the key. Research and measurements behind the
choice: `docs/FREE_CLOUD_OPTION_RESEARCH.md`.

Code: `bridge/voxtral-voice.mjs` (the adapter), `bridge/mistral-rate.mjs` (the shared request scheduler),
`bridge/voice-selection.mjs` (routing and fallback), `bridge/voice-routing-log.mjs` (the log lines), `mod/voice-preview.lua`,
`mod/manager.lua` and `mod/mcm.lua` (the menu). Tests: `bridge/voxtral-voice.test.mjs`, `bridge/mistral-rate.test.mjs`,
`bridge/manager.test.mjs`, `bridge/voice-preview-adapter.test.mjs`.

## What the player sees

Settings > Voices > Companion voices has seven entries: Pocket · Performance, four OmniVoice tiers, **Mistral cloud voice
(Voxtral)**, Convai · Cloud voice. Without a Mistral key the entry reads "Mistral cloud voice (Voxtral) · needs Mistral key" and
Apply refuses it ("Requires a Mistral key (add it in Settings > Development)"), the same way the OmniVoice entries behave without
the pack. The key is the one used for the Mistral text option (`player-mistral-key.txt`, pasted in Settings > Development); the
bridge publishes only whether one is saved (`runtime/mistral-state.json`, `saved`).

It speaks English only here (the Pocket route it rides on is English): with Multilingual conversations on, choosing it is refused
("The Mistral cloud voice speaks only English here. Turn off Multilingual conversations to choose it."), and turning Multilingual on
beside a saved Voxtral choice moves the voice to OmniVoice (pack installed) or the Convai cloud voice, with the usual notice.
Natural speech and Expressive emotions stay available: the voice rides on Pocket, whose tag handling it keeps (Natural speech is
limited to pauses, as with Pocket).

## How it speaks

`VoxtralVoice.synthesizeStream(voiceKey, text, {signal, onPcm})` has the same interface as Pocket TTS and hands `onPcm` packets of
24 kHz mono float32 audio (the Pocket packet contract, 100 ms frames, `engine: 'pocket-tts'`, `timing.voiceEngine: 'voxtral'`).
The reply text, subtitles, lip sync (JaliFace or the phone analysis) and the facial model are all driven by those packets, so they
work exactly as with Pocket. Group chat look-ahead (`BufferedPcm`) is unchanged.

- Request: `POST https://api.mistral.ai/v1/audio/speech`, body `{model, input, ref_audio, response_format: 'pcm', stream: true}`.
  The answer is server-sent events: `speech.audio.delta` (`audio_data`, base64 of raw **float32** little-endian PCM, not 16-bit)
  and `speech.audio.done`. Bytes can split anywhere, including inside a sample; the decoder carries the remainder.
- `ref_audio` is the character's reference clip, chosen as in "Which clip is cloned" below (a clip over 25 s is cut). Saved
  voices need a paid plan, so the clip is sent with **every** call; its base64 form is cached per voice in memory (32 voices).
- **One request per reply**, streamed, never one per sentence, with two exceptions: a long reply (160 characters or more) is split
  once, into its first sentence and the rest (see "Long replies"), and a reply that the text route streams (a Mistral, Groq or Local
  AI reply) is voiced as its first sentence while the model is still writing and its rest when it is finished (see "One reply, one
  voice").
- The key goes only in the Authorization header; messages pass through `redact`; it is never logged or written to a state file.

## Fallback rule

Pocket stays loaded (this voice is a route on top of it), so any reply the cloud cannot deliver is spoken by Pocket, in the same
reply slot, with no gap in the written text. **Only while nothing of the reply has been heard.** Before any audio has been
delivered, each of these throws a `VoxtralError` and Pocket speaks that whole reply; once the first part of a reply has played in
the cloud voice, the rest of it is never given to Pocket (see "One reply, one voice"):

| Cause | Kind | After it |
| --- | --- | --- |
| No Mistral key | `no-key` | Pocket until a key appears |
| No clip at all for this character (see below) | `no-reference` | Pocket for this character; the rest still use Voxtral |
| No first audio in 7 s (counted from the moment the request is sent, not when it queued) or waiting over 6 s behind other Mistral requests | `timeout` | next reply tries again |
| 429 | `limit` | cool-down for `Retry-After` (20 s when none, at most 60 s); every Mistral request pauses for it |
| 401 / 403 | `key` | 60 s cool-down |
| Network error, 5xx, stalled stream (8 s of silence) | `network` | next reply tries again |
| Refused request or unusable answer | `request` | next reply tries again |
| Text over 4,000 characters, or nothing speakable | `text` | not a fallback event; Pocket speaks it |

**The rule for a character with no clip at all: Pocket**, as in the table. A stock Voxtral voice would be a different, generic voice
that does not match the character (the preset voices carry only gender and language tags), so none is used. Today that is
nobody: `8ug8ear` and `jake-estevez`, the last two, got reference sets on 2026-10-13.

## Long replies: two requests

The first audio of a long reply was observed to take over the old 4 s limit in game (2026-10-12, Alex, Local provider: "fell back to
Pocket: timeout" on the third, longest reply). So a reply of 160 characters or more is sent as **two requests started together**
(`splitReply`):

- The first request holds the first sentence (at least 40 characters, so a short "Hey V." joins the next sentence; with no sentence end
  in reach, up to the last comma, semicolon or colon before 120 characters). The rest is the second request. If the rest would be
  under 40 characters, or there is nowhere to cut, the reply stays one request.
- The scheduler starts both at once. The first part's audio is handed to the player as it arrives. The second part's audio is held
  until the first part has been handed on, then released, at once if it is complete, otherwise a little (1.5 s) before the first
  part's audio would run out, so the player hears one reply with its packets in order (same owner, id, increasing index and offset).
- If the first request fails before audio, the second is dropped and Pocket speaks the whole reply, as for a short reply: nothing
  has been heard yet.
- **The second request never goes to Pocket** (changed 2026-10-13; before, a second request that failed before its audio was
  played was spoken by Pocket, a different voice, partway through the reply). It is asked for again once if its first ask fails
  before any audio (6 s to first audio, then 10 s: `tailFirstAudioMs`, `tailRetryAudioMs`), the first part's audio buying the
  time; if the second ask fails too, the reply ends after the first part (`truncated: true`, `partFailure`), and the log says
  "the rest of the reply could not be spoken, the reply ends after the part already heard (the voice is not switched)".
- If the second request fails after its audio has started playing, the reply ends there (`truncated: true`); nothing is spoken twice.

The first-audio limit is 7 s from the send. Every Voxtral reply logs `[Voxtral] first audio Nms, chars N` (with the two request sizes
for a split reply, and `second request first audio Nms`), and every fallback logs its reason with the detail (for example `gave no
audio within 7000 ms`), so the real distribution can be read from `runtime/bridge.stderr.log`.

## One reply, one voice (2026-10-13)

**What was wrong.** With the first sentence streamed (`bridge/reply-stream.mjs`), a reply is voiced as two calls: its first sentence
(the head) as soon as the model has written it, and the rest (the tail) when the model is finished. Each call went through
`VoiceSelection.synthesizeStream` on its own, so each tried Voxtral and fell back to Pocket for itself. When Voxtral had one of its
server-side spikes (5 to 11 s on about one call in ten) on the tail, that call timed out at 7 s and Pocket spoke the tail: a different
voice partway through the reply. Live record, 2026-10-12 21:08Z (reply 3): head 28 characters, first audio 1,103 ms in Voxtral; then
"fell back to Pocket: timeout - gave no audio within 7000 ms" for the tail. (The `voice-routing.log` line of 02:42:19 local, which says
`used="Pocket" ... fallback="Mistral cloud voice fell back (timeout)"`, belongs to the NEXT reply: the line is written before a reply is
voiced and read the previous reply's failure; that reply was spoken in Voxtral from start to end. The line now reports `fallback=` only
when the cloud voice cannot be asked at all (no key, a limit, a refused key) and carries an earlier timeout as `cloudLast=timeout`.)
The same happened inside a single long reply: the second of its two requests failing handed the rest to Pocket.

**The rule now** (`bridge/voice-utterance.mjs`, `VoiceSelection.synthesizeStream` / `synthesizeRest`, `bridge/pocket-speech.mjs`):
- The head's call and the tail's call share an `Utterance`. The head's call decides the engine: `voxtral` the moment its first
  audio is delivered, `pocket` when Pocket speaks it (the cloud voice failed before any audio, was not chosen, or had no key).
- **The tail follows the head.** Head in Pocket: the tail is Pocket's, the cloud voice is not asked. Head in Voxtral: the tail is
  Voxtral's, never Pocket's.
- **The tail's request goes out as soon as its text is known** (when the model finishes), in parallel with the head, even before the
  head has produced audio. What it delivers is held until the head is known to be in Voxtral, and dropped (the request cancelled) if
  Pocket spoke the head, so a failed head never leaves cloud audio in the tail.
- **The tail gets a longer deadline and a second ask.** 6 s to first audio for the first ask, 10 s for the second (`tailFirstAudioMs`,
  `tailRetryAudioMs`; a queue wait up to 15 s, `tailMaxQueueMs`; the head's audio, usually 3 to 7 s of speech, covers the wait). A
  spike is a property of one call and a second call is nearly always quick, so a short first deadline plus a retry beats one long
  deadline (a 9 s spike costs 6 s + 1.3 s, not 9 s). Retried: no audio in time, network error, server fault, empty answer, a 429 (after
  the scheduler's pause). Not retried: a refused key, a cancellation.
- **If the tail fails after both asks**, the reply ends after the head (`truncated`, `timing.voiceTailFailed`); the written reply and the
  subtitles are complete. It is logged: `[Voxtral] the rest of the reply could not be spoken, the reply ends after the part already heard
  (the voice is not switched): ...` and `[Voice] the rest of the reply could not be voiced (...)`. If the head's own audio was cut
  short, the tail is not played after it (`timing.voiceTailSkipped`).
- **Only a failure before any audio may send a whole reply to Pocket**: the head failing, a short reply failing, a split reply's first
  request failing.
- The same applies to a long reply that is not streamed (split into two requests): its second request is asked twice, then the reply ends.

**Harness numbers** (`node scripts/Measure-TurnLatency.mjs --failures --only voxtral --spike-ms 9000`: the real `VoxtralVoice`,
`VoiceSelection` and `deliverPocketSpeech` against a local fake API with a 1.3 s first audio, the tail's first ask held for 9 s; Pocket
is a tone of another pitch so the packets name the voice; muted; the reply is live reply 2, head 100 characters, tail 154):

| | Head | Tail | Voice switched |
| --- | --- | --- | --- |
| 2026-10-12 routing | Voxtral | **Pocket**, first packet 6.7 s after the head's, after "fell back to Pocket: timeout" | yes |
| new routing | Voxtral | **Voxtral**, first packet 6.9 s after the head's, after "asking again" (the 9 s spike cost 6 s + 1.3 s) | no |

The tail arrives at about the same moment either way (the head's 7 s of speech covers it), now in the same voice.

## Which clip is cloned

Tried in this order for a voice key; the first that gives a usable file is used (`VoxtralVoice.build`, `timing.voiceReferenceSource`
says which):

1. **OmniVoice long set** (`omni-long`): the reference in the long voice configuration (`runtime/voice-configs.json`), its sha256
   checked against the registry.
2. **OmniVoice short set** (`omni-short`), the same way.
3. **The Pocket reference** (`pocket`) for that character, the same way.
4. **Clips extracted for the character** (`extracted`): every `.wav` in `runtime/voice-references/extracted/<character>/`, in
   name order. They are joined end to end into one file until about 12 s are reached (at most 8 clips are read, a clip that would
   take the total past 25 s is left out, a clip in another format than the first is skipped), and the result is cut to 25 s. Only a
   character's own key names the folder (lower-case letters, digits and hyphens): a second voice of an ambient profile
   (`-v2` to `-v4`) never borrows the profile's clips, and a key that could point at another folder is refused.

A file that is missing, unreadable or fails its hash passes the turn to the next source. Only a character with none of the four
falls back to Pocket (`no-reference`). The registry sources use the already validated picks (themselves joined clips); the
extracted ones are unvalidated raw game audio, so they are the last resort.

On 2026-10-12 `8ug8ear` and `jake-estevez` were "unprepared" in all three sets and had no folder under `extracted/`, so they spoke
with Pocket. On 2026-10-13 both were given a long, a short and a Pocket set, hand-extracted from the game's voice archive
(`docs/GAME_VOICE_REFERENCES.md`, "Hand-extracted references for 8ug8ear and Jake Estevez"), so every character now has an
`omni-long` reference. Judy, Johnny, Adam Smasher, Ana Friedman and Blue Moon have extracted clips as well.

If audio is already playing and the stream then fails, the reply's audio ends early (the written reply is complete) rather than
playing two voices; the result carries `truncated: true`. The same holds for a failed second request of a split reply and for the tail
of a streamed reply (below): they are asked for again once, and then the reply ends. A failure of the consumer (`onPcm` throwing) or a
cancellation is not a fallback.

The player is told **once per session** per fallback: "Mistral cloud voice (Voxtral) is not ready yet. Companions are using Pocket ·
Performance for now." for a temporary one (a timeout, a limit) and "... is unavailable. Companions are using Pocket · Performance
instead." for a permanent one (no key). It reuses the existing `voice-fallback` notice; the bridge publishes it as
`fallback: {from: 'voxtral', to: 'pocket', temporary, reason}` in `runtime/local-voice-state.json`.

## Why the cloud voice sounded muffled, and the reference as it is now (2026-10-13)

**Root cause: the clone has only the frequencies its reference had.** Versions 1 and 2 of the reference preparer sent the clip at 16 kHz
(nothing above 8 kHz), as a 32 kbit/s MP3 whose encoder low-pass sits at 7.3 kHz, so every answer stopped near 7.5 kHz. Measured on the
real API (25 calls, the same Judy line, `scripts/Measure-VoxtralClarity.mjs`, the files in
`E:\CyberpunkConvai-offload\work\voxtral-ab-2026-10-13\`, with a README naming each): the 8 to 12 kHz bands of an answer from the old
reference were 55 dB under the 0 to 4 kHz level, against 22 to 24 dB for an answer cloned from the whole original clip. The 40 dB
bandwidth was 7.2 kHz against 10.4 to 12 kHz. Spectral rolloff and centroid hardly move, which is why they do not show it: it is the
top bands ("air" and the brightness of s and t) that were missing, about 30 dB.

| Reference sent (the same cut clip) | Body sent | First audio, median | Bandwidth (40 dB) | 8 to 10 / 10 to 12 kHz band |
| --- | --- | --- | --- | --- |
| 16 kHz MP3 32 kbit/s (versions 1 and 2) | 46.0 KB | 1,109 ms (7 calls) | 7.2 kHz | -56 / -55 dB |
| 16 kHz MP3 64 kbit/s | 91.7 KB | 1,491 ms | 7.2 kHz | -56 / -55 dB |
| 16 kHz WAV (the no-ffmpeg fallback of version 2) | 362.5 KB | 1,595 ms | 7.3 kHz | -56 / -55 dB |
| **24 kHz MP3 40 kbit/s (version 3, now sent)** | **57.3 KB** | **1,043 ms (3 calls)** | **10.4 kHz** | **-21 / -33 dB** |
| 24 kHz MP3 48 kbit/s | 68.6 KB | 1,418 ms | 11.1 kHz | -21 / -27 dB |
| 24 kHz MP3 96 kbit/s | 137.0 KB | 1,228 ms | 11.2 kHz | -23 / -29 dB |
| 24 kHz WAV | 543.7 KB | 1,528 ms | 12 kHz | -21 / -21 dB |
| the whole original clip (857 KB) | 856.8 KB | 1,820 ms | 12 kHz | -23 / -23 dB |

The sample rate decides, not the bitrate: 16 kHz at 64 kbit/s or as a WAV is as dull as 32 kbit/s. Voxtral itself is not band-limited
(it reaches its 12 kHz Nyquist), and streaming against non-streaming gives the same spectrum. **Not the cause:** our own path.
`scripts/Measure-VoxtralPipeline.mjs` ran the packets through `ownedLocalPcmPacket`, `ContinuousPcmCore` and the player's graph: the
only lossy step is float32 to int16 (null SNR 85 dB overall, at least 63 dB in every band, 63 dB at 6 to 8 kHz), the "air" low-pass
sits at Nyquist (bit-exact) until about 13.6 m even with Match game dialogue level on, and the limiter only trims peaks (about 1.2 dB
at +6 dB makeup). With Match game dialogue level on, a companion more than about 13.6 m away is low-passed on purpose (at 20 m the
cut is 8.5 kHz, 16 dB off the 10 to 12 kHz band); that is a setting, unchanged. Not measurable offline: the browser's resample from
the 24 kHz context to the sound card's rate.

**Shipped (version 3, `REFERENCE_PREPARATION`):** the cut clip is kept at its own 24 kHz (before, resampled to 16 kHz) and encoded as a
40 kbit/s MP3 (before 32): 42.8 KB for Judy instead of 34.3 KB, bandwidth 10.5 kHz. **Latency trade-off: the body grows by 11.3 KB
(+25%), about +11 ms at the 1 ms per KB measured before, and the medians show no cost (1,043 against 1,109 ms; call-to-call noise is
about 0.3 s, so read "not measurable", not "faster").** 40 kbit/s rather than 48 because bodies over about 65 KB looked about 0.3 s
slower (small samples). The cache signature changes, so the next bridge start prepares each character's clip once (about 0.4 s). Without
ffmpeg the fallback WAV is 24 kHz too (408 KB instead of 272 KB, about +0.15 to 0.2 s); shipped players get the pre-built MP3 slots.
What is left to judge by ear: the files above (use `listen-levelmatched/`, and the same-utterance low-passed copies of one call for the
cleanest comparison), on the player's own headphones; Bluetooth earbuds may roll off the top by themselves.

## Reference size (2026-10-12; the numbers below are for the 16 kHz clip of versions 1 and 2)

The clip is sent with every request, so its size is most of the wait for first audio on a slow uplink: the 13 s 24 kHz long clip is
857 KB in the body (headers back after about 1.4 s); a 16 kHz mono clip cut to 8 s is 354 KB (about 0.9 to 1.3 s); the same as a 64 kbit/s
MP3 is 89 KB (about 0.6 s). `bridge/voxtral-reference.mjs` prepares the clip once per character and `VoxtralVoice` sends that:

- Mono, 24 kHz since version 3 (16 kHz before: see above), cut to about 8.5 s at the quietest moment of the last 2.5 s (a pause, not a
  word), 5 ms fade; a clip that is already short is not cut. Pure JavaScript (about 408 KB for a 13 s clip at 24 kHz, 265 KB at 16 kHz).
- With ffmpeg on the machine (`ffmpeg` on the path, or `CYBERPUNK_CONVAI_FFMPEG`) the same clip is also encoded as a 40 kbit/s MP3
  (about 43 KB; 64 kbit/s, 67 KB, in version 1 and 32 kbit/s, 34 KB, in version 2) and sent with `format: 'mp3'`. Without ffmpeg the
  WAV is sent. An MP3 that is not an MP3 or not smaller is not used.
- Kept on disk in `<references>/prepared/<character>.wav|mp3` with a `.json` naming the source clip's sha256 and the settings: done
  once per character, redone when the clip or the settings change, a cache that cannot be written is ignored. The reference is prepared
  when the voice is warmed, not on the first request (about 0.3 s of the bridge's time for one character).
- The timing record shows `voiceReferenceBytes` (the size sent) and `voiceReferenceFormat`.
- `CYBERPUNK_CONVAI_VOXTRAL_FULL_REFERENCE=1` sends the clips whole, as before. Any failure in preparation sends the whole clip.
- Does the clone stay the same? Six real calls (the same sentence, Judy): ECAPA similarity to the original reference 0.50 and 0.65
  (full clip), 0.58 and 0.57 (cut 16 kHz), 0.58 and 0.51 (cut MP3): inside the call-to-call spread. Listen to the files named in
  `docs/LATENCY_2026-10-12.md`.
- Not done: shipping pre-encoded MP3 clips with the mod (players without ffmpeg only get the smaller WAV).

## One shared Mistral scheduler

Text replies, speech and background memory work share one Mistral key, so they share one allowance.
`bridge/mistral-rate.mjs` starts every request **immediately** (the default spacing is 0; a running request never blocks the next).
When requests have to wait it serves the most urgent first (`PRIORITY.TEXT` before `PRIORITY.TTS` before `PRIORITY.BACKGROUND`, oldest
first within a level). It reads the per-minute headers of every answer and slows down only when an allowance is nearly used up (10% or
2 left: an even spread over the minute for requests, about a second for characters or tokens; it relaxes when a later answer shows room
or after 30 s), pauses until `Retry-After` when one is at 0, and on a 429 pauses for its `Retry-After`, keeps starts about a second
apart for a minute and then relaxes. A per-second header (`x-ratelimit-limit-req-second`), if one ever appears, sets the base spacing. API:

```js
import {mistralScheduler, PRIORITY} from './mistral-rate.mjs';
await mistralScheduler.schedule(({signal, sentAt, attempt}) => fetch(...), {priority: PRIORITY.TEXT, signal, retries: 1, maxQueueMs: 6000});
mistralScheduler.noteHeaders(response.headers);   // after every response
mistralScheduler.pause(ms);                       // a 429 handled by the caller
mistralScheduler.stats();                         // {spacingMs, queued, started, pausedForMs, slowForMs}
```

Group chat: several speakers queue in turn. Measured 2026-10-12 on the developer's free key (a handful of calls): text, then
speech, then text in sequence all answered 200; two text requests and one speech request started at the same moment all answered
200; no 429 and no per-second header appeared. The headers carry only per-minute figures (text: `x-ratelimit-limit-req-minute`
188 and 625,000 tokens for `ministral-8b`; speech: 12,000 input characters a minute). No spacing is therefore applied by default: it
would only delay the voice of a reply by up to a second (more in group chat). `maxQueueMs` (6 s for speech) only matters while the
scheduler is paused or slowed.

## Measured

- Smoke call through the adapter (Judy's long reference, 2026-10-12): a clean 6.24 s utterance, 24 kHz, intelligible
  (zero-crossing rate and level consistent with speech).
- Smoke call with the extracted-clips source (Judy, registries empty, 2026-10-12): the joined 48 kHz file was accepted, first audio
  at 2.1 s, 5.76 s of speech at a normal level.
- Long reply, two live calls (2026-10-12, Judy, 317 characters): sent as two requests (41 + 275 characters) first audio came at
  2.07 s and the second request's at 2.94 s, 23.6 s of speech in 5.2 s; the same text as one request had first audio at 2.07 s and
  21.8 s of speech in 4.2 s. So on this probe the length of the text did not move the first audio; the split is a hedge against the
  slow starts seen in game and in the research (a spike costs only the first sentence's wait), not a measured gain on the median.
- From `docs/FREE_CLOUD_OPTION_RESEARCH.md`: first audio median 1.24 s over six warm runs (0.98 to 1.56 s) with one 11 s spike
  in about ten calls, which is why a first-audio limit (now 7 s) and the Pocket fallback exist. A reply of about 90 characters costs
  about 90 of the 12,000 input characters a minute.

## Limits

- English only (see above); the face and lip sync follow the audio, so a different voice speed is handled by the same packets.
- The audio style comes from the reference clip (Voxtral has no tags or style field), so Natural speech is limited to pauses
  and Expressive emotions use the usual text-based expression.
- A voice that is routed to Pocket for one reply sounds like Pocket for the whole of that reply (never for a part of it); nothing is
  cross-faded. A reply whose rest the cloud could not deliver (after two asks) ends after its first part, in the cloud voice.
- The routing log (`runtime/bridge.stderr.log`, `[VoiceRouting]`) names, under `ref=`, the reference Voxtral clones from (long set, else
  short, else Pocket), not the Pocket reference it rides on; before 2026-10-12 it showed the Pocket one (for Alex, `picked/autobest/pocket
  16.59s` although the long set has an entry). Clips extracted for a character, the last resort, show as `-`.
- The Characters sidebar names "Mistral cloud voice (Voxtral)" for every character routed locally while the voice is active,
  including any that fall back to Pocket for want of a clip.
