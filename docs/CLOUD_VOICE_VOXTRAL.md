# Mistral cloud voice (Voxtral)

Added 2026-10-12. An optional Companion voice that speaks a reply with Mistral's text-to-speech (`voxtral-mini-tts-latest`),
cloned from the character's own OmniVoice long reference clip, on the player's free Mistral key. It works with any
conversation provider (Convai, Mistral, Groq or Local), because it only needs the key. Research and measurements behind the
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
- `ref_audio` is the character's OmniVoice long reference (`runtime/voice-configs.json`, the long config; the file's sha256 is
  checked against the registry, and a clip over 25 s is cut). Saved voices need a paid plan, so the clip is sent with **every**
  call; its base64 form is cached per voice in memory (32 voices).
- **One request per reply**, streamed, never one per sentence.
- The key goes only in the Authorization header; messages pass through `redact`; it is never logged or written to a state file.

## Fallback rule

Pocket stays loaded (this voice is a route on top of it), so any reply the cloud cannot deliver is spoken by Pocket, in the same
reply slot, with no gap in the written text. Before any audio has been delivered, each of these throws a `VoxtralError` and Pocket
speaks that reply:

| Cause | Kind | After it |
| --- | --- | --- |
| No Mistral key | `no-key` | Pocket until a key appears |
| No long reference for this character | `no-reference` | Pocket for this character; the rest still use Voxtral |
| No first audio in 4 s (counted from the moment the request is sent, not when it queued) or waiting over 6 s behind other Mistral requests | `timeout` | next reply tries again |
| 429 | `limit` | cool-down for `Retry-After` (20 s when none, at most 60 s); every Mistral request pauses for it |
| 401 / 403 | `key` | 60 s cool-down |
| Network error, 5xx, stalled stream (8 s of silence) | `network` | next reply tries again |
| Refused request or unusable answer | `request` | next reply tries again |
| Text over 4,000 characters, or nothing speakable | `text` | not a fallback event; Pocket speaks it |

**The rule for a character with no long reference: Pocket**, as in the table (the simplest rule, no stock-voice guess). A stock
Voxtral voice would be a different, generic voice that does not match the character, and the preset voices carry only gender and
language tags. Currently `8ug8ear` and `jake-estevez` have no long reference, so they always speak with Pocket in this mode
(listed as a follow-up in `TODO.md`).

If audio is already playing and the stream then fails, the reply's audio ends early (the written reply is complete) rather than
playing two voices; the result carries `truncated: true`. A failure of the consumer (`onPcm` throwing) or a cancellation is not a
fallback.

The player is told **once per session** per fallback: "Mistral cloud voice (Voxtral) is not ready yet. Companions are using Pocket ·
Performance for now." for a temporary one (a timeout, a limit) and "... is unavailable. Companions are using Pocket · Performance
instead." for a permanent one (no key). It reuses the existing `voice-fallback` notice; the bridge publishes it as
`fallback: {from: 'voxtral', to: 'pocket', temporary, reason}` in `runtime/local-voice-state.json`.

## One shared Mistral scheduler

A free Mistral key may be limited to about one request a second for the whole workspace, shared by text replies and speech.
`bridge/mistral-rate.mjs` spaces the **starts** of requests (default 1.05 s; a running request never blocks the next), serves the
most urgent waiting request first (`PRIORITY.TEXT` before `PRIORITY.TTS` before `PRIORITY.BACKGROUND`, oldest first within a
level), retries a 429 after its `Retry-After`, and lets only a per-second header (`x-ratelimit-limit-req-second`) change the
spacing. API:

```js
import {mistralScheduler, PRIORITY} from './mistral-rate.mjs';
await mistralScheduler.schedule(({signal, sentAt, attempt}) => fetch(...), {priority: PRIORITY.TEXT, signal, retries: 1, maxQueueMs: 6000});
mistralScheduler.noteHeaders(response.headers);   // after every response
mistralScheduler.pause(ms);                       // a 429 handled by the caller
mistralScheduler.stats();                         // {spacingMs, queued, started, pausedForMs}
```

Group chat: several speakers queue in turn. Measured 2026-10-12 on the developer's free key (a handful of calls): text, then
speech, then text in sequence all answered 200; two text requests and one speech request started at the same moment all answered
200; no 429 and no per-second header appeared. The headers carry only per-minute figures (text: `x-ratelimit-limit-req-minute`
188 and 625,000 tokens for `ministral-8b`; speech: 12,000 input characters a minute). The 1.05 s spacing is therefore a precaution
that costs a request about a second of waiting at most when two start together.

## Measured

- Smoke call through the adapter (Judy's long reference, 2026-10-12): a clean 6.24 s utterance, 24 kHz, intelligible
  (zero-crossing rate and level consistent with speech).
- From `docs/FREE_CLOUD_OPTION_RESEARCH.md`: first audio median 1.24 s over six warm runs (0.98 to 1.56 s) with one 11 s spike
  in about ten calls, which is why the 4 s first-audio limit and the Pocket fallback exist. A reply of about 90 characters costs
  about 90 of the 12,000 input characters a minute.

## Limits

- English only (see above); the face and lip sync follow the audio, so a different voice speed is handled by the same packets.
- The audio style comes from the reference clip (Voxtral has no tags or style field), so Natural speech is limited to pauses
  and Expressive emotions use the usual text-based expression.
- A voice that is routed to Pocket for one reply sounds like Pocket for that reply; nothing is cross-faded.
- The Characters sidebar names "Mistral cloud voice (Voxtral)" for every character routed locally while the voice is active,
  including the two that fall back to Pocket for want of a reference.
