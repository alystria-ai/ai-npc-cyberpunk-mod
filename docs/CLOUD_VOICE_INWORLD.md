# Inworld cloud voice

Added 2026-10-13, on branch `inworld-voice` (not merged). An optional Companion voice that speaks a reply with Inworld's
text-to-speech (`inworld-tts-2`), cloned once per character from the character's own reference clip, on the player's own
Inworld key. It sits beside the Mistral cloud voice (Voxtral, `docs/CLOUD_VOICE_VOXTRAL.md`) and works the same way: any
conversation provider can write the replies, Pocket stays loaded and speaks any reply the cloud cannot deliver.

Code: `bridge/inworld-voice.mjs` (the adapter), `bridge/inworld-key.mjs` (the player's key), `bridge/inworld-steering.mjs`
(emotion), `bridge/cloud-reply-voice.mjs` (one voice per reply), `bridge/voice-selection.mjs` (routing and fallback),
`bridge/voice-routing-log.mjs`, `bridge/mistral-key.mjs` (the key command and status), `mod/voice-preview.lua`, `mod/manager.lua`,
`mod/mcm.lua` (the menu). Tests: `bridge/inworld-voice.test.mjs`, `bridge/inworld-steering.test.mjs`,
`bridge/inworld-key.test.mjs`, `bridge/cloud-reply-voice.test.mjs`, `bridge/manager.test.mjs`, `bridge/voice-preview-adapter.test.mjs`.
Measuring script: `scripts/Measure-InworldVoice.mjs`.

## What Inworld offers (read from its docs, 2026-10-13)

| Topic | Finding |
| --- | --- |
| Streaming speech | `POST https://api.inworld.ai/tts/v1/voice:stream`, `Authorization: Basic <the portal key, unchanged>`. Body `{text, voiceId, modelId, audioConfig:{audioEncoding, sampleRateHertz}}`. The answer is newline-delimited JSON, one `{"result":{"audioContent":"<base64>", ...}}` per chunk. |
| Formats | `PCM` is raw 16-bit little-endian with no header (checked live); also MP3, OGG_OPUS, LINEAR16 (WAV header), ALAW, MULAW, FLAC. This adapter asks for PCM at 24,000 Hz, the rate the rest of the bridge uses. |
| Errors | An error can arrive as a `{"error":{code,message}}` line after HTTP 200 (gRPC codes: 3 invalid, 5 not found, 7 permission, 8 exhausted, 14 unavailable, 16 unauthenticated). The adapter reads both forms. |
| Models | `inworld-tts-2` (steering, cloned voices, about 100 ms time to first byte at P90 by Inworld's numbers) and `inworld-tts-2-flash` (about 20 ms, no steering). `tts-1` and `tts-1-max` were discontinued on 2026-06-15. |
| Text limit | 4,000 characters per request. The whole text is counted when the first chunk is produced, so stopping early saves nothing. |
| Instant voice clone | `POST https://api.inworld.ai/voices/v1/voices:clone`, body `{displayName, languageCode, voiceSamples:[{audioData:<base64 wav or mp3>}], ...}`. Answers `voice.voiceId`. The clip must be 3 s at least; 10 to 30 s is best; 30 s is the limit for voices cloned after 2026-08-15; 12 MB at most. Cloning needs a key with write access. |
| Voice list and delete | `GET /voices/v1/voices` (paged), `DELETE /voices/v1/voices/<id>`. The account's list is the source of truth for what already exists. |
| Free plan | The pricing page says "up to 70 minutes of TTS for free" on the On-Demand plan ($0). It does not say whether that is per month or once, nor what happens afterwards (credits start at $10). Paid price: $25 per million characters for TTS-2, $15 for Flash. A commercial licence is listed. 100 custom voices, 5 generations at once. |
| Rate limits | Cloning: 2 requests a minute on the free plan. Speech: HTTP 429 with no documented `Retry-After`. |
| Steering | `inworld-tts-2` only. Bracketed English instructions placed before the words they apply to, lower case and without punctuation; they last until the next one or `[reset]`. A separate request-level `instruction` field exists; this adapter uses the inline form only. |

### Terms for a game mod

Read from the Terms of Service (2025-06-11), the Acceptable Use Policy, the Service Specific Terms and the model cards:

- The licence is "non-sublicensable ... solely for your internal business purposes". A mod that ships one developer key, or
  sends every player's text through the developer's account, is not that. **So each player uses their own Inworld key and
  account**, exactly as for Mistral and Groq. Nothing here puts a key into the release.
- The Terms have no end-user rules for apps built on the API and no voice-cloning consent text. The model cards and the safety
  page forbid impersonating a real person without consent. The reference clips are the game's own voice actors, so cloning them is
  a risk **the player takes on their own account** and the project owner should weigh before offering it; this is the one point
  that may need the owner's decision.
- Limits above are as documented; they were not tested to exhaustion (free minutes are small).

## What the player sees

Settings > Voices > Companion voices has eight entries: Pocket · Performance, four OmniVoice tiers, Mistral cloud voice (Voxtral),
**Inworld cloud voice**, Convai · Cloud voice. Without a key the entry reads "Inworld cloud voice · needs Inworld key" and Apply
refuses it ("Requires an Inworld key (add it in Settings > Development)").

The key is entered like the Mistral and Groq keys: in Settings > Development, **Paste Inworld key** reads the clipboard once, checks
it with Inworld (a free request, the voice list) and saves it in the bridge's state folder as `player-inworld-key.txt`; the same
file can be written by hand. **Remove my Inworld key** deletes it. The page shows only whether a key is saved and its last four
characters (`runtime/mistral-state.json`, `inworld.saved` and `inworld.tail`). The key never goes to a log, a status file or a
setting, and goes only to `api.inworld.ai`. Command file: `runtime/inworld-key-command.json` (ids `:ikey:`).

English only (the Pocket route it rides on is English), as with Voxtral: with Multilingual conversations on, the choice is
refused ("The Inworld cloud voice speaks only English here. Turn off Multilingual conversations to choose it.").

## How it speaks

`InworldVoice.synthesizeStream(voiceKey, text, {signal, onPcm, emotion})` has Pocket's interface and hands `onPcm` 24 kHz mono
float32 packets of 100 ms (the Pocket packet contract, `timing.voiceEngine: 'inworld'`). Subtitles, lip sync and the face are
driven by those packets exactly as with Pocket and Voxtral. Bytes may split anywhere, inside a sample too; the decoder carries the
odd byte over.

### Cloning: once per character

1. The reference clip comes from the same library as Voxtral's (OmniVoice long set first; the bridge's `VoxtralVoice` instance is
   used only as that library, so the two voices always clone the same clip).
2. The voice is named `cp2077-companion-<character>-<hash of the clip>`. The account's voice list is checked first: a voice with
   that name is adopted, not cloned again. Otherwise the clip is sent once to `voices:clone`.
3. The voice id is kept in memory and in `player-inworld-voices.json` in the state folder, so the next session needs no
   request at all before the first reply. A saved id Inworld says does not exist is dropped and made again. A changed key drops
   the saved ids (they belonged to the other account). An older voice of the same character (the clip changed) is deleted after
   the new one is made; no other voice of the account is ever touched.
4. Clones go one at a time and never more than 2 a minute (the free plan). Preparing a character starts its clone in the
   background. A reply waits at most 3 s for a voice still being made, otherwise **Pocket speaks that whole reply**, and the voice
   is there for the next one. The voice of a new character is therefore usually ready before the first reply (about 9 s with the
   clip read, in the live test).

### One voice per reply

A reply may be voiced in two parts (first sentence while the model is still writing, then the rest). `ReplyVoice`
(`bridge/cloud-reply-voice.mjs`) is shared by both parts: the first part decides, the second waits and follows.

- Inworld produces the first packet: the reply is Inworld's. A later part that fails then **ends the reply early** (what was spoken
  stands); it is never handed to Pocket.
- Inworld fails before any audio (no key, no voice yet, 4xx/5xx, no first audio in 5 s): the reply is Pocket's, **whole**, both
  parts, and the second part does not try Inworld.
- A cancelled reply or an error from the audio consumer is not a fallback and does not count against the service.

The existing Voxtral branch of `VoiceSelection` does not use the lock yet (another change was adding the same rule there when this
was written); both can share `ReplyVoice` when they meet.

### Fallbacks

| Cause | Kind | After it |
| --- | --- | --- |
| No Inworld key | `no-key` | Pocket until a key appears |
| No clip for this character | `no-reference` | Pocket for this character |
| Clone refused or still being made | `voice` | Pocket for this reply; the clone is retried after 10 min (30 s after a network fault, 65 s after a limit) |
| Voice not found (404, code 5) | `voice-missing` | the voice is forgotten and made again; this reply is Pocket's |
| No first audio in 5 s | `timeout` | next reply tries again |
| 429 or exhausted | `limit` | pause for `Retry-After` (20 s when none) |
| 401 / 403 | `key` | 60 s pause |
| Plan used up (402, or a quota message) | `quota` | 30 min pause; shown as "unavailable", not "not ready yet" |
| Network, 5xx, stalled stream (8 s) | `network` | next reply tries again |
| Refused request | `request` | next reply tries again |
| Text over 4,000 characters, or nothing speakable | `text` | Pocket speaks it |

## Emotion

Expressive emotions gives each reply marks `{at, name, strength}` (`docs/EMOTION_TAGS.md`): a feeling in force from that word until
the next mark. Inworld steering is the same shape (an instruction in force until the next or `[reset]`), so it maps one to one and
cleanly: each mark becomes one bracketed instruction in front of its word (`bridge/inworld-steering.mjs`).

| Feeling | Subtle | Strong |
| --- | --- | --- |
| joy | say with warm amusement | say with delighted excitement |
| warm | say warmly and gently | say tenderly with deep affection in a soft voice |
| interest | sound curious and engaged | sound intensely curious and fascinated |
| surprise | sound surprised | sound shocked and astonished |
| sadness | say sadly in a quiet low voice | slow and hushed with every word weighted by grief |
| fear | sound worried and tense | sound frightened with a shaky breathless voice |
| anger | say with controlled irritation | speak as if barely holding back rage forcing every word through gritted teeth |
| disgust | say with scorn and disgust | say with open revulsion and contempt |
| calm | `[reset]` | `[reset]` |

- A `calm` mark with nothing in force, and the same instruction twice in a row, add nothing.
- A reply voiced in two parts: the second request starts with the feeling in force where it begins (a new request has no memory).
- Square and angle brackets in the text are replaced by spaces, so nothing the character wrote can be read as an instruction.
- The instruction text is not subtitled and is not metered as speech by the bridge; Inworld bills characters, so it costs a few
  extra characters.
- Natural speech non-verbal tags (`[laugh]`, `[sigh]`, ...) are **not** mapped: Inworld does have such tags, but Natural speech
  and its tag list are a separate design. Voice tags never reach this voice (they are removed before any engine sees the text).

## Measured

All on the test account, Judy's long reference, `inworld-tts-2`, 2026-10-13 (`scripts/Measure-InworldVoice.mjs`; samples and a README
in `E:\CyberpunkConvai-offload\work\inworld-2026-10-13\`).

- First audio, six runs of a 24-character line with the voice made: 429, 439, 585, 1229, 1337, 1344 ms. Two groups, about 0.4 to
  0.6 s and 1.2 to 1.35 s; the longer lines: 1274, 612, 419, 1266 ms. An earlier cold request took 2.06 s. Inworld's own figure
  is a P90 of 100 ms to the first byte; the rest is the network and the first PCM chunk. For comparison, Voxtral's median was 1.24 s
  with one 11 s spike in about ten calls (above).
- Making a voice (clip read, voice list, clone): 8.9 s through the adapter the first time; an existing voice is found by name in
  well under a second.
- The format is raw PCM16 with no header at 24 kHz: decoded and checked sample by sample in the tests.
- Steering is audible in the numbers: the same angry line was 4.32 s (RMS 0.067) plain and 5.74 s (RMS 0.081) with the anger
  instruction; the sad line came out slow and quiet (8.58 s, RMS 0.037). Whether it sounds right is for the user to listen to.
- The whole live session spoke 456 characters of the account's free allowance, plus the earlier smoke runs.

## Limits and open points

- English only, like the Pocket route.
- Whether the free 70 minutes is monthly or once is not in the docs; what the player sees when it is gone is the `quota` fallback
  (Pocket speaks, one "unavailable" notice) after Inworld answers 402 or a quota message. That answer was **not** seen live; the
  mapping follows the documented codes and is unit-tested only.
- A new character's first reply may be Pocket's if its voice is not made yet (two clones a minute on the free plan; about 9 s for
  one). Warm-up at "prepare" makes this rare.
- Cloning game actors' voices is the player's own risk on their own account (terms above).
- Natural speech non-verbal tags are not mapped.
- The Voxtral branch of `VoiceSelection` does not use the `ReplyVoice` lock yet.

## Live checks in game (user)

Install the committed `mod/` files and the bridge from this branch (never `mod/diagnostics.lua`), restart the bridge, reload CET.
1. Settings > Development > Paste Inworld key (key copied from Inworld's portal first): the row reads "Added (ends in ....)".
2. Settings > Voices > Companion voices: choose "Inworld cloud voice", Apply.
3. Talk to a companion: the voice is hers, the lips and subtitles follow it. The first reply of a character not seen before may be
   Pocket's while the voice is made; later replies are Inworld's.
4. `runtime/bridge.stderr.log`: `[Inworld] first audio ... ms` lines and `[VoiceRouting]` lines naming "Inworld cloud voice".
5. Remove the key: the entry reads "... · needs Inworld key" and Apply refuses it.
6. Switch the network off mid-session: the next reply is Pocket's, whole, with one "not ready yet" notice; no reply changes voice
   in the middle.
7. Emotion: a reply with a strong feeling ({anger:strong}, {sadness}) sounds different from a plain one.
